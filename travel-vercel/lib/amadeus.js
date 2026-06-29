// ---------------------------------------------------------------------------
//  Flight pricing via Amadeus for Developers (Self-Service).
//  Env: AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET (required),
//       AMADEUS_HOST (default test.api.amadeus.com — switch to api.amadeus.com for production).
//  OAuth2 client-credentials; token cached in-memory. Graceful: callers fall back to estimate.
// ---------------------------------------------------------------------------

const HOST = () => process.env.AMADEUS_HOST || 'test.api.amadeus.com';

export function amadeusAvailable() {
  return !!(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET);
}

let _tok = null; // { v: accessToken, exp: epoch-ms }
async function token() {
  if (_tok && _tok.exp > Date.now()) return _tok.v;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.AMADEUS_CLIENT_ID,
    client_secret: process.env.AMADEUS_CLIENT_SECRET,
  });
  const r = await fetch(`https://${HOST()}/v1/security/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error('Amadeus auth ' + r.status + ' ' + await r.text().then((t) => t.slice(0, 140)).catch(() => ''));
  const j = await r.json();
  _tok = { v: j.access_token, exp: Date.now() + ((j.expires_in || 1799) * 1000) - 60000 };
  return _tok.v;
}

// Cheapest fare (grand total, rounded) for the route in `currency`, or null. Uses IATA codes.
export async function flightPrice({ originCode, destCode, date, returnDate, currency = 'USD', travelClass = 'ECONOMY', adults = 1 }) {
  if (!originCode || !destCode || !date) return null;
  const t = await token();
  let url = `https://${HOST()}/v2/shopping/flight-offers?originLocationCode=${encodeURIComponent(originCode)}` +
    `&destinationLocationCode=${encodeURIComponent(destCode)}&departureDate=${encodeURIComponent(date)}` +
    `&adults=${adults}&travelClass=${travelClass}&currencyCode=${encodeURIComponent(currency)}&max=10`;
  if (returnDate) url += `&returnDate=${encodeURIComponent(returnDate)}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
  if (!r.ok) throw new Error('Amadeus flight ' + r.status + ' ' + await r.text().then((x) => x.slice(0, 160)).catch(() => ''));
  const j = await r.json();
  const offers = j.data || [];
  let min = Infinity;
  for (const o of offers) { const g = parseFloat(o.price && o.price.grandTotal); if (!isNaN(g) && g < min) min = g; }
  return min === Infinity ? null : Math.round(min);
}

// Representative (median) nightly hotel rate for a city, or null. cityCode = IATA city code (e.g. NYC, DEL).
export async function hotelNightlyRate({ cityCode, checkIn, checkOut, currency = 'USD', nights = 1 }) {
  if (!cityCode || !checkIn || !checkOut) return null;
  const t = await token();
  // 1) hotels in the city
  const lr = await fetch(`https://${HOST()}/v1/reference-data/locations/hotels/by-city?cityCode=${encodeURIComponent(cityCode)}`, { headers: { Authorization: 'Bearer ' + t } });
  if (!lr.ok) throw new Error('Amadeus hotel-list ' + lr.status);
  const ids = ((await lr.json()).data || []).map((h) => h.hotelId).filter(Boolean).slice(0, 25);
  if (!ids.length) return null;
  // 2) cheapest available offer per hotel for the stay
  const or = await fetch(`https://${HOST()}/v3/shopping/hotel-offers?hotelIds=${ids.join(',')}&checkInDate=${checkIn}&checkOutDate=${checkOut}&adults=1&roomQuantity=1&currency=${encodeURIComponent(currency)}&bestRateOnly=true`, { headers: { Authorization: 'Bearer ' + t } });
  if (!or.ok) throw new Error('Amadeus hotel-offers ' + or.status);
  const data = (await or.json()).data || [];
  const nn = Math.max(1, nights || 1);
  const rates = [];
  for (const h of data) { const off = (h.offers || [])[0]; const total = off && parseFloat(off.price && off.price.total); if (!isNaN(total)) rates.push(total / nn); }
  if (!rates.length) return null;
  rates.sort((a, b) => a - b);
  return Math.round(rates[Math.floor(rates.length / 2)]); // median nightly rate
}
