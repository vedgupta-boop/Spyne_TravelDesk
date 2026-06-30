import { POLICY } from './config.js';

export function num(x) {
  const n = parseFloat(String(x == null ? '' : x).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

export function money(n, currency) {
  const cur = currency || 'INR';
  const locale = cur === 'USD' ? 'en-US' : 'en-IN';
  return cur + ' ' + Number(n || 0).toLocaleString(locale, { maximumFractionDigits: 0 });
}

export function duration(start, end) {
  const s = new Date(start), e = new Date(end);
  if (isNaN(s) || isNaN(e) || e < s) return { days: start ? 1 : 0, nights: 0 };
  const days = Math.round((e - s) / 86400000) + 1;
  return { days, nights: Math.max(0, days - 1) };
}

// Nights between two ISO dates (check-out − check-in), min 0.
export function hotelNights(checkIn, checkOut) {
  const s = new Date(checkIn), e = new Date(checkOut);
  if (isNaN(s) || isNaN(e) || e <= s) return checkIn && !checkOut ? 1 : 0;
  return Math.round((e - s) / 86400000);
}

// `usd` = use USD currency + US policy tables (international trips, or US-based domestic/local trips).
// Returns a NUMERIC tier per policy v2.0: India 1–3, US 1–4 (Tier 4 = every unlisted US location).
const hit = (list, c) => list.some((x) => c.indexOf(x) > -1);
export function cityTier(city, usd) {
  const c = String(city || '').toLowerCase();
  if (usd) {
    if (hit(POLICY.US_TIER_1, c)) return 1;
    if (hit(POLICY.US_TIER_2, c)) return 2;
    if (hit(POLICY.US_TIER_3, c)) return 3;
    return 4; // catch-all
  }
  if (hit(POLICY.INDIA_TIER_1, c)) return 1;
  if (hit(POLICY.INDIA_TIER_2, c)) return 2;
  return 3;
}

// Is this a US location named in any tier list? Used to infer USD region when country is absent.
export function isListedUsCity(city) {
  const c = String(city || '').toLowerCase();
  return hit(POLICY.US_TIER_1, c) || hit(POLICY.US_TIER_2, c) || hit(POLICY.US_TIER_3, c);
}

export function hotelCapFor(usd, tier) {
  return usd ? (POLICY.HOTEL.us[tier] || POLICY.HOTEL.us[4]) : (POLICY.HOTEL.india[tier] || POLICY.HOTEL.india[3]);
}

// Resolve a city's per-night hotel cap. Non-US INTERNATIONAL cities have no tier in the policy
// (§6.3 only defines US tiers) → they use HOTEL.intl_default instead of the US Tier-4 catch-all.
export function hotelCapForCity(usd, intl, city) {
  if (usd && intl && !isListedUsCity(city)) return POLICY.HOTEL.intl_default;
  return hotelCapFor(usd, cityTier(city, usd));
}

// Per-diem (§6.4 overseas, §7.4 India). Overseas is breakfast-based, not tier-based; budget uses
// the no-breakfast rate (the higher allowance). Actuals are claimed on bills post-trip.
export function mealPerDiem(usd, type) {
  if (usd) return POLICY.MEALS.overseas;
  if (type === 'domestic') return POLICY.MEALS.domestic;
  return POLICY.MEALS.local;
}

// Is this trip USD-region? International always; otherwise based on the destination country
// (US cities → USD). Lets a domestic/local trip be India (INR) OR United States (USD).
export function isUsRegion(p) {
  if (p.travelType === 'international') return true;
  const dest = String(p.destCountry || '').toLowerCase();
  if (dest) return dest.includes('united states') || dest === 'usa' || dest === 'us';
  // fallback: infer from destination city name against the US tier lists
  return isListedUsCity(p.to);
}

// Authoritative, server-side cost computation. Mirrors the client preview.
// Estimate the primary transport cost (round-trip) from the mode. Flight uses the
// live price when provided (opts.flightCost), else the policy estimate.
function transportEstimate(mode, usd, usDomestic) {
  if (usDomestic) return POLICY.ESTIMATES.FLIGHT.us_domestic; // flight within the US
  if (usd) return POLICY.ESTIMATES.FLIGHT.international; // USD region assumed flight
  const m = String(mode || '').toLowerCase();
  if (m.includes('flight')) return POLICY.ESTIMATES.FLIGHT.domestic;
  if (m.includes('train'))  return POLICY.ESTIMATES.TRANSPORT.train;
  if (m.includes('bus'))    return POLICY.ESTIMATES.TRANSPORT.bus;
  if (m.includes('cab'))    return POLICY.ESTIMATES.TRANSPORT.cab;
  if (m.includes('own'))    return POLICY.ESTIMATES.TRANSPORT.own;
  return POLICY.ESTIMATES.FLIGHT.domestic;
}

/**
 * Fully BACKEND cost computation (traveller enters no amounts). All figures come from
 * policy (hotel cap, meal per-diem) or estimates (flight/transport, local legs).
 * Currency & policy tables follow the destination region (India → INR, US → USD).
 * opts: { flightCost? (live override), advanceDays? (for short-notice break check) }
 */
export function computeCosts(p, dur, opts = {}) {
  const intl = p.travelType === 'international';
  const usd = isUsRegion(p);              // USD currency + US policy tables
  const usDomestic = usd && !intl;        // flight WITHIN the US (cheaper than international)
  const currency = usd ? 'USD' : 'INR';
  const tier = cityTier(p.to, usd);
  const { days, nights } = dur;
  const legs = p.tripType === 'round' ? 2 : 1;

  // Transport — live flight price if available, else estimate by mode.
  const baseTransport = (opts.flightCost != null && opts.flightCost !== '')
    ? num(opts.flightCost)
    : transportEstimate(p.transportMode, usd, usDomestic);
  // Extra flight legs (multi-city) — each estimated at the policy flight fare.
  const extraFlights = Array.isArray(opts.extraFlights) ? opts.extraFlights : [];
  const perExtraFlight = usDomestic ? POLICY.ESTIMATES.FLIGHT.us_domestic
    : (usd ? POLICY.ESTIMATES.FLIGHT.international : POLICY.ESTIMATES.FLIGHT.domestic);
  const extraFlightCost = extraFlights.length * perExtraFlight;
  const transport = baseTransport + extraFlightCost;

  // Local transport = airport transfers (home→airport + airport→dest) × legs
  //   PLUS daily local conveyance (km/day × days × per-km cab rate).
  const leg = usd ? POLICY.ESTIMATES.LOCAL_LEG.international : POLICY.ESTIMATES.LOCAL_LEG.domestic;
  const transfers = (leg.homeAirport + leg.airportDest) * legs;
  const conv = POLICY.ESTIMATES.LOCAL_CONVEYANCE;
  const convRate = usd ? conv.ratePerKm.international : conv.ratePerKm.domestic;
  const dailyConveyance = conv.kmPerDay * days * convRate;
  const local = transfers + dailyConveyance;

  // Primary hotel — explicit Yes/No from the form (falls back to "needed when overnight").
  // When provided, the hotel's own city sets the tier and check-in/out set the nights.
  const hotelExplicit = p.hotelNeeded === true || p.hotelNeeded === false || p.hotelNeeded === 'Yes' || p.hotelNeeded === 'No';
  const hotelWanted = hotelExplicit ? (p.hotelNeeded === true || p.hotelNeeded === 'Yes') : (nights > 0);
  let hotelN = nights;
  if (p.hotelCheckIn && p.hotelCheckOut) hotelN = Math.max(0, hotelNights(p.hotelCheckIn, p.hotelCheckOut));
  if (!hotelWanted) hotelN = 0;
  const hotelPerNight = hotelN > 0 ? ((opts.hotelRate != null && opts.hotelRate !== '') ? num(opts.hotelRate) : hotelCapForCity(usd, intl, p.hotelCity || p.to)) : 0;
  const baseHotel     = hotelPerNight * hotelN;
  // Extra hotel stays (multi-city) — each at its city's cap × nights between check-in/out.
  const extraHotels = Array.isArray(opts.extraHotels) ? opts.extraHotels : [];
  let extraHotelCost = 0, extraHotelNights = 0;
  for (const h of extraHotels) {
    const nn = Math.max(0, hotelNights(h.checkIn, h.checkOut));
    extraHotelNights += nn;
    extraHotelCost += hotelCapForCity(usd, intl, h.city) * nn;
  }
  const hotel         = baseHotel + extraHotelCost;
  const mealsPerDay   = mealPerDiem(usd, p.travelType);
  const meals         = mealsPerDay * days;

  // Foreign currency (forex) — international + traveller opts in. Auto USD 125/day; included in total.
  const forex = (intl && p.forexNeeded) ? POLICY.FOREX_PER_DAY.international * days : 0;

  // ---- Additional allowances / one-off costs (USD) ----
  const X = POLICY.EXTRAS;
  const hotelCount = (hotelN > 0 ? 1 : 0) + extraHotels.length;
  const extras = {};
  if (intl) {
    if (p.visaNeeded) extras.visa = (X.VISA_FEE_BY_COUNTRY && X.VISA_FEE_BY_COUNTRY[String(p.destCountry || '')]) || X.VISA_FEE; // no valid visa → fee by destination
    extras.insurance = X.INSURANCE_PER_DAY * days;        // travel/medical insurance
    extras.phone = X.PHONE_PER_DAY * days;                // phone/communication
    if (days > 10) extras.laundry = Math.ceil(days / 10) * X.LAUNDRY_PER_BLOCK; // §6.6
  }
  if (usDomestic) extras.baggage = X.BAGGAGE_PER_LEG * legs; // checked-bag fee (US domestic)
  const other = Object.values(extras).reduce((a, b) => a + b, 0);

  // ---- ADVANCES (not trip expenses) ----
  // Hotel security deposit (refundable) — international, per hotel. An advance, kept out of the total.
  const deposit = (intl && hotelCount > 0) ? X.SECURITY_DEPOSIT * hotelCount : 0;
  // Forex/tour advance is also a refundable company advance — both kept out of the expense total.
  const total = transport + local + hotel + meals + other;

  // ---- Policy break determination ----
  // Per Policy v2.0 §4.1, ONLY an advance-notice (short-notice) deviation routes to Finance.
  // The flight/total caps are BUDGET references shown to approvers — exceeding them is NOT a
  // policy breach (it sets `overBudget` for guidance only, never `broken`).
  const flightCap = usDomestic ? POLICY.CAPS.FLIGHT.us_domestic
    : (usd ? POLICY.CAPS.FLIGHT.international : POLICY.CAPS.FLIGHT.domestic);
  const totalCap  = usd ? POLICY.CAPS.TOTAL.international  : POLICY.CAPS.TOTAL.domestic;
  const overBudget = transport > flightCap || total > totalCap; // budget guidance only
  const reasons = [];
  if (opts.advanceDays != null) {
    const need = intl ? POLICY.NOTICE_DAYS.international : (p.travelType === 'domestic' ? POLICY.NOTICE_DAYS.domestic : 0);
    if (need && opts.advanceDays < need) reasons.push(`Short notice — ${opts.advanceDays}d (needs ${need}d)`);
  }
  const broken = reasons.length > 0;
  const flag = broken ? ('POLICY BREAK: ' + reasons.join('; ')) : 'Within policy';

  // Group travel: scale every amount by the passenger count. Per-unit rates (hotel/meal/day)
  // stay per-person for display; break-checks above used per-person amounts (caps are per traveller).
  const pax = Math.max(1, parseInt(opts.passengers, 10) || 1);
  const exPax = {}; for (const k in extras) exPax[k] = extras[k] * pax;
  return {
    currency, tier, hotelPerNight, mealsPerDay, days, nights, hotelNights: hotelN, hotelReq: hotelWanted, pax, broken, flag, overBudget,
    transport: transport * pax, local: local * pax, hotel: hotel * pax, meals: meals * pax,
    other: other * pax, extras: exPax, forex: forex * pax, deposit: deposit * pax, total: total * pax,
  };
}
