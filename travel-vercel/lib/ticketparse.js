// ---------------------------------------------------------------------------
//  Flight-ticket extraction via the Claude API (raw fetch, no SDK).
//  Given an uploaded ticket (PDF or image, base64), pulls structured fields
//  (airline, flight no., PNR, dates, passenger, route) using a FORCED tool call
//  so the response is always valid JSON. Best-effort: if ANTHROPIC_API_KEY is
//  unset or the call fails, returns {available:false|ok:false} and the admin
//  fills the booking fields manually as before.
//  Env: ANTHROPIC_API_KEY.
// ---------------------------------------------------------------------------

const MODEL = 'claude-opus-4-8'; // latest model

const TOOL = {
  name: 'extract_ticket',
  description: 'Record the structured details read from a flight ticket / e-ticket / airline itinerary.',
  input_schema: {
    type: 'object',
    properties: {
      airline: { type: 'string', description: 'Operating airline name, e.g. "Air India", "Emirates". Empty string if not present.' },
      flightNumber: { type: 'string', description: 'Flight number(s), e.g. "AI-101". If multiple legs, comma-separate. Empty if not present.' },
      pnr: { type: 'string', description: 'Booking reference / PNR / confirmation code. Empty if not present.' },
      passengerName: { type: 'string', description: 'Primary passenger full name. Empty if not present.' },
      departDate: { type: 'string', description: 'Outbound travel date formatted DD-MM-YYYY when determinable, else as printed. Empty if not present.' },
      returnDate: { type: 'string', description: 'Return travel date (round trip) formatted DD-MM-YYYY, else empty string.' },
      from: { type: 'string', description: 'Origin city or airport. Empty if not present.' },
      to: { type: 'string', description: 'Destination city or airport. Empty if not present.' },
      totalFare: { type: 'string', description: 'Total fare / amount paid as a plain number (no currency symbol or commas), e.g. "24500". Empty string if not present.' },
      currency: { type: 'string', description: 'Fare currency code, e.g. "INR" or "USD". Empty if not present.' },
    },
    required: ['airline', 'flightNumber', 'pnr', 'passengerName', 'departDate', 'returnDate', 'from', 'to', 'totalFare', 'currency'],
    additionalProperties: false,
  },
};

function imageMediaType(mt) {
  mt = String(mt || '').toLowerCase();
  if (mt.includes('png')) return 'image/png';
  if (mt.includes('webp')) return 'image/webp';
  if (mt.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}

// { available, ok, fields:{airline,flightNumber,pnr,passengerName,departDate,returnDate,from,to} }
export async function parseTicket({ base64, mimeType }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !base64) return { available: false };
  const mt = String(mimeType || '').toLowerCase();
  const block = mt.includes('pdf')
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: imageMediaType(mt), data: base64 } };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'extract_ticket' }, // force the tool → guaranteed JSON
        messages: [{
          role: 'user',
          content: [
            block,
            { type: 'text', text: 'Read this flight ticket and record its details with the extract_ticket tool. If there are multiple flights, comma-separate the flight numbers and use the first departure as departDate. Use empty strings for any field not present on the ticket.' },
          ],
        }],
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('ticketparse API error', r.status, t.slice(0, 200));
      return { available: true, ok: false, error: 'parse failed (' + r.status + ')' };
    }
    const j = await r.json();
    const tu = (j.content || []).find((b) => b.type === 'tool_use');
    if (!tu || !tu.input) return { available: true, ok: false, error: 'no extraction returned' };
    return { available: true, ok: true, fields: tu.input };
  } catch (e) {
    console.error('ticketparse threw', e.message);
    return { available: true, ok: false, error: String(e.message || e) };
  }
}
