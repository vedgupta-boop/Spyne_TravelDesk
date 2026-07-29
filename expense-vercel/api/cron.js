import { sendReminders, sendWeeklyDigest } from '../lib/workflow.js';
import { baseUrl } from '../lib/auth.js';
import { applyRoleOverrides } from '../lib/rolesstore.js';
import { applyDelegations } from '../lib/delegationstore.js';

// Scheduled (Vercel Cron) endpoint. Runs daily; sends 24h approval reminders every day and, on
// Mondays, also sends the weekly digest (per-approver pending summary + Finance overview).
// Secured by CRON_SECRET: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`; a manual
// trigger may pass ?key=<CRON_SECRET>. Optional ?task=digest|reminders|both forces a specific job.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const key = (req.query && req.query.key) || '';
  if (!secret || !(auth === `Bearer ${secret}` || key === secret)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  try {
    try { await applyRoleOverrides(); } catch (e) { /* defaults */ }
    try { await applyDelegations(); } catch (e) { /* none */ }
    const base = process.env.APP_BASE_URL || baseUrl(req);
    const task = String((req.query && req.query.task) || 'auto');
    // Monday = 1. Vercel Cron runs in UTC; treat any Monday (UTC) as digest day.
    const isMonday = new Date().getUTCDay() === 1;
    const out = {};
    if (task === 'reminders' || task === 'both' || task === 'auto') {
      out.reminders = await sendReminders(base);
    }
    if (task === 'digest' || task === 'both' || (task === 'auto' && isMonday)) {
      out.digest = await sendWeeklyDigest(base);
    }
    res.status(200).json({ ok: true, ran: Object.keys(out), ...out });
  } catch (err) {
    console.error('cron error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
