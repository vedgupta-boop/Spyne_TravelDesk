// Tiny runtime settings store — a "Settings" tab (Key / Value / Updated By / Updated At) in the
// same Google Sheet. Lets Finance flip switches (e.g. email reminders) from the dashboard without
// any redeploy or env change. Upserts by key.
import { google } from 'googleapis';

const TAB = 'Settings';
const HEADERS = ['Key', 'Value', 'Updated By', 'Updated At'];

function normalizeKey(raw) { let k = (raw || '').trim(); return k.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').replace(/\r/g, ''); }
function jwt() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = normalizeKey(process.env.GOOGLE_PRIVATE_KEY);
  if (!email || !key) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY');
  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
}
function api() { return google.sheets({ version: 'v4', auth: jwt() }); }
function sheetId() { const id = process.env.SHEET_ID; if (!id) throw new Error('Missing SHEET_ID'); return id; }

async function ensureTab() {
  const ss = await api().spreadsheets.get({ spreadsheetId: sheetId() });
  const sheet = ss.data.sheets.find((s) => s.properties.title === TAB);
  if (!sheet) {
    await api().spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { columnCount: HEADERS.length } } } }] } });
  }
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `${TAB}!1:1` });
  const row = (got.data.values && got.data.values[0]) || [];
  if (!(row.length === HEADERS.length && HEADERS.every((h, i) => row[i] === h))) {
    await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [HEADERS] } });
  }
}

export async function getSetting(key, fallback) {
  try {
    const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
    const v = got.data.values || [];
    for (let i = 1; i < v.length; i++) { if (String(v[i][0]) === key) return v[i][1]; }
    return fallback;
  } catch { return fallback; } // tab not created yet
}

export async function setSetting(key, value, byEmail) {
  await ensureTab();
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
  const v = got.data.values || [];
  const by = String(byEmail || '').split('@')[0];
  const at = new Date().toISOString();
  const rowVals = [key, String(value), by, at];
  let rowIdx = -1;
  for (let i = 1; i < v.length; i++) { if (String(v[i][0]) === key) { rowIdx = i; break; } }
  if (rowIdx >= 0) {
    await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A${rowIdx + 1}`, valueInputOption: 'RAW', requestBody: { values: [rowVals] } });
  } else {
    await api().spreadsheets.values.append({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [rowVals] } });
  }
  return { ok: true, key, value: String(value), by, at };
}

// Email-reminders master switch (Finance-controlled from the dashboard). Default OFF when unset.
export async function remindersEnabled() {
  const v = await getSetting('reminders_enabled', '');
  return String(v).toLowerCase() === 'true';
}
export async function setRemindersEnabled(on, byEmail) {
  return setSetting('reminders_enabled', on ? 'true' : 'false', byEmail);
}

// Hour of day (IST, 0–23) at/after which the daily reminder run should fire. Default 9 (9 AM IST).
export async function reminderHour() {
  const n = parseInt(await getSetting('reminder_hour', ''), 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 9;
}
export async function setReminderHour(h, byEmail) {
  const n = parseInt(h, 10);
  return setSetting('reminder_hour', String(Number.isFinite(n) && n >= 0 && n <= 23 ? n : 9), byEmail);
}
