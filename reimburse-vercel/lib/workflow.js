import { randomUUID } from 'crypto';
import { CONFIG, POLICY, COL, deptsForHod } from './config.js';
import { ensureHeaders, appendRecord, findById, updateCells, readAll } from './sheets.js';
import { sendEmail, approvalEmailHtml, rejectedEmailHtml, reminderEmailHtml, noticeEmailHtml, money, parseLines } from './email.js';

// ---------------------------------------------------------------------------
//  Amount helpers
// ---------------------------------------------------------------------------
export function toINR(amount, currency) {
  return String(currency) === 'USD' ? Math.round(Number(amount || 0) * POLICY.FX_USD_INR) : Number(amount || 0);
}
// CEO required when the total claim (INR) exceeds the threshold.
export function needsMgmt(amountINR) { return Number(amountINR || 0) > POLICY.CEO_THRESHOLD_INR; }
export function tierLabel(amountINR) {
  const t = POLICY.CEO_THRESHOLD_INR.toLocaleString('en-IN');
  return needsMgmt(amountINR)
    ? `High value — CEO required (total > ₹${t})`
    : `Standard — Dept Head → Finance (total ≤ ₹${t})`;
}

// ---- approval chain (the approve/reject part) ----
export function chainFor(mgmt) { return mgmt ? ['dept', 'finance', 'mgmt'] : ['dept', 'finance']; }
// Full lifecycle labels for the form's success timeline.
export function chainLabels(mgmt) {
  return ['HOD', 'Finance', ...(mgmt ? ['Sanjay (CEO)'] : []), 'Payout'];
}
function stageLabel(stage) {
  return {
    dept: 'Department Head', finance: 'Finance', mgmt: 'Sanjay (CEO)',
    pay: 'Payout', done: 'Reimbursed',
  }[stage] || stage;
}
function mgmtRequired(rec) { return needsMgmt(Number(rec[COL.AMOUNT_INR] || 0)); }
function approverEmailFor(stage, rec) {
  if (stage === 'dept') return rec[COL.HOD] || CONFIG.FINANCE_SPOC;
  if (stage === 'mgmt') return CONFIG.CEO_EMAIL;
  return CONFIG.FINANCE_SPOC; // finance
}
function approverNameFor(stage, rec) {
  if (stage === 'dept') { const d = CONFIG.DEPARTMENTS[String(rec[COL.DEPT] || '')]; return (d && d.head) || 'Department Head'; }
  if (stage === 'mgmt') return CONFIG.CEO_NAME;
  return CONFIG.FINANCE_NAME;
}
// Next APPROVAL stage in the chain, or null after the last approval.
function nextApprovalStage(rec, current) {
  const chain = chainFor(mgmtRequired(rec));
  const i = chain.indexOf(current);
  if (i === -1) return null;
  return (i + 1 < chain.length) ? chain[i + 1] : null;
}
function actionUrl(base, id, stage, decision, token) {
  return `${base}/api/decision?id=${encodeURIComponent(id)}&stage=${stage}&decision=${decision}&token=${token}`;
}
const APPROVAL_STAGES = ['dept', 'finance', 'mgmt'];

// The actionable approve/reject email to the approver whose turn it is.
async function emailApprover(stage, rec, baseUrl) {
  const to = approverEmailFor(stage, rec);
  const token = rec[COL.TOKEN];
  const id = rec[COL.ID];
  const html = approvalEmailHtml(rec, stageLabel(stage), approverNameFor(stage, rec),
    actionUrl(baseUrl, id, stage, 'approve', token), actionUrl(baseUrl, id, stage, 'reject', token));
  await sendEmail({ to, subject: `[Action Needed] ${id} — ${stageLabel(stage)} approval`, html });
}
async function notify(to, subject, rec, heading, body, link) {
  const opts = { to, subject, html: noticeEmailHtml(rec, heading, body, link) };
  if (CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL] && to !== rec[COL.EMAIL]) opts.cc = rec[COL.EMAIL];
  await sendEmail(opts);
}

// Live "where is my claim" tracker rendered into requester/FYI emails (body is raw HTML).
function chainProgressHtml(rec, note) {
  const chain = chainFor(mgmtRequired(rec));
  const decOf = { dept: COL.DEPT_DEC, finance: COL.FIN_DEC, mgmt: COL.MGMT_DEC };
  const cur = String(rec[COL.STAGE]);
  const rejected = cur === 'rejected';
  const items = chain.map((st) => {
    const d = String(rec[decOf[st]] || '');
    let icon = '•', color = '#999', tail = '';
    if (/approv/i.test(d)) { icon = '✓'; color = '#0a8a0a'; tail = ' — approved'; }
    else if (/reject/i.test(d)) { icon = '✕'; color = '#c0392b'; tail = ' — rejected'; }
    else if (st === cur && !rejected) { icon = '⏳'; color = '#b8860b'; tail = ' — pending'; }
    return `<li style="color:${color};margin:3px 0;">${icon} ${stageLabel(st)}${tail}</li>`;
  }).join('');
  return `${note ? `<p style="margin:0 0 8px;">${note}</p>` : ''}<ul style="list-style:none;padding:0;margin:6px 0 0;font-size:14px;line-height:1.5;">${items}</ul>`;
}
async function emailRequester(rec, baseUrl, heading, note) {
  if (!rec[COL.EMAIL]) return;
  await sendEmail({ to: rec[COL.EMAIL], subject: `Reimbursement ${rec[COL.ID]} — ${heading}`,
    html: noticeEmailHtml(rec, heading, chainProgressHtml(rec, note), (baseUrl || '') + '/my') });
}
async function emailChainFyi(currentStage, rec, baseUrl) {
  const chain = chainFor(mgmtRequired(rec));
  const downstream = chain.slice(chain.indexOf(currentStage) + 1);
  for (const st of downstream) {
    const to = approverEmailFor(st, rec);
    if (!to) continue;
    const note = `Heads-up: this claim will reach you for <b>${stageLabel(st)}</b> approval once the earlier approver(s) sign off — no action needed yet.`;
    await sendEmail({ to, subject: `[FYI] ${rec[COL.ID]} — you're next in line for ${stageLabel(st)} approval`,
      html: noticeEmailHtml(rec, 'A reimbursement claim is in the approval pipeline', chainProgressHtml(rec, note), (baseUrl || '') + '/approvals') });
  }
}
async function notifyFinanceFinal(rec, baseUrl) {
  await notify(CONFIG.FINANCE_SPOC, `[Approved] Reimbursement ${rec[COL.ID]} — ready for payout`, rec,
    'Fully approved — ready for payout',
    'All approvers have signed off. Please record the payout on the Finance dashboard.', (baseUrl || '') + '/finance');
}

// ---- submit ----
export async function submitRequest(p, baseUrl) {
  const missing = [];
  if (!p.name)  missing.push('name');
  if (!p.dept)  missing.push('department');
  if (!p.title) missing.push('claim title');
  if (!p.purpose) missing.push('purpose / justification');

  // Normalise & validate line items (Keka model: each line has a type — Expense / Mileage / Per diem).
  const currency = String(p.currency) === 'USD' ? 'USD' : 'INR';
  const rawLines = Array.isArray(p.lines) ? p.lines : [];
  const lines = [];
  rawLines.forEach((l, i) => {
    const type = POLICY.EXPENSE_TYPES.includes(l.type) ? l.type : 'Expense';
    const distance = Math.max(0, Number(l.distance) || 0);
    const days = Math.max(0, Number(l.days) || 0);
    const rate = Math.max(0, Number(l.rate) || 0);
    // Mileage = distance × rate; Per diem = days × rate; else the entered amount.
    let amount;
    if (type === 'Mileage') amount = Math.round(distance * (rate || POLICY.MILEAGE_RATE_PER_KM));
    else if (type === 'Per diem') amount = Math.round(days * rate);
    else amount = Math.round(Number(l.amount) || 0);
    const hasAny = l.category || l.description || amount > 0 || l.receipt || l.date || distance > 0 || days > 0 || l.merchant;
    if (!hasAny) return; // skip empty rows
    if (!(amount > 0)) { missing.push(`amount on line ${i + 1}`); return; }
    if (!l.category)   { missing.push(`category on line ${i + 1}`); }
    // Receipt mandatory for actual out-of-pocket expenses; optional for mileage / per-diem (computed).
    if (type === 'Expense' && !l.receipt) { missing.push(`receipt on line ${i + 1}`); }
    // Compose a display description that embeds the computation + merchant (so all tables show it).
    let desc = String(l.description || '');
    if (type === 'Mileage') desc = (desc ? desc + ' · ' : '') + distance + ' km × ' + (rate || POLICY.MILEAGE_RATE_PER_KM) + '/km';
    else if (type === 'Per diem') desc = (desc ? desc + ' · ' : '') + days + ' day(s) × ' + rate + '/day';
    if (l.merchant) desc = (desc ? desc + ' ' : '') + '(' + String(l.merchant) + ')';
    lines.push({ date: l.date || '', category: l.category || '', type, merchant: String(l.merchant || ''),
      description: desc, distance, days, rate, amount, receipt: l.receipt || '' });
  });
  if (!lines.length) missing.push('at least one expense line');
  if (missing.length) throw new Error('Missing required field(s): ' + missing.join(', '));

  const amount = lines.reduce((a, l) => a + l.amount, 0);
  const advance = Math.max(0, Math.round(Number(p.advance) || 0));
  const net = Math.max(0, amount - advance);
  const amountINR = toINR(amount, currency);
  const high = needsMgmt(amountINR);

  const deptInfo = CONFIG.DEPARTMENTS[p.dept] || null;
  const hodEmail = (deptInfo && deptInfo.email) || p.hodEmail || CONFIG.FINANCE_SPOC;
  const id = 'RMB-' + stamp() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const token = randomUUID();

  const rec = {
    [COL.ID]: id, [COL.TS]: new Date().toISOString(), [COL.EMAIL]: (p.email || '').trim(),
    [COL.NAME]: p.name, [COL.EMPID]: p.empId || '', [COL.DEPT]: p.dept, [COL.HOD]: hodEmail,
    [COL.TITLE]: p.title, [COL.PROJECT]: p.project || '', [COL.PERIOD_FROM]: p.periodFrom || '', [COL.PERIOD_TO]: p.periodTo || '',
    [COL.CURRENCY]: currency, [COL.AMOUNT]: amount, [COL.AMOUNT_INR]: amountINR,
    [COL.ADVANCE]: advance, [COL.NET]: net,
    [COL.LINES]: JSON.stringify(lines), [COL.LINE_COUNT]: lines.length,
    [COL.PAY_METHOD]: p.payMethod || POLICY.PAYMENT_METHODS[0], [COL.PAY_DETAIL]: p.payDetail || '',
    [COL.PURPOSE]: p.purpose || '', [COL.NOTES]: p.notes || '', [COL.TIER]: tierLabel(amountINR),
    [COL.STATUS]: 'Pending HOD Approval', [COL.STAGE]: 'dept', [COL.TOKEN]: token,
  };

  // Duplicate guard: block a near-identical recent claim unless the user overrides (allowDuplicate).
  if (!p.allowDuplicate) {
    try {
      const all = await readAll();
      const tKey = String(p.title || '').toLowerCase().trim();
      const dKey = String(p.dept || '').toLowerCase().trim();
      const eKey = String(p.email || '').toLowerCase().trim();
      const now = Date.now();
      const dup = all.find((r) => {
        if (String(r[COL.STAGE]) === 'rejected') return false;
        if (String(r[COL.EMAIL] || '').toLowerCase().trim() !== eKey) return false;
        if (String(r[COL.TITLE] || '').toLowerCase().trim() !== tKey) return false;
        if (String(r[COL.DEPT] || '').toLowerCase().trim() !== dKey) return false;
        if (Number(r[COL.AMOUNT_INR] || 0) !== amountINR) return false;
        const ts = Date.parse(r[COL.TS]); if (ts && (now - ts) > 30 * 86400000) return false;
        return true;
      });
      if (dup) {
        return { ok: false, duplicate: true, dupId: dup[COL.ID], dupBy: String(dup[COL.NAME] || dup[COL.EMAIL] || ''), dupDate: fmtDate(dup[COL.TS]),
          error: `Possible duplicate of ${dup[COL.ID]} — "${String(dup[COL.TITLE] || '')}" (${money(amount, currency)}) raised ${fmtDate(dup[COL.TS])} and still active. Submit anyway only if this is genuinely separate.` };
      }
    } catch (e) { console.error('dup check failed (non-fatal):', e.message || e); }
  }

  await ensureHeaders();
  await appendRecord(rec);
  await emailApprover('dept', rec, baseUrl);
  await emailChainFyi('dept', rec, baseUrl);
  await emailRequester(rec, baseUrl, 'received — pending approvals',
    'Your reimbursement claim has been received and is now in the approval workflow. We will email you at every step.');
  return { ok: true, id, currency, amount, advance, net, mgmt: high, chain: chainLabels(high) };
}

// ---- token decision (email links) ----
export async function handleDecision({ id, stage, decision, token }, baseUrl) {
  if (!id || !stage || !decision || !token) return { title: 'Invalid Link', msg: 'This approval link is missing information.', color: '#b00' };
  const rec = await findById(id);
  if (!rec || String(rec[COL.TOKEN]) !== String(token)) return { title: 'Link Expired / Invalid', msg: 'This approval link is no longer valid.', color: '#b00' };
  if (String(rec[COL.STAGE]) !== stage) return { title: 'Already Processed', msg: `This claim is no longer at the "${stageLabel(stage)}" step. Current status: ${rec[COL.STATUS]}.`, color: '#a60' };
  return applyDecision(rec, stage, decision, baseUrl);
}

// Core transition for an APPROVAL stage (dept/finance/mgmt).
async function applyDecision(rec, stage, decision, baseUrl, comment) {
  const id = rec[COL.ID];
  const row = rec.__row;
  const now = new Date().toISOString();
  const decCol = { dept: COL.DEPT_DEC, finance: COL.FIN_DEC, mgmt: COL.MGMT_DEC }[stage];
  const timeCol = { dept: COL.DEPT_TIME, finance: COL.FIN_TIME, mgmt: COL.MGMT_TIME }[stage];
  if (!decCol) return { title: 'Not an approval step', msg: 'This stage is handled on the dashboard.', color: '#a60' };

  if (decision === 'reject') {
    const upd = [[COL.TOKEN, ''], [COL.STAGE, 'rejected'], [COL.STATUS, 'Rejected at ' + stageLabel(stage)], [decCol, 'Rejected'], [COL.HOLD, '']];
    if (timeCol) upd.push([timeCol, now]);
    await updateCells(row, upd);
    if (rec[COL.EMAIL]) await sendEmail({ to: rec[COL.EMAIL], subject: `Reimbursement ${id} — REJECTED`, html: rejectedEmailHtml(rec, stageLabel(stage), comment || '') });
    return { title: 'Rejected', msg: `You have rejected ${id}. The requester has been notified.`, color: '#b00' };
  }
  if (decision !== 'approve') return { title: 'Unknown Action', msg: 'Unrecognized decision.', color: '#b00' };

  const newToken = randomUUID();
  const next = nextApprovalStage(rec, stage);
  const upd = [[decCol, 'Approved'], [COL.TOKEN, newToken], [COL.HOLD, '']];
  if (timeCol) upd.push([timeCol, now]);
  if (next) {
    upd.push([COL.STAGE, next], [COL.STATUS, 'Pending ' + stageLabel(next) + ' Approval']);
    await updateCells(row, upd);
    const fwd = { ...rec, [decCol]: 'Approved', [COL.TOKEN]: newToken, [COL.STAGE]: next };
    await emailApprover(next, fwd, baseUrl);
    await emailRequester(fwd, baseUrl, `approved by ${stageLabel(stage)}`,
      `${stageLabel(stage)} approved your claim — it's now pending <b>${stageLabel(next)}</b> approval.`);
    return { title: 'Approved → ' + stageLabel(next), msg: `${id} approved. Forwarded to ${stageLabel(next)}.`, color: '#0a0' };
  }
  // Last approval done → Finance records the payout.
  upd.push([COL.STAGE, 'pay'], [COL.STATUS, 'Approved — awaiting payout']);
  await updateCells(row, upd);
  const final = { ...rec, [decCol]: 'Approved', [COL.STAGE]: 'pay' };
  await emailRequester(final, baseUrl, 'fully approved', 'All approvals are complete. Finance will now process your payout.');
  await notifyFinanceFinal(final, baseUrl);
  return { title: 'Approved → Payout', msg: `${id} fully approved. Finance notified to release the payout.`, color: '#0a0' };
}

// ---- authenticated approver decision (dashboard) ----
function myStageFor(rec, email, roles) {
  const e = String(email || '').toLowerCase();
  const r = roles || [];
  const dept = String(rec[COL.DEPT] || '');
  const deptHead = String((CONFIG.DEPARTMENTS[dept] || {}).email || '').toLowerCase();
  const stage = String(rec[COL.STAGE]);
  if (stage === 'dept' && r.includes('hod') && (deptHead === e || String(rec[COL.HOD] || '').toLowerCase() === e)) return 'dept';
  if (stage === 'finance' && r.includes('finance')) return 'finance';
  if (stage === 'mgmt' && (r.includes('ceo') || e === String(CONFIG.CEO_EMAIL).toLowerCase())) return 'mgmt';
  return null;
}
function appendComment(rec, stage, who, text) {
  if (!text) return rec[COL.COMMENTS] || '';
  const line = `[${stageLabel(stage)} · ${who} · ${fmtDate(new Date().toISOString())}] ${text}`;
  return rec[COL.COMMENTS] ? `${rec[COL.COMMENTS]}\n${line}` : line;
}
export async function approverDecision({ id, decision, comment, email, roles }, baseUrl) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Claim not found' };
  const stage = String(rec[COL.STAGE]);
  const mine = myStageFor(rec, email, roles);
  if (mine !== stage) return { ok: false, error: `This claim isn't awaiting your approval (current step: ${stageLabel(stage)}).` };
  const who = String(email || '').split('@')[0];
  if (decision === 'hold') {
    await updateCells(rec.__row, [[COL.HOLD, 'On Hold'], [COL.STATUS, 'On Hold — ' + stageLabel(stage)], [COL.COMMENTS, appendComment(rec, stage, who, comment || 'Put on hold')]]);
    return { ok: true, id, title: 'On Hold', msg: `${id} placed on hold.` };
  }
  if (decision !== 'approve' && decision !== 'reject') return { ok: false, error: 'Unknown decision' };
  const merged = { ...rec, [COL.COMMENTS]: appendComment(rec, stage, who, comment) };
  if (comment) await updateCells(rec.__row, [[COL.COMMENTS, merged[COL.COMMENTS]]]);
  const r = await applyDecision(merged, stage, decision, baseUrl, comment);
  return { ok: true, id, title: r.title, msg: r.msg };
}

// ---- payout (Finance records the reimbursement) ----
export async function recordPayout({ id, payRef, paidAmount, email }, baseUrl) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Claim not found' };
  if (String(rec[COL.STAGE]) !== 'pay') return { ok: false, error: 'Not awaiting a payout (current: ' + rec[COL.STATUS] + ').' };
  const amt = Number(paidAmount) > 0 ? Math.round(Number(paidAmount)) : Number(rec[COL.NET] || 0);
  const who = String(email || '').split('@')[0];
  await updateCells(rec.__row, [
    [COL.PAY_REF, String(payRef || '')], [COL.PAY_DATE, new Date().toISOString()], [COL.PAID_AMOUNT, amt],
    [COL.STAGE, 'done'], [COL.STATUS, 'Reimbursed & closed'], [COL.TOKEN, ''],
    [COL.COMMENTS, appendComment(rec, 'pay', who, 'Paid ' + money(amt, rec[COL.CURRENCY]) + (payRef ? ' · ref ' + payRef : ''))],
  ]);
  if (rec[COL.EMAIL]) await notify(rec[COL.EMAIL], `Reimbursement ${id} — paid`, rec, 'Payout released — closed',
    `Your reimbursement of <b>${money(amt, rec[COL.CURRENCY])}</b> has been processed${payRef ? ' (ref ' + payRef + ')' : ''}.`, (baseUrl || '') + '/my');
  return { ok: true, id, title: 'Payout recorded', msg: `${id} marked reimbursed (${money(amt, rec[COL.CURRENCY])}).` };
}

// ---- dashboard data ----
function decStatus(v) { if (!v) return ''; if (/reject/i.test(v)) return 'Rejected'; if (/approv/i.test(v)) return 'Approved'; return String(v); }
function detailOf(r) {
  const cur = String(r[COL.CURRENCY] || 'INR');
  return {
    title: r[COL.TITLE] || '', project: r[COL.PROJECT] || '', periodFrom: fmtDate(r[COL.PERIOD_FROM]), periodTo: fmtDate(r[COL.PERIOD_TO]),
    currency: cur, amount: Number(r[COL.AMOUNT] || 0), advance: Number(r[COL.ADVANCE] || 0), net: Number(r[COL.NET] || 0),
    lines: parseLines(r), lineCount: Number(r[COL.LINE_COUNT] || 0),
    payMethod: r[COL.PAY_METHOD] || '', payDetail: r[COL.PAY_DETAIL] || '',
    purpose: r[COL.PURPOSE] || '', notes: r[COL.NOTES] || '', tier: r[COL.TIER] || '',
    payRef: r[COL.PAY_REF] || '', payDate: fmtDate(r[COL.PAY_DATE]), paidAmount: Number(r[COL.PAID_AMOUNT] || 0),
  };
}
function rowShape(rec) {
  const cur = String(rec[COL.CURRENCY] || 'INR');
  const amount = Number(rec[COL.AMOUNT] || 0);
  const net = Number(rec[COL.NET] || 0);
  return {
    id: rec[COL.ID], name: rec[COL.NAME], email: rec[COL.EMAIL], dept: rec[COL.DEPT],
    title: rec[COL.TITLE], purpose: rec[COL.PURPOSE], currency: cur, amount, net,
    amountLabel: money(amount, cur), netLabel: money(net, cur),
    tier: rec[COL.TIER] || '', mgmt: mgmtRequired(rec), lineCount: Number(rec[COL.LINE_COUNT] || 0),
    submission: fmtDate(rec[COL.TS]), detail: detailOf(rec),
    stage: String(rec[COL.STAGE]), status: rec[COL.STATUS], comments: rec[COL.COMMENTS] || '',
  };
}

// Approvals dashboard — items the signed-in user can act on (by current stage).
// Finance (superuser) can also pass as=dept|finance|mgmt for a read-only monitor of that stage.
export async function approverData({ email, roles, as }) {
  const e = String(email || '').toLowerCase();
  const r = roles || [];
  const isHOD = r.includes('hod'), isCEO = r.includes('ceo') || e === String(CONFIG.CEO_EMAIL).toLowerCase(), isFin = r.includes('finance');
  const myDepts = new Set(deptsForHod(email).map((d) => d.toLowerCase()));
  const myDept = (rec) => { const d = String(rec[COL.DEPT] || ''); const dh = String((CONFIG.DEPARTMENTS[d] || {}).email || '').toLowerCase(); return myDepts.has(d.toLowerCase()) || dh === e || String(rec[COL.HOD] || '').toLowerCase() === e; };
  const all = await readAll();
  const rows = [];

  const lens = (as && ['dept', 'finance', 'mgmt'].includes(as)) ? as : null;
  if (lens) {
    const readOnly = !((lens === 'dept' && isHOD) || (lens === 'finance' && isFin) || (lens === 'mgmt' && isCEO));
    const decCol = { dept: COL.DEPT_DEC, finance: COL.FIN_DEC, mgmt: COL.MGMT_DEC }[lens];
    for (const rec of all) {
      if (lens === 'mgmt' && !mgmtRequired(rec)) continue;
      if (lens === 'dept' && isHOD && !isFin && !myDept(rec)) continue;
      const stage = String(rec[COL.STAGE]);
      const s = rowShape(rec);
      s.pending = !readOnly && stage === lens && !rec[COL.HOLD] && APPROVAL_STAGES.includes(stage);
      s.held = !readOnly && stage === lens && !!rec[COL.HOLD];
      s.canPay = false; s.myStage = lens; s.decision = decStatus(rec[decCol]);
      rows.push(s);
    }
    rows.reverse();
    return { scope: { dept: 'All — Department Head stage', finance: 'All — Finance stage', mgmt: 'All — Management stage' }[lens], rows, readOnly, lens };
  }

  // Action view — only claims this user is involved with.
  const scope = isFin ? 'Finance — Approvals & Payouts' : (isCEO ? 'Sanjay (CEO)' : (deptsForHod(email).join(', ') || 'Department Head'));
  for (const rec of all) {
    const stage = String(rec[COL.STAGE]);
    let involved = false;
    if (isFin) involved = true;
    else if (isHOD && myDept(rec)) involved = true;
    else if (isCEO && mgmtRequired(rec)) involved = true;
    if (!involved) continue;
    const mine = myStageFor(rec, email, roles);
    const held = !!rec[COL.HOLD];
    const s = rowShape(rec);
    s.pending = mine === stage && !held && APPROVAL_STAGES.includes(stage);
    s.canPay = isFin && stage === 'pay';
    s.held = mine === stage && held;
    s.myStage = mine || '';
    s.decision = (isHOD && !isFin && !isCEO) ? decStatus(rec[COL.DEPT_DEC]) : (isCEO && !isFin ? decStatus(rec[COL.MGMT_DEC]) : decStatus(rec[COL.FIN_DEC]));
    rows.push(s);
  }
  rows.reverse();
  return { scope, rows, readOnly: false, lens: null };
}

// Requester self-service — the signed-in user's own claims + where each one is.
export async function myData(email) {
  const e = String(email || '').toLowerCase();
  const all = await readAll();
  const rows = all.filter((r) => String(r[COL.EMAIL] || '').toLowerCase() === e).map((r) => {
    const stage = String(r[COL.STAGE]);
    const mgmt = mgmtRequired(r);
    const s = rowShape(r);
    s.hod = decStatus(r[COL.DEPT_DEC]) || (stage === 'dept' ? 'Pending' : '');
    s.finance = decStatus(r[COL.FIN_DEC]) || (['dept'].includes(stage) ? 'Waiting' : (stage === 'finance' ? 'Pending' : (isAfter(stage, 'finance') ? 'Approved' : 'Waiting')));
    s.mgmtStatus = mgmt ? (decStatus(r[COL.MGMT_DEC]) || (isAfter(stage, 'mgmt') ? 'Approved' : (stage === 'mgmt' ? 'Pending' : 'Waiting'))) : 'N/A';
    s.payStatus = /reimbursed|paid/i.test(String(r[COL.STATUS])) ? 'Paid' : (stage === 'pay' ? 'Pending' : '');
    return s;
  });
  rows.reverse();
  return { rows };
}
const ORDER = ['dept', 'finance', 'mgmt', 'pay', 'done'];
function isAfter(stage, ref) { const a = ORDER.indexOf(stage), b = ORDER.indexOf(ref); return a > -1 && b > -1 && a > b; }

// Finance master tracker
export async function financeData() {
  const all = await readAll();
  const summaries = {};
  const rows = [];
  for (const r of all) {
    const cur = String(r[COL.CURRENCY] || 'INR');
    const net = Number(r[COL.NET] || 0);
    const status = String(r[COL.STATUS] || '');
    const rejected = /reject/i.test(status);
    const paid = /reimbursed|paid/i.test(status);
    if (!summaries[cur]) summaries[cur] = { count: 0, pending: 0, paid: 0, rejected: 0, totalPipeline: 0, totalPaid: 0 };
    const sm = summaries[cur]; sm.count++;
    if (rejected) sm.rejected++; else if (paid) { sm.paid++; sm.totalPaid += Number(r[COL.PAID_AMOUNT] || net); } else sm.pending++;
    if (!rejected && !paid) sm.totalPipeline += net;
    const stage = String(r[COL.STAGE]);
    const mgmt = mgmtRequired(r);
    const s = rowShape(r);
    s.hodStatus = decStatus(r[COL.DEPT_DEC]) || 'Pending';
    s.financeStatus = decStatus(r[COL.FIN_DEC]) || (isAfter(stage, 'finance') ? 'Approved' : 'Pending');
    s.mgmtStatus = mgmt ? (decStatus(r[COL.MGMT_DEC]) || (isAfter(stage, 'mgmt') ? 'Approved' : 'Pending')) : 'N/A';
    s.payStatus = paid ? 'Paid' : (stage === 'pay' ? 'Awaiting payout' : '');
    s.payRef = r[COL.PAY_REF] || ''; s.payDate = fmtDate(r[COL.PAY_DATE]); s.paidAmount = Number(r[COL.PAID_AMOUNT] || 0);
    s.canPay = stage === 'pay';
    s.finalStatus = status;
    s.amountINR = Number(r[COL.AMOUNT_INR] || 0);
    s.held = !!r[COL.HOLD];
    s.tsRaw = r[COL.TS] || '';
    const sinceISO = r[COL.MGMT_TIME] || r[COL.FIN_TIME] || r[COL.DEPT_TIME] || r[COL.TS];
    s.stageSince = sinceISO || '';
    s.ageDays = (APPROVAL_STAGES.includes(stage) && !r[COL.HOLD] && sinceISO)
      ? Math.max(0, Math.floor((Date.now() - Date.parse(sinceISO)) / 86400000)) : null;
    rows.push(s);
  }
  rows.reverse();
  return { currencySummaries: summaries, rows };
}

// ---- reminders ----
const HOUR_MS = 3600000;
export async function sendReminders(baseUrl) {
  const base = String(baseUrl || process.env.APP_BASE_URL || '').replace(/\/$/, '');
  await ensureHeaders();
  const all = await readAll();
  const now = Date.now();
  const sent = [];
  let pending = 0;
  for (const rec of all) {
    const stage = String(rec[COL.STAGE] || '');
    if (!APPROVAL_STAGES.includes(stage) || rec[COL.HOLD]) continue;
    const since = rec[COL.MGMT_TIME] || rec[COL.FIN_TIME] || rec[COL.DEPT_TIME] || rec[COL.TS];
    pending++;
    const waited = now - Date.parse(since);
    if (!(waited >= 24 * HOUR_MS)) continue;
    const last = Date.parse(rec[COL.LAST_REMINDER]);
    if (last && (now - last) < 23 * HOUR_MS) continue;
    const hours = Math.floor(waited / HOUR_MS);
    const to = approverEmailFor(stage, rec);
    const token = rec[COL.TOKEN];
    await sendEmail({ to, subject: `[Reminder] ${rec[COL.ID]} — ${stageLabel(stage)} pending ${hours}h`,
      html: reminderEmailHtml(rec, stageLabel(stage), approverNameFor(stage, rec), actionUrl(base, rec[COL.ID], stage, 'approve', token), actionUrl(base, rec[COL.ID], stage, 'reject', token), hours),
      cc: CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL] ? rec[COL.EMAIL] : undefined });
    await updateCells(rec.__row, [[COL.LAST_REMINDER, new Date(now).toISOString()], [COL.REMINDER_COUNT, Number(rec[COL.REMINDER_COUNT] || 0) + 1]]);
    sent.push({ id: rec[COL.ID], stage, to, hours });
  }
  return { ok: true, scannedPending: pending, sentCount: sent.length, sent };
}

function stamp() { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }
function fmtDate(v) { if (!v) return ''; const d = new Date(v); if (isNaN(d)) return String(v); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
