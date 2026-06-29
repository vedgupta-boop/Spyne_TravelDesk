/**
 * ============================================================================
 *  SPYNE TRAVEL REQUEST + APPROVAL WORKFLOW   (Google Apps Script Web App)
 * ============================================================================
 *  ONE deployable web app, three views:
 *
 *    1. TRAVELLER FORM   (default page)         -> Form.html
 *         Pick department (HOD auto-fills), trip type, dates (duration auto),
 *         hotel yes/no, currency auto per policy, meals/caps auto-computed.
 *
 *    2. APPROVER EMAILS  (sent on submit / each approval)
 *         Itemised cost breakdown — transport, hotel, meals, local, other,
 *         currency, total — with Approve / Reject buttons.
 *
 *    3. FINANCE DASHBOARD (?page=finance)        -> Finance.html
 *         Track every request and the total cost pipeline.
 *
 *  APPROVAL CHAIN (auto, by travel type):
 *    local         -> HOD -> Admin
 *    domestic      -> HOD -> Finance -> Admin
 *    international -> HOD -> CEO -> Finance -> Admin
 *
 *  DEPLOY:  see README.md.  In short:
 *    1. Create an Apps Script project. Add this file plus HTML files named
 *       "Form" and "Finance" (paste Form.html / Finance.html contents).
 *    2. Edit the CONFIG block below.
 *    3. Run  setup()  once (authorize when prompted).
 *    4. Deploy > New deployment > Web app (Execute as: Me; Access: your domain).
 *    5. Run  registerWebAppUrl()  once (it also self-heals on first use).
 * ============================================================================
 */

// ============================== CONFIG ======================================
// >>> EDIT EVERYTHING IN THIS BLOCK <<<
const CONFIG = {
  COMPANY_NAME:   'Spyne',
  COMPANY_DOMAIN: 'spyne.ai',

  // Department -> Head of Department. Selecting the department auto-fills the HOD.
  DEPARTMENTS: {
    'Engineering':      { head: 'Anil Kumar',     email: 'eng.head@spyne.ai' },
    'Sales':            { head: 'Sunita Rao',     email: 'sales.head@spyne.ai' },
    'Marketing':        { head: 'Priya Sharma',   email: 'marketing.head@spyne.ai' },
    'Finance':          { head: 'Vikram Nair',    email: 'finance.head@spyne.ai' },
    'Human Resources':  { head: 'Deepa Krishnan', email: 'hr.head@spyne.ai' },
    'Operations':       { head: 'Rohit Verma',    email: 'ops.head@spyne.ai' },
    'Product':          { head: 'Megha Iyer',     email: 'product.head@spyne.ai' },
    'Customer Success': { head: 'Arjun Menon',    email: 'cs.head@spyne.ai' },
  },

  CEO_EMAIL:    'ceo@spyne.ai',          // international approvals route through the CEO
  FINANCE_SPOC: 'finance.spoc@spyne.ai', // domestic + international, after HOD/CEO
  ADMIN_TEAM:   'admin@spyne.ai',        // makes arrangements after final approval

  CC_REQUESTER_ON_UPDATES: true,         // CC the traveller on every status email
};

// ----------------------------- POLICY --------------------------------------
// Caps & per-diems. Currency is auto: INR for local/domestic, USD for international.
const POLICY = {
  INDIA_TIER_A: ['delhi','gurugram','gurgaon','noida','mumbai','bengaluru','bangalore',
                 'chennai','kolkata','hyderabad','ahmedabad','pune'],
  US_TIER_A:    ['new york','los angeles','san francisco','las vegas','boston','washington',
                 'houston','dallas','miami','seattle','atlanta','chicago'],
  HOTEL: { india: { A: 6000, B: 3000 }, us: { A: 130, B: 120 } }, // per night
  MEALS: { domestic: 800, us_A: 70, us_B: 60, local: 0 },         // per day
  LOCAL_DAILY_CAP: { international: 50 },                          // USD/day; domestic/local = actuals
};

// ----------------------- RESPONSE SHEET SCHEMA ------------------------------
const COL = {
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
  ADMIN:'Admin Status',
};
// Column order in the sheet.
const HEADERS = [
  COL.ID, COL.TS, COL.EMAIL, COL.NAME, COL.EMPID, COL.DEPT, COL.HOD,
  COL.TYPE, COL.TRIP, COL.FROM, COL.TO, COL.RETTO, COL.START, COL.RET, COL.DAYS, COL.NIGHTS,
  COL.PURPOSE, COL.MODE, COL.CURRENCY,
  COL.C_TRANSPORT, COL.HOTEL_REQ, COL.HOTEL_RATE, COL.HOTEL_NIGHTS, COL.C_HOTEL,
  COL.MEAL_RATE, COL.C_MEALS, COL.C_LOCAL, COL.C_OTHER, COL.C_TOTAL, COL.FLAG, COL.NOTES,
  COL.STATUS, COL.STAGE, COL.TOKEN,
  COL.DEPT_DEC, COL.DEPT_TIME, COL.CEO_DEC, COL.CEO_TIME, COL.FIN_DEC, COL.FIN_TIME, COL.ADMIN,
];

const PROP_SHEET_ID   = 'TRF_SHEET_ID';
const PROP_WEBAPP_URL = 'TRF_WEBAPP_URL';
const SHEET_NAME      = 'Requests';


/* ===========================================================================
 *  WEB APP ROUTING
 * ======================================================================== */
function doGet(e) {
  cacheWebAppUrl_();
  const p = (e && e.parameter) || {};

  // Approve / Reject links carry a "decision" param.
  if (p.decision) return handleDecision_(p);

  // Finance dashboard.
  if (p.page === 'finance') {
    return HtmlService.createHtmlOutputFromFile('Finance')
      .setTitle(CONFIG.COMPANY_NAME + ' · Travel — Finance View')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  // Default: the traveller form.
  return HtmlService.createHtmlOutputFromFile('Form')
    .setTitle(CONFIG.COMPANY_NAME + ' · Travel Request')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


/* ===========================================================================
 *  CLIENT-CALLABLE  (google.script.run from the HTML pages)
 * ======================================================================== */

/** Config the form needs to render: departments, policy, the signed-in email. */
function getClientConfig() {
  let email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (err) {}
  const depts = {};
  Object.keys(CONFIG.DEPARTMENTS).forEach(function (d) {
    depts[d] = { head: CONFIG.DEPARTMENTS[d].head, email: CONFIG.DEPARTMENTS[d].email };
  });
  return {
    company: CONFIG.COMPANY_NAME,
    domain: CONFIG.COMPANY_DOMAIN,
    departments: depts,
    policy: POLICY,
    userEmail: email,
  };
}

/**
 * Traveller submits the form. Costs are recomputed SERVER-SIDE (authoritative),
 * a row is written, and the first approver (HOD) is emailed. Returns a summary.
 */
function submitTravelRequest(payload) {
  const p = payload || {};

  // -- minimal validation --
  const missing = [];
  if (!p.name)        missing.push('name');
  if (!p.dept)        missing.push('department');
  if (!p.travelType)  missing.push('travel type');
  if (!p.from)        missing.push('origin');
  if (!p.to)          missing.push('destination');
  if (!p.startDate)   missing.push('start date');
  if (p.tripType === 'round' && !p.returnDate) missing.push('return date');
  if (missing.length) throw new Error('Missing required field(s): ' + missing.join(', '));

  const dur = duration_(p.startDate, (p.tripType === 'round' ? p.returnDate : p.startDate));
  const costs = computeCosts_(p, dur);

  const dept = String(p.dept);
  const deptInfo = CONFIG.DEPARTMENTS[dept] || null;
  const hodEmail = (deptInfo && deptInfo.email) || p.hodEmail || CONFIG.FINANCE_SPOC;

  const requesterEmail = String(p.email || safeUserEmail_() || '').trim();
  const id = 'TRF-' + dateStamp_() + '-' + String(Math.floor(seq_())).slice(-4);
  const token = Utilities.getUuid();

  const record = {};
  record[COL.ID] = id;
  record[COL.TS] = new Date();
  record[COL.EMAIL] = requesterEmail;
  record[COL.NAME] = p.name;
  record[COL.EMPID] = p.empId || '';
  record[COL.DEPT] = dept;
  record[COL.HOD] = hodEmail;
  record[COL.TYPE] = p.travelType;
  record[COL.TRIP] = (p.tripType === 'round' ? 'Round trip' : 'One-way');
  record[COL.FROM] = p.from;
  record[COL.TO] = p.to;
  record[COL.RETTO] = (p.tripType === 'round' ? (p.returnTo || p.from) : '');
  record[COL.START] = p.startDate;
  record[COL.RET] = (p.tripType === 'round' ? p.returnDate : '');
  record[COL.DAYS] = dur.days;
  record[COL.NIGHTS] = dur.nights;
  record[COL.PURPOSE] = p.purpose || '';
  record[COL.MODE] = p.transportMode || '';
  record[COL.CURRENCY] = costs.currency;
  record[COL.C_TRANSPORT] = costs.transport;
  record[COL.HOTEL_REQ] = p.hotelNeeded ? 'Yes' : 'No';
  record[COL.HOTEL_RATE] = costs.hotelPerNight;
  record[COL.HOTEL_NIGHTS] = p.hotelNeeded ? dur.nights : 0;
  record[COL.C_HOTEL] = costs.hotel;
  record[COL.MEAL_RATE] = costs.mealsPerDay;
  record[COL.C_MEALS] = costs.meals;
  record[COL.C_LOCAL] = costs.local;
  record[COL.C_OTHER] = costs.other;
  record[COL.C_TOTAL] = costs.total;
  record[COL.FLAG] = costs.flag;
  record[COL.NOTES] = p.notes || '';
  record[COL.STATUS] = 'Pending HOD Approval';
  record[COL.STAGE] = 'dept';
  record[COL.TOKEN] = token;
  record[COL.ADMIN] = '';

  const sheet = getSheet_();
  const row = appendRecord_(sheet, record);

  emailApprover_('dept', sheet, row);

  return { ok: true, id: id, currency: costs.currency, total: costs.total, chain: chainLabels_(p.travelType) };
}

/** Finance dashboard data — every request with its cost breakdown & status. */
function getRequestsForFinance() {
  const sheet = getSheet_();
  if (sheet.getLastRow() < 2) return { currencySummaries: {}, rows: [] };

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });

  const rows = [];
  const summaries = {}; // currency -> { count, pending, approved, rejected, totalPipeline, totalApproved }

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const cur = String(row[idx[COL.CURRENCY]] || 'INR');
    const total = Number(row[idx[COL.C_TOTAL]] || 0);
    const status = String(row[idx[COL.STATUS]] || '');
    const rejected = /reject/i.test(status);
    const approved = /approved|admin|confirmed/i.test(status);

    if (!summaries[cur]) summaries[cur] = { count: 0, pending: 0, approved: 0, rejected: 0, totalPipeline: 0, totalApproved: 0 };
    const s = summaries[cur];
    s.count++;
    if (rejected) s.rejected++;
    else if (approved) { s.approved++; s.totalApproved += total; }
    else s.pending++;
    if (!rejected) s.totalPipeline += total;

    rows.push({
      id: String(row[idx[COL.ID]] || ''),
      date: fmtDate_(row[idx[COL.TS]]),
      name: String(row[idx[COL.NAME]] || ''),
      dept: String(row[idx[COL.DEPT]] || ''),
      type: String(row[idx[COL.TYPE]] || ''),
      route: String(row[idx[COL.FROM]] || '') + ' → ' + String(row[idx[COL.TO]] || ''),
      start: fmtDate_(row[idx[COL.START]]),
      days: Number(row[idx[COL.DAYS]] || 0),
      currency: cur,
      transport: Number(row[idx[COL.C_TRANSPORT]] || 0),
      hotel: Number(row[idx[COL.C_HOTEL]] || 0),
      meals: Number(row[idx[COL.C_MEALS]] || 0),
      local: Number(row[idx[COL.C_LOCAL]] || 0),
      other: Number(row[idx[COL.C_OTHER]] || 0),
      total: total,
      flag: String(row[idx[COL.FLAG]] || ''),
      status: status,
    });
  }
  rows.reverse(); // newest first
  return { currencySummaries: summaries, rows: rows };
}


/* ===========================================================================
 *  COST ENGINE  (server-side, authoritative)
 * ======================================================================== */
function computeCosts_(p, dur) {
  const intl = p.travelType === 'international';
  const currency = intl ? 'USD' : 'INR';
  const tier = cityTier_(p.to, intl);
  const days = dur.days, nights = dur.nights;

  const transport     = num_(p.transportCost);
  const hotelPerNight = p.hotelNeeded ? num_(p.hotelPerNight) : 0;
  const hotel         = hotelPerNight * nights;
  const mealsPerDay   = mealPerDiem_(p.travelType, tier);
  const meals         = mealsPerDay * days;
  const local         = num_(p.localCost);
  const other         = num_(p.otherCost);
  const total         = transport + hotel + meals + local + other;

  // Policy flags
  const flags = [];
  const hotelCap = hotelCapFor_(intl, tier);
  if (p.hotelNeeded && hotelPerNight > hotelCap) {
    flags.push('Hotel/night ' + money_(hotelPerNight, currency) + ' exceeds cap ' + money_(hotelCap, currency) + ' (Tier ' + tier + ')');
  }
  const localCap = intl ? POLICY.LOCAL_DAILY_CAP.international * days : 0;
  if (localCap && local > localCap) {
    flags.push('Local ' + money_(local, currency) + ' exceeds cap ' + money_(localCap, currency) + ' (USD 50/day)');
  }
  const flag = flags.length ? ('OVER BUDGET: ' + flags.join('; ')) : 'Within policy';

  return {
    currency: currency, tier: tier,
    transport: transport, hotelPerNight: hotelPerNight, hotel: hotel,
    mealsPerDay: mealsPerDay, meals: meals, local: local, other: other,
    total: total, flag: flag,
  };
}

function cityTier_(city, intl) {
  const c = String(city || '').toLowerCase();
  const list = intl ? POLICY.US_TIER_A : POLICY.INDIA_TIER_A;
  return list.some(function (x) { return c.indexOf(x) > -1; }) ? 'A' : 'B';
}
function hotelCapFor_(intl, tier) {
  return intl ? POLICY.HOTEL.us[tier] : POLICY.HOTEL.india[tier];
}
function mealPerDiem_(type, tier) {
  if (type === 'international') return tier === 'A' ? POLICY.MEALS.us_A : POLICY.MEALS.us_B;
  if (type === 'domestic') return POLICY.MEALS.domestic;
  return POLICY.MEALS.local; // local
}


/* ===========================================================================
 *  APPROVAL WORKFLOW
 * ======================================================================== */
// Approval stages per travel type (Admin arrangements happen after the last one).
function chainFor_(type) {
  if (type === 'international') return ['dept', 'ceo', 'finance'];
  if (type === 'domestic')     return ['dept', 'finance'];
  return ['dept']; // local
}
function chainLabels_(type) {
  const map = { dept: 'HOD', ceo: 'CEO', finance: 'Finance' };
  return chainFor_(type).map(function (s) { return map[s]; }).concat(['Admin', 'Confirmed']);
}
function stageLabel_(stage) {
  return { dept: 'Department Head', ceo: 'CEO', finance: 'Finance SPOC' }[stage] || stage;
}
function approverEmailFor_(stage, rec) {
  if (stage === 'dept')    return rec[COL.HOD] || CONFIG.FINANCE_SPOC;
  if (stage === 'ceo')     return CONFIG.CEO_EMAIL;
  if (stage === 'finance') return CONFIG.FINANCE_SPOC;
  return CONFIG.ADMIN_TEAM;
}
function nextStage_(type, current) {
  const chain = chainFor_(type);
  const i = chain.indexOf(current);
  if (i === -1) return null;
  return (i + 1 < chain.length) ? chain[i + 1] : 'admin';
}

/** Email the approver at the given stage. */
function emailApprover_(stage, sheet, row) {
  const rec = readRecord_(sheet, row);
  const to = approverEmailFor_(stage, rec);
  const token = rec[COL.TOKEN];
  const base = PropertiesService.getScriptProperties().getProperty(PROP_WEBAPP_URL) || '';
  const approveUrl = actionUrl_(base, row, stage, 'approve', token);
  const rejectUrl  = actionUrl_(base, row, stage, 'reject', token);

  const banner = String(rec[COL.FLAG]).indexOf('OVER BUDGET') === 0
    ? '<div style="background:#ffe5e5;border:1px solid #b00;color:#900;padding:10px;border-radius:6px;margin:0 0 14px;font-family:Arial,sans-serif;"><b>⚠ ' + esc_(rec[COL.FLAG]) + '</b></div>'
    : '';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">' +
      '<h2 style="margin:0 0 4px;">Travel Request ' + esc_(rec[COL.ID]) + ' — ' + esc_(stageLabel_(stage)) + ' Approval</h2>' +
      '<p style="color:#555;margin:0 0 16px;">Requested by <b>' + esc_(rec[COL.NAME]) + '</b> (' + esc_(rec[COL.EMAIL]) + ')</p>' +
      banner +
      tripSummaryHtml_(rec) +
      breakdownTableHtml_(rec) +
      '<div style="margin:22px 0;">' +
        btn_(approveUrl, 'APPROVE', '#0a8a0a') + '&nbsp;&nbsp;' + btn_(rejectUrl, 'REJECT', '#c0392b') +
      '</div>' +
      '<p style="color:#888;font-size:12px;">If the buttons don\'t work, paste these:<br>' +
        'Approve: ' + esc_(approveUrl) + '<br>Reject: ' + esc_(rejectUrl) + '</p>' +
    '</div>';

  const opts = { htmlBody: html, name: CONFIG.COMPANY_NAME + ' Travel Workflow' };
  if (CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL]) opts.cc = rec[COL.EMAIL];

  MailApp.sendEmail(to,
    '[Action Needed] ' + rec[COL.ID] + ' — ' + stageLabel_(stage) + ' approval (' + money_(rec[COL.C_TOTAL], rec[COL.CURRENCY]) + ')',
    'Open in an HTML email client.\nApprove: ' + approveUrl + '\nReject: ' + rejectUrl, opts);
}

/** Handle an Approve / Reject click from an email link. */
function handleDecision_(p) {
  const stage = p.stage, decision = p.decision, token = p.token;
  const row = parseInt(p.row, 10);
  if (!stage || !decision || !token || !row) {
    return htmlPage_('Invalid Link', 'This approval link is missing information.', '#b00');
  }

  const sheet = getSheet_();
  const rec = readRecord_(sheet, row);
  if (!rec || String(rec[COL.TOKEN]) !== String(token)) {
    return htmlPage_('Link Expired / Invalid', 'This approval link is no longer valid.', '#b00');
  }
  if (String(rec[COL.STAGE]) !== stage) {
    return htmlPage_('Already Processed',
      'This request is no longer at the "' + esc_(stage) + '" step. Current status: ' + esc_(rec[COL.STATUS]) + '.', '#a60');
  }

  const approver = safeUserEmail_();
  const now = new Date();
  const decCol = { dept: COL.DEPT_DEC, ceo: COL.CEO_DEC, finance: COL.FIN_DEC }[stage];
  const timeCol = { dept: COL.DEPT_TIME, ceo: COL.CEO_TIME, finance: COL.FIN_TIME }[stage];

  if (decision === 'reject') {
    updateCells_(sheet, row, [
      [COL.TOKEN, ''], [COL.STAGE, 'rejected'], [COL.STATUS, 'Rejected at ' + stageLabel_(stage)],
      [decCol, 'Rejected by ' + approver], [timeCol, now],
    ]);
    if (rec[COL.EMAIL]) {
      MailApp.sendEmail(rec[COL.EMAIL], 'Travel Request ' + rec[COL.ID] + ' — REJECTED',
        'Your travel request was rejected at the ' + stageLabel_(stage) + ' stage by ' + approver + '.\n' +
        'Please contact them for details or submit a revised request.');
    }
    return htmlPage_('Rejected', 'You have rejected ' + rec[COL.ID] + '. The requester has been notified.', '#b00');
  }
  if (decision !== 'approve') return htmlPage_('Unknown Action', 'Unrecognized decision.', '#b00');

  // ---- APPROVE ----
  const next = nextStage_(rec[COL.TYPE], stage);
  const newToken = Utilities.getUuid();
  const updates = [
    [decCol, 'Approved by ' + approver], [timeCol, now], [COL.TOKEN, newToken],
  ];

  if (next && next !== 'admin') {
    updates.push([COL.STAGE, next], [COL.STATUS, 'Pending ' + stageLabel_(next) + ' Approval']);
    updateCells_(sheet, row, updates);
    emailApprover_(next, sheet, row);
    return htmlPage_('Approved → ' + stageLabel_(next),
      rec[COL.ID] + ' approved. Forwarded to ' + stageLabel_(next) + '.', '#0a0');
  }

  // Final approval -> Admin arrangements.
  updates.push([COL.STAGE, 'admin'], [COL.STATUS, 'Approved — With Admin for Arrangements'], [COL.ADMIN, 'Pending']);
  updateCells_(sheet, row, updates);
  emailAdmin_(sheet, row);
  if (CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL]) {
    MailApp.sendEmail(rec[COL.EMAIL], 'Travel Request ' + rec[COL.ID] + ' — APPROVED',
      'Good news! Your travel request is fully approved. Admin has been notified to make arrangements.');
  }
  return htmlPage_('Approved → Sent to Admin',
    rec[COL.ID] + ' fully approved. Admin has been notified to make arrangements.', '#0a0');
}

function emailAdmin_(sheet, row) {
  const rec = readRecord_(sheet, row);
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">' +
      '<h2 style="margin:0 0 4px;">Travel Request ' + esc_(rec[COL.ID]) + ' — APPROVED ✅</h2>' +
      '<p style="color:#555;margin:0 0 16px;">Fully approved. Please make arrangements per policy.</p>' +
      '<p style="margin:0 0 16px;">Traveller: <b>' + esc_(rec[COL.NAME]) + '</b> (' + esc_(rec[COL.EMAIL]) + ')</p>' +
      tripSummaryHtml_(rec) + breakdownTableHtml_(rec) +
      '<p style="color:#888;font-size:12px;margin-top:18px;">Update the "Admin Status" column once booked.</p>' +
    '</div>';
  const opts = { htmlBody: html, name: CONFIG.COMPANY_NAME + ' Travel Workflow' };
  if (CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL]) opts.cc = rec[COL.EMAIL];
  MailApp.sendEmail(CONFIG.ADMIN_TEAM, '[Approved] Make arrangements — ' + rec[COL.ID] + ' (' + rec[COL.NAME] + ')', '', opts);
}


/* ===========================================================================
 *  EMAIL HTML BUILDERS
 * ======================================================================== */
function tripSummaryHtml_(rec) {
  const rows = [
    ['Travel Type', cap_(rec[COL.TYPE]) + ' · ' + rec[COL.TRIP]],
    ['Route', rec[COL.FROM] + ' → ' + rec[COL.TO] + (rec[COL.RETTO] ? ' → ' + rec[COL.RETTO] : '')],
    ['Dates', rec[COL.START] + (rec[COL.RET] ? ' to ' + rec[COL.RET] : '') + '  (' + rec[COL.DAYS] + ' day(s), ' + rec[COL.NIGHTS] + ' night(s))'],
    ['Department', rec[COL.DEPT]],
    ['Purpose', rec[COL.PURPOSE]],
    ['Transport', rec[COL.MODE]],
  ];
  return kvTable_(rows);
}

/** The itemised cost breakdown approvers asked for. */
function breakdownTableHtml_(rec) {
  const cur = rec[COL.CURRENCY];
  const line = function (label, amount, sub) {
    return '<tr>' +
      '<td style="padding:8px 12px;border:1px solid #eee;">' + label + (sub ? ' <span style="color:#999;font-size:12px;">' + sub + '</span>' : '') + '</td>' +
      '<td style="padding:8px 12px;border:1px solid #eee;text-align:right;white-space:nowrap;">' + money_(amount, cur) + '</td></tr>';
  };
  let html = '<table style="border-collapse:collapse;width:100%;font-size:14px;font-family:Arial,sans-serif;margin-top:6px;">';
  html += '<tr style="background:#0D1B2A;color:#fff;"><th style="padding:8px 12px;text-align:left;">Cost Breakdown</th><th style="padding:8px 12px;text-align:right;">' + esc_(cur) + '</th></tr>';
  html += line('🚆 Travel / Transport', rec[COL.C_TRANSPORT]);
  html += line('🏨 Hotel', rec[COL.C_HOTEL], rec[COL.HOTEL_REQ] === 'Yes' ? money_(rec[COL.HOTEL_RATE], cur) + '/night × ' + rec[COL.HOTEL_NIGHTS] : 'not required');
  html += line('🍽️ Meals', rec[COL.C_MEALS], money_(rec[COL.MEAL_RATE], cur) + '/day × ' + rec[COL.DAYS]);
  html += line('🚖 Local Travel', rec[COL.C_LOCAL]);
  html += line('➕ Other', rec[COL.C_OTHER]);
  html += '<tr style="background:#f3f6fb;font-weight:bold;font-size:15px;">' +
    '<td style="padding:10px 12px;border:1px solid #e3e8f0;">TOTAL ESTIMATED</td>' +
    '<td style="padding:10px 12px;border:1px solid #e3e8f0;text-align:right;">' + money_(rec[COL.C_TOTAL], cur) + '</td></tr>';
  html += '</table>';
  html += '<p style="font-size:12px;color:#555;margin:8px 0 0;"><b>Budget check:</b> ' + esc_(rec[COL.FLAG]) + '</p>';
  if (rec[COL.NOTES]) html += '<p style="font-size:13px;color:#333;margin:8px 0 0;"><b>Notes:</b> ' + esc_(rec[COL.NOTES]) + '</p>';
  return html;
}

function kvTable_(rows) {
  let html = '<table style="border-collapse:collapse;width:100%;font-size:14px;font-family:Arial,sans-serif;">';
  rows.forEach(function (r, i) {
    const bg = i % 2 ? '#f7f7f7' : '#ffffff';
    html += '<tr style="background:' + bg + ';">' +
      '<td style="padding:7px 12px;border:1px solid #eee;color:#555;width:34%;">' + esc_(r[0]) + '</td>' +
      '<td style="padding:7px 12px;border:1px solid #eee;">' + esc_(String(r[1] == null ? '' : r[1])) + '</td></tr>';
  });
  return html + '</table>';
}

function btn_(url, label, color) {
  return '<a href="' + url + '" style="display:inline-block;padding:12px 26px;background:' + color +
    ';color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;">' + label + '</a>';
}
function actionUrl_(base, row, stage, decision, token) {
  return base + '?row=' + row + '&stage=' + stage + '&decision=' + decision + '&token=' + token;
}


/* ===========================================================================
 *  SHEET HELPERS
 * ======================================================================== */
function getSheet_() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty(PROP_SHEET_ID);
  let ss;
  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    ss = SpreadsheetApp.create(CONFIG.COMPANY_NAME + ' - Travel Requests');
    props.setProperty(PROP_SHEET_ID, ss.getId());
  }
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (sheet.getName() !== SHEET_NAME) sheet.setName(SHEET_NAME);
  ensureHeaders_(sheet);
  return sheet;
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() < 1) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    return;
  }
  // add any missing headers at the end (forward-compatible)
  const have = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const haveSet = {}; have.forEach(function (h) { haveSet[h] = true; });
  let next = sheet.getLastColumn() + 1;
  HEADERS.forEach(function (h) { if (!haveSet[h]) { sheet.getRange(1, next++).setValue(h); } });
}

function headerMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach(function (h, i) { map[h] = i + 1; });
  return map;
}

function appendRecord_(sheet, record) {
  const map = headerMap_(sheet);
  const width = sheet.getLastColumn();
  const rowVals = new Array(width).fill('');
  Object.keys(record).forEach(function (k) { if (map[k]) rowVals[map[k] - 1] = record[k]; });
  sheet.appendRow(rowVals);
  return sheet.getLastRow();
}

function readRecord_(sheet, row) {
  if (row < 2 || row > sheet.getLastRow()) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rec = {};
  headers.forEach(function (h, i) { rec[h] = values[i]; });
  return rec;
}

function updateCells_(sheet, row, pairs) {
  const map = headerMap_(sheet);
  pairs.forEach(function (kv) {
    const c = map[kv[0]];
    if (c) sheet.getRange(row, c).setValue(kv[1]);
  });
}


/* ===========================================================================
 *  SETUP / DEPLOY HELPERS
 * ======================================================================== */
function setup() {
  const sheet = getSheet_();
  const ss = sheet.getParent();
  Logger.log('SETUP COMPLETE');
  Logger.log('Responses sheet: ' + ss.getUrl());
  Logger.log('NEXT: Deploy > New deployment > Web app, then run registerWebAppUrl().');
}

function registerWebAppUrl() {
  const url = ScriptApp.getService().getUrl();
  if (!url) { Logger.log('No web app URL yet. Deploy as Web app first.'); return; }
  PropertiesService.getScriptProperties().setProperty(PROP_WEBAPP_URL, url);
  Logger.log('Web app URL registered: ' + url);
}

function cacheWebAppUrl_() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP_WEBAPP_URL)) {
    const u = ScriptApp.getService().getUrl();
    if (u) props.setProperty(PROP_WEBAPP_URL, u);
  }
}


/* ===========================================================================
 *  UTILITIES
 * ======================================================================== */
function duration_(start, end) {
  const s = new Date(start), e = new Date(end);
  if (isNaN(s) || isNaN(e) || e < s) return { days: start ? 1 : 0, nights: 0 };
  const days = Math.round((e - s) / 86400000) + 1;
  return { days: days, nights: Math.max(0, days - 1) };
}
function num_(x) {
  const n = parseFloat(String(x == null ? '' : x).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function money_(n, currency) {
  const cur = currency || 'INR';
  const locale = cur === 'USD' ? 'en-US' : 'en-IN';
  return cur + ' ' + Number(n || 0).toLocaleString(locale, { maximumFractionDigits: 0 });
}
function cap_(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtDate_(d) {
  if (!d) return '';
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd MMM yyyy');
  }
  return String(d);
}
function dateStamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
}
function seq_() {
  // Monotonic-ish per-day sequence using script properties.
  const props = PropertiesService.getScriptProperties();
  const key = 'TRF_SEQ';
  const n = (parseInt(props.getProperty(key), 10) || 1000) + 1;
  props.setProperty(key, String(n));
  return n;
}
function safeUserEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}
function htmlPage_(title, msg, color) {
  const html =
    '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:40px;}' +
    '.card{max-width:480px;margin:40px auto;background:#fff;border-radius:10px;padding:34px;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.08);text-align:center;}' +
    'h1{color:' + color + ';margin:0 0 12px;font-size:22px;}p{color:#444;font-size:15px;line-height:1.5;}</style>' +
    '</head><body><div class="card"><h1>' + esc_(title) + '</h1><p>' + esc_(msg) + '</p>' +
    '<p style="color:#999;font-size:12px;margin-top:20px;">' + esc_(CONFIG.COMPANY_NAME) + ' Travel Workflow</p>' +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title);
}
