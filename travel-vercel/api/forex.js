import { requireRole, getSession, baseUrl } from '../lib/auth.js';
import { forexData, saveForexConfirm, completeForex, saveForexTopup, recallRequest } from '../lib/workflow.js';
import { findById } from '../lib/sheets.js';
import { buildForexLetter, forexLetterFilename } from '../lib/forexletter.js';
import { applyRoleOverrides } from '../lib/rolesstore.js';

export default async function handler(req, res) {
  await applyRoleOverrides();
  // Letter download (GET ?download=letter&id=) — allowed for forex / finance / admin.
  if (req.method === 'GET' && (req.query || {}).download === 'letter') {
    const s = getSession(req);
    const roles = (s && s.roles) || [];
    if (!s) { res.status(401).json({ ok: false, error: 'Not signed in' }); return; }
    if (!roles.includes('forex') && !roles.includes('finance') && !roles.includes('admin')) {
      res.status(403).json({ ok: false, error: 'Forbidden' }); return;
    }
    try {
      const rec = await findById((req.query || {}).id);
      if (!rec) throw new Error('Request not found');
      const amtQ = (req.query || {}).amount;
      const opts = (amtQ != null && amtQ !== '' && Number(amtQ) > 0) ? { amount: Number(amtQ) } : {};
      const buf = await buildForexLetter(rec, opts);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${forexLetterFilename(rec, opts)}"`);
      res.status(200).send(buf);
    } catch (err) { console.error('forex letter error:', err); res.status(500).json({ ok: false, error: String(err.message || err) }); }
    return;
  }

  // List + actions — forex officer only.
  if (!requireRole(req, res, 'forex')) return;
  try {
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!b.id) throw new Error('id is required');
      if (b.action === 'confirm') { res.status(200).json(await saveForexConfirm(b.id, b.confirmDoc)); return; }
      if (b.action === 'topup') { const s = getSession(req); res.status(200).json(await saveForexTopup(b.id, b.amount, b.note, s && s.email)); return; }
      if (b.action === 'complete') { res.status(200).json(await completeForex(b.id, baseUrl(req))); return; }
      if (b.action === 'recall') { const s = getSession(req); res.status(200).json(await recallRequest({ id: b.id, email: s && s.email, roles: (s && s.roles) || [] }, baseUrl(req))); return; }
      throw new Error('unknown action');
    }
    res.status(200).json(await forexData());
  } catch (err) {
    console.error('forex api error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
