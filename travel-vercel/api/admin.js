import { adminData, setAdminStatus, saveTicket, saveBookings, sendToForex, recallRequest, sendBackForAmendment } from '../lib/workflow.js';
import { requireRole, baseUrl } from '../lib/auth.js';
import { applyRoleOverrides } from '../lib/rolesstore.js';

export default async function handler(req, res) {
  await applyRoleOverrides();
  const s = requireRole(req, res, 'admin'); if (!s) return;
  try {
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!b.id) throw new Error('id is required');
      if (b.action === 'ticket') { res.status(200).json(await saveTicket(b.id, b.ticketInfo, b.ticketDoc)); return; }
      if (b.action === 'bookings') { res.status(200).json(await saveBookings(b.id, b.bookings)); return; }
      if (b.action === 'tofx') { res.status(200).json(await sendToForex(b.id, s.email, s.roles, baseUrl(req))); return; }
      if (b.action === 'recall') { res.status(200).json(await recallRequest({ id: b.id, email: s.email, roles: s.roles }, baseUrl(req))); return; }
      if (b.action === 'amend-back') { res.status(200).json(await sendBackForAmendment({ id: b.id, comment: b.comment, email: s.email, roles: s.roles }, baseUrl(req))); return; }
      if (!b.status) throw new Error('status is required');
      res.status(200).json(await setAdminStatus(b.id, b.status, baseUrl(req)));
      return;
    }
    res.status(200).json(await adminData());
  } catch (err) {
    console.error('admin error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
