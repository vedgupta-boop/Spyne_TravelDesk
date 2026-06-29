import crypto from 'crypto';
import { authUrl, setStateCookie, makeSessionToken, setSessionCookie, rolesFor, baseUrl } from '../../lib/auth.js';
import { createUser, verifyUser, createReset, consumeReset, normalizeEmail } from '../../lib/userstore.js';
import { sendEmail } from '../../lib/email.js';
import { applyRoleOverrides } from '../../lib/rolesstore.js';

function resetLink(req, email, token) {
  return baseUrl(req) + '/reset.html?email=' + encodeURIComponent(email) + '&token=' + encodeURIComponent(token);
}
function resetEmailHtml(name, link) {
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:auto;">'
    + '<h2 style="color:#0D1B2A;">Reset your Spyne TravelDesk password</h2>'
    + '<p style="color:#3D506A;line-height:1.5;">Hi ' + (name || 'there') + ', we received a request to reset your password. '
    + 'Click below to set a new one. This link expires in 1 hour. If you didn’t ask for this, you can ignore this email.</p>'
    + '<p style="margin:22px 0;"><a href="' + link + '" style="background:#E8232A;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:800;">Set a new password</a></p>'
    + '<p style="color:#8A97AA;font-size:12px;word-break:break-all;">Or paste this link: ' + link + '</p></div>';
}

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

// Issue an app session cookie for an authenticated email + redeem roles from config.
function signIn(res, email, name) {
  const e = normalizeEmail(email);
  const token = makeSessionToken({ email: e, name: name || e.split('@')[0], roles: rolesFor(e) });
  setSessionCookie(res, token);
}

export default async function handler(req, res) {
  await applyRoleOverrides(); // sign in with the current role assignments
  // ---- POST: app-native email + password (register / login) ----
  if (req.method === 'POST') {
    try {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const next = safeNext(b.next);
      if (b.action === 'register') {
        const r = await createUser({ email: b.email, name: b.name, password: b.password });
        if (!r.ok) { res.status(200).json(r); return; }
        signIn(res, r.email, r.name);
        res.status(200).json({ ok: true, next });
        return;
      }
      if (b.action === 'login') {
        const r = await verifyUser({ email: b.email, password: b.password });
        if (!r.ok) { res.status(200).json(r); return; }
        signIn(res, r.email, r.name);
        res.status(200).json({ ok: true, next });
        return;
      }
      if (b.action === 'forgot') {
        // Always respond the same way — never reveal whether an account exists, and
        // never return the link in the response (only delivered by email).
        try {
          const r = await createReset(b.email);
          if (r.ok) await sendEmail({ to: r.email, subject: 'Reset your Spyne TravelDesk password', html: resetEmailHtml(r.name, resetLink(req, r.email, r.token)) });
        } catch (e) { console.error('forgot error:', e); }
        res.status(200).json({ ok: true, message: 'If an account exists for that email, a reset link is on its way.' });
        return;
      }
      if (b.action === 'reset') {
        const r = await consumeReset({ email: b.email, token: b.token, password: b.password });
        if (!r.ok) { res.status(200).json(r); return; }
        signIn(res, r.email, r.name);
        res.status(200).json({ ok: true, next });
        return;
      }
      res.status(200).json({ ok: false, error: 'Unknown action' });
    } catch (err) {
      console.error('auth POST error:', err);
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
    return;
  }

  // ---- GET: Google OAuth redirect (unchanged) ----
  try {
    const next = safeNext(req.query && req.query.next);
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = Buffer.from(JSON.stringify({ n: nonce, next })).toString('base64url');
    setStateCookie(res, nonce);
    res.writeHead(302, { Location: authUrl(req, state) });
    res.end();
  } catch (err) {
    res.status(500).send('Login error: ' + (err.message || err));
  }
}
