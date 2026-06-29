import { financeData } from '../lib/workflow.js';
import { requireRole } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!requireRole(req, res, 'finance')) return;
  try {
    const data = await financeData();
    res.status(200).json(data);
  } catch (err) {
    console.error('finance error:', err);
    res.status(500).json({ error: String(err.message || err), currencySummaries: {}, rows: [] });
  }
}
