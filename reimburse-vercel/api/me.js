import { getSession } from '../lib/auth.js';
import { myData } from '../lib/workflow.js';
import { kekaEmployeeByEmail } from '../lib/keka.js';

export default async function handler(req, res) {
  const s = getSession(req);
  if (!s) { res.status(200).json({ authenticated: false }); return; }
  // ?mine=1 → the signed-in user's own reimbursement claims + where each one is in the flow.
  if (req.query && req.query.mine) {
    try { res.status(200).json(await myData(s.email)); }
    catch (err) { console.error('myData error:', err); res.status(500).json({ ok: false, error: String(err.message || err) }); }
    return;
  }
  // ?keka=<email> → look up Name + Employee Number from Keka HRMS to auto-fill the form.
  if (req.query && req.query.keka) {
    try { res.status(200).json(await kekaEmployeeByEmail(req.query.keka === '1' ? s.email : String(req.query.keka))); }
    catch (err) { console.error('keka error:', err); res.status(200).json({ available: false }); }
    return;
  }
  res.status(200).json({ authenticated: true, email: s.email, name: s.name || '', roles: s.roles || ['requester'] });
}
