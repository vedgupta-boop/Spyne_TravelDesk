// ---------------------------------------------------------------------------
//  Static configuration & policy. Approver emails can be overridden via env.
// ---------------------------------------------------------------------------
export const CONFIG = {
  COMPANY_NAME: 'Spyne',
  COMPANY_DOMAIN: 'spyne.ai',

  // Department -> Head of Department. Selecting a department auto-fills the HOD.
  DEPARTMENTS: {
    'GTM Sales & Marketing': { head: 'Ankit Khandelwal', email: 'ankit@spyne.ai' },
    'Finance & Account':     { head: 'Rahul Beruwar',    email: 'rahul@spyne.ai' },
    'Product':               { head: 'Amit Walia',       email: 'amit@spyne.ai' },
    'Technology':            { head: 'Jatin Jain',       email: 'jatin@spyne.ai' },
    'HR, IT & Admin':        { head: 'Sangeetha Swamy',  email: 'sangeetha@spyne.ai' },
    "CEO's Office":          { head: 'Sanjay Varnwal',   email: 'sanjay@spyne.ai' },
    'Customer Success':      { head: 'Madhav Uppal',     email: 'madhav.uppal@spyne.ai' },
    'Onboarding':            { head: 'Jagrit Sawhney',   email: 'jagrit@spyne.ai' },
  },

  CEO_EMAIL:    process.env.CEO_EMAIL    || 'sanjay@spyne.ai',   // Sanjay Varnwal
  FINANCE_SPOC: process.env.FINANCE_SPOC || 'finance@spyne.ai',  // Finance Team
  ADMIN_TEAM:   process.env.ADMIN_TEAM   || 'shankul.rastogi@spyne.ai',

  CC_REQUESTER_ON_UPDATES: true,

  // Auto-escalate a stuck approval after this many unanswered 24h reminders (cron) → CC the CEO + admin.
  ESCALATE_AFTER_REMINDERS: 3,

  // Reporting: normalise mixed INR/USD totals to one currency for the Finance analytics tab.
  REPORTING_CURRENCY: 'INR',
  FX: { USD_INR: Number(process.env.USD_INR_RATE) || 92 }, // 1 USD = ₹92 (override via USD_INR_RATE env)

  // Indicative ANNUAL travel budget per department, in the reporting currency (INR).
  // Drives the Finance → Analytics utilisation bars. Tune to real budgets.
  DEPT_BUDGETS: {
    'GTM Sales & Marketing': 4000000,
    'Finance & Account':     1000000,
    'Product':               2500000,
    'Technology':            3000000,
    'HR, IT & Admin':        1200000,
    "CEO's Office":          2000000,
    'Customer Success':      2500000,
    'Onboarding':            800000,
  },
};

export const POLICY = {
  // City tiers per policy v2.0 (§6.1 country/city classification, §7.2 India outstation).
  // India = 3 tiers, US = 4 tiers. Tiers drive the per-night hotel cap (HOTEL below).
  // India Tier 1 (metro) → INR 6,000.
  INDIA_TIER_1: ['delhi','gurugram','gurgaon','mumbai','bengaluru','bangalore',
                 'chennai','kolkata','hyderabad','ahmedabad','pune'],
  // India Tier 2 — state capitals & union-territory capitals → INR 3,000. (Tier 3 = all others → INR 2,500.)
  INDIA_TIER_2: ['jaipur','lucknow','bhopal','patna','raipur','ranchi','bhubaneswar','dehradun','shimla',
                 'gandhinagar','panaji','thiruvananthapuram','trivandrum','chandigarh','itanagar','dispur',
                 'guwahati','imphal','shillong','aizawl','kohima','agartala','gangtok','srinagar','jammu',
                 'amaravati','vijayawada','puducherry','pondicherry','port blair','kavaratti','daman','silvassa','leh'],
  // US Tier 1 → USD 175.
  US_TIER_1: ['new york','san francisco','boston','cambridge','washington','arlington','alexandria','seattle',
              'san jose','santa clara','palo alto','sunnyvale','mountain view','silicon valley'],
  // US Tier 2 → USD 150.
  US_TIER_2: ['los angeles','san diego','chicago','miami','fort lauderdale','denver','austin','nashville',
              'new orleans','portland','philadelphia','oakland','sacramento','scottsdale','westchester','white plains'],
  // US Tier 3 → USD 125. (Tier 4 = every other US location → USD 100.)
  US_TIER_3: ['atlanta','dallas','houston','san antonio','phoenix','tempe','tucson','las vegas','reno',
              'minneapolis','st. paul','saint paul','detroit','grand rapids','pittsburgh','baltimore','tampa',
              'orlando','jacksonville','salt lake city','boise','kansas city','st. louis','saint louis','omaha',
              'des moines','charlotte','raleigh','durham','columbus','cincinnati','cleveland','indianapolis',
              'milwaukee','madison','richmond','providence','hartford','albany','buffalo','rochester','louisville',
              'memphis','oklahoma city','tulsa','albuquerque','spokane'],
  // per night (+ taxes), §6.3 / §7.3. intl_default = non-US international cities (the policy only
  // defines US tier caps; everywhere else overseas uses this default).
  HOTEL: { india: { 1: 6000, 2: 3000, 3: 2500 }, us: { 1: 175, 2: 150, 3: 125, 4: 100 }, intl_default: 175 },
  // Meals/per-diem (§6.4, §7.4). Overseas is breakfast-based, NOT tier-based: USD 70 (no breakfast) / USD 50
  // (breakfast included). Budget uses the no-breakfast rate (70); actuals are claimed on bills.
  MEALS: { domestic: 800, overseas: 70, overseas_breakfast: 50, local: 0 },  // per day
  LOCAL_DAILY_CAP: { domestic: 1000, international: 50 },          // INR/day (India overseas) · USD/day (§6.5)
  FOREX_PER_DAY: { international: 125 },                           // USD/day tour advance (forex)

  // Backend cost ESTIMATES (used when no policy figure / no live price). Currency:
  // INR for domestic & local, USD for international.
  ESTIMATES: {
    FLIGHT:    { domestic: 9000, us_domestic: 300, international: 800 }, // round-trip fallback if no live price (us_domestic = flight within the US)
    TRANSPORT: { train: 4000, bus: 2000, cab: 3000, own: 2500 }, // domestic non-flight (INR)
    LOCAL_LEG: { domestic: { homeAirport: 1000, airportDest: 1000 },   // INR per leg
                 international: { homeAirport: 30, airportDest: 40 } }, // USD per leg
    // Daily local conveyance (cabs at destination): km/day × days × per-km cab rate.
    LOCAL_CONVEYANCE: { kmPerDay: 40, ratePerKm: { domestic: 15, international: 1.75 } },
  },
  // Additional allowances / one-off costs added to the total (all USD; tune as needed).
  EXTRAS: {
    VISA_FEE: 185,          // default international visa fee (fallback when country not in the map below)
    // Per-destination-country visa fee (USD, approximate business/visitor visa). Falls back to VISA_FEE.
    VISA_FEE_BY_COUNTRY: {
      'United States': 185, 'United Kingdom': 150, 'India': 80, 'China': 140, 'Canada': 75,
      'Australia': 140, 'Singapore': 30, 'Japan': 30, 'United Arab Emirates': 90, 'UAE': 90,
      'Germany': 100, 'France': 100, 'Netherlands': 100, 'Schengen': 100,
    },
    INSURANCE_PER_DAY: 5,   // international travel/medical insurance, per day
    PHONE_PER_DAY: 4,       // §6.6 phone/communication, per day (international)
    LAUNDRY_PER_BLOCK: 10,  // §6.6 laundry, USD 10 per 10-day block, only for trips > 10 days
    BAGGAGE_PER_LEG: 35,    // checked-bag fee per flight leg — US domestic flights
    SECURITY_DEPOSIT: 100,  // refundable hotel security deposit, per hotel (international)
  },
  // Policy-break thresholds → adding Finance approval.
  CAPS: {
    FLIGHT: { domestic: 15000, us_domestic: 600, international: 900 },
    TOTAL:  { domestic: 50000, international: 3000 },
  },
  NOTICE_DAYS: { domestic: 15, international: 30 }, // required advance notice
};

// Sheet column headers (order matters — this is the row layout in Google Sheets).
export const COL = {
  ID:'Request ID', TS:'Timestamp', EMAIL:'Requester Email', NAME:'Name', EMPID:'Employee ID',
  DEPT:'Department', HOD:'HOD Email',
  TYPE:'Travel Type', TRIP:'Trip Type', FROM:'From', TO:'To', RETTO:'Return To',
  START:'Start Date', RET:'Return Date', DAYS:'Days', NIGHTS:'Nights',
  PURPOSE:'Purpose', MODE:'Transport Mode', CURRENCY:'Currency',
  C_TRANSPORT:'Transport Cost', HOTEL_REQ:'Hotel Required', HOTEL_RATE:'Hotel/Night',
  HOTEL_NIGHTS:'Hotel Nights', C_HOTEL:'Hotel Cost', MEAL_RATE:'Meals/Day', C_MEALS:'Meals Cost',
  C_LOCAL:'Local Cost', C_OTHER:'Other Cost', C_TOTAL:'Total Cost', FLAG:'Budget Flag', NOTES:'Notes',
  STATUS:'Status', STAGE:'Stage', TOKEN:'Token',
  DEPT_DEC:'Dept Head Decision', DEPT_TIME:'Dept Head Time',
  CEO_DEC:'CEO Decision', CEO_TIME:'CEO Time',
  FIN_DEC:'Finance Decision', FIN_TIME:'Finance Time',
  ADMIN:'Admin Status', FOREX:'Forex Required (USD)', RETFROM:'Return From',
  // Forex card (international) — personal details + uploaded document links
  NATIONALITY:'Nationality', PASSPORT_NO:'Passport No', PASSPORT_ISSUE:'Passport Issue (date & place)',
  DESIGNATION:'Designation', ADDRESS:'Residential Address', MOBILE:'Mobile',
  DOC_PASSPORT:'Doc: Passport', DOC_VISA:'Doc: Visa', DOC_PANAADHAAR:'Doc: PAN & Aadhaar', DOC_TICKET:'Doc: Air Ticket',
  // Country-specific identity documents (India: PAN + Aadhaar separately; US/other: single ID by type)
  ID_DOC_TYPE:'ID Document Type', DOC_AADHAAR:'Doc: Aadhaar', DOC_PAN:'Doc: PAN', DOC_NATIONAL_ID:'Doc: National/US ID',
  TICKET_INFO:'Ticket Information', DOC_FOREX_CONFIRM:'Doc: Forex Confirmation',
  // Lifecycle tracking dates/statuses (master tracker)
  BOOKING_DATE:'Booking Date', TICKET_UPLOAD_DATE:'Ticket Upload Date', FOREX_ISSUE_DATE:'Forex Issue Date',
  ADVANCE_STATUS:'Advance Status', ADVANCE_DATE:'Advance Release Date',
  EXPENSE_DATE:'Expense Submission Date', CLOSURE_DATE:'Closure Date',
  // Multi-city itinerary — extra flight legs & hotel stays (JSON), plus admin booking details (JSON)
  ITINERARY:'Itinerary (JSON)', BOOKINGS:'Bookings (JSON)',
  // Pending-approval reminder tracking (24h email nudges)
  LAST_REMINDER:'Last Reminder', REMINDER_COUNT:'Reminder Count',
  // Approver workflow: on-hold flag + accumulated approver comments/remarks
  HOLD:'On Hold', COMMENTS:'Approver Comments',
  // Per-request approver delegation — forwards THIS record to a colleague (OOO cover);
  // grants that email approval rights for the current stage.
  DELEGATE_EMAIL:'Delegate Approver',
  // Forex letter extras (BookMyForex format): PAN number, passport expiry, airline.
  PAN_NO:'PAN No.', PASSPORT_EXPIRY:'Passport Expiry', AIRLINES:'Airlines',
  // Post-trip ACTUALS (budget vs actual + reimbursement). ACTUALS = JSON of per-line
  // {amount, paidBy:'own'|'company', doc} for flight/hotel/meals/local/visa/baggage/misc.
  ACTUALS:'Actuals (JSON)', ACTUALS_STATUS:'Actuals Status', REIMBURSE_AMT:'Reimbursement Approved',
  // Traveller's preferred flight (screenshot/PDF + notes) to help Admin book. Flight times
  // (HH:MM, origin-local) are stored inside the ITINERARY JSON (times.out/ret + per-extra-leg).
  PREF_FLIGHT_DOC:'Doc: Preferred Flight', PREF_FLIGHT_NOTES:'Preferred Flight Notes',
  // Traveller uploads the back of their issued forex card (card number/details) so the Forex officer can do future top-ups.
  DOC_FOREX_CARD:'Doc: Forex Card Back',
  // Latest "send back for clarification" question from an approver (shown to the requester when they edit).
  CLARIFY_NOTE:'Clarification Note',
  // Last "return your unused tour advance" reminder timestamp (separate from approval/bill reminders).
  ADVANCE_REMINDER:'Advance Reminder',
  // Additional cost components: visa-held flag, itemised extras (JSON), forex top-ups (JSON)
  VISA_NEEDED:'Visa Needed', C_EXTRAS:'Cost Extras (JSON)', FOREX_TOPUPS:'Forex Top-ups (JSON)',
  // Hotel security deposit — an ADVANCE (not an expense), tracked separately from the forex advance
  C_DEPOSIT:'Hotel Security Deposit',
  // Multiple passengers on one request (group travel). PASSENGERS = JSON [{name,email}], PAX = count.
  PASSENGERS:'Passengers (JSON)', PAX:'Passenger Count',
  // Booking on behalf of someone else: REQUESTED_BY = email of the person who filed the form
  // (the signed-in user). When self-booking this equals the traveller's email.
  REQUESTED_BY:'Requested By (Email)',
};

export const HEADERS = [
  COL.ID, COL.TS, COL.EMAIL, COL.NAME, COL.EMPID, COL.DEPT, COL.HOD,
  COL.TYPE, COL.TRIP, COL.FROM, COL.TO, COL.RETTO, COL.START, COL.RET, COL.DAYS, COL.NIGHTS,
  COL.PURPOSE, COL.MODE, COL.CURRENCY,
  COL.C_TRANSPORT, COL.HOTEL_REQ, COL.HOTEL_RATE, COL.HOTEL_NIGHTS, COL.C_HOTEL,
  COL.MEAL_RATE, COL.C_MEALS, COL.C_LOCAL, COL.C_OTHER, COL.C_TOTAL, COL.FLAG, COL.NOTES,
  COL.STATUS, COL.STAGE, COL.TOKEN,
  COL.DEPT_DEC, COL.DEPT_TIME, COL.CEO_DEC, COL.CEO_TIME, COL.FIN_DEC, COL.FIN_TIME, COL.ADMIN,
  COL.FOREX, COL.RETFROM,
  COL.NATIONALITY, COL.PASSPORT_NO, COL.PASSPORT_ISSUE, COL.DESIGNATION, COL.ADDRESS, COL.MOBILE,
  COL.DOC_PASSPORT, COL.DOC_VISA, COL.DOC_PANAADHAAR, COL.DOC_TICKET, COL.TICKET_INFO, COL.DOC_FOREX_CONFIRM,
  COL.BOOKING_DATE, COL.TICKET_UPLOAD_DATE, COL.FOREX_ISSUE_DATE,
  COL.ADVANCE_STATUS, COL.ADVANCE_DATE, COL.EXPENSE_DATE, COL.CLOSURE_DATE,
  COL.ITINERARY, COL.BOOKINGS,
  COL.ID_DOC_TYPE, COL.DOC_AADHAAR, COL.DOC_PAN, COL.DOC_NATIONAL_ID,
  COL.LAST_REMINDER, COL.REMINDER_COUNT,
  COL.HOLD, COL.COMMENTS,
  COL.VISA_NEEDED, COL.C_EXTRAS, COL.FOREX_TOPUPS, COL.C_DEPOSIT,
  COL.PASSENGERS, COL.PAX,
  COL.REQUESTED_BY,
  COL.DELEGATE_EMAIL,
  COL.PAN_NO, COL.PASSPORT_EXPIRY, COL.AIRLINES,
  COL.ACTUALS, COL.ACTUALS_STATUS, COL.REIMBURSE_AMT,
  COL.PREF_FLIGHT_DOC, COL.PREF_FLIGHT_NOTES,
  COL.DOC_FOREX_CARD,
  COL.CLARIFY_NOTE,
  COL.ADVANCE_REMINDER,
];

// ---------------------------------------------------------------------------
//  Auth & roles (Google sign-in, domain-locked). Role is derived from email.
//  Everyone in the domain is a 'requester'; Finance/Admin emails get extra roles.
// ---------------------------------------------------------------------------
function emailList(envVal, fallback) {
  return String(envVal || fallback || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const AUTH = {
  ALLOWED_DOMAIN: process.env.ALLOWED_DOMAIN || CONFIG.COMPANY_DOMAIN,
  FINANCE_EMAILS: emailList(process.env.FINANCE_EMAILS, `${CONFIG.FINANCE_SPOC},finance.head@spyne.ai`),
  ADMIN_EMAILS:   emailList(process.env.ADMIN_EMAILS, CONFIG.ADMIN_TEAM), // Admin = ADMIN_TEAM (shankul.rastogi@spyne.ai) only
  FOREX_EMAILS:   emailList(process.env.FOREX_EMAILS, 'jasvinder@spyne.ai'), // Forex Card officer(s)
};
// Forex officer who receives the card-issuance task after booking.
CONFIG.FOREX_OFFICER = AUTH.FOREX_EMAILS[0] || 'jasvinder@spyne.ai';

// Heads of department — anyone whose email is a department head gets the 'hod' role.
let HOD_EMAILS = Object.values(CONFIG.DEPARTMENTS).map((d) => String(d.email).toLowerCase());

// Snapshot the config/env defaults ONCE, so role overrides can be applied on top and cleanly
// reverted (a removed override falls back to the default — never leaves a stale assignee).
const ROLE_DEFAULTS = {
  ceo: String(CONFIG.CEO_EMAIL || '').toLowerCase(),
  finance: AUTH.FINANCE_EMAILS.slice(),
  admin: AUTH.ADMIN_EMAILS.slice(),
  forex: AUTH.FOREX_EMAILS.slice(),
  depts: Object.fromEntries(Object.keys(CONFIG.DEPARTMENTS).map((d) => [d, String(CONFIG.DEPARTMENTS[d].email || '').toLowerCase()])),
};
// The role names a person can be assigned, plus the live list of departments (for the Users UI).
export const ROLE_KINDS = ['ceo', 'finance', 'admin', 'forex'];
export function departmentNames() { return Object.keys(CONFIG.DEPARTMENTS); }

// Apply a sheet-stored override map ON TOP of the defaults. Keys: ceo, finance, admin, forex
// (comma-separated emails) and `dept:<DeptName>` (single head email). Resets to defaults first,
// so an empty map == the original env/config behaviour exactly. Mutates CONFIG/AUTH in place so
// all sync routing + rolesFor pick up the change immediately.
export function setRoleOverrides(map) {
  map = map || {};
  CONFIG.CEO_EMAIL = (map.ceo ? String(map.ceo).toLowerCase() : ROLE_DEFAULTS.ceo);
  AUTH.FINANCE_EMAILS = map.finance ? emailList(map.finance, '') : ROLE_DEFAULTS.finance.slice();
  AUTH.ADMIN_EMAILS   = map.admin   ? emailList(map.admin, '')   : ROLE_DEFAULTS.admin.slice();
  AUTH.FOREX_EMAILS   = map.forex   ? emailList(map.forex, '')   : ROLE_DEFAULTS.forex.slice();
  CONFIG.FINANCE_SPOC = AUTH.FINANCE_EMAILS[0] || ROLE_DEFAULTS.finance[0] || CONFIG.FINANCE_SPOC;
  CONFIG.ADMIN_TEAM   = AUTH.ADMIN_EMAILS[0]   || ROLE_DEFAULTS.admin[0]   || CONFIG.ADMIN_TEAM;
  CONFIG.FOREX_OFFICER = AUTH.FOREX_EMAILS[0]  || ROLE_DEFAULTS.forex[0]   || CONFIG.FOREX_OFFICER;
  Object.keys(CONFIG.DEPARTMENTS).forEach((d) => {
    const ov = map['dept:' + d];
    CONFIG.DEPARTMENTS[d].email = ov ? String(ov).toLowerCase() : ROLE_DEFAULTS.depts[d];
  });
  HOD_EMAILS = Object.values(CONFIG.DEPARTMENTS).map((d) => String(d.email).toLowerCase());
}
// Current effective assignments (for the Users UI to show who holds what).
export function roleAssignments() {
  return {
    ceo: CONFIG.CEO_EMAIL,
    finance: AUTH.FINANCE_EMAILS.slice(),
    admin: AUTH.ADMIN_EMAILS.slice(),
    forex: AUTH.FOREX_EMAILS.slice(),
    depts: Object.fromEntries(Object.keys(CONFIG.DEPARTMENTS).map((d) => [d, CONFIG.DEPARTMENTS[d].email])),
  };
}

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
  if (AUTH.ADMIN_EMAILS.includes(e)) roles.push('admin');
  if (AUTH.FOREX_EMAILS.includes(e)) roles.push('forex');
  return roles;
}

// Roles that get the Approvals dashboard.
export function isApprover(roles) {
  return ['hod', 'ceo', 'finance'].some((r) => roles.includes(r));
}

// Default landing view for a user's highest-privilege role.
export function homeFor(roles) {
  if (roles.includes('admin')) return '/admin';
  if (roles.includes('forex')) return '/forex';
  if (roles.includes('finance')) return '/finance';
  if (roles.includes('hod') || roles.includes('ceo')) return '/hod';
  return '/';
}
