import { financeData, closeTrip, scrapRequests, currencyAudit, recomputeCurrencyFixes } from '../lib/workflow.js';
import { recordPolicyChange } from '../lib/policystore.js';
import { addPolicyVersion, deletePolicyVersion } from '../lib/policyversionsstore.js';
import { readEmailLog } from '../lib/emaillogstore.js';
import { requireRole, baseUrl } from '../lib/auth.js';
import { listUsers, setUserStatus, inviteUser, createReset } from '../lib/userstore.js';
import { remindersEnabled, setRemindersEnabled, reminderHour, setReminderHour } from '../lib/settingsstore.js';
import { applyRoleOverrides, setRole, rolesView } from '../lib/rolesstore.js';
import { ROLE_KINDS } from '../lib/config.js';
import { sendEmail } from '../lib/email.js';

function resetLink(req, email, token) {
  return baseUrl(req) + '/reset.html?email=' + encodeURIComponent(email) + '&token=' + encodeURIComponent(token);
}

export default async function handler(req, res) {
  await applyRoleOverrides(); // refresh role assignments before the role check + any routing
  const session = requireRole(req, res, 'finance');
  if (!session) return;
  try {
    // Finance edits a single policy value (audit-logged, forward-only).
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.action === 'policy') {
        res.status(200).json(await recordPolicyChange({ by: session.email, path: b.path, value: b.value }));
        return;
      }
      if (b.action === 'close') {
        res.status(200).json(await closeTrip(b.id, b.reimburse, session.email));
        return;
      }
      // Finance publishes a new policy document version (version + effective date + note + PDF link).
      if (b.action === 'policyVersion') {
        res.status(200).json(await addPolicyVersion({ version: b.version, effective: b.effective, file: b.file, summary: b.summary, by: session.email }));
        return;
      }
      if (b.action === 'policyVersion-delete') {
        res.status(200).json(await deletePolicyVersion(b.version, session.email));
        return;
      }
      // Finance recomputes + re-pushes trips priced in the wrong currency (INR vs USD).
      if (b.action === 'recompute-currency') {
        res.status(200).json(await recomputeCurrencyFixes(baseUrl(req), session.roles, b.ids));
        return;
      }
      // Finance bulk-scrap test/junk requests by ID (soft-delete; hidden from all dashboards).
      if (b.action === 'scrap') {
        res.status(200).json(await scrapRequests(b.ids, session.roles));
        return;
      }
      // Finance (re)assigns a role. key: ceo | finance | admin | forex | dept:<DeptName>.
      // value: comma-separated emails (ceo/dept = single). Takes effect immediately (no redeploy).
      if (b.action === 'role') {
        const key = String(b.key || '');
        const okKey = ROLE_KINDS.includes(key) || key.indexOf('dept:') === 0;
        if (!okKey) { res.status(200).json({ ok: false, error: 'Unknown role key.' }); return; }
        const emails = String(b.value || '').split(',').map((s) => s.trim()).filter(Boolean);
        const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
        if (bad) { res.status(200).json({ ok: false, error: 'Invalid email: ' + bad }); return; }
        const r = await setRole(key, emails.join(','), session.email);
        const view = await rolesView();
        res.status(200).json({ ok: r.ok, key, ...view });
        return;
      }
      // Finance controls the email-reminder switch + send time (stored in the sheet, no redeploy).
      if (b.action === 'reminders') {
        if (typeof b.on !== 'undefined') await setRemindersEnabled(!!b.on, session.email);
        if (typeof b.hour !== 'undefined' && b.hour !== null && b.hour !== '') await setReminderHour(b.hour, session.email);
        res.status(200).json({ ok: true, remindersOn: await remindersEnabled(), reminderHour: await reminderHour() });
        return;
      }
      // ---- admin user-management (finance = superuser) ----
      if (b.action === 'user-status') {
        res.status(200).json(await setUserStatus(b.email, !!b.active));
        return;
      }
      if (b.action === 'user-invite') {
        const r = await inviteUser({ email: b.email, name: b.name });
        if (r.ok && r.token) {
          const link = resetLink(req, r.email, r.token);
          try { await sendEmail({ to: r.email, subject: 'You’ve been added to Spyne TravelDesk — set your password', html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:auto;"><h2 style="color:#0D1B2A;">Welcome to Spyne TravelDesk</h2><p style="color:#3D506A;line-height:1.5;">An administrator created an account for you. Set your password to get started (link valid 1 hour):</p><p style="margin:22px 0;"><a href="' + link + '" style="background:#E8232A;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:800;">Set your password</a></p><p style="color:#8A97AA;font-size:12px;word-break:break-all;">Or paste: ' + link + '</p></div>' }); } catch (e) { console.error('invite email:', e); }
          res.status(200).json({ ok: true, email: r.email, link }); // link returned so admin can relay it
          return;
        }
        res.status(200).json(r);
        return;
      }
      if (b.action === 'user-reset') {
        const r = await createReset(b.email);
        if (!r.ok) { res.status(200).json({ ok: false, error: 'User not found or disabled.' }); return; }
        const link = resetLink(req, r.email, r.token);
        try { await sendEmail({ to: r.email, subject: 'Reset your Spyne TravelDesk password', html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:auto;"><p style="color:#3D506A;line-height:1.5;">An administrator initiated a password reset. Set a new password (link valid 1 hour):</p><p style="margin:22px 0;"><a href="' + link + '" style="background:#E8232A;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:800;">Set a new password</a></p><p style="color:#8A97AA;font-size:12px;word-break:break-all;">Or paste: ' + link + '</p></div>' }); } catch (e) { console.error('reset email:', e); }
        res.status(200).json({ ok: true, email: r.email, link });
        return;
      }
      res.status(400).json({ ok: false, error: 'Unknown action' });
      return;
    }
    if (req.query && req.query.view === 'users') {
      res.status(200).json({ ok: true, users: await listUsers() });
      return;
    }
    if (req.query && req.query.view === 'roles') {
      res.status(200).json({ ok: true, ...(await rolesView()) });
      return;
    }
    if (req.query && req.query.view === 'emaillog') {
      res.status(200).json({ ok: true, log: await readEmailLog(150) });
      return;
    }
    if (req.query && req.query.view === 'currency-audit') {
      res.status(200).json({ ok: true, audit: await currencyAudit() });
      return;
    }
    const data = await financeData();
    try { data.remindersOn = await remindersEnabled(); data.reminderHour = await reminderHour(); } catch { data.remindersOn = false; data.reminderHour = 9; }
    res.status(200).json(data);
  } catch (err) {
    console.error('finance error:', err);
    res.status(500).json({ error: String(err.message || err), currencySummaries: {}, rows: [] });
  }
}
