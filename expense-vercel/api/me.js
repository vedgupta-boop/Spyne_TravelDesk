import { getSession } from '../lib/auth.js';
import { myData, vendorDirectory } from '../lib/workflow.js';
import { rolesFor, delegatePrincipals } from '../lib/config.js';

export default async function handler(req, res) {
  const s = getSession(req);
  if (!s) { res.status(200).json({ authenticated: false }); return; }
  // ?mine=1 → the signed-in user's own expense requests + where each one is in the flow.
  if (req.query && req.query.mine) {
    try { res.status(200).json(await myData(s.email)); }
    catch (err) { console.error('myData error:', err); res.status(500).json({ ok: false, error: String(err.message || err) }); }
    return;
  }
  // ?vendors=1 → known vendors + last-seen GST/phone/email for the form's vendor auto-fill.
  if (req.query && req.query.vendors) {
    try { res.status(200).json({ vendors: await vendorDirectory() }); }
    catch (err) { console.error('vendorDirectory error:', err); res.status(200).json({ vendors: [] }); }
    return;
  }
  // Effective roles = session roles + any approval authority granted via an active delegation.
  let roles = (s.roles || ['requester']).slice();
  let delegatedFor = [];
  try {
    const { applyRoleOverrides } = await import('../lib/rolesstore.js'); await applyRoleOverrides();
    const { applyDelegations } = await import('../lib/delegationstore.js'); await applyDelegations();
    const principals = delegatePrincipals(s.email);
    principals.forEach((p) => {
      delegatedFor.push(p);
      rolesFor(p).forEach((r) => { if (r !== 'requester' && !roles.includes(r)) roles.push(r); });
    });
  } catch (e) { /* delegations unavailable → base roles only */ }
  res.status(200).json({ authenticated: true, email: s.email, name: s.name || '', roles, delegatedFor });
}
