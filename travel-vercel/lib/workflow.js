import { randomUUID } from 'crypto';
import { CONFIG, COL, deptsForHod, AUTH } from './config.js';
import { computeCosts, duration, hotelNights, isUsRegion } from './costs.js';
import { searchFlights, flightsAvailable } from './flights.js';
import { flightPrice, hotelNightlyRate, amadeusAvailable } from './amadeus.js';
import { ensureHeaders, appendRecord, findById, updateCells, readAll } from './sheets.js';
import { sendEmail as _sendEmail, approvalEmailHtml, adminEmailHtml, forexOfficerEmailHtml, reminderEmailHtml, taskReminderEmailHtml, itineraryEmailHtml, emailShell, btn, cap } from './email.js';
import { logEmail } from './emaillogstore.js';

// Wrapper around sendEmail that records an audit-log row for every email (who/when/which request).
// The request id is derived from the subject (every subject includes the TRF id). Logging is
// fire-and-forget so it never slows or breaks a send.
async function sendEmail(opts) {
  const r = await _sendEmail(opts);
  try {
    const subj = String((opts && opts.subject) || '');
    const idm = subj.match(/TRF-[0-9A-Za-z-]+/);
    const flat = (x) => Array.isArray(x) ? x.join(', ') : String(x || '');
    logEmail({ id: idm ? idm[0] : '', to: flat(opts && opts.to), cc: flat(opts && opts.cc), subject: subj });
  } catch (e) { /* never break a send over logging */ }
  return r;
}
import { tripICS } from './ics.js';
import { expenseActualsByTrf } from './expenseActuals.js';
import { applyPolicyOverrides, readChanges, editableSnapshot } from './policystore.js';
import { mergedVersions } from './policyversionsstore.js';
import { remindersEnabled, reminderHour, getSetting, setSetting } from './settingsstore.js';
import { flightTimeLabel } from './tz.js';

// The address that should receive requester-facing status emails. When a request was raised
// on behalf of someone else this is the person who FILED it (not the traveller).
function requesterEmail(rec) {
  return String(rec[COL.REQUESTED_BY] || rec[COL.EMAIL] || '').trim();
}

// ---- approval chain ----
export function chainFor(type) {
  // Approval stages (each gets an Approve/Reject email). Finance is added ONLY when the
  // request breaks policy. Local: Admin is the final approver. Domestic/Intl: Admin is
  // notified for arrangements only (no approval).
  const broken = arguments[1];
  const ceoReq = arguments[2]; // CEO's own trip → Finance approves (no HOD/CEO self-approval)
  if (ceoReq) return ['finance'];
  if (type === 'international') return broken ? ['dept', 'ceo', 'finance'] : ['dept', 'ceo'];
  // Local & domestic: HOD approves (+ Finance only if policy-broken). Admin then arranges (no approval).
  return broken ? ['dept', 'finance'] : ['dept'];
}
export function chainLabels(type, broken, ceoReq) {
  const map = { dept: 'HOD', ceo: 'CEO', finance: 'Finance', admin: 'Admin' };
  const steps = chainFor(type, broken, ceoReq).map((s) => map[s]);
  steps.push('Admin'); // Admin arranges/books (all trip types) — informational, no approval
  steps.push('Confirmed');
  return steps;
}
function stageLabel(stage) {
  return { dept: 'Department Head', ceo: 'CEO', finance: 'Finance SPOC', admin: 'Admin' }[stage] || stage;
}
function approverEmailFor(stage, rec) {
  if (rec[COL.DELEGATE_EMAIL]) return rec[COL.DELEGATE_EMAIL]; // OOO delegation overrides the default approver for this stage
  if (stage === 'dept')    return deptHeadIsRequester(rec) ? CONFIG.CEO_EMAIL : (rec[COL.HOD] || CONFIG.FINANCE_SPOC); // dept head's own trip → CEO approves
  if (stage === 'ceo')     return CONFIG.CEO_EMAIL;
  if (stage === 'finance') return CONFIG.FINANCE_SPOC;
  return CONFIG.ADMIN_TEAM;
}
// Next APPROVAL stage, or null if the current stage was the last approval.
function nextStage(type, current, broken, ceoReq) {
  const chain = chainFor(type, broken, ceoReq);
  const i = chain.indexOf(current);
  if (i === -1) return null;
  return (i + 1 < chain.length) ? chain[i + 1] : null;
}

function actionUrl(base, id, stage, decision) {
  // Login-gated portal page. Clicking in the email opens it → the approver must SIGN IN → the
  // approval is then performed by the authenticated session (role + no-self-approval enforced).
  // No token-based one-click approval (that allowed link-scanners / the requester to auto-approve).
  return `${base}/approve?id=${encodeURIComponent(id)}&stage=${stage}&decision=${decision}`;
}

async function emailApprover(stage, rec, baseUrl, extra = {}) {
  const to = approverEmailFor(stage, rec);
  const token = rec[COL.TOKEN];
  const id = rec[COL.ID];
  let html = approvalEmailHtml(rec, stageLabel(stage),
    actionUrl(baseUrl, id, stage, 'approve', token),
    actionUrl(baseUrl, id, stage, 'reject', token));
  let subject = `[Action Needed] ${id} — ${stageLabel(stage)} approval`;
  if (extra.edited) {
    subject = `[Edited — please re-review] ${id} — ${stageLabel(stage)} approval`;
    html = `<div style="background:#FFF7E6;border:1px solid #F59E0B;color:#92400E;padding:11px 14px;border-radius:6px;margin:0 0 14px;font-family:Arial,sans-serif;">` +
      `<b>✏️ This request was edited by the requester and resubmitted.</b> Please review the updated details below before approving.</div>` + html;
  }
  const opts = { to, subject, html };
  if (CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL]) opts.cc = rec[COL.EMAIL];
  await sendEmail(opts);
}

// "City (CODE)" → the plain city name (Sky-Scrapper's airport search resolves city names reliably).
function locQuery(s) {
  return String(s || '').replace(/\s*\([A-Za-z]{3}\)\s*$/, '').trim();
}
// "City (CODE)" → the IATA code (for Amadeus, which takes airport codes directly).
function codeOf(s) {
  const m = String(s || '').match(/\(([A-Za-z]{3})\)/);
  return m ? m[1].toUpperCase() : null;
}
// Airport code → IATA *city* code for hotel search (multi-airport cities differ from their airport code).
const CITY_CODE = { JFK: 'NYC', EWR: 'NYC', ORD: 'CHI', IAD: 'WAS', DCA: 'WAS', IAH: 'HOU' };
function hotelCityCode(airportCode) { return airportCode ? (CITY_CODE[airportCode] || airportCode) : null; }

// Best-effort LIVE median nightly hotel rate (Amadeus). Returns a number or null → policy cap.
async function liveHotelRate(p, nights) {
  try {
    if (!amadeusAvailable() || !(nights > 0)) return null;
    if (p.tripType !== 'round' || !p.startDate || !p.returnDate) return null;
    const cityCode = hotelCityCode(codeOf(p.to));
    if (!cityCode) return null;
    const currency = isUsRegion(p) ? 'USD' : 'INR';
    return await withTimeout(hotelNightlyRate({ cityCode, checkIn: p.startDate, checkOut: p.returnDate, currency, nights }), 6500);
  } catch (e) {
    console.warn('live hotel rate unavailable, using cap:', e.message || e);
    return null;
  }
}
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('flight price timeout')), ms))]);
}
// Best-effort LIVE flight price at submit (RapidAPI Sky-Scrapper). Returns the cheapest economy
// round-trip fare in the trip currency, or null to fall back to the policy estimate. Never throws.
async function liveFlightCost(p) {
  // LIVE PRICING DISABLED (deliberate). The flight budget always comes from the Finance-editable
  // policy estimate — for BOTH the base flight and every extra multi-city leg — so costs are
  // predictable and fully controlled by Finance, never by fluctuating live fares.
  return null;
  /* Preserved for reference — to re-enable live pricing, remove the early return above. */
  try {                                                                     // eslint-disable-line no-unreachable
    if (!/flight/i.test(String(p.transportMode || ''))) return null;   // only when flying
    if (!p.from || !p.to || !p.startDate) return null;
    const currency = isUsRegion(p) ? 'USD' : 'INR';
    const returnDate = p.tripType === 'round' ? p.returnDate : undefined;

    // Primary: Amadeus (takes IATA codes directly from "City (CODE)").
    if (amadeusAvailable()) {
      const oc = codeOf(p.from), dc = codeOf(p.to);
      if (oc && dc) {
        const price = await withTimeout(flightPrice({ originCode: oc, destCode: dc, date: p.startDate, returnDate, currency }), 6500);
        if (price > 0) return price;
      }
    }
    // Fallback: RapidAPI Sky-Scrapper (by city name).
    if (flightsAvailable()) {
      const its = await withTimeout(searchFlights({
        from: locQuery(p.from), to: locQuery(p.to), date: p.startDate, returnDate, currency, cabinClass: 'economy',
      }), 6500);
      if (its && its.length) { const c = its.reduce((m, x) => (x.price < m.price ? x : m), its[0]); if (c.price > 0) return c.price; }
    }
    return null; // → policy estimate
  } catch (e) {
    console.warn('live flight price unavailable, using estimate:', e.message || e);
    return null;
  }
}

// ---- submit ----
// Validate + price + map a payload into the trip/cost columns (shared by submit & edit).
// Returns { trip, personal, costs } — `trip` is the recomputed logistics/cost block,
// `personal` is identity/document fields (only written on create, preserved on edit).
async function computeTripFields(p) {
  await applyPolicyOverrides(); // use the current (Finance-edited) policy values; forward-only by design
  const missing = [];
  if (!p.name)       missing.push('name');
  if (!p.dept)       missing.push('department');
  if (!p.travelType) missing.push('travel type');
  if (!p.from)       missing.push('origin');
  if (!p.to)         missing.push('destination');
  if (!p.startDate)  missing.push('start date');
  if (p.tripType === 'round' && !p.returnDate) missing.push('return date');
  if (missing.length) throw new Error('Missing required field(s): ' + missing.join(', '));

  const dur = duration(p.startDate, p.tripType === 'round' ? p.returnDate : p.startDate);
  // advance notice (calendar days from today to departure) for the short-notice break check
  const advanceDays = Math.ceil((new Date(p.startDate) - new Date()) / 86400000);
  // multi-city itinerary — extra flight legs & hotel stays (beyond the primary trip)
  const extraFlights = (Array.isArray(p.extraFlights) ? p.extraFlights : [])
    .filter((f) => f && (f.from || f.to || f.date))
    .map((f) => ({ from: String(f.from || ''), to: String(f.to || ''), date: String(f.date || ''), time: String(f.time || '') }));
  const flightTimesIn = (p.flightTimes && typeof p.flightTimes === 'object') ? { out: String(p.flightTimes.out || ''), ret: String(p.flightTimes.ret || '') } : { out: '', ret: '' };
  const extraHotels = (Array.isArray(p.extraHotels) ? p.extraHotels : [])
    .filter((h) => h && (h.city || h.checkIn || h.checkOut))
    .map((h) => ({ city: String(h.city || ''), checkIn: String(h.checkIn || ''), checkOut: String(h.checkOut || '') }));
  // Group travel — passenger list (primary requester + any added passengers); cost scales by count.
  const extraPassengers = (Array.isArray(p.extraPassengers) ? p.extraPassengers : [])
    .filter((x) => x && (x.name || x.email))
    .map((x) => ({ name: String(x.name || '').trim(), email: String(x.email || '').trim() }));
  const passengers = [{ name: p.name || '', email: (p.email || '').trim() }].concat(extraPassengers);
  const pax = passengers.length;

  // Primary hotel (explicit Yes/No). Default: needed unless the form says No.
  const hotelNeeded = !(p.hotelNeeded === false || p.hotelNeeded === 'No');
  const hotelN = (p.hotelCheckIn && p.hotelCheckOut) ? hotelNights(p.hotelCheckIn, p.hotelCheckOut) : dur.nights;
  // Live pricing (best-effort, parallel): flight fare + hotel nightly rate. Either falls back to estimate/cap.
  const [flightCost, hotelRate] = await Promise.all([liveFlightCost(p), liveHotelRate(p, hotelNeeded ? hotelN : 0)]);
  const costs = computeCosts(p, dur, { advanceDays, extraFlights, extraHotels, flightCost, hotelRate, passengers: pax });
  const deptInfo = CONFIG.DEPARTMENTS[p.dept] || null;
  const hodEmail = (deptInfo && deptInfo.email) || p.hodEmail || CONFIG.FINANCE_SPOC;

  const trip = {
    [COL.NAME]: p.name, [COL.EMPID]: p.empId || '', [COL.DEPT]: p.dept, [COL.HOD]: hodEmail,
    [COL.TYPE]: p.travelType, [COL.TRIP]: p.tripType === 'round' ? 'Round trip' : 'One-way',
    [COL.FROM]: p.from, [COL.TO]: p.to,
    [COL.RETFROM]: p.tripType === 'round' ? (p.returnFrom || p.to) : '',
    [COL.RETTO]: p.tripType === 'round' ? (p.returnTo || p.from) : '',
    [COL.START]: p.startDate, [COL.RET]: p.tripType === 'round' ? p.returnDate : '',
    [COL.DAYS]: dur.days, [COL.NIGHTS]: dur.nights, [COL.PURPOSE]: p.purpose || '',
    [COL.MODE]: p.transportMode || '', [COL.CURRENCY]: costs.currency,
    [COL.C_TRANSPORT]: costs.transport, [COL.HOTEL_REQ]: costs.hotelReq ? 'Yes' : 'No',
    [COL.HOTEL_RATE]: costs.hotelPerNight, [COL.HOTEL_NIGHTS]: costs.hotelNights,
    [COL.C_HOTEL]: costs.hotel, [COL.MEAL_RATE]: costs.mealsPerDay, [COL.C_MEALS]: costs.meals,
    [COL.C_LOCAL]: costs.local, [COL.C_OTHER]: costs.other, [COL.C_TOTAL]: costs.total,
    [COL.FOREX]: costs.forex, [COL.FLAG]: costs.flag, [COL.NOTES]: p.notes || '',
    [COL.VISA_NEEDED]: (p.travelType === 'international') ? (p.visaNeeded ? 'Yes' : 'No') : '',
    [COL.C_EXTRAS]: JSON.stringify(costs.extras || {}), [COL.C_DEPOSIT]: costs.deposit || 0,
    [COL.PASSENGERS]: JSON.stringify(passengers), [COL.PAX]: pax,
    [COL.ITINERARY]: JSON.stringify({ flights: extraFlights, hotels: extraHotels, times: flightTimesIn,
      primaryHotel: { needed: hotelNeeded, country: p.hotelCountry || '', city: p.hotelCity || '', checkIn: p.hotelCheckIn || '', checkOut: p.hotelCheckOut || '' } }),
    [COL.PREF_FLIGHT_DOC]: p.prefFlightDoc || '', [COL.PREF_FLIGHT_NOTES]: p.prefFlightNotes || '',
  };
  const personal = {
    [COL.NATIONALITY]: p.nationality || '', [COL.PASSPORT_NO]: p.passportNo || '',
    [COL.PASSPORT_ISSUE]: p.passportIssue || '', [COL.DESIGNATION]: p.designation || '',
    [COL.ADDRESS]: p.address || '', [COL.MOBILE]: p.mobile || '',
    [COL.PASSPORT_EXPIRY]: p.passportExpiry || '', [COL.PAN_NO]: p.panNo || '', [COL.AIRLINES]: p.airline || '',
    [COL.DOC_PASSPORT]: p.docPassport || '', [COL.DOC_VISA]: p.docVisa || '',
    [COL.DOC_PANAADHAAR]: p.docPanAadhaar || '',
    [COL.ID_DOC_TYPE]: p.idDocType || '', [COL.DOC_AADHAAR]: p.docAadhaar || '',
    [COL.DOC_PAN]: p.docPan || '', [COL.DOC_NATIONAL_ID]: p.docNationalId || '',
  };
  return { trip, personal, costs };
}

export async function submitRequest(p, baseUrl) {
  // Duplicate guard — same traveller + route + dates + dept submitted in the last 2 minutes → reuse it.
  const recent = await readAll();
  const now = Date.now();
  const dup = recent.find((x) =>
    String(x[COL.STAGE]) !== 'withdrawn' &&
    String(x[COL.EMAIL] || '').toLowerCase() === String(p.email || '').toLowerCase() &&
    String(x[COL.FROM]) === String(p.from) && String(x[COL.TO]) === String(p.to) &&
    String(x[COL.START]) === String(p.startDate) && String(x[COL.DEPT]) === String(p.dept) &&
    (now - Date.parse(x[COL.TS])) < 2 * 60 * 1000);
  if (dup) {
    return { ok: true, id: dup[COL.ID], duplicate: true, currency: dup[COL.CURRENCY],
      total: Number(dup[COL.C_TOTAL] || 0), chain: chainLabels(dup[COL.TYPE], /^POLICY BREAK/.test(String(dup[COL.FLAG] || '')), ceoIsRequester(dup)) };
  }

  // Overlapping-trip warning — the same traveller already has an active trip on overlapping dates.
  // Soft check: the client can re-submit with confirmOverlap:true to proceed anyway.
  if (!p.confirmOverlap) {
    const ns = Date.parse(p.startDate), ne = Date.parse(p.returnDate || p.startDate);
    if (!isNaN(ns)) {
      const clash = recent.find((x) => {
        if (['rejected', 'withdrawn', 'scrapped'].includes(String(x[COL.STAGE]))) return false;
        if (String(x[COL.EMAIL] || '').toLowerCase() !== String(p.email || '').toLowerCase()) return false;
        const xs = Date.parse(x[COL.START]); if (isNaN(xs)) return false;
        const xe = Date.parse(x[COL.RET] || x[COL.START]); const xEnd = isNaN(xe) ? xs : xe;
        const nEnd = isNaN(ne) ? ns : ne;
        return ns <= xEnd && xs <= nEnd; // date ranges overlap
      });
      if (clash) return { ok: false, overlap: { id: clash[COL.ID], route: `${clash[COL.FROM]} → ${clash[COL.TO]}`, start: fmtDate(clash[COL.START]), end: fmtDate(clash[COL.RET]) || '' } };
    }
  }

  const { trip, personal, costs } = await computeTripFields(p);
  const id = 'TRF-' + stamp() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const rec0 = {
    [COL.ID]: id, [COL.TS]: new Date().toISOString(), [COL.EMAIL]: (p.email || '').trim(),
    ...trip, ...personal,
    // Who filed this request. Equals the traveller's email when self-booking; differs when
    // raised on behalf of someone else. Status emails go here (the requester), not the traveller.
    [COL.REQUESTED_BY]: (p.requestedBy || p.email || '').trim(),
  };
  // The CEO's own trip can't be self-approved and has no HOD above → it goes straight to Finance.
  const ceoReq = ceoIsRequester(rec0);
  const firstStage = ceoReq ? 'finance' : 'dept';
  const rec = {
    ...rec0,
    [COL.STATUS]: ceoReq ? ('Pending ' + stageLabel('finance') + ' Approval') : 'Pending HOD Approval', [COL.STAGE]: firstStage, [COL.TOKEN]: randomUUID(), [COL.ADMIN]: '',
    [COL.DOC_TICKET]: '', [COL.FOREX_TOPUPS]: '', [COL.BOOKINGS]: '',
    [COL.ACTUALS]: '', [COL.ACTUALS_STATUS]: 'Pending', [COL.REIMBURSE_AMT]: '',
  };

  await ensureHeaders();
  await appendRecord(rec);
  await emailApprover(firstStage, rec, baseUrl);

  return { ok: true, id, currency: costs.currency, total: costs.total, chain: chainLabels(p.travelType, costs.broken, ceoReq) };
}

// ---- requester self-service: edit (while still at HOD) / withdraw ----
function ownsRequest(rec, email) {
  const e = String(email || '').toLowerCase();
  return [rec[COL.EMAIL], rec[COL.REQUESTED_BY]].map((x) => String(x || '').toLowerCase()).includes(e);
}
// True when the request's own Department Head is the person who raised it / is travelling.
// A dept head can't approve their own trip, so its HOD stage escalates to the CEO instead.
function deptHeadIsRequester(rec) {
  const head = String((CONFIG.DEPARTMENTS[String(rec[COL.DEPT] || '')] || {}).email || '').toLowerCase();
  if (!head) return false;
  const filer = String(rec[COL.REQUESTED_BY] || rec[COL.EMAIL] || '').toLowerCase();
  const traveller = String(rec[COL.EMAIL] || '').toLowerCase();
  return head === filer || head === traveller;
}
// True when the CEO is the traveller / raised the request. The CEO can't approve their own
// trip (and has no one above them), so it routes straight to Finance for approval.
function ceoIsRequester(rec) {
  const ceo = String(CONFIG.CEO_EMAIL || '').toLowerCase();
  if (!ceo) return false;
  const filer = String(rec[COL.REQUESTED_BY] || rec[COL.EMAIL] || '').toLowerCase();
  const traveller = String(rec[COL.EMAIL] || '').toLowerCase();
  return ceo === filer || ceo === traveller;
}
// The current owner/approver address for a stage (for withdraw notifications).
function ownerForStage(rec, stage) {
  if (stage === 'dept') return rec[COL.DELEGATE_EMAIL] || rec[COL.HOD] || CONFIG.FINANCE_SPOC;
  if (stage === 'ceo') return CONFIG.CEO_EMAIL;
  if (stage === 'finance') return CONFIG.FINANCE_SPOC;
  if (stage === 'arrange' || stage === 'admin') return CONFIG.ADMIN_TEAM;
  if (stage === 'forex') return CONFIG.FOREX_OFFICER;
  return '';
}

// Most-recent saved personal/passport details for a traveller, so the international request
// form can prefill them instead of re-typing every time. Returns null if nothing on file.
export async function travellerProfile(email) {
  const e = String(email || '').toLowerCase(); if (!e) return null;
  const all = await readAll();
  const mine = all.filter((r) => String(r[COL.EMAIL] || '').toLowerCase() === e && String(r[COL.PASSPORT_NO] || '').trim());
  if (!mine.length) return null;
  mine.sort((a, b) => (Date.parse(b[COL.TS]) || 0) - (Date.parse(a[COL.TS]) || 0));
  const r = mine[0];
  return {
    nationality: r[COL.NATIONALITY] || '', passportNo: r[COL.PASSPORT_NO] || '',
    passportIssue: r[COL.PASSPORT_ISSUE] || '', passportExpiry: r[COL.PASSPORT_EXPIRY] || '',
    panNo: r[COL.PAN_NO] || '', designation: r[COL.DESIGNATION] || '',
    mobile: r[COL.MOBILE] || '', address: r[COL.ADDRESS] || '',
    docPassport: r[COL.DOC_PASSPORT] || '', docVisa: r[COL.DOC_VISA] || '',
    idDocType: r[COL.ID_DOC_TYPE] || '', docAadhaar: r[COL.DOC_AADHAAR] || '',
    docPan: r[COL.DOC_PAN] || '', docNationalId: r[COL.DOC_NATIONAL_ID] || '',
    fromTrip: r[COL.ID] || '',
  };
}

// Weekly leadership digest — a single branded summary email to the CEO + Finance.
// Called by the daily cron on Mondays. Set WEEKLY_DIGEST=false to disable.
export async function sendWeeklyDigest(baseUrl) {
  if (String(process.env.WEEKLY_DIGEST || '').toLowerCase() === 'false') return { ok: true, skipped: 'disabled' };
  const data = await financeData();
  const rows = data.rows || [];
  const now = Date.now();
  const fx = (CONFIG.FX && CONFIG.FX.USD_INR) || 92;
  const toINR = (amt, cur) => (String(cur).toUpperCase() === 'USD' ? Number(amt || 0) * fx : Number(amt || 0));
  let pendingApproval = 0, breaches = 0, advPending = 0, oldestDays = 0;
  const deptSpend = {};
  for (const r of rows) {
    const st = String(r.status || ''); const rejected = /reject|withdraw/i.test(st);
    const pend = r.hodStatus === 'Pending' || r.ceoStatus === 'Pending' || r.financeStatus === 'Pending';
    if (pend) { pendingApproval++; const sub = Date.parse(r.submission); if (sub) { const d = Math.floor((now - sub) / 86400000); if (d > oldestDays) oldestDays = d; } }
    if (/^POLICY BREAK/i.test(String(r.flag || ''))) breaches++;
    if (r.advance > 0 && /completed|forex card issued|done|confirmed/i.test(st) && (r.actuals && r.actuals.status) !== 'Closed') advPending++;
    if (!rejected) { const dep = r.dept || '—'; deptSpend[dep] = (deptSpend[dep] || 0) + toINR(r.total, r.currency); }
  }
  const topDept = Object.keys(deptSpend).map((k) => ({ k, v: deptSpend[k] })).sort((a, b) => b.v - a.v).slice(0, 5);
  const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  const pm = data.paymentMethods || { own: 0, company: 0, brex: 0 };
  const summaries = data.currencySummaries || {};

  const stat = (n, label, color) => `<td style="padding:0 6px;" width="33%" valign="top"><div style="border:1px solid #e6ebf2;border-radius:10px;padding:14px;text-align:center;"><div style="font-size:26px;font-weight:800;color:${color};line-height:1;">${n}</div><div style="font-size:12px;color:#64748B;margin-top:6px;">${label}</div></div></td>`;
  const row = (a, b) => `<tr><td style="padding:7px 12px;border:1px solid #eef1f5;color:#3D506A;">${a}</td><td style="padding:7px 12px;border:1px solid #eef1f5;text-align:right;font-weight:700;">${b}</td></tr>`;
  let body = `<p style="margin:0 0 16px;color:#3D506A;">Here's this week's travel &amp; expense snapshot across Spyne.</p>`;
  body += `<table width="100%" style="border-collapse:separate;"><tr>${stat(pendingApproval, 'Pending approvals' + (oldestDays ? ` · oldest ${oldestDays}d` : ''), '#D97706')}${stat(breaches, 'Policy breaches', breaches ? '#E8232A' : '#0F9D58')}${stat(advPending, 'Advances to settle', advPending ? '#D97706' : '#0F9D58')}</tr></table>`;
  const curKeys = Object.keys(summaries);
  if (curKeys.length) {
    body += `<h3 style="font-size:14px;color:#0D1B2A;margin:22px 0 6px;">Pipeline by currency</h3><table style="border-collapse:collapse;width:100%;font-size:13px;">` +
      `<tr style="background:#0D1B2A;color:#fff;"><th style="padding:7px 12px;text-align:left;">Currency</th><th style="padding:7px 12px;text-align:right;">Pipeline</th><th style="padding:7px 12px;text-align:right;">Approved</th></tr>`;
    curKeys.forEach((c) => { const s = summaries[c]; const f = (n) => c + ' ' + Math.round(n).toLocaleString(c === 'USD' ? 'en-US' : 'en-IN'); body += `<tr><td style="padding:7px 12px;border:1px solid #eef1f5;">${c}</td><td style="padding:7px 12px;border:1px solid #eef1f5;text-align:right;">${f(s.totalPipeline)}</td><td style="padding:7px 12px;border:1px solid #eef1f5;text-align:right;color:#0F9D58;">${f(s.totalApproved)}</td></tr>`; });
    body += `</table>`;
  }
  if (topDept.length) {
    body += `<h3 style="font-size:14px;color:#0D1B2A;margin:22px 0 6px;">Top departments by spend (₹)</h3><table style="border-collapse:collapse;width:100%;font-size:13px;">`;
    topDept.forEach((d) => { body += row(String(d.k), inr(d.v)); });
    body += `</table>`;
  }
  const pmTot = (pm.own || 0) + (pm.company || 0) + (pm.brex || 0);
  if (pmTot > 0) {
    body += `<h3 style="font-size:14px;color:#0D1B2A;margin:22px 0 6px;">Actual spend by payment method (₹)</h3><table style="border-collapse:collapse;width:100%;font-size:13px;">` +
      row('Own money (reimbursed)', inr(pm.own || 0)) + row('Company card / forex', inr(pm.company || 0)) + row('Brex Card', inr(pm.brex || 0)) + `</table>`;
  }
  body += `<div style="margin:22px 0 4px;">${btn((baseUrl || '') + '/finance', 'Open Finance dashboard →', '#0D1B2A')}</div>`;

  const html = emailShell({
    title: 'Weekly travel & expense summary',
    subtitle: 'Spyne TravelDesk · leadership digest',
    statusText: `${rows.length} live requests · ${pendingApproval} pending · ${breaches} breach${breaches === 1 ? '' : 'es'}`,
    statusColor: '#2563EB',
    body,
  });
  // Finance team only (all finance role holders) — the CEO is intentionally excluded.
  const to = ((AUTH && AUTH.FINANCE_EMAILS) || [CONFIG.FINANCE_SPOC]).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
  if (!to.length) return { ok: true, skipped: 'no recipients' };
  await sendEmail({ to, subject: `Spyne TravelDesk — weekly summary (${rows.length} live · ${pendingApproval} pending)`, html });
  return { ok: true, sent: to.length, pendingApproval, breaches, advPending };
}

export async function editRequest(id, p, email, baseUrl) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (!ownsRequest(rec, email)) return { ok: false, error: 'Only the requester can edit this request.' };
  const stage = String(rec[COL.STAGE]);
  if (stage !== 'dept' && stage !== 'clarify') return { ok: false, error: 'This request has already progressed past the first approval — withdraw it and submit a new one instead.' };
  if (rec[COL.HOLD]) return { ok: false, error: 'This request is on hold; ask the approver to release it before editing.' };

  // Keep the original identity (name/email/empId/requester); only logistics/cost are editable.
  p.email = rec[COL.EMAIL]; p.requestedBy = rec[COL.REQUESTED_BY];
  if (!p.name) p.name = rec[COL.NAME];
  if (!p.empId) p.empId = rec[COL.EMPID];
  const { trip, costs } = await computeTripFields(p);
  const who = String(email || '').split('@')[0];
  // The CEO's own trip resubmits straight to Finance (no HOD/CEO self-approval); everyone else → HOD.
  const ceoReq = ceoIsRequester(rec);
  const reStage = ceoReq ? 'finance' : 'dept';
  const updates = Object.entries(trip).concat([
    [COL.STATUS, ceoReq ? ('Pending ' + stageLabel('finance') + ' Approval') : 'Pending HOD Approval'], [COL.STAGE, reStage], [COL.TOKEN, randomUUID()],
    [COL.DEPT_DEC, ''], [COL.DEPT_TIME, ''], [COL.FIN_DEC, ''], [COL.FIN_TIME, ''], [COL.HOLD, ''], [COL.BOOKINGS, ''], [COL.DOC_TICKET, ''],
    [COL.LAST_REMINDER, ''], [COL.REMINDER_COUNT, 0], [COL.DELEGATE_EMAIL, ''], [COL.CLARIFY_NOTE, ''],
    [COL.COMMENTS, appendComment(rec, reStage, who, (stage === 'clarify' ? 'Clarification provided — resubmitted by requester' : 'Request edited & resubmitted by requester'))],
  ]);
  await updateCells(rec.__row, updates);
  const fresh = { ...rec, ...trip, [COL.TOKEN]: updates.find((u) => u[0] === COL.TOKEN)[1] };
  await emailApprover(reStage, fresh, baseUrl, { edited: true }); // notify the approver it was edited & resubmitted
  return { ok: true, id, status: 'Updated — resent for HOD approval', currency: costs.currency, total: costs.total };
}

export async function withdrawRequest(id, email) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (!ownsRequest(rec, email)) return { ok: false, error: 'Only the requester can withdraw this request.' };
  const stage = String(rec[COL.STAGE]);
  // Allowed only BEFORE the first (HOD) approval — same rule as edit. Once HOD has decided
  // and the request has moved on, it can no longer be withdrawn by the requester.
  if (stage !== 'dept' && stage !== 'clarify') {
    return { ok: false, error: 'This request has already passed the first (HOD) approval and can no longer be withdrawn.' };
  }
  await updateCells(rec.__row, [[COL.STAGE, 'withdrawn'], [COL.STATUS, 'Withdrawn by requester'], [COL.TOKEN, ''], [COL.HOLD, '']]);
  const notify = ownerForStage(rec, stage);
  if (notify) await sendEmail({ to: notify, subject: `Travel Request ${id} — withdrawn by requester`,
    html: `<p>Travel request <b>${id}</b> for <b>${rec[COL.NAME]}</b> has been <b>withdrawn</b> by the requester. No further action is needed.</p>` });
  return { ok: true, id, status: 'Withdrawn' };
}

// Finance-only bulk "scrap" of test/junk requests by ID. Soft-delete: marks STAGE='scrapped'
// (readAll hides those rows everywhere — reversible by clearing the Stage cell in the sheet).
export async function scrapRequests(ids, roles) {
  if (!(roles || []).includes('finance')) return { ok: false, error: 'Finance access required.' };
  const wanted = new Set((Array.isArray(ids) ? ids : String(ids || '').split(/[\s,]+/))
    .map((s) => String(s || '').trim().toUpperCase()).filter(Boolean));
  if (!wanted.size) return { ok: false, error: 'No request IDs provided.' };
  const all = await readAll(); // not-yet-scrapped rows only
  const hits = all.filter((r) => wanted.has(String(r[COL.ID] || '').toUpperCase()));
  for (const rec of hits) {
    await updateCells(rec.__row, [[COL.STAGE, 'scrapped'], [COL.STATUS, 'Scrapped — test data'], [COL.TOKEN, ''], [COL.HOLD, '']]);
  }
  const found = new Set(hits.map((r) => String(r[COL.ID]).toUpperCase()));
  const notFound = Array.from(wanted).filter((id) => !found.has(id));
  return { ok: true, scrapped: hits.length, notFound };
}

// ---- approve / reject ----
// Token-based decision (from the email approve/reject links).
export async function handleDecision({ id, stage, decision, token }, baseUrl) {
  if (!id || !stage || !decision || !token) return { title: 'Invalid Link', msg: 'This approval link is missing information.', color: '#b00' };

  const rec = await findById(id);
  if (!rec || String(rec[COL.TOKEN]) !== String(token)) {
    return { title: 'Link Expired / Invalid', msg: 'This approval link is no longer valid.', color: '#b00' };
  }
  if (String(rec[COL.STAGE]) !== stage) {
    return { title: 'Already Processed', msg: `This request is no longer at the "${stage}" step. Current status: ${rec[COL.STATUS]}.`, color: '#a60' };
  }
  return applyDecision(rec, stage, decision, baseUrl);
}

// Core stage transition (shared by the email-link and the authenticated dashboard paths).
async function applyDecision(rec, stage, decision, baseUrl) {
  const id = rec[COL.ID];
  const row = rec.__row;
  const now = new Date().toISOString();
  const type = rec[COL.TYPE];
  const broken = String(rec[COL.FLAG] || '').startsWith('POLICY BREAK');
  const decCol = { dept: COL.DEPT_DEC, ceo: COL.CEO_DEC, finance: COL.FIN_DEC, admin: COL.ADMIN }[stage];
  const timeCol = { dept: COL.DEPT_TIME, ceo: COL.CEO_TIME, finance: COL.FIN_TIME }[stage]; // none for admin

  if (decision === 'reject') {
    const upd = [[COL.TOKEN, ''], [COL.STAGE, 'rejected'], [COL.STATUS, 'Rejected at ' + stageLabel(stage)], [decCol, 'Rejected'], [COL.HOLD, ''], [COL.DELEGATE_EMAIL, '']];
    if (timeCol) upd.push([timeCol, now]);
    await updateCells(row, upd);
    const rejTo = requesterEmail(rec);
    if (rejTo) await sendEmail({ to: rejTo, subject: `Travel Request ${id} — REJECTED`,
      html: emailShell({ title: 'Travel request rejected', subtitle: `Spyne TravelDesk · ${id}`,
        statusText: `Rejected at the ${stageLabel(stage)} stage`, statusColor: '#E8232A',
        body: `<p style="color:#3D506A;margin:0 0 12px;">Travel request <b>${id}</b>${rec[COL.NAME] ? ` for <b>${rec[COL.NAME]}</b>` : ''} was <b>rejected</b> at the ${stageLabel(stage)} stage.</p><p style="color:#3D506A;margin:0;">If you have questions, please reach out to the approver or the Finance team. You can raise a revised request any time.</p>` }) });
    return { title: 'Rejected', msg: `You have rejected ${id}. The requester has been notified.`, color: '#b00' };
  }
  if (decision !== 'approve') return { title: 'Unknown Action', msg: 'Unrecognized decision.', color: '#b00' };

  const next = nextStage(type, stage, broken, ceoIsRequester(rec));
  const newToken = randomUUID();
  const updates = [[decCol, 'Approved'], [COL.TOKEN, newToken], [COL.HOLD, ''], [COL.DELEGATE_EMAIL, '']];
  if (timeCol) updates.push([timeCol, now]);

  if (next) {
    // advance to the next approver
    updates.push([COL.STAGE, next], [COL.STATUS, 'Pending ' + stageLabel(next) + ' Approval']);
    await updateCells(row, updates);
    const fresh = { ...rec, [COL.TOKEN]: newToken, [COL.STAGE]: next };
    await emailApprover(next, fresh, baseUrl);
    return { title: 'Approved → ' + stageLabel(next), msg: `${id} approved. Forwarded to ${stageLabel(next)}.`, color: '#0a0' };
  }

  // ---- Last approval done (all trip types) → Admin arranges/books. No further approval. ----
  updates.push([COL.STAGE, 'arrange'], [COL.STATUS, 'Approved — With Admin for Arrangements'], [COL.ADMIN, 'Pending']);
  await updateCells(row, updates);
  const reqTo = requesterEmail(rec);
  // Admin gets the full cost breakdown; the requester is NOT CC'd here (travellers must not see the
  // estimated cost) — they get the separate cost-free "APPROVED" note below instead.
  await sendEmail({ to: CONFIG.ADMIN_TEAM, subject: `[Approved — for arrangements] ${id} (${rec[COL.NAME]})`,
    html: adminEmailHtml(rec, baseUrl) });
  if (CONFIG.CC_REQUESTER_ON_UPDATES && reqTo) {
    const forName = rec[COL.NAME] ? ` for <b>${rec[COL.NAME]}</b>` : '';
    await sendEmail({ to: reqTo, subject: `Travel Request ${id} — APPROVED`,
      html: `<p>Good news! Travel request <b>${id}</b>${forName} is fully approved (final approval: ${stageLabel(stage)}). Admin has been notified to make the bookings &amp; arrangements.</p>` });
  }
  return { title: 'Approved → Sent to Admin', msg: `${id} fully approved (${stageLabel(stage)}). Admin notified for arrangements.`, color: '#0a0' };
}

// Which approval stage does this signed-in user own for a given record? Returns 'dept'|'ceo'|'finance'|null.
function myStageFor(rec, email, roles) {
  const e = String(email || '').toLowerCase();
  const r = roles || [];
  // No self-approval: you can NEVER approve a request you raised or are travelling on.
  if (ownsRequest(rec, email)) return null;
  // Delegated to me (OOO cover) → I own whatever approval stage it's currently at.
  const curStage = String(rec[COL.STAGE]);
  if (rec[COL.DELEGATE_EMAIL] && String(rec[COL.DELEGATE_EMAIL]).toLowerCase() === e && ['dept', 'ceo', 'finance'].includes(curStage)) return curStage;
  const dept = String(rec[COL.DEPT] || '');
  const deptHead = String((CONFIG.DEPARTMENTS[dept] || {}).email || '').toLowerCase();
  const isCEO = r.includes('ceo') || e === String(CONFIG.CEO_EMAIL).toLowerCase();
  // A dept head's OWN trip escalates to the CEO for the HOD (dept) stage.
  if (deptHeadIsRequester(rec) && isCEO) return 'dept';
  if ((r.includes('hod')) && (deptHead === e || String(rec[COL.HOD] || '').toLowerCase() === e)) return 'dept';
  if (isCEO) { if (String(rec[COL.TYPE]) === 'international') return 'ceo'; }
  if (r.includes('finance')) return 'finance';
  return null;
}
const decColFor = { dept: COL.DEPT_DEC, ceo: COL.CEO_DEC, finance: COL.FIN_DEC };
const decTimeFor = { dept: COL.DEPT_TIME, ceo: COL.CEO_TIME, finance: COL.FIN_TIME };

// Append an approver remark to the running comments log.
function appendComment(rec, stage, who, text) {
  if (!text) return rec[COL.COMMENTS] || '';
  const stamp = `[${stageLabel(stage)} · ${who} · ${fmtDate(new Date().toISOString())}]`;
  const line = `${stamp} ${text}`;
  return rec[COL.COMMENTS] ? `${rec[COL.COMMENTS]}\n${line}` : line;
}

// Authenticated approver decision (HOD / CEO / Finance) from the Approvals dashboard.
// decision: 'approve' | 'reject' | 'hold'. Optional free-text comment.
export async function approverDecision({ id, decision, comment, email, roles }, baseUrl) {
  await ensureHeaders(); // widen the sheet grid for the On Hold / Comments columns before writing
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  const stage = String(rec[COL.STAGE]);
  const mine = myStageFor(rec, email, roles);
  if (mine !== stage) return { ok: false, error: `This request isn't awaiting your approval (current step: ${stageLabel(stage)}).` };
  const who = String(email || '').split('@')[0];

  if (decision === 'hold') {
    await updateCells(rec.__row, [
      [COL.HOLD, 'On Hold'],
      [COL.STATUS, 'On Hold — ' + stageLabel(stage)],
      [COL.COMMENTS, appendComment(rec, stage, who, comment || 'Put on hold')],
    ]);
    return { ok: true, id, title: 'On Hold', msg: `${id} placed on hold.` };
  }
  if (decision !== 'approve' && decision !== 'reject') return { ok: false, error: 'Unknown decision' };
  // ALWAYS capture who decided (email), even when no free-text remark is given, so the approver
  // is recorded in the audit trail / timeline. Append a stamped line: "Approved by <email> — <remark>".
  const verb = decision === 'approve' ? 'Approved' : 'Rejected';
  const note = verb + ' by ' + String(email || who) + (comment ? ' — ' + comment : '');
  const newComments = appendComment(rec, stage, who, note);
  await updateCells(rec.__row, [[COL.COMMENTS, newComments]]);
  const r = await applyDecision({ ...rec, [COL.COMMENTS]: newComments }, stage, decision, baseUrl);
  return { ok: true, id, title: r.title, msg: r.msg };
}

// Delegate the CURRENT approval of a request to a colleague (OOO cover). The delegate gets
// the approve/reject email and gains dashboard rights for this record's current stage.
export async function delegateRequest({ id, to, email, roles }, baseUrl) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  const stage = String(rec[COL.STAGE]);
  if (myStageFor(rec, email, roles) !== stage) return { ok: false, error: `You can only delegate a request that's awaiting your approval (current step: ${stageLabel(stage)}).` };
  const delegate = String(to || '').trim().toLowerCase();
  if (!delegate || !delegate.includes('@')) return { ok: false, error: 'Enter a valid colleague email to delegate to.' };
  const who = String(email || '').split('@')[0];
  const token = randomUUID();
  await updateCells(rec.__row, [
    [COL.DELEGATE_EMAIL, delegate], [COL.TOKEN, token],
    [COL.COMMENTS, appendComment(rec, stage, who, 'Delegated approval to ' + delegate)],
    [COL.LAST_REMINDER, ''], [COL.REMINDER_COUNT, 0],
  ]);
  await emailApprover(stage, { ...rec, [COL.TOKEN]: token, [COL.DELEGATE_EMAIL]: delegate }, baseUrl);
  return { ok: true, id, msg: `Delegated to ${delegate}. They've been emailed the approve/reject links.` };
}

// Approver sends the request BACK to the requester with a question (instead of approve/reject).
// It moves to the 'clarify' stage — out of every approver's queue (myStageFor never returns 'clarify')
// — where the requester can edit & resubmit; resubmission re-enters the chain from the HOD stage.
export async function requestClarification({ id, comment, email, roles }, baseUrl) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  const stage = String(rec[COL.STAGE]);
  if (myStageFor(rec, email, roles) !== stage) return { ok: false, error: `You can only send back a request that's awaiting your approval (current step: ${stageLabel(stage)}).` };
  const q = String(comment || '').trim();
  if (!q) return { ok: false, error: 'Type your question for the requester before sending it back.' };
  const who = String(email || '').split('@')[0];
  await updateCells(rec.__row, [
    [COL.STAGE, 'clarify'], [COL.STATUS, 'Sent back for clarification'],
    [COL.HOLD, ''], [COL.DELEGATE_EMAIL, ''], [COL.CLARIFY_NOTE, q],
    [COL.LAST_REMINDER, ''], [COL.REMINDER_COUNT, 0],
    [COL.COMMENTS, appendComment(rec, stage, who, 'Sent back to requester for clarification: ' + q)],
  ]);
  const to = rec[COL.REQUESTED_BY] || rec[COL.EMAIL];
  if (to) {
    const link = (baseUrl || '') + '/?edit=' + encodeURIComponent(id);
    await sendEmail({
      to,
      subject: `Travel Request ${id} — clarification needed`,
      html: `<p><b>${stageLabel(stage)}</b> has sent your travel request <b>${id}</b> back with a question:</p>`
        + `<blockquote style="border-left:3px solid #e11d48;margin:10px 0;padding:6px 14px;color:#334;">${q}</blockquote>`
        + `<p>Please update your request to address it and resubmit — it will then go back for approval.</p>`
        + `<p><a href="${link}" style="display:inline-block;background:#e11d48;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600;">Open &amp; update request →</a></p>`,
    });
  }
  return { ok: true, id, title: 'Sent back', msg: `${id} sent back to the requester for clarification.` };
}

// ---- Approvals dashboard data, scoped to what the signed-in approver may act on ----
// HOD → their department's requests · CEO → all international · Finance → all policy-break requests.
export async function approverData({ email, roles }) {
  const e = String(email || '').toLowerCase();
  const r = roles || [];
  const myDepts = new Set(deptsForHod(email).map((d) => d.toLowerCase()));
  const isCEO = r.includes('ceo') || e === String(CONFIG.CEO_EMAIL).toLowerCase();
  const isFin = r.includes('finance');
  const all = await readAll();
  const { byTrf } = await expenseActualsByTrf(); // ExpenseDesk actuals for reconciliation (best-effort)
  const fxr = (CONFIG.FX && CONFIG.FX.USD_INR) || 92;
  const rows = [];
  const scopes = new Set();
  for (const rec of all) {
    const dept = String(rec[COL.DEPT] || '');
    const deptHead = String((CONFIG.DEPARTMENTS[dept] || {}).email || '').toLowerCase();
    const own = ownsRequest(rec, email); // you can't approve your own request
    const amHOD = !own && r.includes('hod') && (myDepts.has(dept.toLowerCase()) || deptHead === e || String(rec[COL.HOD] || '').toLowerCase() === e);
    const escCEO = !own && deptHeadIsRequester(rec) && isCEO; // dept head's own trip → CEO approves the HOD stage
    const intl = String(rec[COL.TYPE]) === 'international';
    const broken = /^POLICY BREAK/i.test(String(rec[COL.FLAG] || ''));
    const curStage = String(rec[COL.STAGE]);
    const amDelegate = !!rec[COL.DELEGATE_EMAIL] && String(rec[COL.DELEGATE_EMAIL]).toLowerCase() === e && ['dept', 'ceo', 'finance'].includes(curStage);
    // is this request within my approver scope at all?
    let relevant = false, myStage = null, myDec = '', myTime = '';
    if (amDelegate) {
      relevant = true; myStage = curStage;
      myDec = decStatus(rec[decColFor[curStage]]); myTime = fmtDate(rec[decTimeFor[curStage]]);
      scopes.add('Delegated to me');
    }
    else if (amHOD) { relevant = true; myStage = 'dept'; myDec = decStatus(rec[COL.DEPT_DEC]); myTime = fmtDate(rec[COL.DEPT_TIME]); scopes.add(deptsForHod(email).join(', ') || dept); }
    else if (escCEO) { relevant = true; myStage = 'dept'; myDec = decStatus(rec[COL.DEPT_DEC]); myTime = fmtDate(rec[COL.DEPT_TIME]); scopes.add('CEO — dept-head requests'); }
    else if (isCEO && intl) { relevant = true; myStage = 'ceo'; myDec = decStatus(rec[COL.CEO_DEC]); myTime = fmtDate(rec[COL.CEO_TIME]); scopes.add('CEO — International'); }
    else if (isFin && (broken || ceoIsRequester(rec))) { relevant = true; myStage = 'finance'; myDec = decStatus(rec[COL.FIN_DEC]); myTime = fmtDate(rec[COL.FIN_TIME]); scopes.add(ceoIsRequester(rec) ? 'Finance — CEO travel' : 'Finance — Policy breaks'); }
    if (!relevant) continue;
    const stage = String(rec[COL.STAGE]);
    const awaitingMe = stage === myStage;
    const held = awaitingMe && !!rec[COL.HOLD];
    const cur = String(rec[COL.CURRENCY] || 'INR');
    const total = Number(rec[COL.C_TOTAL] || 0);
    const advTot = Number(rec[COL.FOREX] || 0) + (parseJSON(rec[COL.FOREX_TOPUPS], []) || []).reduce((a, t) => a + (Number(t.amount) || 0), 0) + Number(rec[COL.C_DEPOSIT] || 0);
    const estINR = cur === 'USD' ? total * fxr : total;
    const advINR = cur === 'USD' ? advTot * fxr : advTot;
    const ex = byTrf[String(rec[COL.ID]).toUpperCase()];
    const recon = ex
      ? { available: true, linked: ex.count, estimateINR: estINR, actualINR: ex.actualINR, paidINR: ex.paidINR, varianceINR: estINR - ex.actualINR, settlementINR: advINR - ex.actualINR, items: ex.items }
      : { available: true, linked: 0, estimateINR: estINR, actualINR: 0, paidINR: 0, varianceINR: estINR, settlementINR: advINR, items: [] };
    rows.push({
      recon,
      id: rec[COL.ID], name: rec[COL.NAME], email: rec[COL.EMAIL], dept,
      type: rec[COL.TYPE], trip: rec[COL.TRIP], purpose: rec[COL.PURPOSE],
      route: `${rec[COL.FROM]} → ${rec[COL.TO]}`,
      start: fmtDate(rec[COL.START]), end: fmtDate(rec[COL.RET]), submission: fmtDate(rec[COL.TS]),
      currency: cur, total, estimatedCost: cur + ' ' + Number(total).toLocaleString(cur === 'USD' ? 'en-US' : 'en-IN', { maximumFractionDigits: 0 }),
      advForex: Number(rec[COL.FOREX] || 0) + (parseJSON(rec[COL.FOREX_TOPUPS], []) || []).reduce((a, t) => a + (Number(t.amount) || 0), 0),
      advDeposit: Number(rec[COL.C_DEPOSIT] || 0),
      advance: Number(rec[COL.FOREX] || 0) + (parseJSON(rec[COL.FOREX_TOPUPS], []) || []).reduce((a, t) => a + (Number(t.amount) || 0), 0) + Number(rec[COL.C_DEPOSIT] || 0),
      flag: String(rec[COL.FLAG] || ''), breakdown: costBreakdown(rec), actuals: actualsData(rec),
      // Full flight/hotel routing so approvers see where→where (esp. multi-city) before approving.
      flights: itineraryFor(rec).flights, hotels: itineraryFor(rec).hotels,
      // HOD approves the reimbursement claim (Point 1): only the trip's HOD, only while Submitted.
      canApproveReimburse: amHOD && String(rec[COL.ACTUALS_STATUS]) === 'Submitted',
      stage, status: rec[COL.STATUS], myStage, ...paxInfo(rec),
      pending: awaitingMe && !held, held,
      decision: myDec, decisionDate: myTime, comments: rec[COL.COMMENTS] || '',
    });
  }
  rows.reverse();
  return { scope: Array.from(scopes).join(' · ') || 'Approvals', rows };
}

// Notifications for THIS user — both the per-area counts (tab badges) and the item LIST
// (for the 🔔 bell dropdown with read/unread). Lightweight: one readAll, no recon/expense reads.
export async function notifications({ email, roles }) {
  const e = String(email || '').toLowerCase();
  const r = roles || [];
  const myDepts = new Set(deptsForHod(email).map((d) => d.toLowerCase()));
  const isCEO = r.includes('ceo') || e === String(CONFIG.CEO_EMAIL).toLowerCase();
  const isFin = r.includes('finance');
  const all = await readAll();
  const items = [];
  const add = (rec, kind, title, href) => items.push({
    key: String(rec[COL.ID]) + ':' + kind, id: rec[COL.ID], kind, title, href,
    sub: (rec[COL.NAME] || '') + ' · ' + String(rec[COL.FROM] || '') + ' → ' + String(rec[COL.TO] || ''),
    ts: rec[COL.TS] || '',
  });
  for (const rec of all) {
    const stage = String(rec[COL.STAGE] || '');
    if (/reject/i.test(String(rec[COL.STATUS] || '')) || stage === 'rejected') continue;
    const onHold = !!rec[COL.HOLD];
    const dept = String(rec[COL.DEPT] || '');
    const deptHead = String((CONFIG.DEPARTMENTS[dept] || {}).email || '').toLowerCase();
    const own = ownsRequest(rec, email); // never notify someone to approve their own request
    const amHOD = !own && r.includes('hod') && (myDepts.has(dept.toLowerCase()) || deptHead === e || String(rec[COL.HOD] || '').toLowerCase() === e);
    const escCEO = !own && deptHeadIsRequester(rec) && isCEO; // dept head's own trip → CEO approves the HOD stage
    const amDelegate = !own && !!rec[COL.DELEGATE_EMAIL] && String(rec[COL.DELEGATE_EMAIL]).toLowerCase() === e && ['dept', 'ceo', 'finance'].includes(stage);
    const intl = String(rec[COL.TYPE]) === 'international';
    const broken = /^POLICY BREAK/i.test(String(rec[COL.FLAG] || ''));
    const astatus = String(rec[COL.ACTUALS_STATUS] || '');
    if (!onHold) {
      if (stage === 'dept' && (amHOD || amDelegate)) add(rec, 'approval', 'Approval needed — Department Head', '/hod');
      else if (stage === 'dept' && escCEO) add(rec, 'approval', 'Approval needed — CEO (dept-head request)', '/hod');
      else if (stage === 'ceo' && intl && (isCEO || amDelegate)) add(rec, 'approval', 'Approval needed — CEO', '/hod');
      else if (stage === 'finance' && broken && (isFin || amDelegate)) add(rec, 'approval', 'Approval needed — Finance', '/hod');
    }
    if (amHOD && astatus === 'Submitted') add(rec, 'reimburse', 'Reimbursement claim to approve', '/department');
    if (stage === 'arrange' && (r.includes('admin') || isFin)) add(rec, 'admin', 'Booking to arrange', '/admin');
    if (stage === 'forex' && (r.includes('forex') || isFin)) add(rec, 'forex', 'Forex card to issue', '/forex');
    if (isFin && astatus === 'HOD Approved') add(rec, 'finance', 'Reimbursement to settle', '/finance');
  }
  const by = (k) => items.filter((i) => i.kind === k).length;
  return { approvals: by('approval'), department: by('reimburse'), finance: by('finance'), admin: by('admin'), forex: by('forex'), items };
}

// ---- requester self-service: my own requests + where each one is ----
export async function myData(email) {
  const e = String(email || '').toLowerCase();
  const all = await readAll();
  // Show requests I'm the traveller on OR requests I filed on behalf of someone else.
  const rows = all.filter((r) => String(r[COL.EMAIL] || '').toLowerCase() === e
      || String(r[COL.REQUESTED_BY] || '').toLowerCase() === e).map((r) => ({
    id: r[COL.ID], type: r[COL.TYPE], trip: r[COL.TRIP], purpose: r[COL.PURPOSE],
    traveller: r[COL.NAME] || '',
    // True when I raised this for someone else (I'm the requester but not the traveller).
    raisedForOther: String(r[COL.REQUESTED_BY] || '').toLowerCase() === e
      && String(r[COL.EMAIL] || '').toLowerCase() !== e,
    route: `${r[COL.FROM]} → ${r[COL.TO]}`,
    start: fmtDate(r[COL.START]), end: fmtDate(r[COL.RET]), submission: fmtDate(r[COL.TS]),
    stage: r[COL.STAGE], status: r[COL.STATUS],
    hod: decStatus(r[COL.DEPT_DEC]) || (String(r[COL.STAGE]) === 'dept' ? 'Pending' : ''),
    ceo: r[COL.TYPE] === 'international' ? (decStatus(r[COL.CEO_DEC]) || (['dept'].includes(String(r[COL.STAGE])) ? 'Waiting' : 'Pending')) : 'N/A',
    finance: decStatus(r[COL.FIN_DEC]) || 'N/A',
    booking: r[COL.ADMIN] || (['arrange', 'admin'].includes(String(r[COL.STAGE])) ? 'Pending' : ''),
    forexIssued: r[COL.FOREX_ISSUE_DATE] ? 'Issued' : (String(r[COL.TYPE]) === 'international' && Number(r[COL.FOREX] || 0) > 0 ? 'Pending' : 'N/A'),
    // Who the request is currently pending with (the live stage approver/owner) — email + label.
    pendingWith: ['dept', 'ceo', 'finance', 'arrange', 'admin', 'forex'].includes(String(r[COL.STAGE]))
      ? ((String(r[COL.STAGE]) === 'dept' && deptHeadIsRequester(r)) ? CONFIG.CEO_EMAIL : ownerForStage(r, String(r[COL.STAGE]))) : '',
    pendingStage: { dept: 'Department Head', ceo: 'CEO', finance: 'Finance', arrange: 'Admin (booking)', admin: 'Admin', forex: 'Forex officer' }[String(r[COL.STAGE])] || '',
    // Self-service flags: both edit & withdraw are allowed ONLY before the first (HOD) approval.
    // (Edit additionally needs the request not to be on hold.)
    canEdit: ['dept', 'clarify'].includes(String(r[COL.STAGE])) && !r[COL.HOLD],
    canWithdraw: ['dept', 'clarify'].includes(String(r[COL.STAGE])),
    clarifyNote: String(r[COL.STAGE]) === 'clarify' ? (r[COL.CLARIFY_NOTE] || '') : '',
    edit: editPayload(r),       // pre-fill values for the edit form
    timeline: buildTimeline(r), // audit trail
    actuals: actualsData(r),    // budget vs actual + reimbursement
    flights: itineraryFor(r).flights, // with IST/US time labels
    prefFlightDoc: r[COL.PREF_FLIGHT_DOC] || '', prefFlightNotes: r[COL.PREF_FLIGHT_NOTES] || '',
    // can add/replace the preferred-flight attachment until booking is done
    canAddFlightDoc: !/done|completed|forex card issued|rejected|withdrawn/i.test(String(r[COL.STATUS] || '') + ' ' + String(r[COL.STAGE] || '')),
    // Traveller can add/edit trip expenses once booked/completed and until Finance closes it.
    canAddActuals: /arrange|admin|forex|done|completed|confirmed|booking|booked|issued/i.test(String(r[COL.STATUS] || '') + ' ' + String(r[COL.STAGE] || '')) && String(r[COL.ACTUALS_STATUS]) !== 'Closed',
    // Forex card back snapshot (for future top-ups) — uploadable once the card is issued.
    forexCardDoc: r[COL.DOC_FOREX_CARD] || '',
    canAddForexCard: !!(r[COL.FOREX_ISSUE_DATE]) || /forex card issued/i.test(String(r[COL.STATUS] || '')),
    ...paxInfo(r),
  }));
  rows.reverse();
  return { rows };
}

// Editable payload (re-hydrates the request form for an in-place edit).
function editPayload(r) {
  const extra = parseJSON(r[COL.ITINERARY], { flights: [], hotels: [] }) || { flights: [], hotels: [] };
  const pax = parseJSON(r[COL.PASSENGERS], []) || [];
  const ph = extra.primaryHotel || {};
  return {
    dept: r[COL.DEPT] || '', travelType: r[COL.TYPE] || '',
    tripType: String(r[COL.TRIP]) === 'Round trip' ? 'round' : 'one',
    from: r[COL.FROM] || '', to: r[COL.TO] || '', returnFrom: r[COL.RETFROM] || '', returnTo: r[COL.RETTO] || '',
    startDate: r[COL.START] || '', returnDate: r[COL.RET] || '',
    flightTimes: extra.times || { out: '', ret: '' },
    prefFlightDoc: r[COL.PREF_FLIGHT_DOC] || '', prefFlightNotes: r[COL.PREF_FLIGHT_NOTES] || '',
    hotelNeeded: ph.needed != null ? !!ph.needed : (String(r[COL.HOTEL_REQ]) === 'Yes'),
    hotelCountry: ph.country || '', hotelCity: ph.city || '', hotelCheckIn: ph.checkIn || '', hotelCheckOut: ph.checkOut || '',
    purpose: r[COL.PURPOSE] || '', transportMode: r[COL.MODE] || '', notes: r[COL.NOTES] || '',
    forexNeeded: Number(r[COL.FOREX] || 0) > 0, visaNeeded: String(r[COL.VISA_NEEDED]) === 'Yes',
    // Forex/passport details (so editing a forex request keeps them).
    nationality: r[COL.NATIONALITY] || '', passportNo: r[COL.PASSPORT_NO] || '', passportIssue: r[COL.PASSPORT_ISSUE] || '',
    passportExpiry: r[COL.PASSPORT_EXPIRY] || '', panNo: r[COL.PAN_NO] || '', airline: r[COL.AIRLINES] || '',
    designation: r[COL.DESIGNATION] || '', mobile: r[COL.MOBILE] || '', address: r[COL.ADDRESS] || '',
    extraFlights: extra.flights || [], extraHotels: extra.hotels || [],
    extraPassengers: pax.slice(1).map((x) => ({ name: x.name || '', email: x.email || '' })),
  };
}

// Audit trail of everything that happened to a request, newest milestone last.
function buildTimeline(r) {
  const t = [];
  const intl = String(r[COL.TYPE]) === 'international';
  const broken = /^POLICY BREAK/i.test(String(r[COL.FLAG] || ''));
  t.push({ label: 'Submitted', status: 'done', date: fmtDateTime(r[COL.TS]) });
  t.push({ label: 'HOD', status: r[COL.DEPT_DEC] ? (/(reject)/i.test(r[COL.DEPT_DEC]) ? 'rejected' : 'done') : 'pending', date: fmtDateTime(r[COL.DEPT_TIME]) });
  if (intl) t.push({ label: 'CEO', status: r[COL.CEO_DEC] ? (/(reject)/i.test(r[COL.CEO_DEC]) ? 'rejected' : 'done') : 'pending', date: fmtDateTime(r[COL.CEO_TIME]) });
  if (broken) t.push({ label: 'Finance', status: r[COL.FIN_DEC] ? (/(reject)/i.test(r[COL.FIN_DEC]) ? 'rejected' : 'done') : 'pending', date: fmtDateTime(r[COL.FIN_TIME]) });
  t.push({ label: 'Booking', status: r[COL.BOOKING_DATE] ? 'done' : 'pending', date: fmtDateTime(r[COL.BOOKING_DATE]), note: r[COL.TICKET_INFO] || '' });
  if (intl && Number(r[COL.FOREX] || 0) > 0) t.push({ label: 'Forex card', status: r[COL.FOREX_ISSUE_DATE] ? 'done' : 'pending', date: fmtDateTime(r[COL.FOREX_ISSUE_DATE]) });
  const comments = String(r[COL.COMMENTS] || '').split('\n').filter(Boolean);
  return { steps: t, comments };
}

// ---- finance dashboard: master tracking data ----
function decStatus(v) { if (!v) return ''; if (/reject/i.test(v)) return 'Rejected'; if (/approv/i.test(v)) return 'Approved'; return String(v); }

// Per-request cost breakup (computed at submit, stored on the sheet) — used by the
// slide-out panel on the Finance, Admin and Forex dashboards.
function costBreakdown(r) {
  return {
    transport: Number(r[COL.C_TRANSPORT] || 0), mode: r[COL.MODE] || '',
    local: Number(r[COL.C_LOCAL] || 0),
    hotel: Number(r[COL.C_HOTEL] || 0), hotelRate: Number(r[COL.HOTEL_RATE] || 0), hotelNights: Number(r[COL.HOTEL_NIGHTS] || 0),
    meals: Number(r[COL.C_MEALS] || 0), mealRate: Number(r[COL.MEAL_RATE] || 0),
    other: Number(r[COL.C_OTHER] || 0), forex: Number(r[COL.FOREX] || 0),
    deposit: Number(r[COL.C_DEPOSIT] || 0),
    extras: parseJSON(r[COL.C_EXTRAS], {}) || {},
    days: Number(r[COL.DAYS] || 0), nights: Number(r[COL.NIGHTS] || 0),
  };
}

// ---- ACTUALS: budget (estimate) vs actual, variance, reimbursement ----
const ACT_LINES = ['flight', 'hotel', 'meals', 'local', 'visa', 'baggage', 'misc'];
const ACT_LABEL = { flight: 'Flight', hotel: 'Hotel', meals: 'Meals', local: 'Local conveyance', visa: 'Visa', baggage: 'Baggage', misc: 'Misc' };
// Per-trip actuals view: line items, totals, per-line variance vs estimate, reimbursement due, advance.
function actualsData(r) {
  const a = parseJSON(r[COL.ACTUALS], {}) || {};
  const cur = String(r[COL.CURRENCY] || 'INR');
  const amt = (k) => Number((a[k] && a[k].amount) || 0);
  const defaultPaid = (k) => (k === 'flight' || k === 'hotel') ? 'company' : 'own';
  const b = costBreakdown(r);
  const extras = b.extras || {};
  const extrasTotal = Object.values(extras).reduce((x, y) => x + (Number(y) || 0), 0);
  // Flight budget: for DOMESTIC / LOCAL trips the budget is always the POLICY estimate
  // (meals already come from the policy per-diem via b.meals). For international, prefer the
  // ACTUAL booked-ticket fare (admin-entered) when available, else the policy estimate.
  const ticketFlight = Number((a.flight && a.flight.amount) || 0);
  const isDomesticTrip = ['domestic', 'local'].includes(String(r[COL.TYPE]));
  const est = { flight: (!isDomesticTrip && ticketFlight > 0) ? ticketFlight : b.transport, hotel: b.hotel, meals: b.meals, local: b.local,
    visa: Number(extras.visa || 0), baggage: Number(extras.baggage || 0),
    misc: Math.max(0, extrasTotal - Number(extras.visa || 0) - Number(extras.baggage || 0)) };
  const fixedItems = ACT_LINES.map((k) => ({
    key: k, label: ACT_LABEL[k], estimate: Number(est[k] || 0), actual: amt(k),
    paidBy: (a[k] && a[k].paidBy) || defaultPaid(k), doc: (a[k] && a[k].doc) || '',
    variance: Number(est[k] || 0) - amt(k),
  }));
  // Traveller-added custom expense lines (their own categories) — no budget estimate.
  const customArr = Array.isArray(a.custom) ? a.custom : [];
  const customItems = customArr.map((c, i) => ({
    key: 'custom-' + i, label: String(c.label || ('Other ' + (i + 1))), estimate: 0,
    actual: Number(c.amount) || 0, paidBy: c.paidBy === 'company' ? 'company' : 'own',
    doc: String(c.doc || ''), variance: -(Number(c.amount) || 0), custom: true,
  }));
  const items = fixedItems.concat(customItems);
  const customActual = customItems.reduce((s, it) => s + it.actual, 0);
  const customReimb = customItems.reduce((s, it) => s + (it.paidBy === 'own' ? it.actual : 0), 0);
  const actualTotal = ACT_LINES.reduce((s, k) => s + amt(k), 0) + customActual;
  const reimbursable = ACT_LINES.reduce((s, k) => s + (((a[k] && a[k].paidBy) || defaultPaid(k)) === 'own' ? amt(k) : 0), 0) + customReimb;
  const estTotal = Number(r[COL.C_TOTAL] || 0);
  const advance = Number(r[COL.FOREX] || 0) + (parseJSON(r[COL.FOREX_TOPUPS], []) || []).reduce((x, t) => x + (Number(t.amount) || 0), 0) + Number(r[COL.C_DEPOSIT] || 0);
  const status = String(r[COL.ACTUALS_STATUS] || 'Pending');
  return {
    status, currency: cur, items, estTotal, actualTotal, variance: estTotal - actualTotal,
    reimbursable, advance, reimburseApproved: Number(r[COL.REIMBURSE_AMT] || 0),
    hodApproved: !!a.hodApproved, hodBy: a.hodBy || '', hodAt: a.hodAt ? fmtDate(a.hodAt) : '',
    late: a.late ? { days: Number(a.late.days) || 0, due: fmtDate(a.late.due) } : null,
    hasActuals: actualTotal > 0 || status !== 'Pending',
  };
}

// Traveller submits post-trip actuals / reimbursement claim (meals/local/visa/baggage/misc).
export async function saveActuals(id, email, payload) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (!ownsRequest(rec, email)) return { ok: false, error: 'Only the requester can submit this trip’s expenses.' };
  if (String(rec[COL.ACTUALS_STATUS]) === 'Closed') return { ok: false, error: 'This trip is closed by Finance — actuals are locked.' };
  const cur = parseJSON(rec[COL.ACTUALS], {}) || {}; // preserve admin-set flight/hotel
  // Payment method: own (reimbursed to employee) · company (company card/forex) · brex (Brex corporate card).
  const normPaid = (v) => (v === 'company' || v === 'brex') ? v : 'own';
  const TRAV = ['meals', 'local', 'visa', 'baggage', 'misc'];
  for (const k of TRAV) {
    const it = payload && payload[k];
    if (!it) continue;
    const amount = Number(it.amount) || 0;
    if (amount > 0 && !it.doc) return { ok: false, error: `A receipt is required for ${ACT_LABEL[k]} (₹${amount}).` };
    cur[k] = { amount, paidBy: normPaid(it.paidBy), doc: String(it.doc || '') };
  }
  // Traveller-added custom expense lines: each carries its own category label.
  if (Array.isArray(payload && payload.custom)) {
    const clean = [];
    for (const c of payload.custom) {
      const amount = Number(c && c.amount) || 0;
      const label = String((c && c.label) || '').trim();
      if (amount <= 0 && !label) continue; // skip blank rows
      if (amount > 0 && !label) return { ok: false, error: 'Please choose a category for each added expense.' };
      if (amount > 0 && !(c && c.doc)) return { ok: false, error: `A receipt is required for ${label} (${amount}).` };
      clean.push({ label: label || 'Other', amount, paidBy: normPaid(c.paidBy), doc: String((c && c.doc) || '') });
    }
    cur.custom = clean;
  }
  cur.currency = rec[COL.CURRENCY] || 'INR';
  cur.enteredBy = String(email || '').split('@')[0];
  cur.updatedAt = new Date().toISOString();
  // A (re)submitted claim needs (re)approval by the HOD before Finance can settle.
  cur.hodApproved = false; delete cur.hodBy; delete cur.hodAt;
  // Late-submission flag (policy §9.1): is this claim being submitted after its due window?
  const ltype = String(rec[COL.TYPE] || 'domestic');
  const lbase = Date.parse(ltype === 'local' ? rec[COL.START] : (rec[COL.RET] || rec[COL.START]));
  if (lbase) {
    const ldue = addBusinessDays(new Date(lbase), claimDueDays(ltype)).getTime();
    const nowT = Date.now();
    if (nowT > ldue) cur.late = { due: new Date(ldue).toISOString(), days: Math.ceil((nowT - ldue) / (24 * 60 * 60 * 1000)) };
    else delete cur.late;
  }
  await updateCells(rec.__row, [[COL.ACTUALS, JSON.stringify(cur)], [COL.ACTUALS_STATUS, 'Submitted'], [COL.EXPENSE_DATE, new Date().toISOString()]]);
  const ad = actualsData({ ...rec, [COL.ACTUALS]: JSON.stringify(cur), [COL.ACTUALS_STATUS]: 'Submitted' });
  return { ok: true, id, reimbursable: ad.reimbursable, actualTotal: ad.actualTotal };
}

// Traveller attaches/replaces the preferred-flight screenshot/notes from My Requests (pre-booking).
export async function saveFlightDoc(id, email, doc, notes) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (!ownsRequest(rec, email)) return { ok: false, error: 'Only the requester can update this.' };
  const upd = [];
  if (doc != null && doc !== '') upd.push([COL.PREF_FLIGHT_DOC, String(doc)]);
  if (notes != null) upd.push([COL.PREF_FLIGHT_NOTES, String(notes)]);
  if (upd.length) await updateCells(rec.__row, upd);
  return { ok: true, id };
}

// HOD (department head) approves the traveller's reimbursement claim before Finance settles.
export async function approveReimbursement(id, email, roles) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  const dept = String(rec[COL.DEPT] || '');
  const e = String(email || '').toLowerCase();
  const deptHead = String((CONFIG.DEPARTMENTS[dept] || {}).email || '').toLowerCase();
  const myDepts = new Set(deptsForHod(email).map((d) => d.toLowerCase()));
  const isHOD = (roles || []).includes('hod') && (myDepts.has(dept.toLowerCase()) || deptHead === e || String(rec[COL.HOD] || '').toLowerCase() === e);
  const isFin = (roles || []).includes('finance');
  if (!isHOD && !isFin) return { ok: false, error: 'Only the department head can approve this claim.' };
  if (String(rec[COL.ACTUALS_STATUS]) !== 'Submitted') return { ok: false, error: 'There is no submitted claim awaiting approval.' };
  const cur = parseJSON(rec[COL.ACTUALS], {}) || {};
  cur.hodApproved = true; cur.hodBy = e.split('@')[0]; cur.hodAt = new Date().toISOString();
  await updateCells(rec.__row, [[COL.ACTUALS, JSON.stringify(cur)], [COL.ACTUALS_STATUS, 'HOD Approved']]);
  const ad = actualsData({ ...rec, [COL.ACTUALS]: JSON.stringify(cur), [COL.ACTUALS_STATUS]: 'HOD Approved' });
  const to = requesterEmail(rec); const fin = (CONFIG.FINANCE_SPOC || '');
  const cc = fin ? [fin] : [];
  if (to) await sendEmail({ to, cc, subject: `Travel ${id} — reimbursement claim approved by your HOD`,
    html: emailShell({ title: 'Reimbursement claim approved ✅', subtitle: `Spyne TravelDesk · ${id}`,
      statusText: `Reimbursement due: ${rec[COL.CURRENCY] || 'INR'} ${Number(ad.reimbursable).toLocaleString('en-IN')}`, statusColor: '#0F9D58',
      body: `<p style="color:#3D506A;margin:0 0 12px;">Your reimbursement claim for trip <b>${id}</b> has been <b>approved by your department head</b>.</p><p style="color:#3D506A;margin:0;">It now goes to <b>Finance</b> for settlement — you'll be notified once it's processed.</p>` }) });
  return { ok: true, id, reimbursable: ad.reimbursable };
}

// Finance reviews actuals + receipts, approves a reimbursement amount, and closes the trip.
export async function closeTrip(id, reimburseAmt, email) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  // Reimbursement must be HOD-approved before Finance settles it (a submitted-but-unapproved claim is blocked).
  if (String(rec[COL.ACTUALS_STATUS]) === 'Submitted') return { ok: false, error: 'The department head must approve this reimbursement claim before Finance can settle it.' };
  const amt = Math.max(0, Number(reimburseAmt) || 0);
  await updateCells(rec.__row, [[COL.ACTUALS_STATUS, 'Closed'], [COL.REIMBURSE_AMT, amt], [COL.CLOSURE_DATE, new Date().toISOString()]]);
  const to = requesterEmail(rec);
  if (CONFIG.CC_REQUESTER_ON_UPDATES && to) {
    await sendEmail({ to, subject: `Travel Request ${id} — trip closed & reimbursement`,
      html: `<p>Your trip <b>${id}</b> has been reconciled and closed by Finance.</p><p>Approved reimbursement: <b>${rec[COL.CURRENCY] || 'INR'} ${amt.toLocaleString('en-IN')}</b>.</p>` });
  }
  return { ok: true, id, reimburse: amt };
}

// Rebuild the compute inputs from a stored record (extras from ITINERARY, pax from PASSENGERS)
// and recompute with the CURRENT (fixed) engine + policy. Shared by the audit and the fixer so
// the "new total" previewed is exactly what the fix will write.
function recomputeRec(rec) {
  const it = parseJSON(rec[COL.ITINERARY], {}) || {};
  const pax = (parseJSON(rec[COL.PASSENGERS], []) || []).length || 1;
  const p = {
    name: rec[COL.NAME], dept: rec[COL.DEPT], email: rec[COL.EMAIL], travelType: rec[COL.TYPE],
    tripType: /one-way/i.test(String(rec[COL.TRIP])) ? 'one-way' : 'round',
    from: rec[COL.FROM], to: rec[COL.TO], returnFrom: rec[COL.RETFROM], returnTo: rec[COL.RETTO],
    transportMode: rec[COL.MODE], hotelNeeded: String(rec[COL.HOTEL_REQ]) === 'Yes',
    forexNeeded: Number(rec[COL.FOREX] || 0) > 0 || String(rec[COL.TYPE]) === 'international',
    visaNeeded: String(rec[COL.VISA_NEEDED]) === 'Yes',
  };
  const dur = duration(rec[COL.START], rec[COL.RET] || rec[COL.START]);
  const advanceDays = Math.ceil((new Date(rec[COL.START]) - new Date(rec[COL.TS] || Date.now())) / 86400000);
  const costs = computeCosts(p, dur, {
    advanceDays, passengers: pax,
    extraFlights: Array.isArray(it.flights) ? it.flights : [],
    extraHotels: Array.isArray(it.hotels) ? it.hotels : [],
  });
  return costs;
}

// Read-only audit: trips whose STORED cost/currency differs from what the current (fixed) engine
// would compute — catches wrong currency (US priced in INR) AND stale amounts (e.g. flight priced
// with an old estimate/live fare or before the one-way fix). Used to review before recompute+re-push.
// Trip IDs Finance has chosen to ignore in the mismatch audit (kept in the Settings tab).
async function dismissedAuditIds() {
  const raw = await getSetting('audit_dismissed', '');
  return new Set(String(raw || '').split(',').map((s) => s.trim()).filter(Boolean));
}
export async function dismissCurrencyMismatch(ids, roles) {
  if (!(roles || []).includes('finance')) return { ok: false, error: 'Finance only.' };
  const add = (Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean);
  if (!add.length) return { ok: false, error: 'No trips selected.' };
  const cur = await dismissedAuditIds();
  add.forEach((x) => cur.add(x));
  await setSetting('audit_dismissed', Array.from(cur).join(','), 'finance');
  return { ok: true, dismissed: add.length };
}

export async function currencyAudit() {
  await applyPolicyOverrides();
  const dismissed = await dismissedAuditIds();
  const all = await readAll();
  const rows = [];
  for (const r of all) {
    const status = String(r[COL.STATUS] || '');
    if (/reject|withdraw/i.test(status) || String(r[COL.STAGE]) === 'rejected') continue;
    if (dismissed.has(String(r[COL.ID]))) continue; // Finance dismissed this one
    let costs; try { costs = recomputeRec(r); } catch { continue; }
    const stored = String(r[COL.CURRENCY] || 'INR').toUpperCase();
    const storedTotal = Number(r[COL.C_TOTAL] || 0);
    const curChanged = costs.currency !== stored;
    const amtChanged = Math.abs(Math.round(costs.total) - Math.round(storedTotal)) > 1;
    if (!curChanged && !amtChanged) continue;
    rows.push({
      id: r[COL.ID], name: r[COL.NAME] || '', dept: r[COL.DEPT] || '',
      route: `${r[COL.FROM]} → ${r[COL.TO]}`, type: r[COL.TYPE] || '',
      stored, correct: costs.currency, oldTotal: storedTotal, newTotal: costs.total,
      curChanged, amtChanged, stage: String(r[COL.STAGE] || ''), status,
      booked: /completed|forex card issued|trip closed|with admin|arrangement/i.test(status) || !!r[COL.BOOKING_DATE],
    });
  }
  return rows;
}

// Fix the trips flagged by currencyAudit: recompute each with the corrected region logic,
// overwrite its stored cost columns, and (unless it's already completed) reset it to the first
// approval stage and re-notify the approver. Finance-only. Returns a per-trip summary.
export async function recomputeCurrencyFixes(baseUrl, roles, ids) {
  if (!(roles || []).includes('finance')) return { ok: false, error: 'Finance only.' };
  await applyPolicyOverrides();
  const base = String(baseUrl || process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const only = Array.isArray(ids) && ids.length ? new Set(ids.map((x) => String(x).trim())) : null; // if given, fix ONLY these
  const all = await readAll();
  const fixed = [];
  for (const rec of all) {
    const status = String(rec[COL.STATUS] || '');
    if (/reject|withdraw/i.test(status) || String(rec[COL.STAGE]) === 'rejected') continue;
    if (only && !only.has(String(rec[COL.ID]))) continue; // Finance picked a subset
    let costs; try { costs = recomputeRec(rec); } catch { continue; }
    const stored = String(rec[COL.CURRENCY] || 'INR').toUpperCase();
    const storedTotal = Number(rec[COL.C_TOTAL] || 0);
    const curChanged = costs.currency !== stored;
    const amtChanged = Math.abs(Math.round(costs.total) - Math.round(storedTotal)) > 1;
    if (!curChanged && !amtChanged) continue; // only trips whose cost/currency actually changed

    const updates = [
      [COL.CURRENCY, costs.currency], [COL.C_TRANSPORT, costs.transport],
      [COL.HOTEL_RATE, costs.hotelPerNight], [COL.HOTEL_NIGHTS, costs.hotelNights], [COL.C_HOTEL, costs.hotel],
      [COL.MEAL_RATE, costs.mealsPerDay], [COL.C_MEALS, costs.meals], [COL.C_LOCAL, costs.local],
      [COL.C_OTHER, costs.other], [COL.C_TOTAL, costs.total], [COL.FOREX, costs.forex],
      [COL.FLAG, costs.flag], [COL.C_EXTRAS, JSON.stringify(costs.extras || {})], [COL.C_DEPOSIT, costs.deposit],
    ];
    const completed = /completed|forex card issued|trip closed/i.test(status) || !!rec[COL.FOREX_ISSUE_DATE];
    let action;
    if (completed) {
      // Don't re-open a completed / forex-issued trip — just correct its figures.
      await updateCells(rec.__row, updates);
      action = 'corrected (kept as completed — not re-opened)';
    } else {
      const ceoReq = ceoIsRequester(rec);
      const firstStage = ceoReq ? 'finance' : 'dept';
      const newToken = randomUUID();
      updates.push([COL.STAGE, firstStage],
        [COL.STATUS, ceoReq ? ('Pending ' + stageLabel('finance') + ' Approval') : 'Pending HOD Approval'],
        [COL.TOKEN, newToken], [COL.DEPT_DEC, ''], [COL.DEPT_TIME, ''], [COL.CEO_DEC, ''], [COL.CEO_TIME, ''],
        [COL.FIN_DEC, ''], [COL.FIN_TIME, ''], [COL.HOLD, ''], [COL.ADMIN, ''], [COL.LAST_REMINDER, ''], [COL.REMINDER_COUNT, 0]);
      await updateCells(rec.__row, updates);
      const freshRec = { ...rec }; updates.forEach(([k, v]) => { freshRec[k] = v; });
      await emailApprover(firstStage, freshRec, base, { edited: true });
      action = 're-pushed for approval';
    }
    fixed.push({ id: rec[COL.ID], from: stored, to: costs.currency, oldTotal: Number(rec[COL.C_TOTAL] || 0), newTotal: costs.total, action });
  }
  return { ok: true, count: fixed.length, fixed };
}

export async function financeData() {
  const all = await readAll();
  await applyPolicyOverrides(); // so the editable-policy snapshot reflects current effective values
  // Pull ACTUAL spend from ExpenseDesk (best-effort) to reconcile against the estimate.
  const { byTrf, available: reconAvailable } = await expenseActualsByTrf();
  const fx = (CONFIG.FX && CONFIG.FX.USD_INR) || 92;
  const toINR = (amt, cur) => (String(cur).toUpperCase() === 'USD' ? Number(amt || 0) * fx : Number(amt || 0));
  const reconTotals = { linked: 0, estimateINR: 0, actualINR: 0, paidINR: 0 };
  const summaries = {};
  // Actual spend split by who paid (normalised to INR): own money (reimbursed), company card/forex, Brex.
  const pm = { own: 0, company: 0, brex: 0 };
  const rows = [];
  for (const r of all) {
    const cur = String(r[COL.CURRENCY] || 'INR');
    const total = Number(r[COL.C_TOTAL] || 0);
    const status = String(r[COL.STATUS] || '');
    const broken = /^POLICY BREAK/.test(String(r[COL.FLAG] || ''));
    const isForex = String(r[COL.TYPE]) === 'international' && Number(r[COL.FOREX] || 0) > 0;
    const rejected = /reject/i.test(status);
    const approved = /approved|admin|confirmed|completed|booking|forex/i.test(status);
    if (!summaries[cur]) summaries[cur] = { count: 0, pending: 0, approved: 0, rejected: 0, totalPipeline: 0, totalApproved: 0 };
    const s = summaries[cur];
    s.count++;
    if (rejected) s.rejected++; else if (approved) { s.approved++; s.totalApproved += total; } else s.pending++;
    if (!rejected) s.totalPipeline += total;

    // derived lifecycle statuses
    const hodStatus = decStatus(r[COL.DEPT_DEC]) || 'Pending';
    let ceoStatus = decStatus(r[COL.CEO_DEC]);
    if (!ceoStatus) ceoStatus = String(r[COL.TYPE]) === 'international' ? 'Pending' : 'N/A'; // CEO only for international
    let financeStatus = decStatus(r[COL.FIN_DEC]);
    if (!financeStatus) financeStatus = (broken || ceoIsRequester(r)) ? 'Pending' : 'N/A';
    let forexStatus = 'N/A';
    if (isForex) forexStatus = (r[COL.FOREX_ISSUE_DATE] || /forex card issued/i.test(status)) ? 'Issued' : 'Pending';

    // Reconciliation: estimate (normalised to INR) vs ACTUAL claimed in ExpenseDesk (INR).
    const estimateINR = toINR(total, cur);
    const advanceINR = toINR(Number(r[COL.FOREX] || 0) + (parseJSON(r[COL.FOREX_TOPUPS], []) || []).reduce((a, t) => a + (Number(t.amount) || 0), 0) + Number(r[COL.C_DEPOSIT] || 0), cur);
    const ex = byTrf[String(r[COL.ID]).toUpperCase()];
    let recon = { available: reconAvailable, linked: 0, estimateINR, actualINR: 0, paidINR: 0, varianceINR: estimateINR, settlementINR: advanceINR, items: [] };
    if (ex) {
      recon = { available: true, linked: ex.count, estimateINR, actualINR: ex.actualINR, paidINR: ex.paidINR,
        varianceINR: estimateINR - ex.actualINR, settlementINR: advanceINR - ex.actualINR, items: ex.items };
      if (!rejected) { reconTotals.linked++; reconTotals.estimateINR += estimateINR; reconTotals.actualINR += ex.actualINR; reconTotals.paidINR += ex.paidINR; }
    }

    // Payment-method split from this trip's submitted actuals (skip rejected trips).
    const ad = actualsData(r);
    if (!rejected) for (const it of (ad.items || [])) {
      const meth = (it.paidBy === 'brex') ? 'brex' : (it.paidBy === 'company' ? 'company' : 'own');
      pm[meth] += toINR(Number(it.actual) || 0, cur);
    }

    rows.push({
      recon,
      id: r[COL.ID], name: r[COL.NAME], dept: r[COL.DEPT], purpose: r[COL.PURPOSE],
      start: fmtDate(r[COL.START]), end: fmtDate(r[COL.RET]) || (r[COL.TRIP] === 'One-way' ? 'One-way' : ''),
      submission: fmtDate(r[COL.TS]), currency: cur, total, estimatedCost: cur + ' ' + Number(total).toLocaleString(cur === 'USD' ? 'en-US' : 'en-IN', { maximumFractionDigits: 0 }),
      // Advance = forex advance (meals & local; base + top-ups) + hotel security deposit. NOT an expense.
      advForex: Number(r[COL.FOREX] || 0) + (parseJSON(r[COL.FOREX_TOPUPS], []) || []).reduce((a, t) => a + (Number(t.amount) || 0), 0),
      advDeposit: Number(r[COL.C_DEPOSIT] || 0),
      advance: Number(r[COL.FOREX] || 0) + (parseJSON(r[COL.FOREX_TOPUPS], []) || []).reduce((a, t) => a + (Number(t.amount) || 0), 0) + Number(r[COL.C_DEPOSIT] || 0),
      hodStatus, hodDate: fmtDate(r[COL.DEPT_TIME]),
      ceoStatus, ceoDate: fmtDate(r[COL.CEO_TIME]),
      financeStatus, financeDate: fmtDate(r[COL.FIN_TIME]),
      bookingStatus: r[COL.ADMIN] || 'Pending', bookingDate: fmtDate(r[COL.BOOKING_DATE]),
      pnr: r[COL.TICKET_INFO] || '', ticketUploadDate: fmtDate(r[COL.TICKET_UPLOAD_DATE]),
      forexStatus, forexIssueDate: fmtDate(r[COL.FOREX_ISSUE_DATE]),
      advanceStatus: r[COL.ADVANCE_STATUS] || '', advanceDate: fmtDate(r[COL.ADVANCE_DATE]),
      expenseDate: fmtDate(r[COL.EXPENSE_DATE]), closureDate: fmtDate(r[COL.CLOSURE_DATE]),
      finalStatus: status, status, type: r[COL.TYPE], route: `${r[COL.FROM]} → ${r[COL.TO]}`,
      trip: r[COL.TRIP] || '', flag: String(r[COL.FLAG] || ''),
      breakdown: costBreakdown(r), actuals: ad, ...paxInfo(r),
      flights: itineraryFor(r).flights, hotels: itineraryFor(r).hotels,
    });
  }
  rows.reverse();
  const policyChanges = (await readChanges()).reverse(); // newest first
  return { currencySummaries: summaries, rows, reconciliation: { available: reconAvailable, fx, ...reconTotals },
    paymentMethods: pm, policyValues: editableSnapshot(), policyChanges, policyVersions: await mergedVersions() };
}

function parseJSON(s, fallback) { try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; } }

// Passenger count + names for a record (group travel).
function paxInfo(r) {
  const a = parseJSON(r[COL.PASSENGERS], []) || [];
  const passengers = a.map((x) => x && x.name).filter(Boolean);
  return { pax: Number(r[COL.PAX] || passengers.length || 1), passengers };
}

// Build the full flight & hotel lists (primary trip + extra multi-city legs) for a record.
// Indices are stable so admin booking details (BOOKINGS) line up by position.
function itineraryFor(r) {
  const extra = parseJSON(r[COL.ITINERARY], { flights: [], hotels: [] }) || { flights: [], hotels: [] };
  const times = extra.times || {};
  const flights = [];
  flights.push({ label: 'Outbound', from: r[COL.FROM], to: r[COL.TO], date: fmtDate(r[COL.START]),
    time: times.out || '', timeLabel: flightTimeLabel(r[COL.START], times.out, r[COL.FROM], r[COL.TO]) });
  if (String(r[COL.TRIP]) === 'Round trip') {
    flights.push({ label: 'Return', from: r[COL.RETFROM] || r[COL.TO], to: r[COL.RETTO] || r[COL.FROM], date: fmtDate(r[COL.RET]),
      time: times.ret || '', timeLabel: flightTimeLabel(r[COL.RET], times.ret, r[COL.RETFROM] || r[COL.TO], r[COL.RETTO] || r[COL.FROM]) });
  }
  (extra.flights || []).forEach((f, i) => flights.push({ label: 'Extra flight ' + (i + 1), from: f.from, to: f.to, date: fmtDate(f.date),
    time: f.time || '', timeLabel: flightTimeLabel(f.date, f.time, f.from, f.to) }));
  const hotels = [];
  const ph = extra.primaryHotel;
  if (Number(r[COL.HOTEL_NIGHTS] || 0) > 0) {
    hotels.push({ label: 'Stay (destination)',
      city: (ph && ph.city) || r[COL.TO],
      checkIn: fmtDate((ph && ph.checkIn) || r[COL.START]),
      checkOut: fmtDate((ph && ph.checkOut) || r[COL.RET]),
      nights: Number(r[COL.HOTEL_NIGHTS] || 0) });
  }
  (extra.hotels || []).forEach((h) => hotels.push({ label: 'Stay', city: h.city, checkIn: fmtDate(h.checkIn), checkOut: fmtDate(h.checkOut), nights: hotelNights(h.checkIn, h.checkOut) }));
  return { flights, hotels };
}

// ---- admin view: fully-approved requests to arrange ----
export async function adminData() {
  const all = await readAll();
  const rows = all
    .filter((r) => {
      const st = String(r[COL.STAGE]);
      const status = String(r[COL.STATUS]);
      if (st === 'rejected' || /reject/i.test(status)) return false;
      // keep everything that reached Admin arrangement — including completed/booked/forex-routed,
      // so the Done / All tabs can show finished requests with their full details.
      return ['admin', 'arrange', 'forex', 'done'].includes(st) || /admin|confirmed|completed|booking|forex/i.test(status);
    })
    .map((r) => ({
      id: r[COL.ID], date: fmtDate(r[COL.TS]), name: r[COL.NAME], email: r[COL.EMAIL],
      dept: r[COL.DEPT], type: r[COL.TYPE], trip: r[COL.TRIP],
      route: `${r[COL.FROM]} → ${r[COL.TO]}` + ((r[COL.RETFROM] || r[COL.RETTO]) ? `  |  return ${r[COL.RETFROM] || r[COL.TO]} → ${r[COL.RETTO] || r[COL.FROM]}` : ''),
      start: fmtDate(r[COL.START]), end: fmtDate(r[COL.RET]),
      days: Number(r[COL.DAYS] || 0), nights: Number(r[COL.NIGHTS] || 0),
      mode: r[COL.MODE], currency: r[COL.CURRENCY],
      hotelReq: r[COL.HOTEL_REQ], hotelRate: Number(r[COL.HOTEL_RATE] || 0), hotelNights: Number(r[COL.HOTEL_NIGHTS] || 0),
      total: Number(r[COL.C_TOTAL] || 0), forex: Number(r[COL.FOREX] || 0), notes: r[COL.NOTES],
      isForex: (String(r[COL.TYPE]) === 'international' && Number(r[COL.FOREX] || 0) > 0), ...paxInfo(r),
      ticketInfo: r[COL.TICKET_INFO] || '', docTicket: r[COL.DOC_TICKET] || '',
      docPassport: r[COL.DOC_PASSPORT] || '', docVisa: r[COL.DOC_VISA] || '', docPanAadhaar: r[COL.DOC_PANAADHAAR] || '',
      status: r[COL.STATUS], adminStatus: r[COL.ADMIN] || 'Pending',
      route2: (r[COL.FROM] + ' → ' + r[COL.TO]), flag: String(r[COL.FLAG] || ''), breakdown: costBreakdown(r),
      prefFlightDoc: r[COL.PREF_FLIGHT_DOC] || '', prefFlightNotes: r[COL.PREF_FLIGHT_NOTES] || '',
      ...itineraryFor(r), bookings: parseJSON(r[COL.BOOKINGS], { flights: [], hotels: [] }) || { flights: [], hotels: [] },
    }));
  rows.reverse();
  return { rows };
}

export async function saveTicket(id, ticketInfo, ticketDocLink) {
  const rec = await findById(id);
  if (!rec) throw new Error('Request not found: ' + id);
  const updates = [];
  if (ticketInfo != null) updates.push([COL.TICKET_INFO, ticketInfo]);
  if (ticketDocLink) updates.push([COL.DOC_TICKET, ticketDocLink], [COL.TICKET_UPLOAD_DATE, new Date().toISOString()]);
  if (updates.length) await updateCells(rec.__row, updates);
  return { ok: true, id };
}

// Save per-leg booking details (multi-city). bookings = {flights:[{info,doc}], hotels:[{info,doc}]}
// Also mirrors a summary into the master-tracker Ticket columns for Finance/Forex.
export async function saveBookings(id, bookings) {
  const rec = await findById(id);
  if (!rec) throw new Error('Request not found: ' + id);
  const arr = (x) => (Array.isArray(x) ? x : []);
  const safe = {
    flights: arr(bookings && bookings.flights).map((f) => ({ airline: String((f && f.airline) || ''), info: String((f && f.info) || ''), doc: String((f && f.doc) || ''), actual: Number((f && f.actual) || 0) })),
    hotels: arr(bookings && bookings.hotels).map((h) => ({ info: String((h && h.info) || ''), doc: String((h && h.doc) || ''), actual: Number((h && h.actual) || 0) })),
  };
  const updates = [[COL.BOOKINGS, JSON.stringify(safe)]];
  // Actual flight/hotel spend (company-paid) → ACTUALS, for budget-vs-actual.
  const flightActual = safe.flights.reduce((s, f) => s + (Number(f.actual) || 0), 0);
  const hotelActual = safe.hotels.reduce((s, h) => s + (Number(h.actual) || 0), 0);
  if (flightActual || hotelActual) {
    const act = parseJSON(rec[COL.ACTUALS], {}) || {};
    if (flightActual) act.flight = { amount: flightActual, paidBy: 'company', doc: (safe.flights.find((f) => f.doc) || {}).doc || (act.flight && act.flight.doc) || '' };
    if (hotelActual) act.hotel = { amount: hotelActual, paidBy: 'company', doc: (safe.hotels.find((h) => h.doc) || {}).doc || (act.hotel && act.hotel.doc) || '' };
    act.currency = rec[COL.CURRENCY] || 'INR';
    updates.push([COL.ACTUALS, JSON.stringify(act)]);
  }
  // Ticket info = "Airline · flight no./PNR/dates" per flight, combined for the forex letter & dashboards.
  const info = safe.flights.map((f) => [f.airline, f.info].filter(Boolean).join(' · ')).filter(Boolean).join(' | ');
  if (info) updates.push([COL.TICKET_INFO, info]);
  // Airline for the forex letter = first booked flight's airline (the outbound).
  const airline = (safe.flights.find((f) => f.airline) || {}).airline || '';
  if (airline) updates.push([COL.AIRLINES, airline]);
  const firstDoc = (safe.flights.find((f) => f.doc) || {}).doc || '';
  if (firstDoc) updates.push([COL.DOC_TICKET, firstDoc], [COL.TICKET_UPLOAD_DATE, new Date().toISOString()]);
  await updateCells(rec.__row, updates);
  return { ok: true, id };
}

// Admin marks the booking; on completion, international+forex requests route to the
// Forex officer (Jasvinder), everything else is marked Completed.
export async function setAdminStatus(id, status, baseUrl) {
  const rec = await findById(id);
  if (!rec) throw new Error('Request not found: ' + id);
  const completing = /done|booked|arranged|complete/i.test(status);
  const isForex = String(rec[COL.TYPE]) === 'international' && Number(rec[COL.FOREX] || 0) > 0;
  // Forex card issuance is triggered only AFTER the ticket is uploaded — block completing an
  // international/forex booking until the flight ticket/e-ticket is attached (Admin uploads it first).
  if (completing && isForex && !rec[COL.DOC_TICKET]) {
    return { ok: false, error: 'Upload the flight ticket/e-ticket first (Save bookings), then mark complete — the Forex officer needs it before issuing the card.' };
  }
  const updates = [[COL.ADMIN, status]];
  if (completing) updates.push([COL.BOOKING_DATE, new Date().toISOString()]);
  if (completing) await sendItinerary(rec); // e-ticket/voucher summary + .ics to the requester
  if (completing && isForex) {
    updates.push([COL.STAGE, 'forex'], [COL.STATUS, 'Booking done — Forex card (Jasvinder)']);
    await updateCells(rec.__row, updates);
    await emailForexOfficer(rec, baseUrl);
  } else if (completing) {
    updates.push([COL.STAGE, 'done'], [COL.STATUS, 'Completed']);
    await updateCells(rec.__row, updates);
  } else {
    await updateCells(rec.__row, updates);
  }
  return { ok: true, id, adminStatus: status };
}

// Manually route an international trip to the Forex officer (Admin/Finance) — covers cases where
// the forex toggle was missed at submission. Notifies Jasvinder + adds it to the Forex queue.
export async function sendToForex(id, email, roles, baseUrl) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  const r = roles || [];
  if (!r.includes('admin') && !r.includes('finance')) return { ok: false, error: 'Only Admin or Finance can send a request to the Forex officer.' };
  if (String(rec[COL.TYPE]) !== 'international') return { ok: false, error: 'Forex card applies to international trips only.' };
  if (String(rec[COL.STAGE]) === 'forex') return { ok: false, error: 'This request is already with the Forex officer.' };
  await updateCells(rec.__row, [[COL.STAGE, 'forex'], [COL.STATUS, 'Booking done — Forex card (Jasvinder)'], [COL.LAST_REMINDER, ''], [COL.REMINDER_COUNT, 0]]);
  await emailForexOfficer(rec, baseUrl);
  return { ok: true, id, msg: 'Sent to the Forex officer (Jasvinder) — notified by email and added to the Forex queue.' };
}

// On booking completion, email the requester the full itinerary + a calendar invite (.ics).
async function sendItinerary(rec) {
  const to = requesterEmail(rec);
  if (!CONFIG.CC_REQUESTER_ON_UPDATES || !to) return;
  const itin = itineraryFor(rec);
  const bookings = parseJSON(rec[COL.BOOKINGS], { flights: [], hotels: [] }) || { flights: [], hotels: [] };
  const ics = tripICS({
    uid: `${rec[COL.ID]}@spyne-traveldesk`,
    summary: `Trip ${rec[COL.ID]}: ${rec[COL.FROM]} → ${rec[COL.TO]}`,
    description: `${rec[COL.PURPOSE] || 'Business travel'} — ${rec[COL.TRIP]}. ${rec[COL.TICKET_INFO] || ''}`.trim(),
    location: rec[COL.TO] || '',
    start: rec[COL.START], end: rec[COL.RET] || rec[COL.START],
  });
  await sendEmail({
    to, subject: `Travel Request ${rec[COL.ID]} — Booked ✈️ (itinerary + calendar invite)`,
    html: itineraryEmailHtml(rec, itin, bookings),
    attachments: [{ filename: `trip-${rec[COL.ID]}.ics`, content: Buffer.from(ics, 'utf8').toString('base64') }],
  });
}

async function emailForexOfficer(rec, baseUrl) {
  const base = String(baseUrl || process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const html = forexOfficerEmailHtml(rec, (base || '') + '/forex');
  const opts = { to: CONFIG.FOREX_OFFICER, subject: `[Forex Card] Issue card — ${rec[COL.ID]} (${rec[COL.NAME]})`, html };
  if (CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL]) opts.cc = rec[COL.EMAIL];
  await sendEmail(opts);
}

// ---- forex officer (Jasvinder) view + actions ----
export async function forexData() {
  const all = await readAll();
  const rows = all.filter((r) => {
    const st = String(r[COL.STAGE]);
    const status = String(r[COL.STATUS]);
    const isForex = String(r[COL.TYPE]) === 'international' && Number(r[COL.FOREX] || 0) > 0;
    // pending forex cards (stage 'forex') + already-issued ones (kept for the Done / All tabs)
    return st === 'forex' || (isForex && (r[COL.FOREX_ISSUE_DATE] || /forex card issued/i.test(status)));
  }).map((r) => ({
    id: r[COL.ID], date: fmtDate(r[COL.TS]), name: r[COL.NAME], email: r[COL.EMAIL], dept: r[COL.DEPT],
    to: r[COL.TO], purpose: r[COL.PURPOSE], start: fmtDate(r[COL.START]), days: Number(r[COL.DAYS] || 0),
    nationality: r[COL.NATIONALITY], passportNo: r[COL.PASSPORT_NO], passportIssue: r[COL.PASSPORT_ISSUE],
    designation: r[COL.DESIGNATION], address: r[COL.ADDRESS], mobile: r[COL.MOBILE],
    forex: Number(r[COL.FOREX] || 0), ticketInfo: r[COL.TICKET_INFO] || '',
    // Full booked flight/hotel attachments so the Forex officer sees every ticket/voucher (not just the first).
    bookings: parseJSON(r[COL.BOOKINGS], { flights: [], hotels: [] }) || { flights: [], hotels: [] },
    prefFlightDoc: r[COL.PREF_FLIGHT_DOC] || '',
    docPassport: r[COL.DOC_PASSPORT] || '', docVisa: r[COL.DOC_VISA] || '', docPanAadhaar: r[COL.DOC_PANAADHAAR] || '',
    idDocType: r[COL.ID_DOC_TYPE] || '', docAadhaar: r[COL.DOC_AADHAAR] || '', docPan: r[COL.DOC_PAN] || '', docNationalId: r[COL.DOC_NATIONAL_ID] || '',
    docTicket: r[COL.DOC_TICKET] || '', docForexConfirm: r[COL.DOC_FOREX_CONFIRM] || '', status: r[COL.STATUS],
    currency: r[COL.CURRENCY] || 'USD', total: Number(r[COL.C_TOTAL] || 0), trip: r[COL.TRIP] || '',
    route: (r[COL.FROM] + ' → ' + r[COL.TO]), flag: String(r[COL.FLAG] || ''), breakdown: costBreakdown(r),
    done: !!(r[COL.FOREX_ISSUE_DATE]) || /forex card issued/i.test(String(r[COL.STATUS])), forexIssueDate: fmtDate(r[COL.FOREX_ISSUE_DATE]),
    forexBase: Number(r[COL.FOREX] || 0),
    topups: (parseJSON(r[COL.FOREX_TOPUPS], []) || []).map((t) => ({ amount: Number(t.amount) || 0, note: t.note || '', by: t.by || '', date: fmtDate(t.date) })),
    forexTotal: Number(r[COL.FOREX] || 0) + (parseJSON(r[COL.FOREX_TOPUPS], []) || []).reduce((a, t) => a + (Number(t.amount) || 0), 0),
    docForexCard: r[COL.DOC_FOREX_CARD] || '', // card back snapshot (for top-ups)
  }));
  rows.reverse();
  return { rows };
}

export async function saveForexConfirm(id, confirmDoc) {
  const rec = await findById(id);
  if (!rec) throw new Error('Request not found: ' + id);
  if (confirmDoc) await updateCells(rec.__row, [[COL.DOC_FOREX_CONFIRM, confirmDoc]]);
  return { ok: true, id };
}

// Forex officer adds an additional advance / top-up against a trip. Each top-up is logged
// (amount + note + who + date); the card's total = base forex + sum of top-ups.
export async function saveForexTopup(id, amount, note, byEmail) {
  await ensureHeaders();
  const rec = await findById(id);
  if (!rec) throw new Error('Request not found: ' + id);
  const amt = Number(amount) || 0;
  if (amt <= 0) return { ok: false, error: 'Enter a top-up amount greater than 0' };
  const list = parseJSON(rec[COL.FOREX_TOPUPS], []) || [];
  list.push({ amount: amt, note: String(note || ''), by: String(byEmail || '').split('@')[0], date: new Date().toISOString() });
  await updateCells(rec.__row, [[COL.FOREX_TOPUPS, JSON.stringify(list)]]);
  const total = Number(rec[COL.FOREX] || 0) + list.reduce((a, t) => a + (Number(t.amount) || 0), 0);
  if (CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL]) {
    await sendEmail({ to: rec[COL.EMAIL], subject: `Travel Request ${id} — Forex top-up of USD ${amt}`,
      html: `<p>An additional forex top-up of <b>USD ${amt}</b> has been loaded for trip <b>${id}</b>${note ? ' (' + String(note) + ')' : ''}. Total forex on the card is now <b>USD ${total}</b>.</p>` });
  }
  return { ok: true, id, amount: amt, total };
}

export async function completeForex(id, baseUrl) {
  const rec = await findById(id);
  if (!rec) throw new Error('Request not found: ' + id);
  await updateCells(rec.__row, [[COL.STAGE, 'done'], [COL.STATUS, 'Completed — Forex card issued'], [COL.FOREX_ISSUE_DATE, new Date().toISOString()]]);
  if (CONFIG.CC_REQUESTER_ON_UPDATES && rec[COL.EMAIL]) {
    const link = (baseUrl || '') + '/my?forexcard=' + encodeURIComponent(id);
    await sendEmail({
      to: rec[COL.EMAIL],
      subject: `Travel Request ${id} — Forex card issued`,
      html: `<p>Your forex card for trip <b>${id}</b> has been issued. Your travel is fully processed. Safe travels!</p>`
        + `<p style="margin-top:14px;"><b>One quick step:</b> please upload a snapshot of the <b>back of your forex card</b> (card number &amp; details). We keep it on file so the Forex officer can load any future <b>top-ups</b> to your card quickly — without asking you for the details each time.</p>`
        + `<p><a href="${link}" style="display:inline-block;background:#e11d48;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600;">Upload forex card (back) →</a></p>`
        + `<p style="color:#667;font-size:13px;">Open your request, then use the <b>“💳 Forex card”</b> action to attach the photo.</p>`,
    });
  }
  return { ok: true, id };
}

// Traveller uploads the back of their issued forex card (for future top-ups).
export async function saveForexCardDoc(id, email, doc) {
  const rec = await findById(id);
  if (!rec) return { ok: false, error: 'Request not found' };
  if (!ownsRequest(rec, email)) return { ok: false, error: 'Only the requester can update this.' };
  if (doc != null && doc !== '') await updateCells(rec.__row, [[COL.DOC_FOREX_CARD, String(doc)]]);
  return { ok: true, id };
}

// ---- 24h reminders ----
// Scans pending requests; if the current approver/owner has taken no action for ≥24h,
// emails them a reminder (re-sent at most once per ~day). Covers HOD, CEO, Finance,
// Admin (approval + arrangements) and Forex card issuance.
const HOUR_MS = 3600000;
// Add N business days (skip Sat/Sun) to a date — for claim-submission deadlines.
function addBusinessDays(date, n) {
  const dt = new Date(date); let added = 0;
  while (added < n) { dt.setDate(dt.getDate() + 1); const wd = dt.getDay(); if (wd !== 0 && wd !== 6) added++; }
  return dt;
}
// Claim-submission window per the policy timelines table (business days unless noted).
function claimDueDays(type) { return type === 'local' ? 7 : (type === 'international' ? 15 : 10); }
function claimReminderEmailHtml(rec, link, overdue, dueLabel) {
  const id = rec[COL.ID];
  return emailShell({
    title: `${overdue ? 'Overdue: ' : ''}Submit your trip bills`,
    subtitle: `Spyne TravelDesk · ${id}`,
    statusText: `${overdue ? '⚠ Overdue' : '⏰ Due'} by ${dueLabel}`,
    statusColor: overdue ? '#E8232A' : '#D97706',
    body: `<p style="color:#3D506A;margin:0 0 12px;">Your trip <b>${id}</b> (${rec[COL.FROM]} → ${rec[COL.TO]}) is complete, but we haven't received your <b>bills / reimbursement claim</b> yet.</p>
      <p style="color:#3D506A;margin:0 0 16px;">Per policy, claims are due by <b>${dueLabel}</b>. Please upload your invoices (PDF) and submit your claim.</p>
      <div style="margin:20px 0 4px;">${btn(link, 'Upload bills →', '#E8232A')}</div>`,
  });
}
function advanceReminderEmailHtml(rec, link, overdue, dueLabel, advLabel) {
  const id = rec[COL.ID];
  return emailShell({
    title: `${overdue ? 'Overdue: ' : ''}Settle your travel advance`,
    subtitle: `Spyne TravelDesk · ${id}`,
    statusText: `${overdue ? '⚠ Overdue' : '⏰ Due'} by ${dueLabel} · advance ${advLabel}`,
    statusColor: overdue ? '#E8232A' : '#D97706',
    body: `<p style="color:#3D506A;margin:0 0 12px;">Your trip <b>${id}</b> (${rec[COL.FROM]} → ${rec[COL.TO]}) took a travel advance of <b>${advLabel}</b>, which has not yet been settled.</p>
      <p style="color:#3D506A;margin:0 0 12px;">Per policy, any <b>unused tour advance must be returned within 30 calendar days of returning</b> — by <b>${dueLabel}</b>. Please submit your final bills so Finance can reconcile and settle the balance.</p>
      ${overdue ? '<p style="color:#B01820;font-weight:700;margin:0 0 12px;">This advance is now overdue. Failure to return unused advances within 30 days may result in forfeiture and/or recovery from salary.</p>' : ''}
      <div style="margin:20px 0 4px;">${btn(link, 'Settle advance →', '#E8232A')}</div>`,
  });
}
// Reminders are CC'd to Shankul (admin) — and, on escalation, the CEO/Finance. The REQUESTER is
// deliberately NOT CC'd, because reminder emails carry the cost breakdown and travellers must not
// see the estimated cost. The requester tracks status on their My Requests page instead.
function reminderCc(rec, to, extra) {
  const list = [CONFIG.ADMIN_TEAM].concat(extra || [])
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean);
  const t = String(to || '').trim().toLowerCase();
  const dedup = list.filter((x, i) => list.indexOf(x) === i && x !== t);
  return dedup.length ? dedup : undefined;
}
export async function sendReminders(baseUrl) {
  // Master switch lives in the sheet (Settings tab) and is toggled by Finance from the dashboard.
  // Default OFF when unset. An env REMINDERS_ENABLED=false also force-disables (hard kill).
  if (String(process.env.REMINDERS_ENABLED || '').toLowerCase() === 'false') {
    return { ok: true, disabled: true, msg: 'Reminders force-disabled via REMINDERS_ENABLED=false.' };
  }
  if (!(await remindersEnabled())) {
    return { ok: true, disabled: true, msg: 'Reminders are OFF — turn them on from the Finance dashboard toggle.' };
  }
  // Send at most once per day, at/after the Finance-configured hour (IST). Lets the cron run
  // hourly while reminders go out only at the chosen time. (On a once-daily cron the run must
  // fall at/after the chosen hour.)
  const hourCfg = await reminderHour();
  const istNow = new Date(Date.now() + 5.5 * HOUR_MS);
  const istHour = istNow.getUTCHours();
  const istDate = istNow.toISOString().slice(0, 10);
  if (istHour < hourCfg) {
    return { ok: true, skipped: 'before configured send hour', sendHourIST: hourCfg, nowHourIST: istHour };
  }
  if (String(await getSetting('reminder_last_run', '')) === istDate) {
    return { ok: true, skipped: 'reminders already sent today', date: istDate };
  }
  await setSetting('reminder_last_run', istDate, 'cron'); // claim today's slot before sending
  const base = String(baseUrl || process.env.APP_BASE_URL || '').replace(/\/$/, '');
  await ensureHeaders(); // widens the sheet grid + syncs header row for the reminder columns
  const all = await readAll();
  const now = Date.now();
  const sent = [];
  let pending = 0;
  for (const rec of all) {
    const stage = String(rec[COL.STAGE] || '');
    const status = String(rec[COL.STATUS] || '');
    if (/reject/i.test(status) || stage === 'rejected' || stage === 'done') continue;
    if (rec[COL.HOLD]) continue; // on-hold requests are paused — no reminders

    let since, to, label, kind = 'approval', link;
    if (stage === 'dept')         { since = rec[COL.TS];                                                          to = rec[COL.HOD] || CONFIG.FINANCE_SPOC; label = 'HOD'; }
    else if (stage === 'ceo')     { since = rec[COL.CEO_TIME] || rec[COL.DEPT_TIME] || rec[COL.TS];               to = CONFIG.CEO_EMAIL;    label = 'CEO'; }
    else if (stage === 'finance') { since = rec[COL.FIN_TIME] || rec[COL.CEO_TIME] || rec[COL.DEPT_TIME] || rec[COL.TS]; to = CONFIG.FINANCE_SPOC; label = 'Finance'; }
    else if (stage === 'admin')   { since = rec[COL.FIN_TIME] || rec[COL.DEPT_TIME] || rec[COL.TS];               to = CONFIG.ADMIN_TEAM;   label = 'Admin'; }
    else if (stage === 'arrange') { since = rec[COL.FIN_TIME] || rec[COL.CEO_TIME] || rec[COL.DEPT_TIME] || rec[COL.TS]; to = CONFIG.ADMIN_TEAM; label = 'Admin — Booking & Arrangements'; kind = 'task'; link = base + '/admin'; }
    else if (stage === 'forex')   { since = rec[COL.BOOKING_DATE] || rec[COL.TS];                                 to = CONFIG.FOREX_OFFICER; label = 'Forex Card Issuance'; kind = 'task'; link = base + '/forex'; }
    else continue;

    // OOO delegation: route approval reminders to the delegate instead of the default approver.
    if (rec[COL.DELEGATE_EMAIL] && ['dept', 'ceo', 'finance'].includes(stage)) { to = rec[COL.DELEGATE_EMAIL]; label += ' (delegated)'; }

    pending++;
    const waitedMs = now - Date.parse(since);
    if (!(waitedMs >= 24 * HOUR_MS)) continue;                 // not pending long enough
    const last = Date.parse(rec[COL.LAST_REMINDER]);
    if (last && (now - last) < 23 * HOUR_MS) continue;         // already reminded within ~a day
    const hours = Math.floor(waitedMs / HOUR_MS);
    const count = Number(rec[COL.REMINDER_COUNT] || 0) + 1;
    // Reminder goes ONLY to the person the request is currently pending with (the stage approver
    // / owner — or their OOO delegate). No CC to the requester, CEO or admin: each reminder
    // reaches just the one person who needs to act, nobody else.
    const prefix = '[Reminder]';

    // Escalation: after N unanswered reminders, also loop in the CEO + Finance (admin is already CC'd).
    const escalated = count >= (CONFIG.ESCALATE_AFTER_REMINDERS || 3);
    const escCc = escalated ? [CONFIG.CEO_EMAIL, CONFIG.FINANCE_SPOC] : [];
    const sub = (escalated ? '[Escalated] ' : prefix + ' ');
    if (kind === 'approval') {
      const token = rec[COL.TOKEN];
      const html = reminderEmailHtml(rec, label,
        actionUrl(base, rec[COL.ID], stage, 'approve', token),
        actionUrl(base, rec[COL.ID], stage, 'reject', token), hours);
      await sendEmail({ to, subject: `${sub}${rec[COL.ID]} — ${label} approval pending ${hours}h`, html, cc: reminderCc(rec, to, escCc) });
    } else {
      await sendEmail({ to, subject: `${sub}${rec[COL.ID]} — ${label} pending ${hours}h`, html: taskReminderEmailHtml(rec, label, link, hours), cc: reminderCc(rec, to, escCc) });
    }
    // Cost-free "still pending" nudge to the requester (no breakdown — travellers don't see cost).
    const reqTo = requesterEmail(rec);
    if (reqTo && reqTo.toLowerCase() !== String(to).toLowerCase()) {
      await sendEmail({ to: reqTo, subject: `${rec[COL.ID]} — still awaiting ${label}`,
        html: emailShell({ title: 'Your travel request is still pending', subtitle: `Spyne TravelDesk · ${rec[COL.ID]}`,
          statusText: `Awaiting ${label} · ~${hours}h`, statusColor: '#D97706',
          body: `<p style="color:#3D506A;margin:0 0 12px;">Hi ${rec[COL.NAME] || 'there'}, your trip <b>${rec[COL.FROM]} → ${rec[COL.TO]}</b> (${rec[COL.START]}${rec[COL.RET] ? (' → ' + rec[COL.RET]) : ''}) is still <b>awaiting ${label}</b>. We've nudged the approver — no action needed from you. You can track it any time on <b>My Requests</b>.</p>` }) });
    }
    await updateCells(rec.__row, [[COL.LAST_REMINDER, new Date(now).toISOString()], [COL.REMINDER_COUNT, count]]);
    sent.push({ id: rec[COL.ID], stage, label, to, hours, reminderCount: count });
  }
  // ---- Bill-not-submitted reminders (post-trip, per claim-submission timelines) ----
  const claims = [];
  for (const rec of all) {
    const status = String(rec[COL.STATUS] || '');
    if (/reject|withdraw/i.test(status)) continue;
    const done = String(rec[COL.STAGE]) === 'done' || /completed|forex card issued|trip closed/i.test(status);
    if (!done) continue;
    const astatus = String(rec[COL.ACTUALS_STATUS] || 'Pending');
    if (astatus !== 'Pending' && astatus !== '') continue;   // a claim was already submitted/approved/closed
    const type = String(rec[COL.TYPE] || 'domestic');
    const baseRaw = type === 'local' ? (rec[COL.EXPENSE_DATE] || rec[COL.START]) : (rec[COL.RET] || rec[COL.START]);
    const baseTime = Date.parse(baseRaw);
    if (!baseTime || now < baseTime) continue;               // trip hasn't returned yet
    const thr = claimDueDays(type);
    const dueTime = addBusinessDays(new Date(baseTime), thr).getTime();
    const remindFrom = addBusinessDays(new Date(baseTime), Math.max(0, thr - 2)).getTime(); // nudge from 2 business days before due
    if (now < remindFrom) continue;
    const last = Date.parse(rec[COL.LAST_REMINDER]);
    if (last && (now - last) < 23 * HOUR_MS) continue;        // once per day
    const to = requesterEmail(rec);
    if (!to) continue;
    if (String(to).toLowerCase() === String(CONFIG.CEO_EMAIL || '').toLowerCase()) continue; // bill reminders go to the traveller, but never nag the CEO (Sanjay)
    const overdue = now > dueTime;
    const link = base + '/my?trip=' + encodeURIComponent(rec[COL.ID]);
    await sendEmail({ to, subject: `${overdue ? '[Overdue]' : '[Reminder]'} ${rec[COL.ID]} — submit your trip bills / reimbursement`,
      html: claimReminderEmailHtml(rec, link, overdue, fmtDate(new Date(dueTime).toISOString())), cc: reminderCc(rec, to) });
    await updateCells(rec.__row, [[COL.LAST_REMINDER, new Date(now).toISOString()], [COL.REMINDER_COUNT, Number(rec[COL.REMINDER_COUNT] || 0) + 1]]);
    claims.push({ id: rec[COL.ID], to, due: fmtDate(new Date(dueTime).toISOString()), overdue });
  }
  // ---- Tour-advance settlement reminders (return unused advance within 30 CALENDAR days of return) ----
  const advances = [];
  const DAY_MS = 24 * HOUR_MS;
  for (const rec of all) {
    const status = String(rec[COL.STATUS] || '');
    if (/reject|withdraw/i.test(status)) continue;
    if (String(rec[COL.ACTUALS_STATUS]) === 'Closed' || rec[COL.CLOSURE_DATE]) continue; // already settled/closed by Finance
    const done = String(rec[COL.STAGE]) === 'done' || /completed|forex card issued|trip closed/i.test(status);
    if (!done) continue;
    const advAmt = Number(rec[COL.FOREX] || 0) + (parseJSON(rec[COL.FOREX_TOPUPS], []) || []).reduce((x, t) => x + (Number(t.amount) || 0), 0) + Number(rec[COL.C_DEPOSIT] || 0);
    if (advAmt <= 0) continue; // no advance to settle
    const baseTime = Date.parse(rec[COL.RET] || rec[COL.START]);
    if (!baseTime || now < baseTime) continue;
    const dueTime = baseTime + 30 * DAY_MS;                    // 30 CALENDAR days from return
    const remindFrom = dueTime - 5 * DAY_MS;                   // nudge from 5 days before due
    if (now < remindFrom) continue;
    const last = Date.parse(rec[COL.ADVANCE_REMINDER]);
    if (last && (now - last) < 23 * HOUR_MS) continue;         // once per day
    const to = requesterEmail(rec);
    if (!to) continue;
    if (String(to).toLowerCase() === String(CONFIG.CEO_EMAIL || '').toLowerCase()) continue; // never nag the CEO
    const overdue = now > dueTime;
    const advLabel = (rec[COL.CURRENCY] || 'INR') + ' ' + Math.round(advAmt).toLocaleString('en-IN');
    const link = base + '/my?trip=' + encodeURIComponent(rec[COL.ID]);
    await sendEmail({ to, subject: `${overdue ? '[Overdue]' : '[Reminder]'} ${rec[COL.ID]} — settle your travel advance`,
      html: advanceReminderEmailHtml(rec, link, overdue, fmtDate(new Date(dueTime).toISOString()), advLabel), cc: reminderCc(rec, to, [CONFIG.FINANCE_SPOC]) });
    await updateCells(rec.__row, [[COL.ADVANCE_REMINDER, new Date(now).toISOString()]]);
    advances.push({ id: rec[COL.ID], to, due: fmtDate(new Date(dueTime).toISOString()), overdue, advance: advAmt });
  }
  return { ok: true, scannedPending: pending, sentCount: sent.length, sent, claimRemindersSent: claims.length, claims, advanceRemindersSent: advances.length, advances };
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }); // DD/MM/YYYY
}
// DD/MM/YYYY HH:MM (IST) — used for the request timeline so each step shows date + time.
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).replace(',', '');
}
