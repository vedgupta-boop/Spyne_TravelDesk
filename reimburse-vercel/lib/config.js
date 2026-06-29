// ---------------------------------------------------------------------------
//  Static configuration & policy for the out-of-pocket Reimbursement workflow.
//  Approver emails can be overridden via env. Mirrors the Travel / Expense apps.
//  Approval flow (Spyne Reimbursement SOP v1.0):
//    Total ≤ ₹50,000   →  Dept Head → Finance
//    Total > ₹50,000   →  Dept Head → Finance → Sanjay (CEO)
//  Finance records the payout once approvals are complete.
// ---------------------------------------------------------------------------
export const CONFIG = {
  COMPANY_NAME: 'Spyne',
  COMPANY_DOMAIN: 'spyne.ai',
  APP_NAME: 'ReimburseDesk',

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
  FINANCE_SPOC: process.env.FINANCE_SPOC || 'finance@spyne.ai',  // Finance Team — approves & pays out
  FINANCE_NAME: 'Finance Team',

  CC_REQUESTER_ON_UPDATES: true,
};

export const POLICY = {
  // CEO is added (after Finance) when the total claim exceeds this INR threshold.
  CEO_THRESHOLD_INR: Number(process.env.CEO_THRESHOLD_INR || 50000),

  // App FX rate used ONLY to normalise USD amounts for the threshold check (not an accounting rate).
  FX_USD_INR: Number(process.env.FX_USD_INR || 92),

  CURRENCIES: ['INR', 'USD'],

  // Expense categories for each claim line (out-of-pocket spend). Keka-aligned.
  CATEGORIES: [
    'Meals & Entertainment', 'Local Travel / Cab', 'Accommodation / Hotel',
    'Flights / Train', 'Fuel / Mileage', 'Per Diem / Daily Allowance',
    'Office Supplies', 'Software / Subscription', 'Client Entertainment',
    'Telephone / Internet', 'Medical', 'Training / Courses', 'Other',
  ],

  // Per-line expense type (Keka model). 'Mileage' = distance × rate; 'Per diem' = days × rate.
  EXPENSE_TYPES: ['Expense', 'Mileage', 'Per diem'],
  // Default conveyance rate per km (INR) for Mileage lines — tune per policy.
  MILEAGE_RATE_PER_KM: Number(process.env.MILEAGE_RATE_PER_KM || 12),

  // How the employee wants to be paid back. Keka routes approved claims to payroll.
  PAYMENT_METHODS: ['Payroll (next salary cycle)', 'Bank transfer (other)', 'Petty cash', 'Adjust against advance'],
};

// Sheet column headers (order matters — this is the row layout in Google Sheets).
export const COL = {
  ID: 'Claim ID', TS: 'Timestamp', EMAIL: 'Requester Email', NAME: 'Name', EMPID: 'Employee ID',
  DEPT: 'Department', HOD: 'HOD Email',
  TITLE: 'Claim Title', PROJECT: 'Project / Cost Center', PERIOD_FROM: 'Period From', PERIOD_TO: 'Period To',
  CURRENCY: 'Currency', AMOUNT: 'Total Claimed', AMOUNT_INR: 'Total (INR equiv)',
  ADVANCE: 'Advance Already Taken', NET: 'Net Reimbursable',
  LINES: 'Line Items (JSON)', LINE_COUNT: 'Line Count',
  PAY_METHOD: 'Payment Method', PAY_DETAIL: 'Payment Detail',
  PURPOSE: 'Purpose / Justification', NOTES: 'Notes', TIER: 'Approval Tier',
  // Workflow state
  STATUS: 'Status', STAGE: 'Stage', TOKEN: 'Token',
  DEPT_DEC: 'Dept Head Decision', DEPT_TIME: 'Dept Head Time',
  FIN_DEC: 'Finance Decision', FIN_TIME: 'Finance Time',
  MGMT_DEC: 'Management Decision', MGMT_TIME: 'Management Time',
  // Payout
  PAY_REF: 'Payment Reference', PAY_DATE: 'Payment Date', PAID_AMOUNT: 'Amount Paid',
  // Reminders + approver workflow
  LAST_REMINDER: 'Last Reminder', REMINDER_COUNT: 'Reminder Count',
  HOLD: 'On Hold', COMMENTS: 'Approver Comments',
};

export const HEADERS = [
  COL.ID, COL.TS, COL.EMAIL, COL.NAME, COL.EMPID, COL.DEPT, COL.HOD,
  COL.TITLE, COL.PROJECT, COL.PERIOD_FROM, COL.PERIOD_TO,
  COL.CURRENCY, COL.AMOUNT, COL.AMOUNT_INR, COL.ADVANCE, COL.NET,
  COL.LINES, COL.LINE_COUNT, COL.PAY_METHOD, COL.PAY_DETAIL,
  COL.PURPOSE, COL.NOTES, COL.TIER,
  COL.STATUS, COL.STAGE, COL.TOKEN,
  COL.DEPT_DEC, COL.DEPT_TIME, COL.FIN_DEC, COL.FIN_TIME, COL.MGMT_DEC, COL.MGMT_TIME,
  COL.PAY_REF, COL.PAY_DATE, COL.PAID_AMOUNT,
  COL.LAST_REMINDER, COL.REMINDER_COUNT, COL.HOLD, COL.COMMENTS,
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

// Departments a given email is the HOD of (usually one). Used to scope the HOD dashboard.
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
