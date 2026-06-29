// ---------------------------------------------------------------------------
//  Static configuration & policy for the Expense / Purchase Approval workflow.
//  Approver emails can be overridden via env. Mirrors the Travel app's structure.
//  Approval flow (Spyne Expense Approval SOP v1.0):
//    Up to ₹50,000   →  Dept Head → Finance
//    Above ₹50,000   →  Dept Head → Sanjay (CEO) → Finance
//  Finance is ALWAYS the final approver.
// ---------------------------------------------------------------------------
export const CONFIG = {
  COMPANY_NAME: 'Spyne',
  COMPANY_DOMAIN: 'spyne.ai',
  APP_NAME: 'Expense Approval Dashboard',

  // Department -> Head of Department. Selecting a department auto-fills the HOD.
  DEPARTMENTS: {
    'GTM Sales & Marketing': { head: 'Ankit Khandelwal', email: 'ankit@spyne.ai' },
    'Finance & Account':     { head: 'Rahul Beruwar',    email: 'rahul@spyne.ai' },
    'Product':               { head: 'Amit Walia',       email: 'amit@spyne.ai' },
    'Technology':            { head: 'Jatin Jain',       email: 'jatin@spyne.ai' },
    'HR, IT & Admin':        { head: 'Sangeetha Swamy',  email: 'sangeetha@spyne.ai' },
    "CEO's Office":          { head: 'Madhav Prakash',   email: 'madhav.prakash@spyne.ai' },
    'Customer Success':      { head: 'Madhav Uppal',     email: 'madhav.uppal@spyne.ai' },
    'Onboarding':            { head: 'Jagrit Sawhney',   email: 'jagrit@spyne.ai' },
  },

  CEO_EMAIL:    process.env.CEO_EMAIL    || 'sanjay@spyne.ai',   // Sanjay Varnwal — approves > ₹50k
  CEO_NAME:     process.env.CEO_NAME     || 'Sanjay Varnwal',
  FINANCE_SPOC: process.env.FINANCE_SPOC || 'finance@spyne.ai',  // Finance Team — final approval
  FINANCE_NAME: 'Finance Team',

  CC_REQUESTER_ON_UPDATES: true,
};

export const POLICY = {
  QUOTE_THRESHOLD_INR: Number(process.env.QUOTE_THRESHOLD_INR || 20000), // ≥ this → 3 quotations required

  // CEO is added (after Finance) when the amount exceeds the nature-specific threshold (INR):
  //   Expense (one-time)  > ₹75,000      Expense (recurring/annualised) > ₹2,40,000
  //   Capex / Asset        > ₹3,00,000
  CEO_EXPENSE_ONETIME_INR:   Number(process.env.CEO_EXPENSE_ONETIME_INR   || 75000),
  CEO_EXPENSE_RECURRING_INR: Number(process.env.CEO_EXPENSE_RECURRING_INR || 240000),
  CEO_CAPEX_INR:             Number(process.env.CEO_CAPEX_INR             || 300000),

  // Nature of spend. Capex is offered only to CAPEX_DEPTS (IT); everyone else → Expense.
  // ('Asset' was retired from the dropdown 2026-06-23; isCapex still recognises it for legacy records.)
  NATURES: ['Expense', 'Capex'],
  CAPEX_DEPTS: ['HR, IT & Admin'],

  // App FX rate used ONLY to normalise USD amounts for the threshold checks (not an accounting rate).
  FX_USD_INR: Number(process.env.FX_USD_INR || 92),

  // Form vocabularies.
  REQUEST_TYPES: ['New Purchase', 'New Subscription', 'Renewal'],
  CATEGORIES: [
    'Software / SaaS', 'Hardware / Equipment', 'Cloud / Infrastructure',
    'Professional Services', 'Marketing', 'Office & Facilities',
    'Events', 'Travel', 'Other',
  ],
  // Billing frequency -> multiplier to annualise the amount (One-time counts once).
  FREQUENCIES: { 'One-time': 1, 'Monthly': 12, 'Quarterly': 4, 'Half-yearly': 2, 'Yearly': 1 },
  CURRENCIES: ['INR', 'USD'],
};

// Sheet column headers (order matters — this is the row layout in Google Sheets).
export const COL = {
  ID: 'Request ID', TS: 'Timestamp', EMAIL: 'Requester Email', NAME: 'Name', EMPID: 'Employee ID',
  DEPT: 'Department', HOD: 'HOD Email',
  REQTYPE: 'Request Type', CATEGORY: 'Category', ITEM: 'Item / Service', VENDOR: 'Vendor / Supplier',
  CURRENCY: 'Currency', AMOUNT: 'Amount', FREQUENCY: 'Billing', ANNUAL: 'Annualised Amount',
  AMOUNT_INR: 'Amount (INR equiv)', NEEDBY: 'Needed By', PURPOSE: 'Purpose / Justification',
  NOTES: 'Notes', TIER: 'Approval Tier',
  // Budget gate (Stage-1 budget module comes later; for now captured as text)
  BUDGET_TAKEN: 'Budget Taken', BUDGET_LINE: 'Budget Line', OOB_JUST: 'Out-of-Budget Justification',
  // Quotations (≥ quote threshold)
  QUOTES_AVAIL: '3 Quotations Available', QUOTE1: 'Doc: Quotation 1', QUOTE2: 'Doc: Quotation 2',
  QUOTE3: 'Doc: Quotation 3', QUOTES_REASON: 'Fewer-Quotations Reason', DOC_QUOTE: 'Doc: Quotation / Proforma',
  // Workflow state
  STATUS: 'Status', STAGE: 'Stage', TOKEN: 'Token',
  DEPT_DEC: 'Dept Head Decision', DEPT_TIME: 'Dept Head Time',
  FIN_DEC: 'Finance Decision', FIN_TIME: 'Finance Time',
  MGMT_DEC: 'Management Decision', MGMT_TIME: 'Management Time',
  // Post-approval lifecycle
  PO_NUMBER: 'PO Number', PO_DATE: 'PO Date',
  DELIVERY: 'Delivery Status', DELIVERY_DATE: 'Delivery Date',
  INVOICE_DOC: 'Doc: e-Invoice', INVOICE_DATE: 'Invoice Date',
  PAY_FIN_DEC: 'Payment — Finance', PAY_MGMT_DEC: 'Payment — Management', PAY_DATE: 'Payment Date',
  // Reminders + approver workflow
  LAST_REMINDER: 'Last Reminder', REMINDER_COUNT: 'Reminder Count',
  HOLD: 'On Hold', COMMENTS: 'Approver Comments',
  // Linkage to an approved budget line (Point 2) — appended at the end so existing rows stay aligned
  BUDGET_ID: 'Linked Budget ID', BUDGET_LINE_ID: 'Linked Budget Line ID',
  NATURE: 'Nature',
  // Extra fields pulled from the legacy Google Form
  VENDOR_GST: 'Vendor GST / PAN', VENDOR_PHONE: 'Vendor Phone', VENDOR_EMAIL: 'Vendor Email',
  RATE: 'Rate per Unit', QTY: 'Quantity', EXPENSE_MONTH: 'Expense Month',
  // Optional link to a TravelDesk request (TRF-…) so trip spend reconciles against its estimate.
  TRAVEL_ID: 'Linked Travel Request (TRF)',
};

export const HEADERS = [
  COL.ID, COL.TS, COL.EMAIL, COL.NAME, COL.EMPID, COL.DEPT, COL.HOD,
  COL.REQTYPE, COL.CATEGORY, COL.ITEM, COL.VENDOR,
  COL.CURRENCY, COL.AMOUNT, COL.FREQUENCY, COL.ANNUAL, COL.AMOUNT_INR,
  COL.NEEDBY, COL.PURPOSE, COL.NOTES, COL.TIER,
  COL.BUDGET_TAKEN, COL.BUDGET_LINE, COL.OOB_JUST,
  COL.QUOTES_AVAIL, COL.QUOTE1, COL.QUOTE2, COL.QUOTE3, COL.QUOTES_REASON, COL.DOC_QUOTE,
  COL.STATUS, COL.STAGE, COL.TOKEN,
  COL.DEPT_DEC, COL.DEPT_TIME, COL.FIN_DEC, COL.FIN_TIME, COL.MGMT_DEC, COL.MGMT_TIME,
  COL.PO_NUMBER, COL.PO_DATE, COL.DELIVERY, COL.DELIVERY_DATE, COL.INVOICE_DOC, COL.INVOICE_DATE,
  COL.PAY_FIN_DEC, COL.PAY_MGMT_DEC, COL.PAY_DATE,
  COL.LAST_REMINDER, COL.REMINDER_COUNT, COL.HOLD, COL.COMMENTS,
  COL.BUDGET_ID, COL.BUDGET_LINE_ID, COL.NATURE,
  COL.VENDOR_GST, COL.VENDOR_PHONE, COL.VENDOR_EMAIL, COL.RATE, COL.QTY, COL.EXPENSE_MONTH,
  COL.TRAVEL_ID,
];

// ---------------------------------------------------------------------------
//  Auth & roles (Google sign-in, domain-locked). Role is derived from email.
//  Everyone in the domain is a 'requester'; HOD/CEO/Finance get extra roles.
// ---------------------------------------------------------------------------
function emailList(envVal, fallback) {
  return String(envVal || fallback || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const AUTH = {
  ALLOWED_DOMAIN: process.env.ALLOWED_DOMAIN || CONFIG.COMPANY_DOMAIN,
  FINANCE_EMAILS: emailList(process.env.FINANCE_EMAILS, `${CONFIG.FINANCE_SPOC},finance.head@spyne.ai`),
};

// Heads of department — anyone whose email is a department head gets the 'hod' role.
const HOD_EMAILS = Object.values(CONFIG.DEPARTMENTS).map((d) => String(d.email).toLowerCase());

// Departments a given email is the HOD of (usually one). Used to scope the HOD dashboard
// so each HOD sees ONLY their own department's requests.
export function deptsForHod(email) {
  const e = String(email || '').toLowerCase();
  return Object.keys(CONFIG.DEPARTMENTS).filter((d) => String(CONFIG.DEPARTMENTS[d].email).toLowerCase() === e);
}

export function rolesFor(email) {
  const e = String(email || '').toLowerCase();
  const roles = ['requester']; // any authenticated domain user can submit
  if (HOD_EMAILS.includes(e)) roles.push('hod');
  if (e === String(CONFIG.CEO_EMAIL).toLowerCase()) roles.push('ceo');
  if (AUTH.FINANCE_EMAILS.includes(e)) roles.push('finance');
  return roles;
}

// Roles that get the Approvals dashboard.
export function isApprover(roles) {
  return ['hod', 'ceo', 'finance'].some((r) => (roles || []).includes(r));
}

// Default landing view for a user's highest-privilege role.
export function homeFor(roles) {
  roles = roles || [];
  if (roles.includes('finance')) return '/finance';
  if (roles.includes('hod') || roles.includes('ceo')) return '/approvals';
  return '/';
}
