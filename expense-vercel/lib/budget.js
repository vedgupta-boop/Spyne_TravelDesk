import { randomUUID } from 'crypto';
import { google } from 'googleapis';
import { CONFIG, POLICY } from './config.js';
import { sendEmail, noticeEmailHtml } from './email.js';

// ---------------------------------------------------------------------------
//  Budget module (Stages 1–3 of the Expense & Budget Approval Workflow).
//  Stored in a separate "Budgets" tab of the same spreadsheet (SHEET_ID).
//  Two record types share the tab: 'budget' and 'realloc' (reallocation request).
//  Approval chain for both: HOD → Finance → Management (Sanjay/CEO), all required.
// ---------------------------------------------------------------------------
const TAB = 'Budgets';
export const PERIODS = ['FY 2026-27', 'Q1 FY2026-27', 'Q2 FY2026-27', 'Q3 FY2026-27', 'Q4 FY2026-27'];

export const BCOL = {
  ID: 'Budget ID', TYPE: 'Type', PARENT: 'Parent Budget', TS: 'Created', CREATOR: 'Created By',
  DEPT: 'Department', HOD: 'HOD Email', PERIOD: 'Period', TITLE: 'Title',
  STATUS: 'Status', STAGE: 'Stage', TOKEN: 'Token',
  DEPT_DEC: 'HOD Decision', DEPT_TIME: 'HOD Time', FIN_DEC: 'Finance Decision', FIN_TIME: 'Finance Time',
  MGMT_DEC: 'Management Decision', MGMT_TIME: 'Management Time',
  LINES: 'Line Items (JSON)', DETAIL: 'Detail (JSON)', COMMENTS: 'Comments', CURRENCY: 'Currency',
};
export const BHEADERS = [
  BCOL.ID, BCOL.TYPE, BCOL.PARENT, BCOL.TS, BCOL.CREATOR, BCOL.DEPT, BCOL.HOD, BCOL.PERIOD, BCOL.TITLE,
  BCOL.STATUS, BCOL.STAGE, BCOL.TOKEN,
  BCOL.DEPT_DEC, BCOL.DEPT_TIME, BCOL.FIN_DEC, BCOL.FIN_TIME, BCOL.MGMT_DEC, BCOL.MGMT_TIME,
  BCOL.LINES, BCOL.DETAIL, BCOL.COMMENTS, BCOL.CURRENCY,
];
// FX conversion between INR and USD (uses POLICY.FX_USD_INR).
function convert(amount, from, to) {
  const a = Number(amount) || 0;
  if (from === to) return Math.round(a);
  if (from === 'USD' && to === 'INR') return Math.round(a * POLICY.FX_USD_INR);
  if (from === 'INR' && to === 'USD') return Math.round(a / POLICY.FX_USD_INR);
  return Math.round(a);
}

// ---- low-level sheet I/O (named tab) ----
function jwtAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = (process.env.GOOGLE_PRIVATE_KEY || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').replace(/\r/g, '');
  if (!email || !key) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY');
  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
}
function api() { return google.sheets({ version: 'v4', auth: jwtAuth() }); }
function sheetId() { const id = process.env.SHEET_ID; if (!id) throw new Error('Missing SHEET_ID'); return id; }

async function ensureTab() {
  const ss = await api().spreadsheets.get({ spreadsheetId: sheetId() });
  let sheet = (ss.data.sheets || []).find((s) => s.properties.title === TAB);
  if (!sheet) {
    await api().spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { columnCount: BHEADERS.length } } } }] } });
  } else if ((sheet.properties.gridProperties.columnCount || 26) < BHEADERS.length) {
    await api().spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: sheet.properties.sheetId, gridProperties: { columnCount: BHEADERS.length } }, fields: 'gridProperties.columnCount' } }] } });
  }
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `${TAB}!1:1` });
  const row = (got.data.values && got.data.values[0]) || [];
  if (!(row.length === BHEADERS.length && BHEADERS.every((h, i) => row[i] === h))) {
    await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [BHEADERS] } });
  }
}
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
async function readAll() {
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
  const v = got.data.values || []; if (v.length < 2) return [];
  const h = v[0];
  return v.slice(1).map((r, i) => { const rec = {}; h.forEach((k, c) => { rec[k] = r[c] != null ? r[c] : ''; }); rec.__row = i + 2; return rec; });
}
async function append(rec) {
  await api().spreadsheets.values.append({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [BHEADERS.map((h) => (rec[h] == null ? '' : rec[h]))] } });
}
async function update(row, pairs) {
  const data = pairs.map(([name, value]) => { const idx = BHEADERS.indexOf(name); if (idx < 0) return null; return { range: `${TAB}!${colLetter(idx + 1)}${row}`, values: [[value == null ? '' : value]] }; }).filter(Boolean);
  if (data.length) await api().spreadsheets.values.batchUpdate({ spreadsheetId: sheetId(), requestBody: { valueInputOption: 'RAW', data } });
}
async function findById(id) { return (await readAll()).find((r) => String(r[BCOL.ID]) === String(id)) || null; }

// ---- helpers ----
function parseJSON(s, f) { try { const v = JSON.parse(s); return v == null ? f : v; } catch { return f; } }
function fmtDate(v) { if (!v) return ''; const d = new Date(v); return isNaN(d) ? String(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
function lineTotals(lines) {
  return (lines || []).map((l) => { const spent = (l.vendors || []).reduce((a, v) => a + (Number(v.amount) || 0), 0); return { ...l, spent, remaining: (Number(l.amount) || 0) - spent }; });
}
function budgetTotal(lines) { return (lines || []).reduce((a, l) => a + (Number(l.amount) || 0), 0); }
// Approval order: HOD → CEO → Finance (Finance locks/finalises). 'mgmt' stage = CEO (Sanjay).
function stageLabel(st) { return { dept: 'Department Head', mgmt: 'CEO (Sanjay)', finance: 'Finance' }[st] || st; }
// Approval orders by record type:
//   budget   → HOD → CEO → Finance (Finance locks)
//   realloc  → HOD → Finance → Management
//   claim    → HOD → Finance (then drawn down)
function chainNext(cur, type) { const c = (type === 'realloc') ? ['dept', 'finance', 'mgmt'] : (type === 'claim') ? ['dept', 'finance'] : ['dept', 'mgmt', 'finance']; const i = c.indexOf(cur); return i > -1 && i + 1 < c.length ? c[i + 1] : null; }
function approverEmail(stage, rec) { if (stage === 'dept') return rec[BCOL.HOD] || CONFIG.FINANCE_SPOC; if (stage === 'mgmt') return CONFIG.CEO_EMAIL; return CONFIG.FINANCE_SPOC; }
async function notifyNext(stage, rec, baseUrl, kind) {
  const to = approverEmail(stage, rec);
  await sendEmail({ to, subject: `[Action Needed] ${rec[BCOL.ID]} — ${stageLabel(stage)} approval (${kind})`,
    html: noticeEmailHtmlSafe(rec, `${kind === 'realloc' ? 'Reallocation' : 'Budget'} awaiting your approval`, `${rec[BCOL.TITLE] || rec[BCOL.DEPT]} · ${rec[BCOL.PERIOD]}. Open the Budgets page to review and approve.`, (baseUrl || '') + '/budget') });
}
const ALERT_PCT = 0.9; // email HOD + Finance when a line crosses this utilisation
async function sendUtilAlert(rec, li) {
  try {
    const spent = (li.vendors || []).reduce((a, v) => a + (Number(v.amount) || 0), 0);
    const pct = li.amount > 0 ? Math.round((spent / li.amount) * 100) : 0;
    const to = [rec[BCOL.HOD] || CONFIG.FINANCE_SPOC, CONFIG.FINANCE_SPOC];
    await sendEmail({ to, subject: `[Budget alert] ${rec[BCOL.ID]} — "${li.head}" at ${pct}% utilisation`,
      html: noticeEmailHtmlSafe(rec, `Budget line "${li.head}" at ${pct}% utilisation`, `Spent ₹${spent.toLocaleString('en-IN')} of ₹${Number(li.amount).toLocaleString('en-IN')} allocated (remaining ₹${(li.amount - spent).toLocaleString('en-IN')}) · ${rec[BCOL.PERIOD]}.`, '') });
  } catch (e) { console.error('util alert failed (non-fatal):', e.message || e); }
}
// Returns true (and flips li.alerted90) if this line just crossed the alert threshold.
function crossedAlert(li) {
  const spent = (li.vendors || []).reduce((a, v) => a + (Number(v.amount) || 0), 0);
  if (!li.alerted90 && li.amount > 0 && spent / li.amount >= ALERT_PCT) { li.alerted90 = true; return true; }
  return false;
}
function noticeEmailHtmlSafe(rec, h, b, link) {
  // budgets aren't expense records — build a small standalone notice
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;">${esc(rec[BCOL.ID])}</h2>` +
    `<p style="font-size:16px;font-weight:700;margin:6px 0 4px;color:#0D1B2A;">${esc(h)}</p>` +
    `<p style="color:#555;margin:0 0 14px;">${esc(b)}</p>` +
    `<p style="margin:18px 0;"><a href="${esc(link)}" style="display:inline-block;padding:12px 24px;background:#0D1B2A;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Open Budgets →</a></p></div>`;
}

// ---- Stage 1: create a budget ----
export async function createBudget(p, baseUrl) {
  if (!p.dept) throw new Error('Department is required');
  if (!p.period) throw new Error('Period is required');
  const FREQ = ['One-time', 'Monthly', 'Quarterly', 'Half-yearly', 'Yearly'];
  const lines = (Array.isArray(p.lines) ? p.lines : []).map((l) => ({ id: randomUUID().slice(0, 8), head: String(l.head || '').trim(), amount: Math.round(Number(l.amount) || 0), frequency: FREQ.includes(l.frequency) ? l.frequency : 'One-time', vendors: [] })).filter((l) => l.head && l.amount > 0);
  if (!lines.length) throw new Error('Add at least one line item with an amount');
  // Duplicate-budget guard: block an active budget for the same department + period unless overridden.
  if (!p.allowDuplicate) {
    try {
      await ensureTab();
      const all = await readAll();
      const dKey = String(p.dept || '').toLowerCase().trim(), pKey = String(p.period || '').toLowerCase().trim();
      const dup = all.find((r) => String(r[BCOL.TYPE] || 'budget') === 'budget'
        && !['rejected', 'closed'].includes(String(r[BCOL.STAGE]))
        && String(r[BCOL.DEPT] || '').toLowerCase().trim() === dKey
        && String(r[BCOL.PERIOD] || '').toLowerCase().trim() === pKey);
      if (dup) return { ok: false, duplicate: true, dupId: dup[BCOL.ID],
        error: `A budget for ${p.dept} · ${p.period} already exists (${dup[BCOL.ID]} — ${stageLabel(String(dup[BCOL.STAGE]))}). Create anyway only if this is intentional.` };
    } catch (e) { console.error('budget dup check failed (non-fatal):', e.message || e); }
  }
  const deptInfo = CONFIG.DEPARTMENTS[p.dept] || null;
  const hod = (deptInfo && deptInfo.email) || CONFIG.FINANCE_SPOC;
  const id = 'BUD-' + stamp() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const rec = {
    [BCOL.ID]: id, [BCOL.TYPE]: 'budget', [BCOL.PARENT]: '', [BCOL.TS]: new Date().toISOString(), [BCOL.CREATOR]: (p.email || '').trim(),
    [BCOL.DEPT]: p.dept, [BCOL.HOD]: hod, [BCOL.PERIOD]: p.period, [BCOL.TITLE]: p.title || (p.dept + ' — ' + p.period),
    [BCOL.STATUS]: 'Pending HOD Approval', [BCOL.STAGE]: 'dept', [BCOL.TOKEN]: randomUUID(),
    [BCOL.LINES]: JSON.stringify(lines), [BCOL.DETAIL]: '', [BCOL.COMMENTS]: '', [BCOL.CURRENCY]: p.currency === 'USD' ? 'USD' : 'INR',
  };
  await ensureTab(); await append(rec); await notifyNext('dept', rec, baseUrl, 'budget');
  return { ok: true, id, total: budgetTotal(lines), lines: lines.length };
}

// ---- Stage 3: create a reallocation request ----
export async function createReallocation(p, baseUrl) {
  const parent = await findById(p.parentId);
  if (!parent) throw new Error('Budget not found');
  if (String(parent[BCOL.STAGE]) !== 'locked') throw new Error('Reallocation is only allowed on a locked budget');
  const lines = lineTotals(parseJSON(parent[BCOL.LINES], []));
  const from = lines.find((l) => l.id === p.fromId);
  if (!from) throw new Error('Pick the From line item');
  if (from.closed) throw new Error('That line item is closed');
  const amount = Math.round(Number(p.amount) || 0);
  if (!(amount > 0)) throw new Error('Enter an amount');
  if (amount > from.remaining) throw new Error(`Only ${from.remaining} is unused on "${from.head}"`);
  if (!p.reasonUnused) throw new Error('State why the budget went unused');
  const drop = !!p.drop;
  let to = null;
  if (!drop) {
    to = lines.find((l) => l.id === p.toId);
    if (!to || to.id === from.id) throw new Error('Pick a distinct To line item');
    if (!p.reasonNeeded) throw new Error('State why the To item needs it');
  }
  const id = 'RAL-' + stamp() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const detail = drop
    ? { drop: true, fromId: from.id, fromHead: from.head, amount, reasonUnused: p.reasonUnused }
    : { fromId: from.id, fromHead: from.head, toId: to.id, toHead: to.head, amount, reasonUnused: p.reasonUnused, reasonNeeded: p.reasonNeeded };
  const rec = {
    [BCOL.ID]: id, [BCOL.TYPE]: 'realloc', [BCOL.PARENT]: parent[BCOL.ID], [BCOL.TS]: new Date().toISOString(), [BCOL.CREATOR]: (p.email || '').trim(),
    [BCOL.DEPT]: parent[BCOL.DEPT], [BCOL.HOD]: parent[BCOL.HOD], [BCOL.PERIOD]: parent[BCOL.PERIOD],
    [BCOL.TITLE]: drop ? `Drop ${amount} from ${from.head}` : `Reallocate ${amount}: ${from.head} → ${to.head}`,
    [BCOL.STATUS]: 'Pending HOD Approval', [BCOL.STAGE]: 'dept', [BCOL.TOKEN]: randomUUID(),
    [BCOL.LINES]: '', [BCOL.DETAIL]: JSON.stringify(detail), [BCOL.COMMENTS]: '', [BCOL.CURRENCY]: parent[BCOL.CURRENCY] || 'INR',
  };
  await ensureTab(); await append(rec); await notifyNext('dept', rec, baseUrl, 'realloc');
  return { ok: true, id, amount, drop };
}

// ---- Stage 2: budget claim (approval-bearing) — HOD → Finance, then draws down the line ----
export async function createClaim(p, baseUrl) {
  const parent = await findById(p.parentId);
  if (!parent) throw new Error('Budget not found');
  if (String(parent[BCOL.STAGE]) !== 'locked') throw new Error('Claims are only allowed on a locked budget');
  const li = lineTotals(parseJSON(parent[BCOL.LINES], [])).find((l) => l.id === p.lineId);
  if (!li) throw new Error('Pick a budget line item');
  if (li.closed) throw new Error('That line item is closed');
  const amount = Math.round(Number(p.amount) || 0);
  if (!(amount > 0)) throw new Error('Enter the claim amount');
  if (!p.expense) throw new Error('Enter the expense / purpose (mandatory)');
  if (amount > li.remaining) throw new Error(`Only ${li.remaining} remaining on "${li.head}"`);
  const id = 'CLM-' + stamp() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const rec = {
    [BCOL.ID]: id, [BCOL.TYPE]: 'claim', [BCOL.PARENT]: parent[BCOL.ID], [BCOL.TS]: new Date().toISOString(), [BCOL.CREATOR]: (p.email || '').trim(),
    [BCOL.DEPT]: parent[BCOL.DEPT], [BCOL.HOD]: parent[BCOL.HOD], [BCOL.PERIOD]: parent[BCOL.PERIOD],
    [BCOL.TITLE]: `Claim ${amount} — ${li.head}: ${p.expense}`,
    [BCOL.STATUS]: 'Pending HOD Approval', [BCOL.STAGE]: 'dept', [BCOL.TOKEN]: randomUUID(),
    [BCOL.LINES]: '', [BCOL.DETAIL]: JSON.stringify({ lineId: li.id, lineHead: li.head, expense: String(p.expense), vendor: String(p.vendor || ''), amount }), [BCOL.COMMENTS]: '', [BCOL.CURRENCY]: parent[BCOL.CURRENCY] || 'INR',
  };
  await ensureTab(); await append(rec); await notifyNext('dept', rec, baseUrl, 'claim');
  return { ok: true, id, amount };
}

// ---- Stage 2 (manual): direct vendor mapping (no approval; only on a locked budget) ----
export async function addVendorMapping(p) {
  const rec = await findById(p.id);
  if (!rec) return { ok: false, error: 'Budget not found' };
  if (String(rec[BCOL.STAGE]) !== 'locked') return { ok: false, error: 'Budget must be locked (fully approved) first' };
  const lines = parseJSON(rec[BCOL.LINES], []);
  const li = lines.find((l) => l.id === p.lineId);
  if (!li) return { ok: false, error: 'Line item not found' };
  const amount = Math.round(Number(p.amount) || 0);
  if (!(amount > 0)) return { ok: false, error: 'Enter a spend amount' };
  // Point 4: the expense/purpose is mandatory (that's what the budget was taken for); vendor is optional.
  if (!p.note) return { ok: false, error: 'Enter what this spend is for (expense / purpose)' };
  const spent = (li.vendors || []).reduce((a, v) => a + (Number(v.amount) || 0), 0);
  if (amount > (Number(li.amount) || 0) - spent) return { ok: false, error: `Only ${(Number(li.amount) || 0) - spent} remaining on "${li.head}"` };
  li.vendors = li.vendors || [];
  li.vendors.push({ vendor: String(p.vendor || ''), amount, note: String(p.note || ''), by: String(p.email || '').split('@')[0], date: new Date().toISOString() });
  const alert = crossedAlert(li);
  await update(rec.__row, [[BCOL.LINES, JSON.stringify(lines)]]);
  if (alert) await sendUtilAlert(rec, li);
  return { ok: true, id: p.id, title: 'Spend logged', msg: `${p.note} (${amount}) logged against "${li.head}".` };
}

// Build a carry-forward budget (pending fresh HOD→CEO→Finance) from a set of {head, amount} lines.
async function makeCarryForward(rec, carryLines, newPeriod, email, baseUrl) {
  const remLines = carryLines.filter((l) => l.amount > 0).map((l) => ({ id: randomUUID().slice(0, 8), head: l.head, amount: l.amount, frequency: l.frequency || 'One-time', vendors: [] }));
  if (!remLines.length) return null;
  const nid = 'BUD-' + stamp() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const nrec = {
    [BCOL.ID]: nid, [BCOL.TYPE]: 'budget', [BCOL.PARENT]: rec[BCOL.ID], [BCOL.TS]: new Date().toISOString(), [BCOL.CREATOR]: (email || '').trim(),
    [BCOL.DEPT]: rec[BCOL.DEPT], [BCOL.HOD]: rec[BCOL.HOD], [BCOL.PERIOD]: newPeriod || rec[BCOL.PERIOD],
    [BCOL.TITLE]: rec[BCOL.DEPT] + ' — ' + (newPeriod || 'next period') + ' (carry-forward)',
    [BCOL.STATUS]: 'Pending HOD Approval', [BCOL.STAGE]: 'dept', [BCOL.TOKEN]: randomUUID(),
    [BCOL.LINES]: JSON.stringify(remLines), [BCOL.DETAIL]: '', [BCOL.COMMENTS]: 'Carry-forward of unused budget from ' + rec[BCOL.ID], [BCOL.CURRENCY]: rec[BCOL.CURRENCY] || 'INR',
  };
  await append(nrec); await notifyNext('dept', nrec, baseUrl, 'budget');
  return nid;
}

// ---- close-out, optionally carrying remaining forward. With lineId → close just one line item. ----
export async function closeBudget({ id, lineId, carryForward, newPeriod, email, roles }, baseUrl) {
  if (!(roles || []).includes('finance')) return { ok: false, error: 'Only Finance can close a budget' };
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Budget not found' };
  if (String(rec[BCOL.STAGE]) !== 'locked') return { ok: false, error: 'Only a locked budget can be closed' };
  const who = String(email || '').split('@')[0];
  const when = fmtDate(new Date().toISOString());

  // --- Line-wise close: shut a single line item, optionally carrying its remaining forward. ---
  if (lineId) {
    const raw = parseJSON(rec[BCOL.LINES], []);
    const li = raw.find((l) => l.id === lineId);
    if (!li) return { ok: false, error: 'Line item not found' };
    if (li.closed) return { ok: false, error: 'That line item is already closed' };
    const spent = (li.vendors || []).reduce((a, v) => a + (Number(v.amount) || 0), 0);
    const remaining = (Number(li.amount) || 0) - spent;
    li.closed = true; li.closedOn = new Date().toISOString();
    if (carryForward && remaining > 0) li.carried = remaining;
    li.amount = spent; // release the unused portion from this budget
    const note = `[Line closed · ${who} · ${when}] "${li.head}" closed${carryForward && remaining > 0 ? ` — ${remaining} carried forward` : (remaining > 0 ? ` — ${remaining} released` : '')}.`;
    await update(rec.__row, [[BCOL.LINES, JSON.stringify(raw)], [BCOL.COMMENTS, rec[BCOL.COMMENTS] ? rec[BCOL.COMMENTS] + '\n' + note : note]]);
    let carried = null;
    if (carryForward && remaining > 0) carried = await makeCarryForward(rec, [{ head: li.head, amount: remaining, frequency: li.frequency }], newPeriod, email, baseUrl);
    return { ok: true, id, carried, title: 'Line closed', msg: carried ? `"${li.head}" closed; carried forward to ${carried}.` : `"${li.head}" closed.` };
  }

  // --- Whole-budget close. ---
  const lines = lineTotals(parseJSON(rec[BCOL.LINES], []));
  const note = `[Closed · ${who} · ${when}] Closed${carryForward ? ' with carry-forward' : ''}.`;
  await update(rec.__row, [[BCOL.STAGE, 'closed'], [BCOL.STATUS, 'Closed'], [BCOL.COMMENTS, rec[BCOL.COMMENTS] ? rec[BCOL.COMMENTS] + '\n' + note : note]]);
  let carried = null;
  if (carryForward) carried = await makeCarryForward(rec, lines.filter((l) => !l.closed && l.remaining > 0).map((l) => ({ head: l.head, amount: l.remaining, frequency: l.frequency })), newPeriod, email, baseUrl);
  return { ok: true, id, carried, title: 'Budget closed', msg: carried ? `${id} closed; carried forward to ${carried}.` : `${id} closed.` };
}

// ---- Finance-only: record an out-of-budget / missed expense directly on a line (no approval). ----
// For when an actual spend was incurred that wasn't claimed; Finance logs it after the fact.
export async function financeAddExpense(p) {
  if (!(p.roles || []).includes('finance')) return { ok: false, error: 'Only Finance can add an expense directly' };
  const rec = await findById(p.id);
  if (!rec) return { ok: false, error: 'Budget not found' };
  if (String(rec[BCOL.STAGE]) !== 'locked') return { ok: false, error: 'Budget must be locked (fully approved) first' };
  const lines = parseJSON(rec[BCOL.LINES], []);
  const li = lines.find((l) => l.id === p.lineId);
  if (!li) return { ok: false, error: 'Line item not found' };
  if (li.closed) return { ok: false, error: 'That line item is closed' };
  const amount = Math.round(Number(p.amount) || 0);
  if (!(amount > 0)) return { ok: false, error: 'Enter the expense amount' };
  if (!p.note) return { ok: false, error: 'Enter what this expense is for' };
  li.vendors = li.vendors || [];
  // No remaining-balance block: these are real, already-incurred expenses Finance is reconciling
  // (they may legitimately push the line over its allocation).
  li.vendors.push({ vendor: String(p.vendor || ''), amount, note: String(p.note || ''), by: String(p.email || '').split('@')[0], date: new Date().toISOString(), financeAdd: true });
  const alert = crossedAlert(li);
  await update(rec.__row, [[BCOL.LINES, JSON.stringify(lines)]]);
  if (alert) await sendUtilAlert(rec, li);
  return { ok: true, id: p.id, title: 'Expense added', msg: `${p.note} (${amount}) recorded against "${li.head}".` };
}

// ---- claim a budget line from an approved expense (Point 2 linkage) ----
// Called by the expense workflow on final approval; records the spend as a vendor entry
// on the linked budget line so it flows from / draws down the budget. Non-fatal.
export async function claimBudget(budgetId, lineId, { vendor, amount, currency, note, ref, by }) {
  try {
    if (!budgetId || !lineId) return { ok: false, error: 'No budget linkage' };
    const rec = await findById(budgetId);
    if (!rec || String(rec[BCOL.STAGE]) !== 'locked') return { ok: false, error: 'Linked budget not locked' };
    const bcur = rec[BCOL.CURRENCY] || 'INR';
    const amt = convert(amount, currency === 'USD' ? 'USD' : 'INR', bcur);
    const lines = parseJSON(rec[BCOL.LINES], []);
    const li = lines.find((l) => l.id === lineId);
    if (!li) return { ok: false, error: 'Linked line not found' };
    li.vendors = li.vendors || [];
    li.vendors.push({ vendor: String(vendor || ''), amount: amt, note: String(note || ''), by: String(by || '').split('@')[0], date: new Date().toISOString(), expense: String(ref || '') });
    const alert = crossedAlert(li);
    await update(rec.__row, [[BCOL.LINES, JSON.stringify(lines)]]);
    if (alert) await sendUtilAlert(rec, li);
    return { ok: true };
  } catch (e) { console.error('claimBudget failed (non-fatal):', e.message || e); return { ok: false, error: String(e.message || e) }; }
}

// A single locked budget line (for the expense over-budget guard).
export async function getBudgetLine(budgetId, lineId) {
  if (!budgetId || !lineId) return null;
  const rec = await findById(budgetId);
  if (!rec || String(rec[BCOL.STAGE]) !== 'locked') return null;
  const li = lineTotals(parseJSON(rec[BCOL.LINES], [])).find((l) => l.id === lineId);
  return (li && !li.closed) ? { head: li.head, amount: li.amount, spent: li.spent, remaining: li.remaining, title: rec[BCOL.TITLE], period: rec[BCOL.PERIOD], currency: rec[BCOL.CURRENCY] || 'INR' } : null;
}

// Locked budgets for a department — minimal shape for the expense form's budget-line picker.
export async function lockedBudgetsFor(dept) {
  await ensureTab();
  const all = await readAll();
  const d = String(dept || '').toLowerCase();
  return all.filter((r) => String(r[BCOL.TYPE] || 'budget') === 'budget' && String(r[BCOL.STAGE]) === 'locked' && (!d || String(r[BCOL.DEPT] || '').toLowerCase() === d))
    .map((r) => ({ id: r[BCOL.ID], title: r[BCOL.TITLE], period: r[BCOL.PERIOD], dept: r[BCOL.DEPT], currency: r[BCOL.CURRENCY] || 'INR', lines: lineTotals(parseJSON(r[BCOL.LINES], [])).filter((l) => !l.closed).map((l) => ({ id: l.id, head: l.head, amount: l.amount, spent: l.spent, remaining: l.remaining })) }));
}

// ---- approve / reject (budget & realloc share the chain) ----
export async function budgetDecision({ id, decision, comment, email, roles }, baseUrl) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Record not found' };
  const stage = String(rec[BCOL.STAGE]);
  const mine = myStage(rec, email, roles);
  if (mine !== stage) return { ok: false, error: `Not awaiting your approval (current: ${stageLabel(stage)}).` };
  if (!comment) return { ok: false, error: 'A justification/remark is required for budget decisions.' };
  const who = String(email || '').split('@')[0];
  const now = new Date().toISOString();
  const decCol = { dept: BCOL.DEPT_DEC, finance: BCOL.FIN_DEC, mgmt: BCOL.MGMT_DEC }[stage];
  const timeCol = { dept: BCOL.DEPT_TIME, finance: BCOL.FIN_TIME, mgmt: BCOL.MGMT_TIME }[stage];
  const line = `[${stageLabel(stage)} · ${who} · ${fmtDate(now)}] ${comment}`;
  const comments = rec[BCOL.COMMENTS] ? `${rec[BCOL.COMMENTS]}\n${line}` : line;
  const isRealloc = String(rec[BCOL.TYPE]) === 'realloc';
  const isClaim = String(rec[BCOL.TYPE]) === 'claim';

  if (decision === 'reject') {
    await update(rec.__row, [[decCol, 'Rejected'], [timeCol, now], [BCOL.STAGE, 'rejected'], [BCOL.STATUS, 'Rejected at ' + stageLabel(stage)], [BCOL.TOKEN, ''], [BCOL.COMMENTS, comments]]);
    if (rec[BCOL.CREATOR]) await sendEmail({ to: rec[BCOL.CREATOR], subject: `${id} — Rejected`, html: noticeEmailHtmlSafe(rec, 'Rejected at ' + stageLabel(stage), comment, (baseUrl || '') + '/budget') });
    return { ok: true, id, title: 'Rejected', msg: `${id} rejected.` };
  }
  if (decision !== 'approve') return { ok: false, error: 'Unknown decision' };
  const next = chainNext(stage, String(rec[BCOL.TYPE]));
  if (next) {
    const token = randomUUID();
    await update(rec.__row, [[decCol, 'Approved'], [timeCol, now], [BCOL.STAGE, next], [BCOL.STATUS, 'Pending ' + stageLabel(next) + ' Approval'], [BCOL.TOKEN, token], [BCOL.COMMENTS, comments]]);
    await notifyNext(next, { ...rec, [BCOL.TOKEN]: token }, baseUrl, isRealloc ? 'realloc' : 'budget');
    return { ok: true, id, title: 'Approved → ' + stageLabel(next), msg: `${id} forwarded to ${stageLabel(next)}.` };
  }
  // final (management) approval
  if (isRealloc) {
    const d = parseJSON(rec[BCOL.DETAIL], {});
    const parent = await findById(rec[BCOL.PARENT]);
    if (parent) {
      const lines = parseJSON(parent[BCOL.LINES], []);
      const from = lines.find((l) => l.id === d.fromId);
      if (d.drop) { if (from) from.amount = (Number(from.amount) || 0) - d.amount; }
      else { const to = lines.find((l) => l.id === d.toId); if (from && to) { from.amount = (Number(from.amount) || 0) - d.amount; to.amount = (Number(to.amount) || 0) + d.amount; } }
      await update(parent.__row, [[BCOL.LINES, JSON.stringify(lines)]]);
    }
    const what = d.drop ? 'Applied — budget dropped' : 'Applied — budget moved';
    await update(rec.__row, [[decCol, 'Approved'], [timeCol, now], [BCOL.STAGE, 'applied'], [BCOL.STATUS, what], [BCOL.TOKEN, ''], [BCOL.COMMENTS, comments]]);
    if (rec[BCOL.CREATOR]) await sendEmail({ to: rec[BCOL.CREATOR], subject: `${id} — ${d.drop ? 'Budget dropped' : 'Reallocation applied'}`, html: noticeEmailHtmlSafe(rec, d.drop ? 'Budget dropped / released' : 'Reallocation applied', d.drop ? 'The unused budget has been released from the line item.' : 'The budget has been moved between line items.', (baseUrl || '') + '/budget') });
    return { ok: true, id, title: 'Applied', msg: `${id} approved — ${d.drop ? 'budget released' : 'budget moved'}.` };
  }
  if (isClaim) {
    const d = parseJSON(rec[BCOL.DETAIL], {});
    const parent = await findById(rec[BCOL.PARENT]);
    let alert = false, li = null;
    if (parent) {
      const plines = parseJSON(parent[BCOL.LINES], []);
      li = plines.find((l) => l.id === d.lineId);
      if (li) { li.vendors = li.vendors || []; li.vendors.push({ vendor: d.vendor || '', amount: d.amount, note: d.expense, by: String(rec[BCOL.CREATOR] || '').split('@')[0], date: new Date().toISOString(), claim: id }); alert = crossedAlert(li); await update(parent.__row, [[BCOL.LINES, JSON.stringify(plines)]]); }
    }
    await update(rec.__row, [[decCol, 'Approved'], [timeCol, now], [BCOL.STAGE, 'recorded'], [BCOL.STATUS, 'Recorded — budget drawn down'], [BCOL.TOKEN, ''], [BCOL.COMMENTS, comments]]);
    if (alert && parent && li) await sendUtilAlert(parent, li);
    if (rec[BCOL.CREATOR]) await sendEmail({ to: rec[BCOL.CREATOR], subject: `${id} — Claim recorded`, html: noticeEmailHtmlSafe(rec, 'Claim approved & recorded', 'The claim has drawn down the budget line.', (baseUrl || '') + '/budget') });
    return { ok: true, id, title: 'Recorded', msg: `${id} approved — budget drawn down.` };
  }
  await update(rec.__row, [[decCol, 'Approved'], [timeCol, now], [BCOL.STAGE, 'locked'], [BCOL.STATUS, 'Locked'], [BCOL.TOKEN, ''], [BCOL.COMMENTS, comments]]);
  if (rec[BCOL.CREATOR]) await sendEmail({ to: rec[BCOL.CREATOR], subject: `${id} — Budget locked`, html: noticeEmailHtmlSafe(rec, 'Budget approved & locked', 'Your department budget is locked for the period. You can now map vendors against line items as you spend.', (baseUrl || '') + '/budget') });
  return { ok: true, id, title: 'Locked', msg: `${id} fully approved — budget locked.` };
}

function myStage(rec, email, roles) {
  const e = String(email || '').toLowerCase(); const r = roles || [];
  const dept = String(rec[BCOL.DEPT] || ''); const dh = String((CONFIG.DEPARTMENTS[dept] || {}).email || '').toLowerCase();
  const stage = String(rec[BCOL.STAGE]);
  if (stage === 'dept' && r.includes('hod') && (dh === e || String(rec[BCOL.HOD] || '').toLowerCase() === e)) return 'dept';
  if (stage === 'finance' && r.includes('finance')) return 'finance';
  if (stage === 'mgmt' && (r.includes('ceo') || e === String(CONFIG.CEO_EMAIL).toLowerCase())) return 'mgmt';
  return null;
}

// ---- dashboard data ----
export async function budgetData({ email, roles, commitments }) {
  const e = String(email || '').toLowerCase(); const r = roles || [];
  const isHOD = r.includes('hod'), isCEO = r.includes('ceo') || e === String(CONFIG.CEO_EMAIL).toLowerCase(), isFin = r.includes('finance');
  const myDeptsSet = new Set(Object.keys(CONFIG.DEPARTMENTS).filter((d) => String(CONFIG.DEPARTMENTS[d].email).toLowerCase() === e).map((d) => d.toLowerCase()));
  const commit = commitments || {}; // { budgetLineId: { committedINR, count } } — approved-but-unpaid spend
  await ensureTab();
  const all = await readAll();
  // Index child records (realloc/claim/drop) by their parent budget for the revision history.
  const childrenByParent = {};
  all.forEach((c) => { const p = String(c[BCOL.PARENT] || ''); if (p && String(c[BCOL.TYPE]) !== 'budget') (childrenByParent[p] = childrenByParent[p] || []).push(c); });
  const rows = all.map((rec) => {
    const type = String(rec[BCOL.TYPE] || 'budget');
    const cur0 = rec[BCOL.CURRENCY] || 'INR';
    let lines = type === 'budget' ? lineTotals(parseJSON(rec[BCOL.LINES], [])) : [];
    // Commitment tracking (Point 5): reserve approved-but-unpaid expense against each line.
    lines = lines.map((l) => {
      const c = commit[l.id];
      const committed = c ? convert(c.committedINR || 0, 'INR', cur0) : 0;
      return { ...l, committed, committedCount: c ? c.count : 0, available: (Number(l.amount) || 0) - (l.spent || 0) - committed };
    });
    const detail = (type === 'realloc' || type === 'claim') ? parseJSON(rec[BCOL.DETAIL], {}) : null;
    const stage = String(rec[BCOL.STAGE]);
    const mine = myStage(rec, email, roles);
    const total = budgetTotal(lines);
    const spent = lines.reduce((a, l) => a + (l.spent || 0), 0);
    const committed = lines.reduce((a, l) => a + (l.committed || 0), 0);
    const sinceISO = rec[BCOL.MGMT_TIME] || rec[BCOL.FIN_TIME] || rec[BCOL.DEPT_TIME] || rec[BCOL.TS];
    const ageDays = ['dept', 'finance', 'mgmt'].includes(stage) && sinceISO ? Math.max(0, Math.floor((Date.now() - Date.parse(sinceISO)) / 86400000)) : null;
    return {
      id: rec[BCOL.ID], type, parent: rec[BCOL.PARENT] || '', creator: rec[BCOL.CREATOR], dept: rec[BCOL.DEPT], period: rec[BCOL.PERIOD],
      currency: rec[BCOL.CURRENCY] || 'INR', ageDays,
      title: rec[BCOL.TITLE], status: rec[BCOL.STATUS], stage, submission: fmtDate(rec[BCOL.TS]),
      hod: dec(rec[BCOL.DEPT_DEC]), finance: dec(rec[BCOL.FIN_DEC]), mgmt: dec(rec[BCOL.MGMT_DEC]),
      lines, detail, total, spent, committed, remaining: total - spent, available: total - spent - committed, comments: rec[BCOL.COMMENTS] || '',
      pending: mine === stage, canApprove: mine === stage, mine,
      isMine: String(rec[BCOL.CREATOR] || '').toLowerCase() === e,
      locked: stage === 'locked', canClose: isFin && stage === 'locked', canFinanceAdd: isFin && stage === 'locked', closed: stage === 'closed',
      history: type === 'budget' ? budgetHistory(rec, childrenByParent[rec[BCOL.ID]]) : [],
      // can this user see/scope it? HOD → own dept; others → all
      inScope: isFin || isCEO || (isHOD && myDeptsSet.has(String(rec[BCOL.DEPT] || '').toLowerCase())) || String(rec[BCOL.CREATOR] || '').toLowerCase() === e,
    };
  }).filter((x) => x.inScope);
  rows.reverse();
  return { rows, periods: PERIODS, isApprover: isHOD || isCEO || isFin };
}

// Revision history for a budget — a chronological log of allocation-changing events
// (approvals, spends, claims, reallocations/drops, closes). Computed from existing data; read-only.
function budgetHistory(rec, children) {
  const cur = rec[BCOL.CURRENCY] || 'INR';
  const money = (a) => cur + ' ' + Number(a || 0).toLocaleString(cur === 'USD' ? 'en-US' : 'en-IN', { maximumFractionDigits: 0 });
  const ev = [];
  const push = (when, label, detail) => { if (when) ev.push({ when: String(when), at: fmtDate(when), label, detail: detail || '' }); };
  push(rec[BCOL.TS], 'Created', 'Budget raised for approval');
  if (rec[BCOL.DEPT_TIME]) push(rec[BCOL.DEPT_TIME], 'Department Head — ' + (dec(rec[BCOL.DEPT_DEC]) || 'reviewed'), '');
  if (rec[BCOL.MGMT_TIME]) push(rec[BCOL.MGMT_TIME], 'CEO — ' + (dec(rec[BCOL.MGMT_DEC]) || 'reviewed'), '');
  if (rec[BCOL.FIN_TIME]) push(rec[BCOL.FIN_TIME], 'Finance — ' + (dec(rec[BCOL.FIN_DEC]) || 'reviewed') + (String(rec[BCOL.STAGE]) !== 'rejected' ? ' · budget locked' : ''), '');
  // per-line spends (vendor mappings / finance-added / claims / linked expenses)
  parseJSON(rec[BCOL.LINES], []).forEach((l) => (l.vendors || []).forEach((v) => {
    const kind = v.financeAdd ? 'Finance expense' : (v.claim ? 'Claim drawn down' : (v.expense ? 'Linked expense' : 'Spend logged'));
    push(v.date, kind + ' — "' + l.head + '"', [v.vendor, money(v.amount), (v.note || v.expense || '')].filter(Boolean).join(' · '));
  }));
  // child reallocation / claim / drop records
  (children || []).forEach((c) => {
    const t = String(c[BCOL.TYPE]); const st = String(c[BCOL.STAGE]);
    const state = ['applied', 'recorded'].includes(st) ? 'applied' : (st === 'rejected' ? 'rejected' : 'pending');
    const kind = t === 'realloc' ? 'Reallocation' : (t === 'claim' ? 'Claim' : 'Change');
    push(c[BCOL.TS], kind + ' ' + c[BCOL.ID] + ' — ' + state, c[BCOL.TITLE] || '');
  });
  ev.sort((a, b) => (Date.parse(a.when) || 0) - (Date.parse(b.when) || 0));
  return ev;
}
function dec(v) { if (!v) return ''; if (/reject/i.test(v)) return 'Rejected'; if (/approv/i.test(v)) return 'Approved'; return String(v); }
function stamp() { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }
