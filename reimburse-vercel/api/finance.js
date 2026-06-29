import { financeData, recordPayout } from '../lib/workflow.js';
import { requireRole, baseUrl } from '../lib/auth.js';

export default async function handler(req, res) {
  // Finance records a payout once a claim is fully approved.
  if (req.method === 'POST') {
    const s = requireRole(req, res, 'finance'); if (!s) return;
    try {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.action === 'pay') {
        res.status(200).json(await recordPayout({ id: b.id, payRef: b.payRef, paidAmount: b.paidAmount, email: s.email }, baseUrl(req)));
        return;
      }
      res.status(400).json({ ok: false, error: 'Unknown action' });
    } catch (err) {
      console.error('finance action error:', err);
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
    return;
  }
  // GET → master tracker data.
  if (!requireRole(req, res, 'finance')) return;
  try {
    res.status(200).json(await financeData());
  } catch (err) {
    console.error('finance error:', err);
    res.status(500).json({ error: String(err.message || err), currencySummaries: {}, rows: [] });
  }
}
