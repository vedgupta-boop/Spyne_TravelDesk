// ---------------------------------------------------------------------------
//  Flight-time timezone helper. A flight's departure time is entered in the
//  ORIGIN city's local time; we display it in both IST (India) and the relevant
//  US local zone (DST-correct, via Intl). Used server-side for the data rows,
//  itinerary email, etc. A mirror of `flightTimes()` lives inline in index.html
//  for the live form preview.
// ---------------------------------------------------------------------------

const IST = 'Asia/Kolkata';

export function cityTz(city) {
  const c = String(city || '').toLowerCase();
  if (/new york|jfk|newark|ewr|philadelph|phl|boston|\bbos\b|atlanta|atl|miami|mia|washington|iad|dca/.test(c)) return 'America/New_York';
  if (/chicago|ord|dallas|dfw|houston|iah|austin|aus/.test(c)) return 'America/Chicago';
  if (/denver|den|phoenix|phx/.test(c)) return 'America/Denver';
  if (/los angeles|lax|san francisco|sfo|san jose|sjc|seattle|sea|las vegas|las/.test(c)) return 'America/Los_Angeles';
  return IST; // India (and anything unknown) → IST
}
const US_ABBR = { 'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Los_Angeles': 'PT' };

function tzOffsetMin(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; dtf.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour % 24), +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}
// Interpret a wall-clock (dateISO + HH:MM) in tz → the UTC instant.
function toInstant(dateISO, hhmm, tz) {
  const d = String(dateISO).split('-').map(Number);
  const t = String(hhmm).split(':').map(Number);
  if (d.length < 3 || isNaN(d[0])) return null;
  const guess = Date.UTC(d[0], d[1] - 1, d[2], t[0] || 0, t[1] || 0);
  const off = tzOffsetMin(tz, new Date(guess));
  return new Date(guess - off * 60000);
}
function fmtHM(instant, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(instant);
}
function dayTag(instant, tz, baseDateISO) {
  const dd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  if (dd === baseDateISO) return '';
  return dd > baseDateISO ? ' +1' : ' −1';
}

// Given the departure local time at originCity (with the other city for US-zone detection),
// return { ist, us } display strings (us is null for India-only legs).
export function flightTimes(dateISO, hhmm, originCity, otherCity) {
  if (!dateISO || !hhmm) return null;
  const oTz = cityTz(originCity);
  const inst = toInstant(dateISO, hhmm, oTz);
  if (!inst || isNaN(inst)) return null;
  const ist = fmtHM(inst, IST) + dayTag(inst, IST, dateISO) + ' IST';
  let usTz = oTz !== IST ? oTz : (cityTz(otherCity) !== IST ? cityTz(otherCity) : null);
  const us = usTz ? (fmtHM(inst, usTz) + dayTag(inst, usTz, dateISO) + ' ' + (US_ABBR[usTz] || 'US')) : null;
  return { ist, us };
}

// Short "10:00 IST · 23:30 −1 ET" style label for a leg (or '' if no time).
export function flightTimeLabel(dateISO, hhmm, originCity, otherCity) {
  const t = flightTimes(dateISO, hhmm, originCity, otherCity);
  if (!t) return '';
  return t.ist + (t.us ? ' · ' + t.us : '');
}
