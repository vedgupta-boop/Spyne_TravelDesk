import { randomUUID } from 'crypto';
import { CONFIG, POLICY, COL, deptsForHod } from './config.js';
import { ensureHeaders, appendRecord, findById, updateCells, readAll } from './sheets.js';
import { sendEmail, approvalEmailHtml, rejectedEmailHtml, reminderEmailHtml, noticeEmailHtml, money } from './email.js';
import { claimBudget, getBudgetLine } from './budget.js';

// Days a request may sit at one approval stage before it's auto-escalated to Finance/CEO.
const SLA_ESCALATE_DAYS = Number(process.env.SLA_ESCALATE_DAYS || 3);

// ---------------------------------------------------------------------------
//  Amount helpers
// ---------------------------------------------------------------------------
export function annualize(amount, frequency) {
  const mult = POLICY.FREQUENCIES[frequency] != null ? POLICY.FREQUENCIES[frequency] : 1;
  return Math.round(Number(amount || 0) * mult);
}
export function toINR(amount, currency) {
  return String(currency) === 'USD' ? Math.round(Number(amount || 0) * POLICY.FX_USD_INR) : Number(amount || 0);
}
export function needsQuotes(amountINR) { return Number(amountINR || 0) >= POLICY.QUOTE_THRESHOLD_INR; }
export function isCapex(nature) { return nature === 'Capex' || nature === 'Asset'; }
// CEO threshold (INR) by nature + recurrence.
export function ceoThreshold(nature, recurring) {
  if (isCapex(nature)) return POLICY.CEO_CAPEX_INR;
  return recurring ? POLICY.CEO_EXPENSE_RECURRING_INR : POLICY.CEO_EXPENSE_ONETIME_INR;
}
// CEO required when the relevant basis exceeds the nature threshold.
// Basis: recurring Expense → annualised INR; otherwise per-transaction INR.
export function needsMgmt(nature, recurring, amountINR, annualINR) {
  const basis = (!isCapex(nature) && recurring) ? Number(annualINR || 0) : Number(amountINR || 0);
  return basis > ceoThreshold(nature, recurring);
}
export function tierLabel(nature, recurring, amountINR, annualINR, outOfBudget) {
  const t = ceoThreshold(nature, recurring).toLocaleString('en-IN');
  const basis = (!isCapex(nature) && recurring) ? 'annualised' : 'amount';
  const hi = needsMgmt(nature, recurring, amountINR, annualINR) || !!outOfBudget;
  const why = outOfBudget && !needsMgmt(nature, recurring, amountINR, annualINR) ? 'out-of-budget' : `${basis} vs ₹${t}`;
  return `${nature}${recurring && !isCapex(nature) ? ' · recurring' : ''}${outOfBudget ? ' · out-of-budget' : ''} — CEO ${hi ? 'required' : 'not required'} (${why})`;
}

// ---- approval chain (the approve/reject part) ----
export function chainFor(mgmt) { return mgmt ? ['dept', 'finance', 'mgmt'] : ['dept', 'finance']; }
// Full lifecycle labels for the form's success timeline (PO/Delivery only for Capex/Asset).
export function chainLabels(mgmt, nature) {
  const proc = isCapex(nature) ? ['PO', 'Delivery'] : [];
  return ['HOD', 'Finance', ...(mgmt ? ['Sanjay (CEO)'] : []), ...proc, 'e-Invoice', 'Payment', 'Paid'];
}
function stageLabel(stage) {
  return {
    dept: 'Department Head', finance: 'Finance', mgmt: 'Sanjay (CEO)',
    payment: 'Payment — Finance', payment_mgmt: 'Payment — Management',
    po: 'PO issuance', delivery: 'Delivery', invoice: 'e-Invoice',
  }[stage] || stage;
}
function mgmtRequired(rec) {
  const nature = String(rec[COL.NATURE] || 'Expense');
  const recurring = String(rec[COL.FREQUENCY] || 'One-time') !== 'One-time';
  const oob = String(rec[COL.BUDGET_TAKEN]) === 'No';
  return needsMgmt(nature, recurring, Number(rec[COL.AMOUNT_INR] || 0), toINR(Number(rec[COL.ANNUAL] || 0), rec[COL.CURRENCY])) || oob;
}
function natureOf(rec) { return String(rec[COL.NATURE] || 'Expense'); }
function approverEmailFor(stage, rec) {
  if (stage === 'dept') return rec[COL.HOD] || CONFIG.FINANCE_SPOC;
  if (stage === 'mgmt' || stage === 'payment_mgmt') return CONFIG.CEO_EMAIL;
  return CONFIG.FINANCE_SPOC; // finance, payment
}
function approverNameFor(stage, rec) {
  if (stage === 'dept') { const d = CONFIG.DEPARTMENTS[String(rec[COL.DEPT] || '')]; return (d && d.head) || 'Department Head'; }
  if (stage === 'mgmt' || stage === 'payment_mgmt') return CONFIG.CEO_NAME;
  return CONFIG.FINANCE_NAME;
}
// Next APPROVAL stage in the request-approval chain, or null after the last approval.
function nextApprovalStage(rec, current) {
  const chain = chainFor(mgmtRequired(rec));
  const i = chain.indexOf(current);
  if (i === -1) return null;
  return (i + 1 < chain.length) ? chain[i + 1] : null;
}
function actionUrl(base, id, stage, decision, token) {
  return `${base}/api/decision?id=${encodeURIComponent(id)}&stage=${stage}&decision=${decision}&token=${token}`;
}
const APPROVAL_STAGES = ['dept', 'finance', 'mgmt', 'payment', 'payment_mgmt'];

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

// Live "where is my request" tracker rendered into requester/FYI emails (body is raw HTML).
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
// Dedicated requester update with the progress tracker.
async function emailRequester(rec, baseUrl, heading, note) {
  if (!rec[COL.EMAIL]) return;
  await sendEmail({ to: rec[COL.EMAIL], subject: `Expense Request ${rec[COL.ID]} — ${heading}`,
    html: noticeEmailHtml(rec, heading, chainProgressHtml(rec, note), (baseUrl || '') + '/my') });
}
// At submit: heads-up to every downstream approver so all concerned approvers have visibility.
async function emailChainFyi(currentStage, rec, baseUrl) {
  const chain = chainFor(mgmtRequired(rec));
  const downstream = chain.slice(chain.indexOf(currentStage) + 1);
  for (const st of downstream) {
    const to = approverEmailFor(st, rec);
    if (!to) continue;
    const note = `Heads-up: this request will reach you for <b>${stageLabel(st)}</b> approval once the earlier approver(s) sign off — no action needed yet.`;
    await sendEmail({ to, subject: `[FYI] ${rec[COL.ID]} — you're next in line for ${stageLabel(st)} approval`,
      html: noticeEmailHtml(rec, 'A request is in the approval pipeline', chainProgressHtml(rec, note), (baseUrl || '') + '/approvals') });
  }
}
// On full approval: confirmation to Finance as the final record-keeper (CC requester).
async function notifyFinanceFinal(rec, baseUrl) {
  await notify(CONFIG.FINANCE_SPOC, `[Approved] Expense Request ${rec[COL.ID]} — fully approved`, rec,
    'Fully approved — over to Finance',
    'All approvers have signed off on this expense request. Recorded with Finance for processing.', (baseUrl || '') + '/finance');
}

// ---- submit ----
export async function submitRequest(p, baseUrl) {
  const missing = [];
  if (!p.name)    missing.push('name');
  if (!p.dept)    missing.push('department');
  if (!p.reqType) missing.push('request type');
  if (!p.item)    missing.push('item / service');
  if (!p.vendor)  missing.push('vendor');
  if (!(Number(p.amount) > 0)) missing.push('amount');
  if (!p.purpose) missing.push('purpose / justification');
  if (p.budgetTaken !== 'Yes' && p.budgetTaken !== 'No') missing.push('budget taken (Yes/No)');
  if (p.budgetTaken === 'No' && !p.oobJustification) missing.push('out-of-budget justification');
  if (missing.length) throw new Error('Missing required field(s): ' + missing.join(', '));

  const currency = String(p.currency) === 'USD' ? 'USD' : 'INR';
  const rate = Number(p.rate) || 0, qty = Number(p.qty) || 0;
  const amount = (rate > 0 && qty > 0) ? Math.round(rate * qty) : Math.round(Number(p.amount) || 0);
  const frequency = POLICY.FREQUENCIES[p.frequency] != null ? p.frequency : 'One-time';
  const recurring = frequency !== 'One-time';
  const annual = annualize(amount, frequency);
  const amountINR = toINR(amount, currency);
  const annualINR = toINR(annual, currency);
  // Nature of spend — Capex/Asset only for CAPEX_DEPTS, else forced to Expense.
  const nature = (POLICY.NATURES.includes(p.nature) && (p.nature === 'Expense' || (POLICY.CAPEX_DEPTS || []).includes(p.dept))) ? p.nature : 'Expense';
  const linked = p.budgetTaken === 'Yes';
  const outOfBudget = p.budgetTaken === 'No';
  const high = needsMgmt(nature, recurring, amountINR, annualINR) || outOfBudget;
  const quotesReq = needsQuotes(amountINR);

  // quotations required at/above threshold: either all 3 docs OR a reason for fewer
  const q = Array.isArray(p.quotations) ? p.quotations.filter(Boolean) : [];
  if (quotesReq) {
    if (p.quotesAvailable === 'Yes' && q.length < 3) throw new Error('Three quotations are required for ₹' + POLICY.QUOTE_THRESHOLD_INR.toLocaleString('en-IN') + '+ — attach all three or select "No" with a reason.');
    if (p.quotesAvailable !== 'Yes' && !p.quotesReason) throw new Error('Enter a reason for providing fewer than three quotations.');
  }

  // Over-budget guard: a budgeted expense must fit the linked line's remaining balance.
  if (linked && p.budgetId && p.lineId) {
    const li = await getBudgetLine(p.budgetId, p.lineId);
    // Compare in the budget's own currency: convert this request into that currency.
    const reqInBudgetCur = (li && li.currency === 'USD') ? Math.round(amountINR / POLICY.FX_USD_INR) : amountINR;
    if (li && reqInBudgetCur > li.remaining) {
      const sym = li.currency === 'USD' ? '$' : '₹';
      throw new Error(`This exceeds the remaining budget on "${li.head}" (remaining ${sym}${Number(li.remaining).toLocaleString('en-IN')}, this request ${sym}${Number(reqInBudgetCur).toLocaleString('en-IN')}). Reduce the amount, pick another line, or mark it out-of-budget.`);
    }
  }

  const deptInfo = CONFIG.DEPARTMENTS[p.dept] || null;
  const hodEmail = (deptInfo && deptInfo.email) || p.hodEmail || CONFIG.FINANCE_SPOC;
  const id = 'EXP-' + stamp() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const token = randomUUID();

  const rec = {
    [COL.ID]: id, [COL.TS]: new Date().toISOString(), [COL.EMAIL]: (p.email || '').trim(),
    [COL.NAME]: p.name, [COL.EMPID]: p.empId || '', [COL.DEPT]: p.dept, [COL.HOD]: hodEmail,
    [COL.REQTYPE]: p.reqType, [COL.CATEGORY]: p.category || '', [COL.ITEM]: p.item, [COL.VENDOR]: p.vendor,
    [COL.CURRENCY]: currency, [COL.AMOUNT]: amount, [COL.FREQUENCY]: frequency, [COL.ANNUAL]: annual, [COL.AMOUNT_INR]: amountINR,
    [COL.NEEDBY]: p.needBy || '', [COL.PURPOSE]: p.purpose || '', [COL.NOTES]: p.notes || '',
    [COL.NATURE]: nature, [COL.TIER]: tierLabel(nature, recurring, amountINR, annualINR, outOfBudget),
    [COL.BUDGET_TAKEN]: linked ? 'Yes' : 'No', [COL.BUDGET_LINE]: linked ? (p.budgetLine || '') : '', [COL.OOB_JUST]: outOfBudget ? (p.oobJustification || '') : '',
    [COL.BUDGET_ID]: linked ? (p.budgetId || '') : '', [COL.BUDGET_LINE_ID]: linked ? (p.lineId || '') : '',
    [COL.VENDOR_GST]: p.vendorGst || '', [COL.VENDOR_PHONE]: p.vendorPhone || '', [COL.VENDOR_EMAIL]: p.vendorEmail || '',
    [COL.RATE]: rate, [COL.QTY]: qty, [COL.EXPENSE_MONTH]: p.expenseMonth || '',
    [COL.TRAVEL_ID]: String(p.travelId || '').trim().toUpperCase(),
    [COL.QUOTES_AVAIL]: quotesReq ? (p.quotesAvailable === 'Yes' ? 'Yes' : 'No') : 'N/A',
    [COL.QUOTE1]: q[0] || '', [COL.QUOTE2]: q[1] || '', [COL.QUOTE3]: q[2] || '',
    [COL.QUOTES_REASON]: quotesReq && p.quotesAvailable !== 'Yes' ? (p.quotesReason || '') : '',
    [COL.DOC_QUOTE]: p.docQuote || '',
    [COL.STATUS]: 'Pending HOD Approval', [COL.STAGE]: 'dept', [COL.TOKEN]: token,
  };

  // Duplicate guard: block a near-identical recent request unless the user overrides (allowDuplicate).
  if (!p.allowDuplicate) {
    try {
      const all = await readAll();
      const vKey = String(p.vendor || '').toLowerCase().trim();
      const iKey = String(p.item || '').toLowerCase().trim();
      const dKey = String(p.dept || '').toLowerCase().trim();
      const now = Date.now();
      const dup = all.find((r) => {
        if (String(r[COL.STAGE]) === 'rejected') return false;
        if (String(r[COL.VENDOR] || '').toLowerCase().trim() !== vKey) return false;
        if (String(r[COL.ITEM] || '').toLowerCase().trim() !== iKey) return false;
        if (String(r[COL.DEPT] || '').toLowerCase().trim() !== dKey) return false;
        if (Number(r[COL.AMOUNT_INR] || 0) !== amountINR) return false;
        const ts = Date.parse(r[COL.TS]); if (ts && (now - ts) > 30 * 86400000) return false;
        return true;
      });
      if (dup) {
        return { ok: false, duplicate: true, dupId: dup[COL.ID], dupBy: String(dup[COL.NAME] || dup[COL.EMAIL] || ''), dupDate: fmtDate(dup[COL.TS]),
          error: `Possible duplicate of ${dup[COL.ID]} — "${String(dup[COL.ITEM] || '')}" from ${String(dup[COL.VENDOR] || '')} (${money(amount, currency)}) raised ${fmtDate(dup[COL.TS])} by ${String(dup[COL.NAME] || dup[COL.EMAIL] || '').split('@')[0]} and still active. Submit anyway only if this is genuinely separate.` };
      }
    } catch (e) { console.error('dup check failed (non-fatal):', e.message || e); }
  }

  await ensureHeaders();
  await appendRecord(rec);
  await emailApprover('dept', rec, baseUrl);                         // action email to the HOD
  await emailChainFyi('dept', rec, baseUrl);                         // FYI to all downstream approvers
  await emailRequester(rec, baseUrl, 'received — pending approvals',  // acknowledgement to the requester
    'Your expense request has been received and is now in the approval workflow. We will email you at every step.');
  return { ok: true, id, currency, amount, annual, nature, quotesReq, mgmt: high, chain: chainLabels(high, nature) };
}

// ---- token decision (email links) ----
export async function handleDecision({ id, stage, decision, token }, baseUrl) {
  if (!id || !stage || !decision || !token) return { title: 'Invalid Link', msg: 'This approval link is missing information.', color: '#b00' };
  const rec = await findById(id);
  if (!rec || String(rec[COL.TOKEN]) !== String(token)) return { title: 'Link Expired / Invalid', msg: 'This approval link is no longer valid.', color: '#b00' };
  if (String(rec[COL.STAGE]) !== stage) return { title: 'Already Processed', msg: `This request is no longer at the "${stageLabel(stage)}" step. Current status: ${rec[COL.STATUS]}.`, color: '#a60' };
  return applyDecision(rec, stage, decision, baseUrl);
}

// Core transition for an APPROVAL stage (dept/finance/mgmt/payment/payment_mgmt).
async function applyDecision(rec, stage, decision, baseUrl, comment) {
  const id = rec[COL.ID];
  const row = rec.__row;
  const now = new Date().toISOString();
  const decCol = { dept: COL.DEPT_DEC, finance: COL.FIN_DEC, mgmt: COL.MGMT_DEC, payment: COL.PAY_FIN_DEC, payment_mgmt: COL.PAY_MGMT_DEC }[stage];
  const timeCol = { dept: COL.DEPT_TIME, finance: COL.FIN_TIME, mgmt: COL.MGMT_TIME }[stage];

  if (decision === 'reject') {
    const upd = [[COL.TOKEN, ''], [COL.STAGE, 'rejected'], [COL.STATUS, 'Rejected at ' + stageLabel(stage)], [decCol, 'Rejected'], [COL.HOLD, '']];
    if (timeCol) upd.push([timeCol, now]);
    await updateCells(row, upd);
    if (rec[COL.EMAIL]) await sendEmail({ to: rec[COL.EMAIL], subject: `Expense Request ${id} — REJECTED`, html: rejectedEmailHtml(rec, stageLabel(stage), comment || '') });
    return { title: 'Rejected', msg: `You have rejected ${id}. The requester has been notified.`, color: '#b00' };
  }
  if (decision !== 'approve') return { title: 'Unknown Action', msg: 'Unrecognized decision.', color: '#b00' };

  const newToken = randomUUID();
  const base = { [decCol]: 'Approved' };

  // ----- request-approval stages: dept → finance → [mgmt] → PO -----
  if (stage === 'dept' || stage === 'finance' || stage === 'mgmt') {
    const next = nextApprovalStage(rec, stage);
    const upd = [[decCol, 'Approved'], [COL.TOKEN, newToken], [COL.HOLD, '']];
    if (timeCol) upd.push([timeCol, now]);
    if (next) {
      upd.push([COL.STAGE, next], [COL.STATUS, 'Pending ' + stageLabel(next) + ' Approval']);
      await updateCells(row, upd);
      const fwd = { ...rec, [decCol]: 'Approved', [COL.TOKEN]: newToken, [COL.STAGE]: next };
      await emailApprover(next, fwd, baseUrl);                       // action email to the next approver
      await emailRequester(fwd, baseUrl, `approved by ${stageLabel(stage)}`,
        `${stageLabel(stage)} approved your request — it's now pending <b>${stageLabel(next)}</b> approval.`);
      return { title: 'Approved → ' + stageLabel(next), msg: `${id} approved. Forwarded to ${stageLabel(next)}.`, color: '#0a0' };
    }
    // last approval done. Claim the linked budget line (both natures), then branch the lifecycle.
    if (rec[COL.BUDGET_ID] && rec[COL.BUDGET_LINE_ID]) {
      await claimBudget(rec[COL.BUDGET_ID], rec[COL.BUDGET_LINE_ID], { vendor: rec[COL.VENDOR], amount: Number(rec[COL.AMOUNT] || 0), currency: rec[COL.CURRENCY] === 'USD' ? 'USD' : 'INR', note: 'Expense ' + id + ' · ' + rec[COL.ITEM], ref: id, by: rec[COL.EMAIL] });
    }
    if (isCapex(natureOf(rec))) {
      // Capex / Asset → procurement: Finance issues a PO.
      upd.push([COL.STAGE, 'po'], [COL.STATUS, 'Approved — Finance to issue PO']);
      await updateCells(row, upd);
      const final = { ...rec, [decCol]: 'Approved', [COL.STAGE]: 'po' };
      await notify(CONFIG.FINANCE_SPOC, `[PO needed] ${id} approved — issue Purchase Order`, rec, 'Approved — issue the Purchase Order', 'This Capex/Asset request is fully approved. Please issue the PO on the Finance dashboard.', (baseUrl || '') + '/finance');
      await emailRequester(final, baseUrl, 'fully approved', 'All approvals are complete. Finance will now issue the PO; you will then confirm delivery and submit the invoice.');
      await notifyFinanceFinal(final, baseUrl);
      return { title: 'Approved → PO', msg: `${id} fully approved. Finance notified to issue the PO.`, color: '#0a0' };
    }
    // Expense → no PO/delivery; requester submits the e-invoice directly, then Finance pays.
    upd.push([COL.STAGE, 'invoice'], [COL.STATUS, 'Approved — submit e-invoice']);
    await updateCells(row, upd);
    const final = { ...rec, [decCol]: 'Approved', [COL.STAGE]: 'invoice' };
    await emailRequester(final, baseUrl, 'fully approved', 'All approvals are complete. Please submit the e-invoice / receipt on “My Requests”; Finance will then release payment.');
    await notifyFinanceFinal(final, baseUrl);
    return { title: 'Approved → e-Invoice', msg: `${id} fully approved. Requester to submit the e-invoice.`, color: '#0a0' };
  }

  // ----- payment approval: Finance, then Management only if it wasn't already approved earlier -----
  if (stage === 'payment') {
    const upd = [[COL.PAY_FIN_DEC, 'Approved'], [COL.TOKEN, newToken], [COL.HOLD, '']];
    if (mgmtRequired(rec)) {
      // Management already signed off during the flow → Finance alone closes it.
      upd.push([COL.STAGE, 'done'], [COL.STATUS, 'Paid & closed'], [COL.PAY_DATE, now]);
      await updateCells(row, upd);
      if (rec[COL.EMAIL]) await notify(rec[COL.EMAIL], `Expense Request ${id} — Paid & closed`, rec, 'Payment released — closed', 'Your expense has been paid and closed against the budget.');
      return { title: 'Payment released', msg: `${id} paid & closed.`, color: '#0a0' };
    }
    // not previously management-approved → route to Management for payment sign-off
    upd.push([COL.STAGE, 'payment_mgmt'], [COL.STATUS, 'Pending Payment — Management Approval']);
    await updateCells(row, upd);
    await emailApprover('payment_mgmt', { ...rec, [COL.TOKEN]: newToken, [COL.STAGE]: 'payment_mgmt' }, baseUrl);
    return { title: 'Approved → Management', msg: `${id} payment approved by Finance. Forwarded to Management.`, color: '#0a0' };
  }
  if (stage === 'payment_mgmt') {
    await updateCells(row, [[COL.PAY_MGMT_DEC, 'Approved'], [COL.TOKEN, ''], [COL.HOLD, ''], [COL.STAGE, 'done'], [COL.STATUS, 'Paid & closed'], [COL.PAY_DATE, now]]);
    if (rec[COL.EMAIL]) await notify(rec[COL.EMAIL], `Expense Request ${id} — Paid & closed`, rec, 'Payment released — closed', 'Your expense has been paid and closed against the budget.');
    return { title: 'Payment released', msg: `${id} paid & closed.`, color: '#0a0' };
  }
  return { title: 'Not an approval step', msg: 'This stage is handled on the dashboard.', color: '#a60' };
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
  if (stage === 'payment' && r.includes('finance')) return 'payment';
  if (stage === 'payment_mgmt' && (r.includes('ceo') || e === String(CONFIG.CEO_EMAIL).toLowerCase())) return 'payment_mgmt';
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
  if (!rec) return { ok: false, error: 'Request not found' };
  const stage = String(rec[COL.STAGE]);
  const mine = myStageFor(rec, email, roles);
  if (mine !== stage) return { ok: false, error: `This request isn't awaiting your approval (current step: ${stageLabel(stage)}).` };
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

// ---- operational lifecycle actions ----
export async function issuePO(id, poNumber, baseUrl) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (String(rec[COL.STAGE]) !== 'po') return { ok: false, error: 'Not awaiting a PO (current: ' + rec[COL.STATUS] + ').' };
  if (!poNumber) return { ok: false, error: 'Enter a PO number.' };
  await updateCells(rec.__row, [[COL.PO_NUMBER, String(poNumber)], [COL.PO_DATE, new Date().toISOString()], [COL.STAGE, 'delivery'], [COL.STATUS, 'PO issued — awaiting delivery']]);
  if (rec[COL.EMAIL]) await notify(rec[COL.EMAIL], `Expense Request ${id} — PO ${poNumber} issued`, rec, 'Purchase Order issued', `PO <b>${esc(poNumber)}</b> has been issued to ${esc(rec[COL.VENDOR])}. Confirm delivery on “My Requests” once received.`, (baseUrl || '') + '/my');
  return { ok: true, id, title: 'PO issued', msg: `PO ${poNumber} issued for ${id}.` };
}
export async function confirmDelivery(id, email) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (String(rec[COL.STAGE]) !== 'delivery') return { ok: false, error: 'Not awaiting delivery (current: ' + rec[COL.STATUS] + ').' };
  await updateCells(rec.__row, [[COL.DELIVERY, 'Delivered'], [COL.DELIVERY_DATE, new Date().toISOString()], [COL.STAGE, 'invoice'], [COL.STATUS, 'Delivered — submit e-invoice']]);
  return { ok: true, id, title: 'Delivery confirmed', msg: `Delivery confirmed for ${id}. Please submit the e-invoice.` };
}
export async function submitInvoice(id, invoiceDoc, baseUrl) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (String(rec[COL.STAGE]) !== 'invoice') return { ok: false, error: 'Not awaiting an invoice (current: ' + rec[COL.STATUS] + ').' };
  const newToken = randomUUID();
  await updateCells(rec.__row, [[COL.INVOICE_DOC, invoiceDoc || ''], [COL.INVOICE_DATE, new Date().toISOString()], [COL.STAGE, 'payment'], [COL.STATUS, 'Invoice submitted — Payment Approval'], [COL.TOKEN, newToken]]);
  await emailApprover('payment', { ...rec, [COL.TOKEN]: newToken, [COL.STAGE]: 'payment' }, baseUrl);
  return { ok: true, id, title: 'Invoice submitted', msg: `e-Invoice submitted for ${id}. Sent to Finance for payment approval.` };
}

// ---- dashboard data ----
function decStatus(v) { if (!v) return ''; if (/reject/i.test(v)) return 'Rejected'; if (/approv/i.test(v)) return 'Approved'; return String(v); }
function detailOf(r) {
  const cur = String(r[COL.CURRENCY] || 'INR');
  return {
    reqType: r[COL.REQTYPE] || '', category: r[COL.CATEGORY] || '', item: r[COL.ITEM] || '', vendor: r[COL.VENDOR] || '',
    currency: cur, amount: Number(r[COL.AMOUNT] || 0), frequency: r[COL.FREQUENCY] || 'One-time', annual: Number(r[COL.ANNUAL] || 0),
    needBy: fmtDate(r[COL.NEEDBY]), purpose: r[COL.PURPOSE] || '', notes: r[COL.NOTES] || '', tier: r[COL.TIER] || '',
    nature: r[COL.NATURE] || 'Expense',
    vendorGst: r[COL.VENDOR_GST] || '', vendorPhone: r[COL.VENDOR_PHONE] || '', vendorEmail: r[COL.VENDOR_EMAIL] || '',
    rate: Number(r[COL.RATE] || 0), qty: Number(r[COL.QTY] || 0), expenseMonth: r[COL.EXPENSE_MONTH] || '',
    travelId: r[COL.TRAVEL_ID] || '',
    budgetTaken: r[COL.BUDGET_TAKEN] || '', budgetLine: r[COL.BUDGET_LINE] || '', oob: r[COL.OOB_JUST] || '',
    quotesAvail: r[COL.QUOTES_AVAIL] || '', quotes: [r[COL.QUOTE1], r[COL.QUOTE2], r[COL.QUOTE3]].filter(Boolean), quotesReason: r[COL.QUOTES_REASON] || '',
    doc: r[COL.DOC_QUOTE] || '', poNumber: r[COL.PO_NUMBER] || '', poDate: fmtDate(r[COL.PO_DATE]),
    delivery: r[COL.DELIVERY] || '', deliveryDate: fmtDate(r[COL.DELIVERY_DATE]),
    invoiceDoc: r[COL.INVOICE_DOC] || '', invoiceDate: fmtDate(r[COL.INVOICE_DATE]),
  };
}
function rowShape(rec) {
  const cur = String(rec[COL.CURRENCY] || 'INR');
  const amount = Number(rec[COL.AMOUNT] || 0);
  return {
    id: rec[COL.ID], name: rec[COL.NAME], email: rec[COL.EMAIL], dept: rec[COL.DEPT],
    reqType: rec[COL.REQTYPE], category: rec[COL.CATEGORY], item: rec[COL.ITEM], vendor: rec[COL.VENDOR],
    purpose: rec[COL.PURPOSE], currency: cur, amount, frequency: rec[COL.FREQUENCY] || 'One-time',
    amountLabel: money(amount, cur), tier: rec[COL.TIER] || '', nature: natureOf(rec), capex: isCapex(natureOf(rec)),
    mgmt: mgmtRequired(rec), quotesReq: needsQuotes(Number(rec[COL.AMOUNT_INR] || 0)), budgeted: String(rec[COL.BUDGET_TAKEN]) === 'Yes',
    needBy: fmtDate(rec[COL.NEEDBY]), submission: fmtDate(rec[COL.TS]), detail: detailOf(rec),
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
      s.canPO = false; s.myStage = lens; s.decision = decStatus(rec[decCol]);
      rows.push(s);
    }
    rows.reverse();
    return { scope: { dept: 'All — Department Head stage', finance: 'All — Finance stage', mgmt: 'All — Management stage' }[lens], rows, readOnly, lens };
  }

  // Action view — only requests this user is involved with.
  const scope = isFin ? 'Finance — Approvals, PO & Payments' : (isCEO ? 'Sanjay (CEO)' : (deptsForHod(email).join(', ') || 'Department Head'));
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
    s.canPO = isFin && stage === 'po';
    s.held = mine === stage && held;
    s.myStage = mine || '';
    s.decision = (isHOD && !isFin && !isCEO) ? decStatus(rec[COL.DEPT_DEC]) : (isCEO && !isFin ? decStatus(rec[COL.MGMT_DEC]) : decStatus(rec[COL.FIN_DEC]));
    rows.push(s);
  }
  rows.reverse();
  return { scope, rows, readOnly: false, lens: null };
}

// Requester self-service
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
    s.po = r[COL.PO_NUMBER] ? ('PO ' + r[COL.PO_NUMBER]) : (stage === 'po' ? 'Pending' : (isAfter(stage, 'po') ? 'Issued' : ''));
    s.deliveryStatus = r[COL.DELIVERY] || (stage === 'delivery' ? 'Awaiting' : (isAfter(stage, 'delivery') ? 'Delivered' : ''));
    s.invoiceStatus = r[COL.INVOICE_DOC] ? 'Submitted' : (stage === 'invoice' ? 'Awaiting' : (isAfter(stage, 'invoice') ? 'Submitted' : ''));
    s.payStatus = /paid/i.test(String(r[COL.STATUS])) ? 'Paid' : (['payment', 'payment_mgmt'].includes(stage) ? 'Pending' : '');
    s.canConfirmDelivery = stage === 'delivery';
    s.canSubmitInvoice = stage === 'invoice';
    return s;
  });
  rows.reverse();
  return { rows };
}
const ORDER = ['dept', 'finance', 'mgmt', 'po', 'delivery', 'invoice', 'payment', 'payment_mgmt', 'done'];
function isAfter(stage, ref) { const a = ORDER.indexOf(stage), b = ORDER.indexOf(ref); return a > -1 && b > -1 && a > b; }

// Vendor directory — known vendors + last-seen GST / phone / email (for form auto-fill).
export async function vendorDirectory() {
  const all = await readAll();
  const map = {};
  for (const r of all) {
    const v = String(r[COL.VENDOR] || '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    const e = map[k] || { vendor: v, gst: '', phone: '', email: '' };
    if (r[COL.VENDOR_GST]) e.gst = r[COL.VENDOR_GST];
    if (r[COL.VENDOR_PHONE]) e.phone = r[COL.VENDOR_PHONE];
    if (r[COL.VENDOR_EMAIL]) e.email = r[COL.VENDOR_EMAIL];
    map[k] = e;
  }
  return Object.values(map).sort((a, b) => a.vendor.localeCompare(b.vendor));
}

// Finance master tracker
export async function financeData() {
  const all = await readAll();
  const summaries = {};
  const rows = [];
  for (const r of all) {
    const cur = String(r[COL.CURRENCY] || 'INR');
    const amount = Number(r[COL.AMOUNT] || 0);
    const status = String(r[COL.STATUS] || '');
    const rejected = /reject/i.test(status);
    const paid = /paid/i.test(status);
    if (!summaries[cur]) summaries[cur] = { count: 0, pending: 0, paid: 0, rejected: 0, totalPipeline: 0, totalPaid: 0 };
    const sm = summaries[cur]; sm.count++;
    if (rejected) sm.rejected++; else if (paid) { sm.paid++; sm.totalPaid += amount; } else sm.pending++;
    if (!rejected) sm.totalPipeline += amount;
    const stage = String(r[COL.STAGE]);
    const mgmt = mgmtRequired(r);
    const s = rowShape(r);
    s.hodStatus = decStatus(r[COL.DEPT_DEC]) || 'Pending';
    s.financeStatus = decStatus(r[COL.FIN_DEC]) || (isAfter(stage, 'finance') ? 'Approved' : 'Pending');
    s.mgmtStatus = mgmt ? (decStatus(r[COL.MGMT_DEC]) || (isAfter(stage, 'mgmt') ? 'Approved' : 'Pending')) : 'N/A';
    s.poNumber = r[COL.PO_NUMBER] || ''; s.poDate = fmtDate(r[COL.PO_DATE]);
    s.deliveryStatus = r[COL.DELIVERY] || ''; s.invoiceStatus = r[COL.INVOICE_DOC] ? 'Submitted' : '';
    s.payStatus = paid ? 'Paid' : (['payment', 'payment_mgmt'].includes(stage) ? 'Pending' : (decStatus(r[COL.PAY_FIN_DEC]) || ''));
    s.canPO = stage === 'po';
    s.finalStatus = status;
    // Extra fields for the dashboard analytics / aging / dedup.
    s.amountINR = Number(r[COL.AMOUNT_INR] || 0);
    s.outOfBudget = String(r[COL.BUDGET_TAKEN]) === 'No';
    s.held = !!r[COL.HOLD];
    s.tsRaw = r[COL.TS] || '';
    s.deptTimeRaw = r[COL.DEPT_TIME] || ''; s.finTimeRaw = r[COL.FIN_TIME] || ''; s.mgmtTimeRaw = r[COL.MGMT_TIME] || '';
    const sinceISO = r[COL.MGMT_TIME] || r[COL.FIN_TIME] || r[COL.DEPT_TIME] || r[COL.TS];
    s.stageSince = sinceISO || '';
    s.ageDays = (APPROVAL_STAGES.includes(stage) && !r[COL.HOLD] && sinceISO)
      ? Math.max(0, Math.floor((Date.now() - Date.parse(sinceISO)) / 86400000)) : null;
    s.escalated = s.ageDays != null && s.ageDays >= SLA_ESCALATE_DAYS;
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
    // SLA escalation: once a request is overdue past the threshold, notify Finance (+CEO) one time.
    const days = Math.floor(waited / (24 * HOUR_MS));
    if (days >= SLA_ESCALATE_DAYS && !/Auto-escalation/i.test(String(rec[COL.COMMENTS] || ''))) {
      const escTo = [CONFIG.FINANCE_SPOC]; if (mgmtRequired(rec)) escTo.push(CONFIG.CEO_EMAIL);
      await sendEmail({ to: escTo, subject: `[ESCALATION] ${rec[COL.ID]} — ${days} days at ${stageLabel(stage)}`,
        html: noticeEmailHtml(rec, `Overdue ${days} days at ${stageLabel(stage)}`, `This request has been awaiting <b>${stageLabel(stage)}</b> approval for ${days} days and is past the ${SLA_ESCALATE_DAYS}-day SLA. Please follow up with the approver.`, base + '/approvals'),
        cc: rec[COL.EMAIL] || undefined });
      const note = `[Auto-escalation · system · ${fmtDate(new Date(now).toISOString())}] Overdue ${days}d at ${stageLabel(stage)} — escalated to Finance${mgmtRequired(rec) ? '/CEO' : ''}.`;
      await updateCells(rec.__row, [[COL.COMMENTS, rec[COL.COMMENTS] ? rec[COL.COMMENTS] + '\n' + note : note]]);
    }
  }
  return { ok: true, scannedPending: pending, sentCount: sent.length, sent };
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function stamp() { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }
function fmtDate(v) { if (!v) return ''; const d = new Date(v); if (isNaN(d)) return String(v); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
