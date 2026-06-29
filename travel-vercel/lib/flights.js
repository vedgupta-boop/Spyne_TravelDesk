// ---------------------------------------------------------------------------
//  Flight pricing via RapidAPI "Sky-Scrapper" (apiheya) — Skyscanner data.
//  Env: RAPIDAPI_KEY (required), RAPIDAPI_HOST (default sky-scrapper.p.rapidapi.com)
//  Graceful: if no key / no results / error, callers fall back to manual entry.
// ---------------------------------------------------------------------------

const HOST = () => process.env.RAPIDAPI_HOST || 'sky-scrapper.p.rapidapi.com';

export function flightsAvailable() { return !!process.env.RAPIDAPI_KEY; }

async function rapid(path) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) throw new Error('RAPIDAPI_KEY not set');
  const res = await fetch(`https://${HOST()}${path}`, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': HOST() },
  });
  if (!res.ok) throw new Error(`RapidAPI ${res.status} ${await res.text().then(t => t.slice(0, 120)).catch(() => '')}`);
  return res.json();
}

// Resolve a city/airport name -> { skyId, entityId }. Cached to conserve API quota.
const _airportCache = new Map();
async function resolveAirport(query) {
  const k = String(query || '').trim().toLowerCase();
  if (_airportCache.has(k)) return _airportCache.get(k);
  const j = await rapid(`/api/v1/flights/searchAirport?query=${encodeURIComponent(query)}&locale=en-US`);
  const list = j.data || [];
  const pick = list.find((x) => x?.navigation?.relevantFlightParams?.skyId) || list[0];
  if (!pick) return null;
  const p = pick.navigation?.relevantFlightParams || {};
  const out = { skyId: p.skyId || pick.skyId, entityId: p.entityId || pick.entityId, name: pick.presentation?.title || query };
  _airportCache.set(k, out);
  return out;
}

// Search and normalize itineraries -> [{ price, priceText, durationMin, stops, carrier }]
export async function searchFlights({ from, to, date, returnDate, currency, cabinClass = 'economy' }) {
  const o = await resolveAirport(from);
  const d = await resolveAirport(to);
  if (!o || !d) throw new Error(`Could not resolve airports for "${from}" / "${to}"`);

  let path = `/api/v2/flights/searchFlights?originSkyId=${encodeURIComponent(o.skyId)}&destinationSkyId=${encodeURIComponent(d.skyId)}` +
    `&originEntityId=${encodeURIComponent(o.entityId)}&destinationEntityId=${encodeURIComponent(d.entityId)}` +
    `&date=${encodeURIComponent(date)}&cabinClass=${cabinClass}&adults=1&sortBy=best&currency=${currency}&market=en-US&countryCode=IN`;
  if (returnDate) path += `&returnDate=${encodeURIComponent(returnDate)}`;

  // Sky-Scrapper aggregates results asynchronously (context.status "incomplete"),
  // so a single call can return an empty/partial set. Retry until we get itineraries.
  let its = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const j = await rapid(path);
    its = (j.data && j.data.itineraries) || [];
    if (its.length) break;
    if (attempt < 1) await new Promise((r) => setTimeout(r, 1500));
  }

  return its.map((it) => {
    const legs = it.legs || [];
    const durationMin = legs.reduce((s, l) => s + (l.durationInMinutes || 0), 0);
    const stops = legs.length ? Math.max(...legs.map((l) => l.stopCount || 0)) : 0;
    const carrier = (legs[0]?.carriers?.marketing?.[0]?.name) || '';
    const price = (it.price && (it.price.raw ?? it.price.amount)) ?? null;
    const depart = (legs[0] && legs[0].departure) || '';
    const arrive = (legs.length && legs[legs.length - 1] && legs[legs.length - 1].arrival) || '';
    return { price: price != null ? Math.round(price) : null, priceText: it.price?.formatted || '', durationMin, stops, carrier, depart, arrive };
  }).filter((x) => x.price != null);
}

// Pick the policy combinations: domestic = cheapest + fastest; international = + non-stop/1-stop.
export function pickOptions(parsed, intl) {
  if (!parsed.length) return [];
  const byPrice = [...parsed].sort((a, b) => a.price - b.price);
  const byTime = [...parsed].sort((a, b) => a.durationMin - b.durationMin);
  const seen = new Set();
  const add = (kind, x, out) => { if (!x) return; const k = x.price + ':' + x.durationMin; if (seen.has(k)) return; seen.add(k); out.push({ kind, ...x }); };
  const out = [];
  add('Cheapest', byPrice[0], out);
  add('Fastest', byTime[0], out);
  if (intl) {
    const direct = byPrice.find((x) => x.stops === 0);
    add('Non-stop', direct, out);
    if (!direct) add('1-stop', byPrice.find((x) => x.stops <= 1), out);
  }
  return out;
}
