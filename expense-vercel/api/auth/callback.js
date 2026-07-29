import { exchangeAndVerify, makeSessionToken, setSessionCookie, clearStateCookie, parseCookies, COOKIES } from '../../lib/auth.js';
import { AUTH, rolesFor, homeFor } from '../../lib/config.js';

function fail(res, msg) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(403).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#f4f4f4;margin:0;padding:40px;}
.card{max-width:460px;margin:40px auto;background:#fff;border-radius:10px;padding:32px;box-shadow:0 2px 10px rgba(0,0,0,.08);text-align:center;}
h1{color:#b00;font-size:20px;margin:0 0 12px;}p{color:#444;line-height:1.5;}a{color:#0077CC;}</style></head>
<body><div class="card"><h1>Sign-in blocked</h1><p>${esc(msg)}</p><p><a href="/api/auth/login">Try again</a></p></div></body></html>`);
}

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : null;
}

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    if (q.error) return fail(res, 'Google sign-in was cancelled or denied.');
    if (!q.code || !q.state) return fail(res, 'Missing authorization code or state.');

    let state;
    try { state = JSON.parse(Buffer.from(q.state, 'base64url').toString('utf8')); }
    catch { return fail(res, 'Invalid state parameter.'); }

    const cookies = parseCookies(req);
    if (!state.n || state.n !== cookies[COOKIES.STATE]) return fail(res, 'State mismatch — possible CSRF. Please retry.');
    clearStateCookie(res);

    const payload = await exchangeAndVerify(req, q.code);
    const email = String(payload.email || '').toLowerCase();
    const domain = AUTH.ALLOWED_DOMAIN.toLowerCase();
    const allowed = payload.email_verified && (payload.hd === domain || email.endsWith('@' + domain));
    if (!allowed) return fail(res, `Access is restricted to @${AUTH.ALLOWED_DOMAIN} accounts.`);

    try { const { applyRoleOverrides } = await import('../../lib/rolesstore.js'); await applyRoleOverrides(); } catch (e) { /* fall back to config defaults */ }
    const roles = rolesFor(email);
    setSessionCookie(res, makeSessionToken({ email, roles, name: payload.name || '' }));
    res.writeHead(302, { Location: safeNext(state.next) || homeFor(roles) });
    res.end();
  } catch (err) {
    console.error('callback error:', err);
    fail(res, 'Sign-in failed: ' + (err.message || err));
  }
}
