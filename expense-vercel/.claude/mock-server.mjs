import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { POLICY, CONFIG } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8732;
function money(a, c) { c = c || 'INR'; return c + ' ' + Number(a || 0).toLocaleString(c === 'USD' ? 'en-US' : 'en-IN', { maximumFractionDigits: 0 }); }
function toINR(a, c) { return c === 'USD' ? Math.round(a * POLICY.FX_USD_INR) : a; }
const FREQ_MULT = { Monthly: 12, Quarterly: 4, 'Half-yearly': 2, Yearly: 1, 'One-time': 1 };
function annualOf(o) { return Math.round(o.amount * (FREQ_MULT[o.frequency] || 1)); }
function isCapexN(o) { return o.nature === 'Capex' || o.nature === 'Asset'; }
function ceoThr(o) { const rec = o.frequency !== 'One-time'; return isCapexN(o) ? POLICY.CEO_CAPEX_INR : (rec ? POLICY.CEO_EXPENSE_RECURRING_INR : POLICY.CEO_EXPENSE_ONETIME_INR); }
function mgmtReq(o) { const rec = o.frequency !== 'One-time'; const basis = (!isCapexN(o) && rec) ? toINR(annualOf(o), o.currency) : toINR(o.amount, o.currency); return basis > ceoThr(o); }
function quotesReq(o) { return toINR(o.amount, o.currency) >= POLICY.QUOTE_THRESHOLD_INR; }
const ORDER = ['dept', 'finance', 'mgmt', 'po', 'delivery', 'invoice', 'payment', 'payment_mgmt', 'paying', 'done'];
function isAfter(s, ref) { return ORDER.indexOf(s) > ORDER.indexOf(ref); }
function tier(o) { const rec = o.frequency !== 'One-time'; const t = ceoThr(o).toLocaleString('en-IN'); const basis = (!isCapexN(o) && rec) ? 'annualised' : 'amount'; return (o.nature || 'Expense') + (rec && !isCapexN(o) ? ' · recurring' : '') + ' — CEO ' + (mgmtReq(o) ? 'required' : 'not required') + ' (' + basis + ' vs ₹' + t + ')'; }
const ME = { authenticated: true, email: 'finance.demo@spyne.ai', name: 'Finance Demo', roles: ['requester', 'finance'] };
const CONFIG_RES = { company: CONFIG.COMPANY_NAME, appName: CONFIG.APP_NAME, domain: CONFIG.COMPANY_DOMAIN, ceoName: CONFIG.CEO_NAME, departments: CONFIG.DEPARTMENTS, policy: POLICY, userEmail: ME.email };

// demo records (new schema)
const R = [
  { id: 'EXP-20260620-AB12', name: 'Arjun Nair', email: 'arjun@spyne.ai', dept: 'Technology', nature: 'Expense', reqType: 'New Purchase', category: 'Professional Services', item: 'Annual brand photoshoot', vendor: 'StudioPixel',
    currency: 'INR', amount: 90000, rate: 45000, qty: 2, frequency: 'One-time', needBy: '01 Jul 2026', expenseMonth: '2026-07', vendorGst: '29ABCDE1234F1Z5', vendorPhone: '+91 98xxxx1234', vendorEmail: 'sales@studiopixel.in', budgetTaken: 'No', quotesAvail: 'Yes', quotes: ['#q1', '#q2', '#q3'], purpose: 'Refresh brand imagery.',
    stage: 'mgmt', status: 'Pending Sanjay (CEO) Approval', hod: 'Approved', finance: 'Approved', mgmtD: '', comments: '[Finance · accounts · 20 Jun 2026] Approved — >₹75k, routing to CEO.' },
  { id: 'EXP-20260620-CD34', name: 'Neha Singh', email: 'neha@spyne.ai', dept: 'Technology', nature: 'Expense', reqType: 'New Subscription', category: 'Software / SaaS', item: 'Linear (15 seats)', vendor: 'Linear',
    currency: 'INR', amount: 32000, frequency: 'One-time', needBy: '28 Jun 2026', budgetTaken: 'Yes', budgetLine: 'BUD-…TECH · SaaS tools', quotesAvail: 'Yes', quotes: ['#q1', '#q2', '#q3'], purpose: 'Issue tracking for the team.',
    stage: 'dept', status: 'Pending HOD Approval', hod: '', finance: '', mgmtD: '', comments: '' },
  { id: 'EXP-20260619-EF56', name: 'Imran Khan', email: 'imran@spyne.ai', dept: 'HR, IT & Admin', nature: 'Asset', reqType: 'New Purchase', category: 'Hardware / Equipment', item: 'Office NAS server', vendor: 'Synology',
    currency: 'INR', amount: 350000, frequency: 'One-time', needBy: '10 Jul 2026', budgetTaken: 'No', quotesAvail: 'Yes', quotes: ['#q1', '#q2', '#q3'], purpose: 'Shared storage for the office.',
    stage: 'po', status: 'Approved — Finance to issue PO', hod: 'Approved', finance: 'Approved', mgmtD: 'Approved', comments: '[Sanjay (CEO) · sanjay · 19 Jun 2026] Approved — >₹3L Asset.' },
  { id: 'EXP-20260618-GH78', name: 'Priya Sharma', email: 'priya@spyne.ai', dept: 'GTM Sales & Marketing', nature: 'Expense', reqType: 'New Purchase', category: 'Events', item: 'Team offsite venue', vendor: 'Taj Bengaluru',
    currency: 'INR', amount: 18000, frequency: 'One-time', needBy: '22 Jun 2026', budgetTaken: 'No', quotesAvail: 'N/A', quotes: [], purpose: 'Quarterly team offsite for 12.',
    stage: 'payment', status: 'Invoice submitted — Payment Approval', hod: 'Approved', finance: 'Approved', mgmtD: '', invoiceDoc: '#inv', comments: '' },
  { id: 'EXP-20260617-IJ90', name: 'Karan Mehta', email: 'karan@spyne.ai', dept: 'Technology', nature: 'Expense', reqType: 'New Subscription', category: 'Software / SaaS', item: 'Premium Grammarly (8 seats)', vendor: 'Grammarly',
    currency: 'INR', amount: 9600, frequency: 'Yearly', needBy: '01 Jul 2026', budgetTaken: 'No', quotesAvail: 'N/A', quotes: [], purpose: 'Writing assistant.',
    stage: 'rejected', status: 'Rejected at Department Head', hod: 'Rejected', finance: '', mgmtD: '', comments: '[Department Head · jatin · 17 Jun 2026] Rejected — use the enterprise plan.' },
  { id: 'EXP-20260616-MN20', name: 'Finance Demo', email: 'finance.demo@spyne.ai', dept: 'Finance & Account', nature: 'Expense', reqType: 'New Purchase', category: 'Office & Facilities', item: 'Standing desk', vendor: 'Featherlite',
    currency: 'INR', amount: 15000, frequency: 'One-time', needBy: '30 Jun 2026', budgetTaken: 'No', quotesAvail: 'N/A', quotes: [], purpose: 'Ergonomic desk.',
    stage: 'invoice', status: 'Approved — submit e-invoice', hod: 'Approved', finance: 'Approved', mgmtD: '', comments: '' },
  { id: 'EXP-20260621-DUP1', name: 'Neha Singh', email: 'neha@spyne.ai', dept: 'Technology', nature: 'Expense', reqType: 'New Subscription', category: 'Software / SaaS', item: 'Linear (15 seats)', vendor: 'Linear',
    currency: 'INR', amount: 32000, frequency: 'One-time', needBy: '29 Jun 2026', expenseMonth: '2026-07', budgetTaken: 'Yes', budgetLine: 'BUD-…TECH · SaaS tools', quotesAvail: 'Yes', quotes: ['#q1', '#q2', '#q3'], purpose: 'Re-raised by mistake.',
    stage: 'dept', status: 'Pending HOD Approval', hod: '', finance: '', mgmtD: '', comments: '' },
  { id: 'EXP-20260615-PAY1', name: 'Deepak Rao', email: 'deepak@spyne.ai', dept: 'GTM Sales & Marketing', nature: 'Expense', reqType: 'New Purchase', category: 'Marketing', item: 'Trade-show booth build', vendor: 'ExpoWorks',
    currency: 'INR', amount: 200000, frequency: 'One-time', needBy: '20 Jun 2026', budgetTaken: 'No', quotesAvail: 'Yes', quotes: ['#q1', '#q2', '#q3'], purpose: 'Booth for the Q2 expo.',
    stage: 'paying', status: 'Partially paid — INR 80,000 of INR 200,000', hod: 'Approved', finance: 'Approved', mgmtD: 'Approved',
    invoiceDoc: '#inv', invoiceDocs: ['#inv1', '#inv2'], invoiceGst: 36000, invoiceGstin: '29ABCDE1234F1Z5',
    invoiceRegion: 'India', invoiceBase: 164000, invoiceTotal: 200000, invoiceNumber: 'EXPO/26/118', invoiceVDate: '24 Jun 2026', invoiceCategory: 'Marketing',
    vendorCountry: 'India', vendorEntity: '',
    payments: [{ amount: 80000, date: '2026-06-25T00:00:00Z', mode: 'NEFT', ref: 'UTR9931', by: 'accounts' }], comments: '[Payment — Finance · accounts · 25 Jun 2026] Approved for payment.' },
  { id: 'EXP-20260624-USW9', name: 'Meera Iyer', email: 'meera@spyne.ai', dept: 'Technology', nature: 'Expense', reqType: 'New Subscription', category: 'Software / SaaS', item: 'Vercel Enterprise', vendor: 'Vercel Inc',
    currency: 'USD', amount: 2000, frequency: 'Monthly', needBy: '01 Jul 2026', budgetTaken: 'No', quotesAvail: 'N/A', quotes: [], purpose: 'Hosting.',
    vendorCountry: 'United States', vendorEntity: 'LLC', w9Doc: '#w9',
    stage: 'finance', status: 'Pending Finance Approval', hod: 'Approved', finance: '', mgmtD: '', comments: '' },
  { id: 'EXP-20260622-MINE1', name: 'Finance Demo', email: 'finance.demo@spyne.ai', dept: 'Finance & Account', nature: 'Expense', reqType: 'New Purchase', category: 'Office & Facilities', item: 'Whiteboards ×3', vendor: 'OfficeMart',
    currency: 'INR', amount: 12000, frequency: 'One-time', needBy: '05 Jul 2026', vendorEmail: 'sales@officemart.in', budgetTaken: 'No', quotesAvail: 'N/A', quotes: [], purpose: 'Meeting rooms.',
    stage: 'dept', status: 'Pending HOD Approval', hod: '', finance: '', mgmtD: '', comments: '' },
  { id: 'EXP-20260623-MINE2', name: 'Finance Demo', email: 'finance.demo@spyne.ai', dept: 'Finance & Account', nature: 'Expense', reqType: 'New Subscription', category: 'Software / SaaS', item: 'Calendly Pro', vendor: 'Calendly',
    currency: 'USD', amount: 120, frequency: 'Yearly', needBy: '10 Jul 2026', vendorEmail: 'billing@calendly.com', budgetTaken: 'No', quotesAvail: 'N/A', quotes: [], purpose: 'Scheduling tool.',
    stage: 'amend', status: 'Sent back for amendment (by Finance)', hod: 'Approved', finance: '', mgmtD: '', comments: '[Finance · accounts · 22 Jun 2026] Please attach the renewal quote.' },
];
// Mock aging (days at current stage) + raw timestamp, by stage — for the dashboard aging/overdue UI.
const AGE_BY_STAGE = { dept: 2, finance: 4, mgmt: 8, payment: 6, payment_mgmt: 5 };
function detail(o) {
  return { nature: o.nature || 'Expense', reqType: o.reqType, category: o.category, item: o.item, vendor: o.vendor, currency: o.currency, amount: o.amount, frequency: o.frequency, annual: annualOf(o),
    vendorGst: o.vendorGst || '', vendorPhone: o.vendorPhone || '', vendorEmail: o.vendorEmail || '', rate: o.rate || 0, qty: o.qty || 0, expenseMonth: o.expenseMonth || '',
    needBy: o.needBy, purpose: o.purpose, notes: o.notes || '', tier: tier(o), budgetTaken: o.budgetTaken, budgetLine: o.budgetLine || '', oob: o.oob || '',
    quotesAvail: o.quotesAvail, quotes: o.quotes || [], quotesReason: o.quotesReason || '', doc: o.doc || '', poNumber: o.poNumber || '', poDate: o.poNumber ? '20 Jun 2026' : '', delivery: o.delivery || '', deliveryDate: o.delivery ? '20 Jun 2026' : '', invoiceDoc: o.invoiceDoc || '', invoiceDate: o.invoiceDoc ? '20 Jun 2026' : '',
    vendorCountry: o.vendorCountry || '', vendorEntity: o.vendorEntity || '', w9Doc: o.w9Doc || '',
    invoiceDocs: o.invoiceDocs || (o.invoiceDoc ? [o.invoiceDoc] : []), invoiceRegion: o.invoiceRegion || '', invoiceBase: o.invoiceBase || 0, invoiceTax: o.invoiceGst || 0, invoiceTotal: o.invoiceTotal || 0, invoiceGstin: o.invoiceGstin || '', invoiceNumber: o.invoiceNumber || '', invoiceVDate: o.invoiceVDate || '', invoiceCategory: o.invoiceCategory || '' };
}
function base(o) {
  return { id: o.id, name: o.name, email: o.email, dept: o.dept, reqType: o.reqType, category: o.category, item: o.item, vendor: o.vendor, purpose: o.purpose,
    currency: o.currency, amount: o.amount, frequency: o.frequency, amountLabel: money(o.amount, o.currency), tier: tier(o), nature: o.nature || 'Expense', capex: isCapexN(o), mgmt: mgmtReq(o), quotesReq: quotesReq(o), budgeted: o.budgetTaken === 'Yes',
    needBy: o.needBy, submission: '20 Jun 2026', detail: detail(o), stage: o.stage, status: o.status, comments: o.comments || '' };
}
function approvalsResp(as, roles) {
  const isFin = true; // demo = finance superuser
  const lens = (as && ['dept', 'finance', 'mgmt'].includes(as)) ? as : null;
  if (lens) {
    const readOnly = !isFin; // finance superuser can act on every lens (dept/finance/mgmt)
    const decKey = { dept: 'hod', finance: 'finance', mgmt: 'mgmtD' }[lens];
    const list = R.filter((o) => lens === 'mgmt' ? mgmtReq(o) : true);
    const rows = list.map((o) => { const s = base(o); s.pending = !readOnly && o.stage === lens; s.held = false; s.canPO = false; s.myStage = lens; s.decision = /approv/i.test(o[decKey] || '') ? 'Approved' : (/reject/i.test(o[decKey] || '') ? 'Rejected' : ''); return s; });
    return { scope: { dept: 'All — Department Head stage', finance: 'All — Finance stage', mgmt: 'All — Management stage' }[lens], rows, readOnly, lens };
  }
  const rows = R.map((o) => { const s = base(o); s.pending = ['finance', 'payment'].includes(o.stage); s.canPO = o.stage === 'po'; s.held = false; s.myStage = o.stage; s.decision = /approv/i.test(o.finance) ? 'Approved' : '';
    s.canRecallApproval = ['mgmt', 'po', 'delivery', 'invoice', 'payment', 'payment_mgmt', 'done'].includes(o.stage) && o.finance === 'Approved' && !/paid|reject/i.test(o.status); return s; });
  return { scope: 'Finance — Approvals, PO & Payments', rows, readOnly: false, lens: null, analytics: mockAnalytics() };
}
function mockAnalytics() {
  const byCategory = {}, byDept = {}, byStage = {};
  let count = 0, pipelineINR = 0, paidINR = 0, oob = 0, overdue = 0;
  R.forEach((o) => {
    if (o.stage === 'scrapped') return;
    const amt = toINR(o.amount, o.currency); const rej = /reject/i.test(o.status) || o.stage === 'rejected';
    count++; const lbl = ({ dept: 'Department Head', finance: 'Finance', mgmt: 'Sanjay (CEO)', po: 'PO issuance', delivery: 'Delivery', invoice: 'e-Invoice', payment: 'Payment — Finance', payment_mgmt: 'Payment — Management', paying: 'Disbursement', done: 'Paid', rejected: 'Rejected', amend: 'Amendment' })[o.stage] || o.stage;
    if (!rej) { byCategory[o.category || 'Uncategorised'] = (byCategory[o.category || 'Uncategorised'] || 0) + amt; byDept[o.dept || '—'] = (byDept[o.dept || '—'] || 0) + amt; }
    byStage[lbl] = (byStage[lbl] || 0) + 1;
    if (o.stage === 'done') paidINR += amt; else if (!rej) pipelineINR += amt;
    if (!rej && o.budgetTaken === 'No') oob++;
    if (['dept', 'finance', 'mgmt', 'payment', 'payment_mgmt'].includes(o.stage) && (AGE_BY_STAGE[o.stage] || 0) >= 3) overdue++;
  });
  return { count, pipelineINR, paidINR, oob, overdue, showDept: true, byCategory, byDept, byStage };
}
function mineResp() {
  const rows = R.filter((o) => o.email === ME.email).map((o) => { const s = base(o); s.hod = o.hod || 'Pending'; s.finance = o.finance || (isAfter(o.stage, 'finance') ? 'Approved' : 'Waiting'); s.mgmtStatus = mgmtReq(o) ? (o.mgmtD || (isAfter(o.stage, 'mgmt') ? 'Approved' : 'Pending')) : 'N/A'; s.po = o.poNumber ? ('PO ' + o.poNumber) : ''; s.deliveryStatus = o.delivery || (o.stage === 'delivery' ? 'Awaiting' : ''); s.invoiceStatus = o.invoiceDoc ? 'Submitted' : (o.stage === 'invoice' ? 'Awaiting' : ''); s.payStatus = /paid/i.test(o.status) ? 'Paid' : (['payment', 'payment_mgmt'].includes(o.stage) ? 'Pending' : ''); s.canConfirmDelivery = o.stage === 'delivery'; s.canSubmitInvoice = o.stage === 'invoice';
    s.canRecall = ['dept', 'finance', 'mgmt'].includes(o.stage); s.canWithdraw = ['dept', 'finance', 'mgmt', 'po', 'delivery', 'invoice', 'payment', 'payment_mgmt'].includes(o.stage); s.canAmend = o.stage === 'amend'; return s; });
  return { rows };
}
function financeResp() {
  const summaries = {}; const rows = R.map((o) => {
    const cur = o.currency; if (!summaries[cur]) summaries[cur] = { count: 0, pending: 0, paid: 0, rejected: 0, totalPipeline: 0, totalPaid: 0 };
    const sm = summaries[cur]; sm.count++; const rej = /reject/i.test(o.status), paid = o.stage === 'done';
    if (rej) sm.rejected++; else if (paid) { sm.paid++; sm.totalPaid += o.amount; } else sm.pending++; if (!rej) sm.totalPipeline += o.amount;
    const s = base(o); s.hodStatus = o.hod || 'Pending'; s.financeStatus = o.finance || (isAfter(o.stage, 'finance') ? 'Approved' : 'Pending'); s.mgmtStatus = mgmtReq(o) ? (o.mgmtD || (isAfter(o.stage, 'mgmt') ? 'Approved' : 'Pending')) : 'N/A';
    s.poNumber = o.poNumber || ''; s.deliveryStatus = o.delivery || ''; s.invoiceStatus = o.invoiceDoc ? 'Submitted' : '';
    s.invoiceGst = o.invoiceGst || 0; s.invoiceGstin = o.invoiceGstin || ''; s.invoiceDocs = o.invoiceDocs || (o.invoiceDoc ? [o.invoiceDoc] : []);
    s.payments = o.payments || []; s.paidToDate = s.payments.reduce((a, x) => a + (Number(x.amount) || 0), 0); s.paymentTotal = o.amount; s.paymentBalance = Math.max(0, o.amount - s.paidToDate); s.canRecordPayment = o.stage === 'paying';
    s.payStatus = paid ? 'Paid' : (o.stage === 'paying' ? (s.paidToDate > 0 ? 'Partly paid' : 'To disburse') : (['payment', 'payment_mgmt'].includes(o.stage) ? 'Pending' : '')); s.canPO = o.stage === 'po'; s.finalStatus = o.status;
    s.amountINR = o.currency === 'USD' ? Math.round(o.amount * 92) : o.amount;
    s.outOfBudget = o.budgetTaken === 'No'; s.held = false; s.tsRaw = (o.expenseMonth || '2026-06') + '-15T00:00:00Z';
    s.ageDays = (AGE_BY_STAGE[o.stage] != null) ? AGE_BY_STAGE[o.stage] : null; s.stageSince = s.tsRaw;
    s.escalated = s.ageDays != null && s.ageDays >= 3;
    var t0 = new Date(s.tsRaw).getTime();
    s.deptTimeRaw = o.hod ? new Date(t0 + 1 * 864e5).toISOString() : '';
    s.finTimeRaw = o.finance ? new Date(t0 + 3 * 864e5).toISOString() : '';
    s.mgmtTimeRaw = o.mgmtD ? new Date(t0 + 6 * 864e5).toISOString() : '';
    return s;
  });
  return { currencySummaries: summaries, rows };
}
function line(id, head, amount, vendors, frequency) { const v = vendors || []; const spent = v.reduce((a, x) => a + x.amount, 0); return { id, head, amount, frequency: frequency || 'One-time', vendors: v, spent, remaining: amount - spent }; }
function budgetResp() {
  const b1lines = [line('l1', 'SaaS tools', 600000, [{ vendor: 'Figma', amount: 103500, note: 'Org plan', by: 'arjun', date: '2026-06-20' }, { vendor: 'Datadog', amount: 64400, note: 'Monitoring', by: 'imran', date: '2026-06-19' }], 'Monthly'), line('l2', 'Hardware', 400000, [{ vendor: 'Dell', amount: 32000, note: 'Monitor', by: 'neha', date: '2026-06-20' }], 'One-time'), line('l3', 'Cloud / Infra', 800000, [{ vendor: 'AWS', amount: 250000, note: 'Q1 usage', by: 'jatin', date: '2026-06-15' }], 'Monthly'), { ...line('l4', 'Events', 120000, [{ vendor: 'Venue', amount: 120000, note: 'Q1 meetup', by: 'neha', date: '2026-06-10' }], 'One-time'), closed: true, carried: 0 }];
  // Commitment tracking demo: some lines have approved-but-unpaid (in-flight) expense requests.
  const COMMIT = { l1: { c: 50000, n: 1 }, l3: { c: 120000, n: 2 } };
  b1lines.forEach((l) => { const c = COMMIT[l.id]; l.committed = c ? c.c : 0; l.committedCount = c ? c.n : 0; l.available = l.amount - l.spent - l.committed; });
  const t1 = b1lines.reduce((a, l) => a + l.amount, 0), s1 = b1lines.reduce((a, l) => a + l.spent, 0), c1 = b1lines.reduce((a, l) => a + (l.committed || 0), 0);
  const rows = [
    { id: 'BUD-20260601-TECH', type: 'budget', parent: '', creator: 'jatin@spyne.ai', dept: 'Technology', period: 'FY 2026-27', currency: 'INR', title: 'Technology — FY 2026-27', status: 'Locked', stage: 'locked', submission: '01 Jun 2026', hod: 'Approved', finance: 'Approved', mgmt: 'Approved', lines: b1lines, detail: null, total: t1, spent: s1, committed: c1, remaining: t1 - s1, available: t1 - s1 - c1,
      history: [{ at: '01 Jun 2026', label: 'Created', detail: 'Budget raised for approval' }, { at: '02 Jun 2026', label: 'Department Head — Approved', detail: '' }, { at: '03 Jun 2026', label: 'CEO — Approved', detail: '' }, { at: '03 Jun 2026', label: 'Finance — Approved · budget locked', detail: '' }, { at: '15 Jun 2026', label: 'Linked expense — "Cloud / Infra"', detail: 'AWS · ₹2,50,000 · Q1 usage' }, { at: '18 Jun 2026', label: 'Reallocation RAL-20260618-TECH — pending', detail: 'Reallocate 100000: Hardware → Cloud / Infra' }], comments: '[Management · sanjay · 03 Jun 2026] Approved for FY26-27.', pending: false, canApprove: false, mine: null, isMine: false, locked: true, inScope: true },
    { id: 'BUD-20260610-MKTG', type: 'budget', parent: '', creator: 'ankit@spyne.ai', dept: 'GTM Sales & Marketing', period: 'Q2 FY2026-27', currency: 'USD', title: 'Marketing — Q2 (USD)', status: 'Pending CEO (Sanjay) Approval', stage: 'mgmt', submission: '10 Jun 2026', hod: 'Approved', finance: '', mgmt: '', lines: [line('m1', 'Paid ads', 50000, []), line('m2', 'Events', 30000, [])], detail: null, total: 80000, spent: 0, remaining: 80000, comments: '[Department Head · ankit · 10 Jun 2026] Approved — aligned to Q2 plan.', pending: false, canApprove: false, mine: null, isMine: false, locked: false, inScope: true },
    { id: 'RAL-20260618-TECH', type: 'realloc', parent: 'BUD-20260601-TECH', creator: 'jatin@spyne.ai', dept: 'Technology', period: 'FY 2026-27', currency: 'INR', title: 'Reallocate 100000: Hardware → Cloud / Infra', status: 'Pending Finance Approval', stage: 'finance', submission: '18 Jun 2026', hod: 'Approved', finance: '', mgmt: '', lines: [], detail: { fromId: 'l2', fromHead: 'Hardware', toId: 'l3', toHead: 'Cloud / Infra', amount: 100000, reasonUnused: 'Laptop refresh deferred to FY27', reasonNeeded: 'Higher AWS usage from new workloads' }, total: 0, spent: 0, remaining: 0, comments: '[Department Head · jatin · 18 Jun 2026] Approved.', pending: true, canApprove: true, mine: 'finance', isMine: false, locked: false, inScope: true },
    { id: 'RAL-20260619-TECH', type: 'realloc', parent: 'BUD-20260601-TECH', creator: 'jatin@spyne.ai', dept: 'Technology', period: 'FY 2026-27', currency: 'INR', title: 'Drop 50000 from Hardware', status: 'Pending HOD Approval', stage: 'dept', submission: '19 Jun 2026', hod: '', finance: '', mgmt: '', lines: [], detail: { drop: true, fromId: 'l2', fromHead: 'Hardware', amount: 50000, reasonUnused: 'Refresh cancelled this year' }, total: 0, spent: 0, remaining: 0, comments: '', pending: false, canApprove: false, mine: null, isMine: false, locked: false, inScope: true },
    { id: 'CLM-20260620-TECH', type: 'claim', parent: 'BUD-20260601-TECH', creator: 'neha@spyne.ai', dept: 'Technology', period: 'FY 2026-27', currency: 'INR', title: 'Claim 40000 — SaaS tools: Notion annual', status: 'Pending Finance Approval', stage: 'finance', submission: '20 Jun 2026', hod: 'Approved', finance: '', mgmt: '', lines: [], detail: { lineId: 'l1', lineHead: 'SaaS tools', expense: 'Notion annual', vendor: 'Notion', amount: 40000 }, total: 0, spent: 0, remaining: 0, comments: '[Department Head · jatin · 20 Jun 2026] Approved.', pending: true, canApprove: true, mine: 'finance', isMine: false, locked: false, inScope: true },
  ];
  rows.forEach((r) => { r.canClose = (r.type === 'budget' && r.locked); r.canFinanceAdd = (r.type === 'budget' && r.locked); r.closed = false; r.ageDays = (['dept', 'finance', 'mgmt'].includes(r.stage) ? (AGE_BY_STAGE[r.stage] != null ? AGE_BY_STAGE[r.stage] : 1) : null); });
  return { rows, periods: ['FY 2026-27', 'Q1 FY2026-27', 'Q2 FY2026-27', 'Q3 FY2026-27', 'Q4 FY2026-27'], isApprover: true };
}
function pickerResp(dept) {
  const d = String(dept || '').toLowerCase();
  const budgets = budgetResp().rows.filter((r) => r.type === 'budget' && r.locked && (!d || String(r.dept).toLowerCase() === d))
    .map((r) => ({ id: r.id, title: r.title, period: r.period, dept: r.dept, currency: r.currency || 'INR', lines: r.lines.map((l) => ({ id: l.id, head: l.head, amount: l.amount, spent: l.spent, remaining: l.remaining })) }));
  return { budgets };
}
function accessResp() {
  const depts = Object.keys(CONFIG.DEPARTMENTS);
  const finance = ['finance@spyne.ai', 'accounts@spyne.ai'];
  const assignments = { ceo: CONFIG.CEO_EMAIL, finance, depts: Object.fromEntries(depts.map((d) => [d, String(CONFIG.DEPARTMENTS[d].email || '').toLowerCase()])) };
  const hodEmails = depts.map((d) => String(CONFIG.DEPARTMENTS[d].email || '').toLowerCase());
  const map = {};
  R.forEach((o) => { const e = String(o.email || '').toLowerCase(); if (!e) return; const c = map[e] || { email: e, name: o.name || '', count: 0 }; c.count++; if (!c.name && o.name) c.name = o.name; map[e] = c; });
  [assignments.ceo, ...finance, ...Object.values(assignments.depts)].forEach((e) => { e = String(e || '').toLowerCase(); if (e && !map[e]) map[e] = { email: e, name: '', count: 0 }; });
  const rolesOf = (e) => { const r = ['requester']; if (hodEmails.includes(e)) r.push('hod'); if (e === String(CONFIG.CEO_EMAIL).toLowerCase()) r.push('ceo'); if (finance.includes(e)) r.push('finance'); return r; };
  const users = Object.values(map).map((u) => ({ ...u, roles: rolesOf(u.email) })).sort((a, b) => b.count - a.count);
  // Vendor master (de-duplicated, with a spelling-variant demo).
  const vmap = {};
  R.forEach((o) => { const v = String(o.vendor || '').trim(); if (!v) return; const k = v.toLowerCase().replace(/\b(pvt|ltd|inc|technologies|india)\b/g, '').replace(/\s+/g, ' ').trim() || v.toLowerCase();
    const e = vmap[k] || { vendor: v, gst: '', phone: '', email: '', count: 0, spellings: {} }; if (o.vendorGst) e.gst = o.vendorGst; if (o.vendorEmail) e.email = o.vendorEmail; e.count++; e.spellings[v] = 1; vmap[k] = e; });
  const vendors = Object.values(vmap).map((e) => { e.variants = Object.keys(e.spellings).length; delete e.spellings; return e; }).sort((a, b) => b.count - a.count);
  if (!vendors.length) vendors.push({ vendor: 'Figma', gst: '', phone: '', email: '', count: 3, variants: 2 }, { vendor: 'AWS', gst: '29ABCDE1234F1Z5', phone: '', email: 'billing@aws.com', count: 5, variants: 1 });
  return { ok: true, assignments, departments: depts, users, delegations: DELEGATIONS.map((d) => ({ ...d, active: true })), vendors };
}
let DELEGATIONS = [{ approver: 'jatin@spyne.ai', delegate: 'amit@spyne.ai', from: '', to: '', note: 'Covering while on leave', active: true }];
function json(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

http.createServer((req, res) => {
  const url = req.url.split('?')[0]; const qs = req.url.split('?')[1] || '';
  if (req.method === 'POST') { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    if (url === '/api/submit') { let p = {}; try { p = JSON.parse(b || '{}'); } catch {}
      const dup = !p.allowDuplicate && R.find((o) => String(o.vendor || '').toLowerCase().trim() === String(p.vendor || '').toLowerCase().trim() && String(o.item || '').toLowerCase().trim() === String(p.item || '').toLowerCase().trim() && String(o.dept || '').toLowerCase().trim() === String(p.dept || '').toLowerCase().trim() && o.vendor);
      if (dup) return json(res, { ok: false, duplicate: true, dupId: dup.id, dupBy: dup.name, dupDate: '20 Jun 2026', error: 'Possible duplicate of ' + dup.id + ' — "' + dup.item + '" from ' + dup.vendor + ' raised 20 Jun 2026 and still active. Submit anyway only if this is genuinely separate.' });
      return json(res, { ok: true, id: 'EXP-MOCK-NEW', chain: ['HOD', 'Finance', 'e-Invoice', 'Payment', 'Paid'] });
    }
    if (url === '/api/access' || url === '/api/finance') { let p = {}; try { p = JSON.parse(b || '{}'); } catch {}
      if (p.action === 'scrap') return json(res, { ok: true, scrapped: (p.ids || []).length, notFound: [] });
      if (p.action === 'role') return json(res, { ok: true, key: p.key, value: p.value });
      if (p.action === 'delegate') { DELEGATIONS = DELEGATIONS.filter((d) => !(d.approver === p.approver && d.delegate === p.delegate)); DELEGATIONS.push({ approver: String(p.approver || '').toLowerCase(), delegate: String(p.delegate || '').toLowerCase(), from: p.from || '', to: p.to || '', note: p.note || '', active: true }); return json(res, { ok: true, approver: p.approver, delegate: p.delegate }); }
      if (p.action === 'undelegate') { DELEGATIONS = DELEGATIONS.filter((d) => !(d.approver === String(p.approver || '').toLowerCase() && (!p.delegate || d.delegate === String(p.delegate || '').toLowerCase()))); return json(res, { ok: true }); } }
    if (url === '/api/budget') { let p = {}; try { p = JSON.parse(b || '{}'); } catch {}
      if (p.action === 'create' && !p.allowDuplicate) {
        const dup = budgetResp().rows.find((r) => r.type === 'budget' && !['rejected', 'closed'].includes(r.stage) && String(r.dept || '').toLowerCase().trim() === String(p.dept || '').toLowerCase().trim() && String(r.period || '').toLowerCase().trim() === String(p.period || '').toLowerCase().trim());
        if (dup) return json(res, { ok: false, duplicate: true, dupId: dup.id, error: 'A budget for ' + p.dept + ' · ' + p.period + ' already exists (' + dup.id + '). Create anyway only if this is intentional.' });
      }
    }
    if (url === '/api/action') { let p = {}; try { p = JSON.parse(b || '{}'); } catch {}
      if (p.action === 'pay') {
        const o = R.find((x) => x.id === p.id);
        if (!o) return json(res, { ok: false, error: 'Request not found' });
        if (o.stage !== 'paying') return json(res, { ok: false, error: 'Not awaiting disbursement.' });
        o.payments = o.payments || [];
        const paidSoFar = o.payments.reduce((a, x) => a + (Number(x.amount) || 0), 0);
        const remaining = Math.max(0, o.amount - paidSoFar);
        let amt = Math.round(Number(p.amount) || 0); if (!(amt > 0)) amt = remaining;
        if (amt > remaining + 0.5) return json(res, { ok: false, error: 'Only ' + money(remaining, o.currency) + ' unpaid.' });
        o.payments.push({ amount: amt, date: new Date().toISOString(), mode: p.mode || '', ref: p.ref || '', by: 'accounts' });
        const paidNow = paidSoFar + amt, full = paidNow >= o.amount - 0.5;
        o.status = full ? 'Paid & closed' : ('Partially paid — ' + money(paidNow, o.currency) + ' of ' + money(o.amount, o.currency));
        if (full) o.stage = 'done';
        return json(res, { ok: true, fullyPaid: full, title: full ? 'Paid & closed' : 'Part payment recorded', msg: full ? 'Fully paid & closed.' : money(amt, o.currency) + ' recorded — ' + money(o.amount - paidNow, o.currency) + ' balance.' });
      }
      if (p.action === 'invoice') {
        const o = R.find((x) => x.id === p.id);
        if (o) { o.invoiceDoc = (p.invoiceDocs && p.invoiceDocs[0]) || p.invoiceDoc || '#inv'; o.invoiceDocs = p.invoiceDocs || [o.invoiceDoc]; o.invoiceGst = Number(p.gstAmount) || 0; o.invoiceGstin = (p.gstNumber || '').toUpperCase(); o.stage = 'payment'; o.status = 'Invoice submitted — Payment Approval'; }
        return json(res, { ok: true, title: 'Invoice submitted', msg: 'Invoice submitted (mock).' });
      }
    }
    json(res, { ok: true, title: 'Done (mock)', msg: 'Mock — no persistence.' });
  }); return; }
  if (url === '/api/me' && /vendors/.test(qs)) {
    const map = {};
    R.forEach((o) => { const v = (o.vendor || '').trim(); if (!v) return; const k = v.toLowerCase(); const e = map[k] || { vendor: v, gst: '', phone: '', email: '' }; if (o.vendorGst) e.gst = o.vendorGst; if (o.vendorPhone) e.phone = o.vendorPhone; if (o.vendorEmail) e.email = o.vendorEmail; map[k] = e; });
    return json(res, { vendors: Object.values(map) });
  }
  if (url === '/api/me') return json(res, /mine/.test(qs) ? mineResp() : ME);
  if (url === '/api/config') return json(res, CONFIG_RES);
  if (url === '/api/finance') return json(res, /view=access/.test(qs) ? accessResp() : financeResp());
  if (url === '/api/decision' && /view=approvals/.test(qs)) return json(res, approvalsResp((qs.match(/as=(\w+)/) || [])[1] || ''));
  if (url === '/api/budget' && /dept=/.test(qs)) return json(res, pickerResp(decodeURIComponent((qs.match(/dept=([^&]*)/) || [])[1] || '')));
  if (url === '/api/budget') return json(res, budgetResp());
  if (url === '/api/access') return json(res, accessResp());
  let f = url === '/' ? (process.env.PREVIEW_PAGE || '/index.html') : url;
  if (f === '/approvals') f = '/approvals.html'; if (f === '/finance') f = '/finance.html'; if (f === '/department') f = '/department.html'; if (f === '/my') f = '/my.html'; if (f === '/budget') f = '/budget.html'; if (f === '/exec') f = '/exec.html'; if (f === '/access') f = '/access.html';
  if (!path.extname(f)) f += '.html';
  try { const data = readFileSync(path.join(root, f)); const ext = path.extname(f); res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'text/plain' }); res.end(data); }
  catch { res.writeHead(404); res.end('not found'); }
}).listen(PORT, () => console.log('mock on ' + PORT));
