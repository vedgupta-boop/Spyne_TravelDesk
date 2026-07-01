import { sendReminders, sendWeeklyDigest } from '../lib/workflow.js';
import { baseUrl } from '../lib/auth.js';
import { applyRoleOverrides } from '../lib/rolesstore.js';

// Scheduled (Vercel Cron) endpoint that emails 24h reminders to pending approvers/owners.
// Secured by CRON_SECRET: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`; a manual
// trigger may pass ?key=<CRON_SECRET>. Refuses to run if no secret is configured.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const key = (req.query && req.query.key) || '';
  if (!secret || !(auth === `Bearer ${secret}` || key === secret)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  try {
    await applyRoleOverrides(); // remind the currently-assigned approvers
    const base = process.env.APP_BASE_URL || baseUrl(req);
    const result = await sendReminders(base);
    // Weekly leadership digest — once a week (Mondays), or on-demand via ?digest=1.
    let digest = null;
    if (new Date().getUTCDay() === 1 || (req.query && req.query.digest)) {
      try { digest = await sendWeeklyDigest(base); } catch (e) { console.error('weekly digest error:', e); digest = { ok: false, error: String(e.message || e) }; }
    }
    res.status(200).json({ ...result, digest });
  } catch (err) {
    console.error('cron reminders error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
