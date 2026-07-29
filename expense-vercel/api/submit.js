import { submitRequest } from '../lib/workflow.js';
import { baseUrl, requireRole } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  const session = requireRole(req, res, 'requester');
  if (!session) return;
  try {
    try { const { applyRoleOverrides } = await import('../lib/rolesstore.js'); await applyRoleOverrides(); } catch (e) { /* defaults */ }
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    payload.email = session.email; // trust the signed-in identity, not client input
    const result = await submitRequest(payload, baseUrl(req));
    res.status(200).json(result);
  } catch (err) {
    console.error('submit error:', err);
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
}
