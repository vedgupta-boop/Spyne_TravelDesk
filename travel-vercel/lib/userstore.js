import crypto from 'crypto';
import { google } from 'googleapis';
import { AUTH, rolesFor } from './config.js';

// ---------------------------------------------------------------------------
//  App-native email + password accounts (alternative to Google sign-in).
//  Stored in a "Users" tab of the same Google Sheet. Passwords are NEVER
//  stored in clear — only a per-user scrypt hash + random salt. Roles are NOT
//  stored here: they are always re-derived from the email via rolesFor() at
//  sign-in, so role changes in config take effect immediately and there is no
//  stale-permission risk. Self-signup is restricted to the allowed domain.
// ---------------------------------------------------------------------------

const TAB = 'Users';
const UH = { EMAIL: 'Email', NAME: 'Name', SALT: 'Salt', HASH: 'Hash', CREATED: 'Created', LAST: 'Last Login', STATUS: 'Status', RTOKEN: 'Reset Token', REXP: 'Reset Expires' };
const UHEADERS = [UH.EMAIL, UH.NAME, UH.SALT, UH.HASH, UH.CREATED, UH.LAST, UH.STATUS, UH.RTOKEN, UH.REXP];
const RESET_TTL_MS = 60 * 60 * 1000; // password-reset link valid for 1 hour

function normalizeKey(raw) {
  let k = (raw || '').trim();
  return k.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').replace(/\r/g, '');
}
function jwt() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = normalizeKey(process.env.GOOGLE_PRIVATE_KEY);
  if (!email || !key) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY');
  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
}
function api() { return google.sheets({ version: 'v4', auth: jwt() }); }
function sheetId() { const id = process.env.SHEET_ID; if (!id) throw new Error('Missing SHEET_ID'); return id; }

// ---- password hashing (scrypt, no external dep) ----
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(password, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return { salt, hash };
}
function verifyHash(password, saltHex, expectedHex) {
  if (!saltHex || !expectedHex) return false;
  const { hash } = hashPassword(password, saltHex);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }
export function isAllowedDomain(email) {
  const dom = (AUTH.ALLOWED_DOMAIN || '').toLowerCase();
  if (!dom) return true; // no restriction configured
  return normalizeEmail(email).endsWith('@' + dom);
}

async function ensureTab() {
  const ss = await api().spreadsheets.get({ spreadsheetId: sheetId() });
  const sheet = ss.data.sheets.find((s) => s.properties.title === TAB);
  if (!sheet) {
    await api().spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { columnCount: UHEADERS.length } } } }] } });
  }
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `${TAB}!1:1` });
  const row = (got.data.values && got.data.values[0]) || [];
  if (!(row.length === UHEADERS.length && UHEADERS.every((h, i) => row[i] === h))) {
    await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [UHEADERS] } });
  }
}

function colLetter(n) { let s = ''; n = n + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// Returns { email, name, salt, hash, status, resetToken, resetExpires, rowNumber } or null.
export async function findUser(email) {
  const want = normalizeEmail(email);
  try {
    const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
    const v = got.data.values || [];
    if (v.length < 2) return null;
    const h = v[0];
    const ix = (n) => h.indexOf(n);
    for (let i = 1; i < v.length; i++) {
      const r = v[i];
      if (normalizeEmail(r[ix(UH.EMAIL)]) === want) {
        return {
          email: want, name: r[ix(UH.NAME)] || '', salt: r[ix(UH.SALT)] || '', hash: r[ix(UH.HASH)] || '',
          status: r[ix(UH.STATUS)] || 'Active', resetToken: r[ix(UH.RTOKEN)] || '', resetExpires: r[ix(UH.REXP)] || '',
          rowNumber: i + 1,
        };
      }
    }
    return null;
  } catch { return null; } // tab not created yet
}

// Update a single named cell on a user's row (best-effort helper).
async function setCell(rowNumber, header, value) {
  const col = colLetter(UHEADERS.indexOf(header));
  await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!${col}${rowNumber}`, valueInputOption: 'RAW', requestBody: { values: [[value == null ? '' : value]] } });
}

// Self-signup. Validates domain + uniqueness, writes a hashed row.
export async function createUser({ email, name, password }) {
  const e = normalizeEmail(email);
  if (!e || e.indexOf('@') < 0) return { ok: false, error: 'Enter a valid email address.' };
  if (!isAllowedDomain(e)) return { ok: false, error: `Only @${AUTH.ALLOWED_DOMAIN} email addresses can sign up.` };
  if (!password || String(password).length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  await ensureTab();
  const existing = await findUser(e);
  if (existing) return { ok: false, error: 'An account with this email already exists — sign in instead.' };
  const { salt, hash } = hashPassword(password);
  const rec = { [UH.EMAIL]: e, [UH.NAME]: String(name || '').trim(), [UH.SALT]: salt, [UH.HASH]: hash, [UH.CREATED]: new Date().toISOString(), [UH.LAST]: new Date().toISOString() };
  await api().spreadsheets.values.append({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [UHEADERS.map((hh) => (rec[hh] == null ? '' : rec[hh]))] } });
  return { ok: true, email: e, name: rec[UH.NAME] };
}

// Verify credentials. Returns { ok, email, name } or { ok:false, error }.
export async function verifyUser({ email, password }) {
  const u = await findUser(email);
  if (!u) return { ok: false, error: 'No account found for that email. Create one first.' };
  if ((u.status || 'Active') === 'Disabled') return { ok: false, error: 'This account has been disabled. Contact an administrator.' };
  if (!verifyHash(password, u.salt, u.hash)) return { ok: false, error: 'Incorrect email or password.' };
  try { await setCell(u.rowNumber, UH.LAST, new Date().toISOString()); } catch {} // best-effort last-login stamp
  return { ok: true, email: u.email, name: u.name };
}

// ---- password reset ----
// Create a reset token for an existing user. Returns { ok, token, name } (raw token
// for building a link) or { ok:false }. Caller decides whether to reveal it.
export async function createReset(email) {
  const u = await findUser(email);
  if (!u || (u.status || 'Active') === 'Disabled') return { ok: false };
  const token = crypto.randomBytes(24).toString('hex');
  await ensureTab();
  await setCell(u.rowNumber, UH.RTOKEN, sha256(token));
  await setCell(u.rowNumber, UH.REXP, String(Date.now() + RESET_TTL_MS));
  return { ok: true, token, name: u.name, email: u.email };
}

// Consume a reset token + set the new password. Returns { ok, email, name } or { ok:false, error }.
export async function consumeReset({ email, token, password }) {
  if (!password || String(password).length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  const u = await findUser(email);
  if (!u || !u.resetToken) return { ok: false, error: 'This reset link is invalid. Request a new one.' };
  if (!u.resetExpires || Number(u.resetExpires) < Date.now()) return { ok: false, error: 'This reset link has expired. Request a new one.' };
  const ok = (() => { const a = Buffer.from(sha256(token), 'hex'), b = Buffer.from(u.resetToken, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); })();
  if (!ok) return { ok: false, error: 'This reset link is invalid. Request a new one.' };
  const { salt, hash } = hashPassword(password);
  await setCell(u.rowNumber, UH.SALT, salt);
  await setCell(u.rowNumber, UH.HASH, hash);
  await setCell(u.rowNumber, UH.RTOKEN, '');     // single-use
  await setCell(u.rowNumber, UH.REXP, '');
  await setCell(u.rowNumber, UH.STATUS, 'Active'); // a reset re-activates an invited account
  return { ok: true, email: u.email, name: u.name };
}

// ---- admin user-management ----
// All app accounts + their derived roles (roles are NEVER stored — always from rolesFor).
export async function listUsers() {
  try {
    const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
    const v = got.data.values || [];
    if (v.length < 2) return [];
    const h = v[0];
    const ix = (n) => h.indexOf(n);
    return v.slice(1)
      .filter((r) => r[ix(UH.EMAIL)])
      .map((r) => {
        const email = normalizeEmail(r[ix(UH.EMAIL)]);
        return {
          email, name: r[ix(UH.NAME)] || '', created: r[ix(UH.CREATED)] || '', lastLogin: r[ix(UH.LAST)] || '',
          status: r[ix(UH.STATUS)] || 'Active', roles: rolesFor(email),
          pendingInvite: !!(r[ix(UH.RTOKEN)] && (!r[ix(UH.LAST)] || r[ix(UH.LAST)] === r[ix(UH.CREATED)])),
        };
      });
  } catch { return []; }
}

// Enable / disable an account (reversible; safer than deletion).
export async function setUserStatus(email, active) {
  const u = await findUser(email);
  if (!u) return { ok: false, error: 'User not found.' };
  await setCell(u.rowNumber, UH.STATUS, active ? 'Active' : 'Disabled');
  return { ok: true, email: u.email, status: active ? 'Active' : 'Disabled' };
}

// Admin invites a user: create the account (no usable password) + a reset token so the
// person sets their own password via the returned link. Domain-restricted like self-signup.
export async function inviteUser({ email, name }) {
  const e = normalizeEmail(email);
  if (!e || e.indexOf('@') < 0) return { ok: false, error: 'Enter a valid email address.' };
  if (!isAllowedDomain(e)) return { ok: false, error: `Only @${AUTH.ALLOWED_DOMAIN} email addresses are allowed.` };
  await ensureTab();
  const existing = await findUser(e);
  if (existing) return { ok: false, error: 'An account with this email already exists.' };
  const { salt, hash } = hashPassword(crypto.randomBytes(32).toString('hex')); // unusable until they set one
  const rec = { [UH.EMAIL]: e, [UH.NAME]: String(name || '').trim(), [UH.SALT]: salt, [UH.HASH]: hash, [UH.CREATED]: new Date().toISOString(), [UH.LAST]: '', [UH.STATUS]: 'Active', [UH.RTOKEN]: '', [UH.REXP]: '' };
  await api().spreadsheets.values.append({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [UHEADERS.map((hh) => (rec[hh] == null ? '' : rec[hh]))] } });
  const r = await createReset(e); // mint set-password link
  return { ok: true, email: e, name: rec[UH.NAME], token: r.token };
}
