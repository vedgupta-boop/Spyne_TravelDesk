import { submitRequest } from '../lib/workflow.js';
import { baseUrl, requireRole } from '../lib/auth.js';
import { applyRoleOverrides } from '../lib/rolesstore.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  await applyRoleOverrides(); // route to the currently-assigned HOD/CEO/etc.
  const session = requireRole(req, res, 'requester');
  if (!session) return;
  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    // The signed-in user is always the one who FILED the request (trusted, not client input).
    payload.requestedBy = session.email;
    // Self-booking: the traveller IS the signed-in user. Booking for someone else: keep the
    // traveller's email from the form so the record belongs to the actual traveller.
    if (payload.bookingFor !== 'other') payload.email = session.email;
    const result = await submitRequest(payload, baseUrl(req));
    res.status(200).json(result);
  } catch (err) {
    console.error('submit error:', err);
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
}
