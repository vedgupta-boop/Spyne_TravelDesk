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
  if (/new york|\bjfk\b|\blga\b|newark|\bewr\b|philadelph|\bphl\b|boston|\bbos\b|atlanta|\batl\b|miami|\bmia\b|washington|\biad\b|\bdca\b|baltimore|\bbwi\b|orlando|\bmco\b|fort lauderdale|\bfll\b|tampa|\btpa\b|west palm|\bpbi\b|jacksonville|\bjax\b|raleigh|durham|\brdu\b|greensboro|\bgso\b|charlotte|\bclt\b|richmond|\bric\b|norfolk|\borf\b|pittsburgh|\bpit\b|buffalo|\bbuf\b|rochester|\broc\b|albany|\balb\b|syracuse|\bsyr\b|providence|\bpvd\b|hartford|\bbdl\b|manchester|\bmht\b|detroit|\bdtw\b|grand rapids|\bgrr\b|cleveland|\bcle\b|columbus|\bcmh\b|cincinnati|\bcvg\b|indianapolis|\bind\b|louisville|\bsdf\b|charleston|\bchs\b|savannah|\bsav\b|greenville|\bgsp\b/.test(c)) return 'America/New_York';
  if (/chicago|\bord\b|\bmdw\b|dallas|\bdfw\b|\bdal\b|houston|\biah\b|\bhou\b|austin|\baus\b|san antonio|\bsat\b|minneapolis|\bmsp\b|st\.? ?louis|\bstl\b|kansas city|\bmci\b|new orleans|\bmsy\b|nashville|\bbna\b|memphis|\bmem\b|oklahoma city|\bokc\b|tulsa|\btul\b|omaha|\boma\b|milwaukee|\bmke\b|des moines|\bdsm\b/.test(c)) return 'America/Chicago';
  if (/phoenix|\bphx\b|tucson|\btus\b|scottsdale|tempe|\bmesa\b/.test(c)) return 'America/Phoenix';
  if (/denver|\bden\b|salt lake|\bslc\b|albuquerque|\babq\b|boise|\bboi\b|el paso|\belp\b|colorado springs|\bcos\b|billings/.test(c)) return 'America/Denver';
  if (/los angeles|\blax\b|san francisco|\bsfo\b|san jose|\bsjc\b|oakland|\boak\b|san diego|\bsan\b|sacramento|\bsmf\b|ontario|\bont\b|burbank|\bbur\b|orange county|\bsna\b|long beach|\blgb\b|fresno|\bfat\b|palm springs|\bpsp\b|seattle|\bsea\b|portland|\bpdx\b|spokane|\bgeg\b|las vegas|\blas\b|reno|\brno\b/.test(c)) return 'America/Los_Angeles';
  if (/anchorage|\banc\b/.test(c)) return 'America/Anchorage';
  if (/honolulu|\bhnl\b|\bogg\b|\bkoa\b|hawaii/.test(c)) return 'Pacific/Honolulu';
  if (/london|heathrow|lhr|gatwick|lgw|manchester|united kingdom|\buk\b|england|dublin|\bdub\b|ireland/.test(c)) return 'Europe/London';
  if (/paris|\bcdg\b|orly|france|frankfurt|\bfra\b|munich|\bmuc\b|germany|amsterdam|\bams\b|madrid|\bmad\b|barcelona|\bbcn\b|rome|\bfco\b|milan|zurich|\bzrh\b|geneva|\bgva\b|brussels|\bbru\b/.test(c)) return 'Europe/Paris';
  if (/dubai|\bdxb\b|abu dhabi|\bauh\b|sharjah|\buae\b|united arab/.test(c)) return 'Asia/Dubai';
  if (/singapore|\bsin\b/.test(c)) return 'Asia/Singapore';
  if (/hong kong|\bhkg\b/.test(c)) return 'Asia/Hong_Kong';
  if (/tokyo|haneda|\bhnd\b|narita|\bnrt\b|osaka|\bkix\b|japan/.test(c)) return 'Asia/Tokyo';
  if (/sydney|\bsyd\b|melbourne|\bmel\b|australia/.test(c)) return 'Australia/Sydney';
  return IST; // India (and anything unknown) → IST
}
// Fixed-offset zones whose OS abbreviation is a bare GMT offset — show the well-known code instead
// (these have no DST, so it's always accurate). US/Europe/Australia get DST-correct abbreviations from Intl.
const FRIENDLY = { 'Asia/Kolkata': 'IST', 'Asia/Dubai': 'GST', 'Asia/Singapore': 'SGT', 'Asia/Hong_Kong': 'HKT', 'Asia/Tokyo': 'JST' };
function tzAbbr(tz, instant) {
  let n = '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(instant).forEach((p) => { if (p.type === 'timeZoneName') n = p.value; }); } catch (e) { /* older runtime */ }
  if (n && !/^(GMT|UTC)[+\-−]/.test(n)) return n; // EST, EDT, PST, PDT, CST, CDT, MST, MDT, GMT, BST…
  return FRIENDLY[tz] || n || '';
}

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
export function flightTimes(dateISO, hhmm, originCity, otherCity, originTz) {
  if (!dateISO || !hhmm) return null;
  const oTz = originTz || cityTz(originCity);
  const inst = toInstant(dateISO, hhmm, oTz);
  if (!inst || isNaN(inst)) return null;
  const ist = fmtHM(inst, IST) + dayTag(inst, IST, dateISO) + ' IST';
  const otherTz = oTz !== IST ? oTz : (cityTz(otherCity) !== IST ? cityTz(otherCity) : null);
  const us = otherTz ? (fmtHM(inst, otherTz) + dayTag(inst, otherTz, dateISO) + ' ' + tzAbbr(otherTz, inst)) : null;
  return { ist, us };
}

// Short "10:00 IST · 23:30 −1 ET" style label for a leg (or '' if no time).
export function flightTimeLabel(dateISO, hhmm, originCity, otherCity, originTz) {
  const t = flightTimes(dateISO, hhmm, originCity, otherCity, originTz);
  if (!t) return '';
  return t.ist + (t.us ? ' · ' + t.us : '');
}
