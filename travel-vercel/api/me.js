import { getSession, baseUrl } from '../lib/auth.js';
import { myData, editRequest, withdrawRequest, saveActuals, saveFlightDoc, saveForexCardDoc, notifications } from '../lib/workflow.js';
import { kekaEmployeeByEmail } from '../lib/keka.js';
import { searchFlights, pickOptions, flightsAvailable } from '../lib/flights.js';
import { applyRoleOverrides } from '../lib/rolesstore.js';

export default async function handler(req, res) {
  await applyRoleOverrides(); // re-derive the caller's roles from current assignments
  const s = getSession(req);
  if (!s) { res.status(200).json({ authenticated: false }); return; }

  // Requester self-service actions on their own request: withdraw / edit.
  if (req.method === 'POST') {
    try {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!b.id) throw new Error('id is required');
      if (b.action === 'cancel') { res.status(200).json(await withdrawRequest(b.id, s.email)); return; }
      if (b.action === 'edit')   { res.status(200).json(await editRequest(b.id, b.payload || {}, s.email, baseUrl(req))); return; }
      if (b.action === 'actuals') { res.status(200).json(await saveActuals(b.id, s.email, b.actuals || {})); return; }
      if (b.action === 'flightdoc') { res.status(200).json(await saveFlightDoc(b.id, s.email, b.doc, b.notes)); return; }
      if (b.action === 'forexcard') { res.status(200).json(await saveForexCardDoc(b.id, s.email, b.doc)); return; }
      throw new Error('Unknown action');
    } catch (err) {
      console.error('me action error:', err);
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
    return;
  }

  // ?counts=1 → tab-badge counts + notification list (🔔 bell) for this user. Best-effort.
  if (req.query && req.query.counts) {
    try { res.status(200).json(await notifications({ email: s.email, roles: s.roles || [] })); }
    catch (err) { console.error('notifications error:', err); res.status(200).json({ approvals: 0, department: 0, finance: 0, admin: 0, forex: 0, items: [] }); }
    return;
  }

  // ?keka=<email> → resolve employee Name + Employee Number from Keka HRMS (form auto-fill).
  if (req.query && req.query.keka) {
    try { res.status(200).json(await kekaEmployeeByEmail(req.query.keka)); }
    catch (err) { console.error('keka lookup error:', err); res.status(200).json({ available: true, ok: false, error: String(err.message || err) }); }
    return;
  }

  // ?flights → live flight options (cheapest / fastest / non-stop + more) for a route + dates.
  // Used by the request form (traveller) and the Admin booking screen. Needs RAPIDAPI_KEY.
  if (req.query && req.query.flights) {
    const q = req.query;
    try {
      if (!flightsAvailable()) { res.status(200).json({ ok: true, configured: false }); return; }
      if (!q.from || !q.to || !q.date) { res.status(200).json({ ok: false, configured: true, error: 'Need origin, destination and date.' }); return; }
      const currency = (q.cur === 'USD') ? 'USD' : 'INR';
      const its = await searchFlights({ from: q.from, to: q.to, date: q.date, returnDate: q.ret || undefined, currency, cabinClass: 'economy' });
      const intl = String(q.intl) === '1';
      const options = pickOptions(its || [], intl);
      const more = [...(its || [])].sort((a, b) => a.price - b.price).slice(0, 8);
      res.status(200).json({ ok: true, configured: true, currency, count: (its || []).length, options, more });
    } catch (err) { console.error('flight search error:', err); res.status(200).json({ ok: false, configured: true, error: String(err.message || err) }); }
    return;
  }

  // ?mine=1 → the signed-in user's own travel requests + where each one is in the flow.
  if (req.query && req.query.mine) {
    try { res.status(200).json(await myData(s.email)); }
    catch (err) { console.error('myData error:', err); res.status(500).json({ ok: false, error: String(err.message || err) }); }
    return;
  }
  res.status(200).json({ authenticated: true, email: s.email, name: s.name || '', roles: s.roles || ['requester'] });
}
