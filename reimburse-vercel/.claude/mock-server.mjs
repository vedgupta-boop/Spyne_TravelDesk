import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { POLICY, CONFIG } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8733;
function money(a, c) { c = c || 'INR'; return c + ' ' + Number(a || 0).toLocaleString(c === 'USD' ? 'en-US' : 'en-IN', { maximumFractionDigits: 0 }); }
function toINR(a, c) { return c === 'USD' ? Math.round(a * POLICY.FX_USD_INR) : a; }
function mgmtReq(o) { return toINR(o.amount, o.currency) > POLICY.CEO_THRESHOLD_INR; }
function tier(o) { const t = POLICY.CEO_THRESHOLD_INR.toLocaleString('en-IN'); return mgmtReq(o) ? ('High value — CEO required (total > ₹' + t + ')') : ('Standard — Dept Head → Finance (total ≤ ₹' + t + ')'); }
const ORDER = ['dept', 'finance', 'mgmt', 'pay', 'done'];
function isAfter(s, ref) { return ORDER.indexOf(s) > ORDER.indexOf(ref); }

const ME = { authenticated: true, email: 'finance.demo@spyne.ai', name: 'Finance Demo', roles: ['requester', 'finance', 'hod', 'ceo'] };
const CONFIG_RES = { company: CONFIG.COMPANY_NAME, appName: CONFIG.APP_NAME, domain: CONFIG.COMPANY_DOMAIN, ceoName: CONFIG.CEO_NAME, departments: CONFIG.DEPARTMENTS, policy: POLICY, userEmail: ME.email };

// demo claims
const R = [
  { id: 'RMB-20260624-AB12', name: 'Arjun Nair', email: 'arjun@spyne.ai', dept: 'Technology', title: 'Client visit — Mumbai (June)', project: 'ACME onboarding', currency: 'INR',
    advance: 0, periodFrom: '2026-06-10', periodTo: '2026-06-12', payMethod: 'Payroll (next salary cycle)', payDetail: 'a/c …4821', purpose: 'On-site debugging at customer office.', notes: '',
    lines: [{ date: '2026-06-10', category: 'Flights / Train', type: 'Expense', merchant: 'IndiGo', description: 'BLR→BOM flight (IndiGo)', amount: 6200, receipt: '#r1' }, { date: '2026-06-11', category: 'Fuel / Mileage', type: 'Mileage', description: 'Airport ↔ office · 38 km × 12/km', distance: 38, rate: 12, amount: 456, receipt: '' }, { date: '2026-06-11', category: 'Meals & Entertainment', type: 'Expense', merchant: 'Trident', description: 'Team dinner (Trident)', amount: 2800, receipt: '#r3' }],
    stage: 'dept', status: 'Pending HOD Approval', hod: '', finance: '', mgmtD: '', comments: '' },
  { id: 'RMB-20260623-CD34', name: 'Neha Singh', email: 'neha@spyne.ai', dept: 'GTM Sales & Marketing', title: 'Conference — SaaSBoomi', currency: 'INR',
    advance: 5000, periodFrom: '2026-06-15', periodTo: '2026-06-17', payMethod: 'Adjust against advance', payDetail: '', purpose: 'Attended SaaSBoomi annual conference.', notes: 'Advance of ₹5,000 already drawn.',
    lines: [{ date: '2026-06-15', category: 'Accommodation / Hotel', description: '2 nights', amount: 14000, receipt: '#r1' }, { date: '2026-06-15', category: 'Training / Courses', description: 'Conference ticket', amount: 18000, receipt: '#r2' }, { date: '2026-06-16', category: 'Meals & Entertainment', description: 'Meals', amount: 3200, receipt: '#r3' }],
    stage: 'mgmt', status: 'Pending Sanjay (CEO) Approval', hod: 'Approved', finance: 'Approved', mgmtD: '', comments: '[Finance · accounts · 23 Jun 2026] Approved — over ₹50k, routing to CEO.' },
  { id: 'RMB-20260622-EF56', name: 'Imran Khan', email: 'imran@spyne.ai', dept: 'HR, IT & Admin', title: 'Office supplies run', currency: 'INR',
    advance: 0, periodFrom: '2026-06-20', periodTo: '2026-06-20', payMethod: 'Petty cash', payDetail: '', purpose: 'Stationery and pantry restock.', notes: '',
    lines: [{ date: '2026-06-20', category: 'Office Supplies', description: 'Stationery', amount: 2400, receipt: '#r1' }, { date: '2026-06-20', category: 'Office Supplies', description: 'Pantry', amount: 1800, receipt: '#r2' }],
    stage: 'finance', status: 'Pending Finance Approval', hod: 'Approved', finance: '', mgmtD: '', comments: '[Department Head · sangeetha · 22 Jun 2026] Approved.' },
  { id: 'RMB-20260621-GH78', name: 'Finance Demo', email: 'finance.demo@spyne.ai', dept: 'Finance & Account', title: 'Internet reimbursement — June', currency: 'INR',
    advance: 0, periodFrom: '2026-06-01', periodTo: '2026-06-30', payMethod: 'Bank transfer (payroll account)', payDetail: '', purpose: 'Work-from-home broadband.', notes: '',
    lines: [{ date: '2026-06-01', category: 'Telephone / Internet', description: 'Broadband bill', amount: 1499, receipt: '#r1' }],
    stage: 'pay', status: 'Approved — awaiting payout', hod: 'Approved', finance: 'Approved', mgmtD: '', comments: '' },
  { id: 'RMB-20260618-IJ90', name: 'Karan Mehta', email: 'karan@spyne.ai', dept: 'Technology', title: 'Taxi to airport', currency: 'INR',
    advance: 0, periodFrom: '2026-06-15', periodTo: '2026-06-15', payMethod: 'Petty cash', payDetail: '', purpose: 'Late-night airport drop.', notes: '',
    lines: [{ date: '2026-06-15', category: 'Local Travel / Cab', description: 'Ola to BLR airport', amount: 900, receipt: '#r1' }],
    stage: 'rejected', status: 'Rejected at Department Head', hod: 'Rejected', finance: '', mgmtD: '', comments: '[Department Head · jatin · 18 Jun 2026] Rejected — covered by trip advance.' },
  { id: 'RMB-20260616-MN20', name: 'Priya Sharma', email: 'priya@spyne.ai', dept: 'Customer Success', title: 'Client lunch', currency: 'USD',
    advance: 0, periodFrom: '2026-06-12', periodTo: '2026-06-12', payMethod: 'Bank transfer (other)', payDetail: '', purpose: 'Lunch with US client.', notes: '',
    lines: [{ date: '2026-06-12', category: 'Client Entertainment', description: 'Lunch for 3', amount: 140, receipt: '#r1' }],
    stage: 'done', status: 'Reimbursed & closed', hod: 'Approved', finance: 'Approved', mgmtD: '', payRef: 'UTR-558210', payDate: '2026-06-19', paidAmount: 140, comments: '[Payout · accounts · 19 Jun 2026] Paid USD 140 · ref UTR-558210' },
];
const AGE_BY_STAGE = { dept: 2, finance: 4, mgmt: 8 };

function detail(o) {
  return { title: o.title, project: o.project || '', periodFrom: o.periodFrom, periodTo: o.periodTo, currency: o.currency,
    amount: amt(o), advance: o.advance || 0, net: net(o), lines: o.lines || [], lineCount: (o.lines || []).length,
    payMethod: o.payMethod || '', payDetail: o.payDetail || '', purpose: o.purpose || '', notes: o.notes || '', tier: tier(o),
    payRef: o.payRef || '', payDate: o.payDate || '', paidAmount: o.paidAmount || 0 };
}
function amt(o) { return (o.lines || []).reduce((a, l) => a + (l.amount || 0), 0); }
function net(o) { return Math.max(0, amt(o) - (o.advance || 0)); }
function base(o) {
  return { id: o.id, name: o.name, email: o.email, dept: o.dept, title: o.title, purpose: o.purpose, currency: o.currency,
    amount: amt(o), net: net(o), amountLabel: money(amt(o), o.currency), netLabel: money(net(o), o.currency),
    tier: tier(o), mgmt: mgmtReq(o), lineCount: (o.lines || []).length, submission: '24 Jun 2026', detail: detail(o),
    stage: o.stage, status: o.status, comments: o.comments || '' };
}
function approvalsResp(as) {
  const lens = (as && ['dept', 'finance', 'mgmt'].includes(as)) ? as : null;
  if (lens) {
    const readOnly = lens !== 'finance'; // demo is finance superuser
    const decKey = { dept: 'hod', finance: 'finance', mgmt: 'mgmtD' }[lens];
    const list = R.filter((o) => lens === 'mgmt' ? mgmtReq(o) : true);
    const rows = list.map((o) => { const s = base(o); s.pending = !readOnly && o.stage === lens; s.held = false; s.canPay = false; s.myStage = lens; s.decision = /approv/i.test(o[decKey] || '') ? 'Approved' : (/reject/i.test(o[decKey] || '') ? 'Rejected' : ''); return s; });
    return { scope: { dept: 'All — Department Head stage', finance: 'All — Finance stage', mgmt: 'All — Management stage' }[lens], rows, readOnly, lens };
  }
  const rows = R.map((o) => { const s = base(o); s.pending = ['dept', 'finance', 'mgmt'].includes(o.stage); s.canPay = o.stage === 'pay'; s.held = false; s.myStage = o.stage; s.decision = /approv/i.test(o.finance) ? 'Approved' : ''; return s; });
  return { scope: 'Finance — Approvals & Payouts', rows, readOnly: false, lens: null };
}
function mineResp() {
  const rows = R.filter((o) => o.email === ME.email).map((o) => { const s = base(o); s.hod = o.hod || 'Pending'; s.finance = o.finance || (isAfter(o.stage, 'finance') ? 'Approved' : 'Waiting'); s.mgmtStatus = mgmtReq(o) ? (o.mgmtD || (isAfter(o.stage, 'mgmt') ? 'Approved' : 'Pending')) : 'N/A'; s.payStatus = /reimbursed|paid/i.test(o.status) ? 'Paid' : (o.stage === 'pay' ? 'Pending' : ''); return s; });
  return { rows };
}
function financeResp() {
  const summaries = {}; const rows = R.map((o) => {
    const cur = o.currency; if (!summaries[cur]) summaries[cur] = { count: 0, pending: 0, paid: 0, rejected: 0, totalPipeline: 0, totalPaid: 0 };
    const sm = summaries[cur]; sm.count++; const rej = /reject/i.test(o.status), paid = /reimbursed|paid/i.test(o.status);
    if (rej) sm.rejected++; else if (paid) { sm.paid++; sm.totalPaid += (o.paidAmount || net(o)); } else sm.pending++; if (!rej && !paid) sm.totalPipeline += net(o);
    const s = base(o); s.hodStatus = o.hod || 'Pending'; s.financeStatus = o.finance || (isAfter(o.stage, 'finance') ? 'Approved' : 'Pending'); s.mgmtStatus = mgmtReq(o) ? (o.mgmtD || (isAfter(o.stage, 'mgmt') ? 'Approved' : 'Pending')) : 'N/A';
    s.payStatus = paid ? 'Paid' : (o.stage === 'pay' ? 'Awaiting payout' : ''); s.payRef = o.payRef || ''; s.payDate = o.payDate || ''; s.paidAmount = o.paidAmount || 0;
    s.canPay = o.stage === 'pay'; s.finalStatus = o.status; s.amountINR = toINR(amt(o), o.currency); s.held = false; s.tsRaw = '2026-06-24T00:00:00Z';
    s.ageDays = (AGE_BY_STAGE[o.stage] != null) ? AGE_BY_STAGE[o.stage] : null; s.stageSince = s.tsRaw;
    return s;
  });
  return { currencySummaries: summaries, rows };
}
function json(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

http.createServer((req, res) => {
  const url = req.url.split('?')[0]; const qs = req.url.split('?')[1] || '';
  if (req.method === 'POST') {
    let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
      if (url === '/api/submit') {
        let p = {}; try { p = JSON.parse(b || '{}'); } catch {}
        const dup = !p.allowDuplicate && R.find((o) => String(o.title || '').toLowerCase().trim() === String(p.title || '').toLowerCase().trim() && String(o.dept || '').toLowerCase().trim() === String(p.dept || '').toLowerCase().trim() && o.title && o.stage !== 'rejected');
        if (dup) return json(res, { ok: false, duplicate: true, dupId: dup.id, dupBy: dup.name, dupDate: '24 Jun 2026', error: 'Possible duplicate of ' + dup.id + ' — "' + dup.title + '" raised 24 Jun 2026 and still active. Submit anyway only if this is genuinely separate.' });
        const lineAmt = (l) => l.type === 'Mileage' ? Math.round((Number(l.distance) || 0) * (Number(l.rate) || POLICY.MILEAGE_RATE_PER_KM)) : (l.type === 'Per diem' ? Math.round((Number(l.days) || 0) * (Number(l.rate) || 0)) : Math.round(Number(l.amount) || 0));
        const total = (p.lines || []).reduce((a, l) => a + lineAmt(l), 0); const adv = Math.max(0, Number(p.advance) || 0);
        const mgmt = toINR(total, p.currency) > POLICY.CEO_THRESHOLD_INR;
        return json(res, { ok: true, id: 'RMB-MOCK-NEW', currency: p.currency || 'INR', amount: total, advance: adv, net: Math.max(0, total - adv), mgmt, chain: ['HOD', 'Finance', ...(mgmt ? ['Sanjay (CEO)'] : []), 'Payout'] });
      }
      if (url === '/api/upload') { return json(res, { ok: true, link: 'https://example.com/mock-receipt-' + Date.now(), id: 'mock' }); }
      json(res, { ok: true, id: 'RMB-MOCK', title: 'Done (mock)', msg: 'Mock — no persistence.' });
    });
    return;
  }
  if (url === '/api/me' && /keka/.test(qs)) return json(res, { available: true, ok: true, name: 'Finance Demo', employeeId: 'SPN-1001', email: ME.email });
  if (url === '/api/me') return json(res, /mine/.test(qs) ? mineResp() : ME);
  if (url === '/api/config') return json(res, CONFIG_RES);
  if (url === '/api/finance') return json(res, financeResp());
  if (url === '/api/decision' && /view=approvals/.test(qs)) return json(res, approvalsResp((qs.match(/as=(\w+)/) || [])[1] || ''));
  let f = url === '/' ? (process.env.PREVIEW_PAGE || '/index.html') : url;
  if (f === '/approvals') f = '/approvals.html'; if (f === '/finance') f = '/finance.html'; if (f === '/my') f = '/my.html'; if (f === '/login.html') f = '/login.html';
  if (!path.extname(f)) f += '.html';
  try {
    const data = readFileSync(path.join(root, f)); const ext = path.extname(f);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime }); res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(PORT, () => console.log('mock on ' + PORT));
