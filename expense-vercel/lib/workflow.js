import { randomUUID } from 'crypto';
import { CONFIG, POLICY, COL, AUTH, deptsForHod, delegatePrincipals, delegatesOf, normalizeVendor, vendorKey, w9Required } from './config.js';
import { ensureHeaders, appendRecord, findById, updateCells, readAll } from './sheets.js';
import { sendEmail, approvalEmailHtml, rejectedEmailHtml, reminderEmailHtml, noticeEmailHtml, digestEmailHtml, money } from './email.js';
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
    po: 'PO issuance', delivery: 'Delivery', invoice: 'e-Invoice', paying: 'Disbursement',
    amend: 'Amendment', withdrawn: 'Withdrawn',
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
  const cc = delegatesOf(String(to || '').toLowerCase());
  await sendEmail({ to, subject: `[Action Needed] ${id} — ${stageLabel(stage)} approval`, html, cc: cc.length ? cc : undefined });
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
  const vendor = normalizeVendor(p.vendor); // canonical display (trim + collapse whitespace)
  // US vendor compliance: a W-9 is required unless the entity is a Corporation.
  const vendorCountry = String(p.vendorCountry || 'India');
  const vendorEntity = String(p.vendorEntity || '');
  if (w9Required(vendorCountry, vendorEntity) && !p.w9Doc) {
    throw new Error('A W-9 form is required for this US vendor (only Corporations are exempt). Attach the W-9 to proceed.');
  }
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
    [COL.REQTYPE]: p.reqType, [COL.CATEGORY]: p.category || '', [COL.ITEM]: p.item, [COL.VENDOR]: vendor,
    [COL.CURRENCY]: currency, [COL.AMOUNT]: amount, [COL.FREQUENCY]: frequency, [COL.ANNUAL]: annual, [COL.AMOUNT_INR]: amountINR,
    [COL.NEEDBY]: p.needBy || '', [COL.PURPOSE]: p.purpose || '', [COL.NOTES]: p.notes || '',
    [COL.NATURE]: nature, [COL.TIER]: tierLabel(nature, recurring, amountINR, annualINR, outOfBudget),
    [COL.BUDGET_TAKEN]: linked ? 'Yes' : 'No', [COL.BUDGET_LINE]: linked ? (p.budgetLine || '') : '', [COL.OOB_JUST]: outOfBudget ? (p.oobJustification || '') : '',
    [COL.BUDGET_ID]: linked ? (p.budgetId || '') : '', [COL.BUDGET_LINE_ID]: linked ? (p.lineId || '') : '',
    [COL.VENDOR_GST]: p.vendorGst || '', [COL.VENDOR_PHONE]: p.vendorPhone || '', [COL.VENDOR_EMAIL]: p.vendorEmail || '',
    [COL.VENDOR_COUNTRY]: vendorCountry, [COL.VENDOR_ENTITY]: vendorEntity, [COL.W9_DOC]: p.w9Doc || '',
    [COL.RATE]: rate, [COL.QTY]: qty, [COL.EXPENSE_MONTH]: p.expenseMonth || '',
    [COL.TRAVEL_ID]: String(p.travelId || '').trim().toUpperCase(),
    [COL.QUOTES_AVAIL]: quotesReq ? (p.quotesAvailable === 'Yes' ? 'Yes' : 'No') : 'N/A',
    [COL.QUOTE1]: q[0] || '', [COL.QUOTE2]: q[1] || '', [COL.QUOTE3]: q[2] || '',
    [COL.QUOTES_REASON]: quotesReq && p.quotesAvailable !== 'Yes' ? (p.quotesReason || '') : '',
    [COL.DOC_QUOTE]: p.docQuote || '',
    [COL.STATUS]: 'Pending HOD Approval', [COL.STAGE]: 'dept', [COL.TOKEN]: token,
  };

  // Duplicate guard: block a near-identical recent request unless the user overrides (allowDuplicate).
  if (!p.allowDuplicate && !p.editId) {
    try {
      const all = await readAll();
      const vKey = vendorKey(p.vendor);
      const iKey = String(p.item || '').toLowerCase().trim();
      const dKey = String(p.dept || '').toLowerCase().trim();
      const now = Date.now();
      const dup = all.find((r) => {
        if (String(r[COL.STAGE]) === 'rejected') return false;
        if (vendorKey(r[COL.VENDOR]) !== vKey) return false;
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

  // Edit & resubmit: an amended/recalled request keeps its ID, is updated in place,
  // and re-enters the chain at Department Head. Only the owner may do this.
  if (p.editId) {
    const existing = await findById(p.editId);
    if (!existing) return { ok: false, error: 'Original request not found.' };
    if (String(existing[COL.EMAIL] || '').toLowerCase() !== String(p.email || '').toLowerCase()) return { ok: false, error: 'Only the requester can amend this request.' };
    const upd = [];
    Object.keys(rec).forEach((k) => { if (k !== COL.ID && k !== COL.TS && k !== COL.EMAIL) upd.push([k, rec[k]]); });
    // reset all prior decisions / lifecycle so it starts a fresh approval pass
    [COL.DEPT_DEC, COL.FIN_DEC, COL.MGMT_DEC, COL.DEPT_TIME, COL.FIN_TIME, COL.MGMT_TIME,
      COL.PO_NUMBER, COL.PO_DATE, COL.DELIVERY, COL.DELIVERY_DATE, COL.INVOICE_DOC, COL.INVOICE_DATE,
      COL.PAY_FIN_DEC, COL.PAY_MGMT_DEC, COL.HOLD, COL.LAST_REMINDER, COL.REMINDER_COUNT].forEach((c) => { if (c) upd.push([c, '']); });
    upd.push([COL.STAGE, 'dept'], [COL.STATUS, 'Pending HOD Approval'], [COL.TOKEN, token]);
    await updateCells(existing.__row, upd);
    const fresh = { ...existing, ...rec, [COL.ID]: p.editId, [COL.STAGE]: 'dept', [COL.TOKEN]: token };
    await emailApprover('dept', fresh, baseUrl);
    await emailRequester(fresh, baseUrl, 'resubmitted — pending approvals',
      'Your amended request has been resubmitted and is back in the approval workflow.');
    return { ok: true, id: p.editId, edited: true, currency, amount, annual, nature, quotesReq, mgmt: high, chain: chainLabels(high, nature) };
  }

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
  if (decision === 'sendback') {
    // Approver returns the request to the requester to amend & resubmit (not a rejection).
    await updateCells(row, [[COL.TOKEN, ''], [COL.STAGE, 'amend'], [COL.STATUS, 'Sent back for amendment (by ' + stageLabel(stage) + ')'], [COL.HOLD, '']]);
    if (rec[COL.EMAIL]) await sendEmail({ to: rec[COL.EMAIL], subject: `Expense Request ${id} — sent back for amendment`,
      html: noticeEmailHtml(rec, 'Sent back for amendment', `${stageLabel(stage)} sent your request back for changes${comment ? ': ' + esc(comment) : ''}. Open “My Requests” to edit and resubmit.`, (baseUrl || '') + '/my') });
    return { title: 'Sent back', msg: `${id} sent back to the requester for amendment.`, color: '#a60' };
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
      // Management already signed off during the flow → payment approved → Finance disburses.
      upd.push([COL.STAGE, 'paying'], [COL.STATUS, 'Approved for payment — awaiting disbursement']);
      await updateCells(row, upd);
      if (rec[COL.EMAIL]) await emailRequester({ ...rec, [COL.STAGE]: 'paying' }, baseUrl, 'approved for payment', 'Your expense is approved for payment. Finance will now release the disbursement (possibly in instalments).');
      return { title: 'Approved for payment', msg: `${id} approved — Finance to disburse.`, color: '#0a0' };
    }
    // not previously management-approved → route to Management for payment sign-off
    upd.push([COL.STAGE, 'payment_mgmt'], [COL.STATUS, 'Pending Payment — Management Approval']);
    await updateCells(row, upd);
    await emailApprover('payment_mgmt', { ...rec, [COL.TOKEN]: newToken, [COL.STAGE]: 'payment_mgmt' }, baseUrl);
    return { title: 'Approved → Management', msg: `${id} payment approved by Finance. Forwarded to Management.`, color: '#0a0' };
  }
  if (stage === 'payment_mgmt') {
    await updateCells(row, [[COL.PAY_MGMT_DEC, 'Approved'], [COL.TOKEN, ''], [COL.HOLD, ''], [COL.STAGE, 'paying'], [COL.STATUS, 'Approved for payment — awaiting disbursement']]);
    if (rec[COL.EMAIL]) await emailRequester({ ...rec, [COL.STAGE]: 'paying' }, baseUrl, 'approved for payment', 'Your expense is approved for payment. Finance will now release the disbursement (possibly in instalments).');
    return { title: 'Approved for payment', msg: `${id} approved — Finance to disburse.`, color: '#0a0' };
  }
  return { title: 'Not an approval step', msg: 'This stage is handled on the dashboard.', color: '#a60' };
}

// ---- authenticated approver decision (dashboard) ----
function myStageFor(rec, email, roles) {
  const e = String(email || '').toLowerCase();
  const r = roles || [];
  const dept = String(rec[COL.DEPT] || '');
  const deptHead = String((CONFIG.DEPARTMENTS[dept] || {}).email || '').toLowerCase();
  const recHod = String(rec[COL.HOD] || '').toLowerCase();
  const ceo = String(CONFIG.CEO_EMAIL).toLowerCase();
  const finEmails = (AUTH.FINANCE_EMAILS || []).map((x) => String(x).toLowerCase());
  const stage = String(rec[COL.STAGE]);
  // Delegation: principal approver emails this user may currently act on behalf of.
  const principals = delegatePrincipals(e);
  const actsForDept = (deptHead && principals.includes(deptHead)) || (recHod && principals.includes(recHod));
  const actsForFin = principals.some((p) => finEmails.includes(p));
  const actsForCeo = principals.includes(ceo);
  if (stage === 'dept' && ((r.includes('hod') && (deptHead === e || recHod === e)) || actsForDept)) return 'dept';
  if (stage === 'finance' && (r.includes('finance') || actsForFin)) return 'finance';
  if (stage === 'mgmt' && (r.includes('ceo') || e === ceo || actsForCeo)) return 'mgmt';
  if (stage === 'payment' && (r.includes('finance') || actsForFin)) return 'payment';
  if (stage === 'payment_mgmt' && (r.includes('ceo') || e === ceo || actsForCeo)) return 'payment_mgmt';
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
  const isFinance = (roles || []).includes('finance');
  const financeOverride = isFinance && APPROVAL_STAGES.includes(stage);
  if (mine !== stage && !financeOverride) return { ok: false, error: `This request isn't awaiting your approval (current step: ${stageLabel(stage)}).` };
  const who = String(email || '').split('@')[0];
  if (decision === 'hold') {
    await updateCells(rec.__row, [[COL.HOLD, 'On Hold'], [COL.STATUS, 'On Hold — ' + stageLabel(stage)], [COL.COMMENTS, appendComment(rec, stage, who, comment || 'Put on hold')]]);
    return { ok: true, id, title: 'On Hold', msg: `${id} placed on hold.` };
  }
  if (decision === 'sendback' && !comment) return { ok: false, error: 'Add a reason for sending it back for amendment.' };
  if (decision !== 'approve' && decision !== 'reject' && decision !== 'sendback') return { ok: false, error: 'Unknown decision' };
  const merged = { ...rec, [COL.COMMENTS]: appendComment(rec, stage, who, comment) };
  if (comment) await updateCells(rec.__row, [[COL.COMMENTS, merged[COL.COMMENTS]]]);
  const r = await applyDecision(merged, stage, decision, baseUrl, comment);
  return { ok: true, id, title: r.title, msg: r.msg };
}

// ---- requester self-service: recall (pull back to fix) / withdraw (cancel) ----
export async function recallRequest(id, email) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (String(rec[COL.EMAIL] || '').toLowerCase() !== String(email || '').toLowerCase()) return { ok: false, error: 'Only the requester can recall this request.' };
  const stage = String(rec[COL.STAGE]);
  if (!['dept', 'finance', 'mgmt'].includes(stage)) return { ok: false, error: 'Only a request still in approval can be recalled.' };
  await updateCells(rec.__row, [[COL.TOKEN, ''], [COL.STAGE, 'amend'], [COL.STATUS, 'Recalled by requester — edit & resubmit'], [COL.HOLD, '']]);
  return { ok: true, id, title: 'Recalled', msg: `${id} recalled — edit & resubmit it from My Requests.` };
}
export async function withdrawRequest(id, email) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (String(rec[COL.EMAIL] || '').toLowerCase() !== String(email || '').toLowerCase()) return { ok: false, error: 'Only the requester can withdraw this request.' };
  const stage = String(rec[COL.STAGE]);
  if (['done', 'rejected', 'withdrawn'].includes(stage) || /paid/i.test(String(rec[COL.STATUS] || ''))) return { ok: false, error: 'This request can no longer be withdrawn.' };
  await updateCells(rec.__row, [[COL.TOKEN, ''], [COL.STAGE, 'withdrawn'], [COL.STATUS, 'Withdrawn by requester'], [COL.HOLD, '']]);
  return { ok: true, id, title: 'Withdrawn', msg: `${id} has been withdrawn.` };
}

// The approval stage an approver personally holds on a record (dept for its HOD, finance, mgmt for CEO).
function ownedStage(rec, email, roles) {
  const e = String(email || '').toLowerCase(); const r = roles || [];
  const dept = String(rec[COL.DEPT] || ''); const dh = String((CONFIG.DEPARTMENTS[dept] || {}).email || '').toLowerCase();
  if ((r.includes('ceo') || e === String(CONFIG.CEO_EMAIL).toLowerCase()) && decStatus(rec[COL.MGMT_DEC]) === 'Approved') return 'mgmt';
  if (r.includes('finance') && decStatus(rec[COL.FIN_DEC]) === 'Approved') return 'finance';
  if (r.includes('hod') && (dh === e || String(rec[COL.HOD] || '').toLowerCase() === e) && decStatus(rec[COL.DEPT_DEC]) === 'Approved') return 'dept';
  return null;
}
// True when this approver approved the record and it has since moved past their stage (and isn't final).
export function canRecallApproval(rec, email, roles) {
  const stage = String(rec[COL.STAGE]);
  if (['rejected', 'withdrawn', 'scrapped', 'amend'].includes(stage) || /paid/i.test(String(rec[COL.STATUS] || ''))) return false;
  const stg = ownedStage(rec, email, roles);
  return !!stg && isAfter(stage, stg);
}
// Approver pulls back their own approval → the request returns to their stage for re-review.
// Clears their decision + every downstream decision & lifecycle field so the pass restarts cleanly.
export async function recallApproval({ id, email, roles }, baseUrl) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  const stg = ownedStage(rec, email, roles);
  if (!stg) return { ok: false, error: 'You have no approval to recall on this request.' };
  const cur = String(rec[COL.STAGE]);
  if (['rejected', 'withdrawn', 'scrapped', 'amend'].includes(cur) || /paid/i.test(String(rec[COL.STATUS] || ''))) return { ok: false, error: 'This request can no longer be recalled.' };
  if (!isAfter(cur, stg)) return { ok: false, error: 'It is already awaiting your action — nothing to recall.' };
  const token = randomUUID();
  const rank = { dept: 0, finance: 1, mgmt: 2 }[stg];
  const upd = [[COL.TOKEN, token], [COL.HOLD, ''], [COL.STAGE, stg], [COL.STATUS, 'Pending ' + stageLabel(stg) + ' Approval (recalled)']];
  if (rank <= 0) upd.push([COL.DEPT_DEC, ''], [COL.DEPT_TIME, '']);
  if (rank <= 1) upd.push([COL.FIN_DEC, ''], [COL.FIN_TIME, '']);
  if (rank <= 2) upd.push([COL.MGMT_DEC, ''], [COL.MGMT_TIME, '']);
  upd.push([COL.PO_NUMBER, ''], [COL.PO_DATE, ''], [COL.DELIVERY, ''], [COL.DELIVERY_DATE, ''], [COL.INVOICE_DOC, ''], [COL.INVOICE_DATE, ''], [COL.PAY_FIN_DEC, ''], [COL.PAY_MGMT_DEC, '']);
  await updateCells(rec.__row, upd);
  const fresh = { ...rec, [COL.STAGE]: stg, [COL.TOKEN]: token };
  await emailApprover(stg, fresh, baseUrl);
  if (rec[COL.EMAIL]) await emailRequester(fresh, baseUrl, 'approval recalled', `${stageLabel(stg)} recalled their approval to review ${id} again.`);
  return { ok: true, id, title: 'Approval recalled', msg: `${id} pulled back to ${stageLabel(stg)} for re-review.` };
}

// ---- admin: soft-delete (scrap) test/junk requests by ID (reversible in the sheet) ----
export async function scrapRequests(ids) {
  const list = (Array.isArray(ids) ? ids : []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: 'No IDs given' };
  await ensureHeaders();
  const all = await readAll();
  const byId = {}; all.forEach((r) => { byId[String(r[COL.ID])] = r; });
  let scrapped = 0; const notFound = [];
  for (const id of list) {
    const rec = byId[id];
    if (!rec) { notFound.push(id); continue; }
    await updateCells(rec.__row, [[COL.STAGE, 'scrapped'], [COL.STATUS, 'Scrapped'], [COL.TOKEN, '']]);
    scrapped++;
  }
  return { ok: true, scrapped, notFound };
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
export async function submitInvoice(id, payload, baseUrl) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (String(rec[COL.STAGE]) !== 'invoice') return { ok: false, error: 'Not awaiting an invoice (current: ' + rec[COL.STATUS] + ').' };
  // Back-compat: payload may be a bare doc URL (string) or an object with the full invoice detail.
  const p = (payload && typeof payload === 'object') ? payload : { invoiceDoc: payload };
  const docs = Array.isArray(p.invoiceDocs) ? p.invoiceDocs.filter(Boolean) : (p.invoiceDoc ? [p.invoiceDoc] : []);
  const primary = docs[0] || '';
  const region = String(p.region || 'India') === 'US' ? 'US' : 'India';
  const base = Math.max(0, Math.round(Number(p.baseAmount) || 0));
  const tax = Math.max(0, Math.round(Number(p.taxAmount) || 0));
  let total = Math.max(0, Math.round(Number(p.totalAmount) || 0));
  if (!total && (base || tax)) total = base + tax; // derive total if not supplied
  // Reconciliation guard: base + tax must equal total (allow ₹1 rounding).
  if (base && total && Math.abs((base + tax) - total) > 1) {
    return { ok: false, error: `Invoice doesn't add up: base ${money(base, rec[COL.CURRENCY])} + tax ${money(tax, rec[COL.CURRENCY])} ≠ total ${money(total, rec[COL.CURRENCY])}.` };
  }
  const taxId = String(p.gstNumber || p.taxId || '').trim().toUpperCase();
  const newToken = randomUUID();
  await updateCells(rec.__row, [
    [COL.INVOICE_DOC, primary], [COL.INVOICE_DOCS, JSON.stringify(docs)],
    [COL.INVOICE_REGION, region], [COL.INVOICE_BASE, base || ''], [COL.INVOICE_GST, tax || ''], [COL.INVOICE_TOTAL, total || ''], [COL.INVOICE_GSTIN, taxId],
    [COL.INVOICE_NUMBER, String(p.invoiceNumber || '').trim()], [COL.INVOICE_VDATE, p.invoiceDate ? new Date(p.invoiceDate).toISOString() : ''], [COL.INVOICE_CATEGORY, String(p.category || '').trim()],
    [COL.INVOICE_DATE, new Date().toISOString()], [COL.STAGE, 'payment'], [COL.STATUS, 'Invoice submitted — Payment Approval'], [COL.TOKEN, newToken],
  ]);
  await emailApprover('payment', { ...rec, [COL.TOKEN]: newToken, [COL.STAGE]: 'payment' }, baseUrl);
  return { ok: true, id, title: 'Invoice submitted', msg: `e-Invoice submitted for ${id}${docs.length > 1 ? ' (' + docs.length + ' files)' : ''}. Sent to Finance for payment approval.` };
}

// ---- partial payments (Point 6) ----
// After payment approval the request sits at stage 'paying'; Finance records one or more
// disbursements. When cumulative paid ≥ the request amount, it auto-closes to 'done'.
export async function recordPayment({ id, amount, date, ref, mode, doc, email, roles }, baseUrl) {
  if (!(roles || []).includes('finance')) return { ok: false, error: 'Only Finance can record a payment.' };
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  const stage = String(rec[COL.STAGE]);
  if (stage !== 'paying') return { ok: false, error: `Not awaiting disbursement (current: ${stageLabel(stage)}). Payment must be approved first.` };
  const total = Number(rec[COL.AMOUNT] || 0);
  const cur = rec[COL.CURRENCY] || 'INR';
  const payments = (() => { try { const v = JSON.parse(rec[COL.PAYMENTS] || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })();
  const paidSoFar = payments.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const remaining = Math.max(0, total - paidSoFar);
  let amt = Math.round(Number(amount) || 0);
  if (!(amt > 0)) amt = remaining; // blank amount = pay the full remaining balance
  if (amt > remaining + 0.5) return { ok: false, error: `Only ${money(remaining, cur)} is unpaid on this request (total ${money(total, cur)}, already paid ${money(paidSoFar, cur)}).` };
  const when = date ? new Date(date).toISOString() : new Date().toISOString();
  payments.push({ amount: amt, date: when, ref: String(ref || '').trim(), mode: String(mode || '').trim(), doc: String(doc || '').trim(), by: String(email || '').split('@')[0] });
  const paidNow = paidSoFar + amt;
  const fullyPaid = paidNow >= total - 0.5;
  const upd = [[COL.PAYMENTS, JSON.stringify(payments)]];
  if (fullyPaid) upd.push([COL.STAGE, 'done'], [COL.STATUS, 'Paid & closed'], [COL.PAY_DATE, when], [COL.TOKEN, '']);
  else upd.push([COL.STATUS, `Partially paid — ${money(paidNow, cur)} of ${money(total, cur)}`]);
  await updateCells(rec.__row, upd);
  if (rec[COL.EMAIL]) {
    if (fullyPaid) await notify(rec[COL.EMAIL], `Expense Request ${id} — Paid & closed`, rec, 'Payment released — closed', `Your expense has been fully paid (${money(total, cur)}) and closed against the budget.`);
    else await notify(rec[COL.EMAIL], `Expense Request ${id} — part payment of ${money(amt, cur)}`, rec, 'Part payment released', `A payment of <b>${money(amt, cur)}</b> was released. Paid so far: ${money(paidNow, cur)} of ${money(total, cur)} (balance ${money(total - paidNow, cur)}).`);
  }
  return { ok: true, id, fullyPaid, paid: paidNow, total, remaining: total - paidNow, title: fullyPaid ? 'Paid & closed' : 'Part payment recorded', msg: fullyPaid ? `${id} fully paid & closed.` : `${money(amt, cur)} recorded — ${money(total - paidNow, cur)} balance remaining.` };
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
    vendorCountry: r[COL.VENDOR_COUNTRY] || '', vendorEntity: r[COL.VENDOR_ENTITY] || '', w9Doc: r[COL.W9_DOC] || '',
    rate: Number(r[COL.RATE] || 0), qty: Number(r[COL.QTY] || 0), expenseMonth: r[COL.EXPENSE_MONTH] || '',
    travelId: r[COL.TRAVEL_ID] || '',
    budgetTaken: r[COL.BUDGET_TAKEN] || '', budgetLine: r[COL.BUDGET_LINE] || '', oob: r[COL.OOB_JUST] || '',
    quotesAvail: r[COL.QUOTES_AVAIL] || '', quotes: [r[COL.QUOTE1], r[COL.QUOTE2], r[COL.QUOTE3]].filter(Boolean), quotesReason: r[COL.QUOTES_REASON] || '',
    doc: r[COL.DOC_QUOTE] || '', poNumber: r[COL.PO_NUMBER] || '', poDate: fmtDate(r[COL.PO_DATE]),
    delivery: r[COL.DELIVERY] || '', deliveryDate: fmtDate(r[COL.DELIVERY_DATE]),
    invoiceDoc: r[COL.INVOICE_DOC] || '', invoiceDate: fmtDate(r[COL.INVOICE_DATE]),
    invoiceDocs: parseList(r[COL.INVOICE_DOCS]), invoiceRegion: r[COL.INVOICE_REGION] || '', invoiceBase: Number(r[COL.INVOICE_BASE] || 0),
    invoiceTax: Number(r[COL.INVOICE_GST] || 0), invoiceTotal: Number(r[COL.INVOICE_TOTAL] || 0), invoiceGstin: r[COL.INVOICE_GSTIN] || '',
    invoiceNumber: r[COL.INVOICE_NUMBER] || '', invoiceVDate: fmtDate(r[COL.INVOICE_VDATE]), invoiceCategory: r[COL.INVOICE_CATEGORY] || '',
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
    const readOnly = !(isFin || (lens === 'dept' && isHOD) || (lens === 'mgmt' && isCEO));
    const decCol = { dept: COL.DEPT_DEC, finance: COL.FIN_DEC, mgmt: COL.MGMT_DEC }[lens];
    for (const rec of all) {
      if (String(rec[COL.STAGE]) === 'scrapped') continue;
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
    if (String(rec[COL.STAGE]) === 'scrapped') continue;
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
    s.canRecallApproval = canRecallApproval(rec, email, roles);
    s.myStage = mine || '';
    s.decision = (isHOD && !isFin && !isCEO) ? decStatus(rec[COL.DEPT_DEC]) : (isCEO && !isFin ? decStatus(rec[COL.MGMT_DEC]) : decStatus(rec[COL.FIN_DEC]));
    rows.push(s);
  }
  rows.reverse();
  // Scoped analytics — HOD sees their department, CEO/Finance see everything.
  const analytics = buildApproverAnalytics(all, { isFin, isCEO, isHOD, myDept });
  return { scope, rows, readOnly: false, lens: null, analytics };
}

// Analytics for the approvals page, scoped to what the viewer oversees (HOD → dept, CEO/Finance → all).
function buildApproverAnalytics(all, { isFin, isCEO, isHOD, myDept }) {
  const showAll = isFin || isCEO;
  const byCategory = {}, byDept = {}, byStage = {};
  let count = 0, pipelineINR = 0, paidINR = 0, oob = 0, overdue = 0;
  for (const rec of all) {
    const stage = String(rec[COL.STAGE] || '');
    if (stage === 'scrapped') continue;
    if (!showAll && !(isHOD && myDept(rec))) continue; // HOD → own dept only
    const amtINR = Number(rec[COL.AMOUNT_INR] || 0) || toINR(Number(rec[COL.AMOUNT] || 0), rec[COL.CURRENCY]);
    const rejected = stage === 'rejected' || /reject/i.test(String(rec[COL.STATUS] || ''));
    count++;
    const cat = String(rec[COL.CATEGORY] || 'Uncategorised');
    if (!rejected) { byCategory[cat] = (byCategory[cat] || 0) + amtINR; byDept[String(rec[COL.DEPT] || '—')] = (byDept[String(rec[COL.DEPT] || '—')] || 0) + amtINR; }
    byStage[stageLabel(stage)] = (byStage[stageLabel(stage)] || 0) + 1;
    if (stage === 'done') paidINR += amtINR; else if (!rejected) pipelineINR += amtINR;
    if (!rejected && String(rec[COL.BUDGET_TAKEN]) === 'No') oob++;
    if (APPROVAL_STAGES.includes(stage) && !rec[COL.HOLD]) {
      const since = rec[COL.MGMT_TIME] || rec[COL.FIN_TIME] || rec[COL.DEPT_TIME] || rec[COL.TS];
      if (since && Math.floor((Date.now() - Date.parse(since)) / 86400000) >= SLA_ESCALATE_DAYS) overdue++;
    }
  }
  return { count, pipelineINR, paidINR, oob, overdue, showDept: showAll, byCategory, byDept, byStage };
}

// Requester self-service
export async function myData(email) {
  const e = String(email || '').toLowerCase();
  const all = await readAll();
  const rows = all.filter((r) => String(r[COL.EMAIL] || '').toLowerCase() === e && String(r[COL.STAGE]) !== 'scrapped').map((r) => {
    const stage = String(r[COL.STAGE]);
    const mgmt = mgmtRequired(r);
    const s = rowShape(r);
    s.hod = decStatus(r[COL.DEPT_DEC]) || (stage === 'dept' ? 'Pending' : '');
    s.finance = decStatus(r[COL.FIN_DEC]) || (['dept'].includes(stage) ? 'Waiting' : (stage === 'finance' ? 'Pending' : (isAfter(stage, 'finance') ? 'Approved' : 'Waiting')));
    s.mgmtStatus = mgmt ? (decStatus(r[COL.MGMT_DEC]) || (isAfter(stage, 'mgmt') ? 'Approved' : (stage === 'mgmt' ? 'Pending' : 'Waiting'))) : 'N/A';
    s.po = r[COL.PO_NUMBER] ? ('PO ' + r[COL.PO_NUMBER]) : (stage === 'po' ? 'Pending' : (isAfter(stage, 'po') ? 'Issued' : ''));
    s.deliveryStatus = r[COL.DELIVERY] || (stage === 'delivery' ? 'Awaiting' : (isAfter(stage, 'delivery') ? 'Delivered' : ''));
    s.invoiceStatus = r[COL.INVOICE_DOC] ? 'Submitted' : (stage === 'invoice' ? 'Awaiting' : (isAfter(stage, 'invoice') ? 'Submitted' : ''));
    const mpays = parseList(r[COL.PAYMENTS]); const mpaid = mpays.reduce((a, x) => a + (Number(x.amount) || 0), 0); const mtot = Number(r[COL.AMOUNT] || 0);
    s.paidToDate = mpaid; s.paymentTotal = mtot; s.paymentBalance = Math.max(0, mtot - mpaid); s.paymentsCount = mpays.length;
    s.payStatus = /paid & closed/i.test(String(r[COL.STATUS])) ? 'Paid' : (stage === 'paying' ? (mpaid > 0 ? 'Partly paid' : 'Approved — to disburse') : (['payment', 'payment_mgmt'].includes(stage) ? 'Pending' : ''));
    s.canConfirmDelivery = stage === 'delivery';
    s.canSubmitInvoice = stage === 'invoice';
    // requester self-service
    s.canRecall = ['dept', 'finance', 'mgmt'].includes(stage);
    s.canWithdraw = ['dept', 'finance', 'mgmt', 'po', 'delivery', 'invoice', 'payment', 'payment_mgmt'].includes(stage);
    s.canAmend = stage === 'amend';
    return s;
  });
  rows.reverse();
  return { rows };
}
const ORDER = ['dept', 'finance', 'mgmt', 'po', 'delivery', 'invoice', 'payment', 'payment_mgmt', 'paying', 'done'];
function isAfter(stage, ref) { const a = ORDER.indexOf(stage), b = ORDER.indexOf(ref); return a > -1 && b > -1 && a > b; }

// Vendor directory — known vendors + last-seen GST / phone / email (for form auto-fill).
// Vendor master — de-duplicated by canonical key so "Amazon" / "amazon.in" / "AMAZON Pvt Ltd"
// collapse into one entry. Keeps the most-used display spelling, merges contact details, and
// records how many spellings/requests map to each vendor (surfaces dupes to Finance).
export async function vendorDirectory() {
  const all = await readAll();
  const map = {};
  for (const r of all) {
    const display = normalizeVendor(r[COL.VENDOR]);
    if (!display) continue;
    const k = vendorKey(display) || display.toLowerCase();
    const e = map[k] || { vendor: display, gst: '', phone: '', email: '', count: 0, spellings: {} };
    if (r[COL.VENDOR_GST]) e.gst = r[COL.VENDOR_GST];
    if (r[COL.VENDOR_PHONE]) e.phone = r[COL.VENDOR_PHONE];
    if (r[COL.VENDOR_EMAIL]) e.email = r[COL.VENDOR_EMAIL];
    e.count++;
    e.spellings[display] = (e.spellings[display] || 0) + 1;
    map[k] = e;
  }
  return Object.values(map).map((e) => {
    // Prefer the most frequent spelling as the canonical display.
    const spellings = Object.keys(e.spellings);
    e.vendor = spellings.sort((a, b) => e.spellings[b] - e.spellings[a] || b.length - a.length)[0] || e.vendor;
    e.variants = spellings.length; // >1 means multiple spellings were merged
    delete e.spellings;
    return e;
  }).sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
}

// Finance master tracker
export async function financeData() {
  const all = await readAll();
  const summaries = {};
  const rows = [];
  for (const r of all) {
    if (String(r[COL.STAGE]) === 'scrapped') continue;
    const cur = String(r[COL.CURRENCY] || 'INR');
    const amount = Number(r[COL.AMOUNT] || 0);
    const status = String(r[COL.STATUS] || '');
    const rejected = /reject/i.test(status);
    // "Paid" = fully paid & closed only (stage 'done'); NOT "Partially paid" (which also matches /paid/).
    const paid = String(r[COL.STAGE]) === 'done';
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
    // Invoice GST + attachments
    s.invoiceGst = Number(r[COL.INVOICE_GST] || 0); s.invoiceGstin = r[COL.INVOICE_GSTIN] || '';
    s.invoiceDocs = parseList(r[COL.INVOICE_DOCS]); if (!s.invoiceDocs.length && r[COL.INVOICE_DOC]) s.invoiceDocs = [r[COL.INVOICE_DOC]];
    // Partial-payment ledger
    const pays = parseList(r[COL.PAYMENTS]);
    s.payments = pays; s.paidToDate = pays.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    s.paymentTotal = Number(r[COL.AMOUNT] || 0); s.paymentBalance = Math.max(0, s.paymentTotal - s.paidToDate);
    s.canRecordPayment = stage === 'paying';
    s.payStatus = paid ? 'Paid' : (stage === 'paying' ? (s.paidToDate > 0 ? 'Partly paid' : 'To disburse') : (['payment', 'payment_mgmt'].includes(stage) ? 'Pending' : (decStatus(r[COL.PAY_FIN_DEC]) || '')));
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
    const ccList = delegatesOf(String(to || '').toLowerCase());
    if (CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL]) ccList.push(rec[COL.EMAIL]);
    await sendEmail({ to, subject: `[Reminder] ${rec[COL.ID]} — ${stageLabel(stage)} pending ${hours}h`,
      html: reminderEmailHtml(rec, stageLabel(stage), approverNameFor(stage, rec), actionUrl(base, rec[COL.ID], stage, 'approve', token), actionUrl(base, rec[COL.ID], stage, 'reject', token), hours),
      cc: ccList.length ? ccList : undefined });
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

// ---- weekly digest ----
// One summary email per approver of everything currently awaiting them (incl. items they hold
// via delegation), plus a portfolio overview to Finance. Called weekly from the cron.
export async function sendWeeklyDigest(baseUrl) {
  const base = String(baseUrl || process.env.APP_BASE_URL || '').replace(/\/$/, '');
  await ensureHeaders();
  const all = await readAll();
  const now = Date.now();
  const byApprover = {}; // principalEmail -> [{id, item, vendor, amount, cur, stage, age, oob}]
  const stageCounts = {};
  for (const rec of all) {
    const stage = String(rec[COL.STAGE] || '');
    if (!APPROVAL_STAGES.includes(stage) || rec[COL.HOLD]) continue;
    const to = String(approverEmailFor(stage, rec) || '').toLowerCase();
    if (!to) continue;
    const since = rec[COL.MGMT_TIME] || rec[COL.FIN_TIME] || rec[COL.DEPT_TIME] || rec[COL.TS];
    const age = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 86400000)) : 0;
    const item = { id: rec[COL.ID], item: rec[COL.ITEM] || '', vendor: rec[COL.VENDOR] || '', amount: Number(rec[COL.AMOUNT] || 0), cur: rec[COL.CURRENCY] || 'INR', stage, age, oob: String(rec[COL.BUDGET_TAKEN]) === 'No' };
    (byApprover[to] = byApprover[to] || []).push(item);
    stageCounts[stage] = (stageCounts[stage] || 0) + 1;
  }
  const sent = [];
  const fmtRow = (x) => [x.id, `${x.item}${x.vendor ? ' · ' + x.vendor : ''}`, money(x.amount, x.cur), stageLabel(x.stage), `${x.age}d${x.age >= SLA_ESCALATE_DAYS ? ' ⚠' : ''}${x.oob ? ' · OOB' : ''}`];
  for (const email of Object.keys(byApprover)) {
    const items = byApprover[email].sort((a, b) => b.age - a.age);
    const overdue = items.filter((x) => x.age >= SLA_ESCALATE_DAYS).length;
    const cc = delegatesOf(email);
    await sendEmail({ to: email, cc: cc.length ? cc : undefined,
      subject: `[Weekly] ${items.length} request${items.length === 1 ? '' : 's'} awaiting your approval${overdue ? ` (${overdue} overdue)` : ''}`,
      html: digestEmailHtml('Your weekly approvals digest',
        `You have <b>${items.length}</b> request${items.length === 1 ? '' : 's'} awaiting action${overdue ? `, of which <b>${overdue}</b> ${overdue === 1 ? 'is' : 'are'} past the ${SLA_ESCALATE_DAYS}-day SLA` : ''}. Oldest first.`,
        ['Request', 'Item / Vendor', 'Amount', 'Stage', 'Waiting'], items.map(fmtRow), base + '/approvals', 'Open Approvals') });
    sent.push({ to: email, count: items.length, overdue });
  }
  // Finance portfolio overview.
  try {
    const totalPending = Object.values(stageCounts).reduce((a, b) => a + b, 0);
    const overview = APPROVAL_STAGES.filter((st) => stageCounts[st]).map((st) => [stageLabel(st), String(stageCounts[st])]);
    await sendEmail({ to: CONFIG.FINANCE_SPOC,
      subject: `[Weekly] Approvals overview — ${totalPending} in the pipeline`,
      html: digestEmailHtml('Approvals — weekly overview', `<b>${totalPending}</b> request${totalPending === 1 ? '' : 's'} in the approval pipeline across all stages.`,
        ['Stage', 'Awaiting'], overview.length ? overview : [['—', '0']], base + '/finance', 'Open Finance') });
  } catch (e) { console.error('digest finance overview failed (non-fatal):', e.message || e); }
  return { ok: true, approvers: sent.length, sent };
}

// ---- commitment tracking (Point 5) ----
// Money approved-but-not-yet-paid, grouped by linked budget line. A request "commits" budget once
// it passes Finance approval (stage moves beyond 'finance') and until it is paid/rejected/scrapped.
export async function commitmentsByBudgetLine() {
  const all = await readAll();
  const map = {}; // lineId -> { committedINR, count }
  for (const rec of all) {
    const lineId = String(rec[COL.BUDGET_LINE_ID] || '');
    if (!lineId) continue;
    const stage = String(rec[COL.STAGE] || '');
    const status = String(rec[COL.STATUS] || '');
    // Committed = past finance approval, still in-flight (po/delivery/invoice/payment/payment_mgmt), not paid/rejected/scrapped.
    const committedStages = ['po', 'delivery', 'invoice', 'payment', 'payment_mgmt'];
    if (!committedStages.includes(stage)) continue;
    if (/paid|reject/i.test(status) || stage === 'scrapped' || stage === 'done') continue;
    const amtINR = Number(rec[COL.AMOUNT_INR] || 0) || toINR(Number(rec[COL.AMOUNT] || 0), rec[COL.CURRENCY]);
    const e = map[lineId] || { committedINR: 0, count: 0 };
    e.committedINR += amtINR; e.count++;
    map[lineId] = e;
  }
  return map;
}

function parseList(s) { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function stamp() { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }
function fmtDate(v) { if (!v) return ''; const d = new Date(v); if (isNaN(d)) return String(v); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
