import { sendReminders } from '../lib/workflow.js';
import { baseUrl } from '../lib/auth.js';

// Scheduled (Vercel Cron) endpoint that emails 24h reminders to pending approvers.
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
    const result = await sendReminders(process.env.APP_BASE_URL || baseUrl(req));
    res.status(200).json(result);
  } catch (err) {
    console.error('cron reminders error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
