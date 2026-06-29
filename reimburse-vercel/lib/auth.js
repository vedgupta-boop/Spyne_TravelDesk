import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { AUTH, rolesFor } from './config.js';

const SESSION_COOKIE = 'rmb_session';
const STATE_COOKIE = 'rmb_oauth_state';
const MAX_AGE = 8 * 3600; // seconds

// ---- base URL ----
export function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
export function redirectUri(req) { return baseUrl(req) + '/api/auth/callback'; }

function oauthClient(req) {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET');
  return new OAuth2Client(id, secret, redirectUri(req));
}

// ---- Google OAuth ----
export function authUrl(req, state) {
  return oauthClient(req).generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    hd: AUTH.ALLOWED_DOMAIN, // hint Google to the workspace domain
    state,
    prompt: 'select_account',
  });
}

export async function exchangeAndVerify(req, code) {
  const client = oauthClient(req);
  const { tokens } = await client.getToken(code);
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_OAUTH_CLIENT_ID });
  return ticket.getPayload(); // { email, email_verified, hd, name, ... }
}

// ---- signed session cookie (HMAC, no external dep) ----
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('Missing SESSION_SECRET');
  return s;
}
function sign(body) { return crypto.createHmac('sha256', secret()).update(body).digest('base64url'); }

export function makeSessionToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + MAX_AGE * 1000 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
export function readSessionToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  let expected;
  try { expected = sign(body); } catch { return null; }
  if (!safeEqual(sig, expected)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!obj.exp || obj.exp < Date.now()) return null;
  return obj;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ---- cookie helpers ----
export function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function cookie(name, value, maxAge) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}
export function setSessionCookie(res, token) { appendCookie(res, cookie(SESSION_COOKIE, token, MAX_AGE)); }
export function clearSessionCookie(res) { appendCookie(res, cookie(SESSION_COOKIE, '', 0)); }
export function setStateCookie(res, state) { appendCookie(res, cookie(STATE_COOKIE, state, 600)); }
export function clearStateCookie(res) { appendCookie(res, cookie(STATE_COOKIE, '', 0)); }
function appendCookie(res, c) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}

// ---- session access for handlers ----
export function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  return readSessionToken(token); // { email, roles, name, exp } | null
}

// Guard a data API. Returns the session, or null after sending a 401/403.
// Finance is a superuser: it can access every dashboard/API.
export function requireRole(req, res, role) {
  const s = getSession(req);
  if (!s) { res.status(401).json({ ok: false, error: 'Not signed in', authRequired: true }); return null; }
  const roles = s.roles || [];
  const allowed = !role || roles.includes(role) || roles.includes('finance');
  if (!allowed) {
    res.status(403).json({ ok: false, error: `Forbidden — requires "${role}" role` });
    return null;
  }
  return s;
}

export const COOKIES = { SESSION: SESSION_COOKIE, STATE: STATE_COOKIE };
export { rolesFor };
