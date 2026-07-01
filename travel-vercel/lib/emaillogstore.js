import { google } from 'googleapis';

// ---------------------------------------------------------------------------
//  Lightweight audit trail of every email the app sends (who was emailed, when,
//  about which request). Appended to an "Email Log" tab. Best-effort — logging a
//  send must never break the send itself, so callers fire-and-forget (no await).
// ---------------------------------------------------------------------------

const TAB = 'Email Log';
const PH = { TS: 'Timestamp', ID: 'Request ID', TO: 'To', CC: 'CC', SUBJECT: 'Subject' };
const PHEADERS = [PH.TS, PH.ID, PH.TO, PH.CC, PH.SUBJECT];

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

let _ensured = false;
async function ensureTab() {
  if (_ensured) return;
  const ss = await api().spreadsheets.get({ spreadsheetId: sheetId() });
  const sheet = ss.data.sheets.find((s) => s.properties.title === TAB);
  if (!sheet) {
    await api().spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { columnCount: PHEADERS.length } } } }] } });
    await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [PHEADERS] } });
  }
  _ensured = true;
}

// Record one sent email. Never throws (best-effort).
export async function logEmail({ id, to, cc, subject }) {
  try {
    await ensureTab();
    await api().spreadsheets.values.append({
      spreadsheetId: sheetId(), range: TAB, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[new Date().toISOString(), String(id || ''), String(to || ''), String(cc || ''), String(subject || '')]] },
    });
  } catch (e) { console.error('email log (non-fatal):', e.message || e); }
}

// Most-recent emails first (default 100).
export async function readEmailLog(limit = 100) {
  try {
    const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
    const v = got.data.values || [];
    if (v.length < 2) return [];
    const h = v[0]; const ix = (n) => h.indexOf(n);
    const rows = v.slice(1).map((r) => ({
      ts: r[ix(PH.TS)] || '', id: r[ix(PH.ID)] || '', to: r[ix(PH.TO)] || '', cc: r[ix(PH.CC)] || '', subject: r[ix(PH.SUBJECT)] || '',
    })).filter((e) => e.ts || e.subject);
    return rows.reverse().slice(0, limit);
  } catch { return []; }
}
