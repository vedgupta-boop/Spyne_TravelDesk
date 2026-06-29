import { google } from 'googleapis';
import { HEADERS } from './config.js';

// ---------------------------------------------------------------------------
//  Google Sheets storage via a service account.
//  Env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID
//  The target spreadsheet must be shared (Editor) with the service account.
// ---------------------------------------------------------------------------

function normalizeKey(raw) {
  let k = (raw || '').trim();
  k = k.replace(/^["']|["']$/g, ''); // strip accidental surrounding quotes
  k = k.replace(/\\n/g, '\n');        // convert literal \n -> real newlines
  k = k.replace(/\r/g, '');           // drop CR (CRLF -> LF)
  return k;
}

function jwtAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = normalizeKey(process.env.GOOGLE_PRIVATE_KEY);
  if (!email || !key) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY');
  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
}

function api() { return google.sheets({ version: 'v4', auth: jwtAuth() }); }
function sheetId() {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error('Missing SHEET_ID');
  return id;
}

let _meta = null;
async function meta() {
  if (_meta) return _meta;
  const m = await api().spreadsheets.get({ spreadsheetId: sheetId() });
  const p = m.data.sheets[0].properties;
  _meta = {
    title: p.title,
    sheetId: p.sheetId,
    columnCount: (p.gridProperties && p.gridProperties.columnCount) || 26,
    rowCount: (p.gridProperties && p.gridProperties.rowCount) || 1000,
  };
  return _meta;
}
async function tabTitle() { return (await meta()).title; }

// Grow the sheet's column grid if the schema (HEADERS) has more columns than the grid allows.
async function ensureGridWidth() {
  const m = await meta();
  if (m.columnCount >= HEADERS.length) return;
  await api().spreadsheets.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: { requests: [{ updateSheetProperties: {
      properties: { sheetId: m.sheetId, gridProperties: { columnCount: HEADERS.length } },
      fields: 'gridProperties.columnCount',
    } }] },
  });
  m.columnCount = HEADERS.length; // update cache
}

function colLetter(index1) { // 1-based -> A1 column letters
  let n = index1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export async function ensureHeaders() {
  await ensureGridWidth();
  const tab = await tabTitle();
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `${tab}!1:1` });
  const row = (got.data.values && got.data.values[0]) || [];
  // Write/refresh the header row whenever it doesn't match the current schema.
  // Rows are written positionally (HEADERS order), so row 1 must equal HEADERS.
  const matches = row.length === HEADERS.length && HEADERS.every((h, i) => row[i] === h);
  if (!matches) {
    await api().spreadsheets.values.update({
      spreadsheetId: sheetId(),
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
}

export async function appendRecord(record) {
  const tab = await tabTitle();
  const rowVals = HEADERS.map((h) => (record[h] == null ? '' : record[h]));
  await api().spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowVals] },
  });
}

export async function readAll() {
  const tab = await tabTitle();
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: tab });
  const values = got.data.values || [];
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map((r, i) => {
    const rec = {};
    headers.forEach((h, c) => { rec[h] = r[c] != null ? r[c] : ''; });
    rec.__row = i + 2; // 1-based sheet row (header is row 1)
    return rec;
  });
}

export async function findById(id) {
  const all = await readAll();
  return all.find((r) => String(r['Request ID']) === String(id)) || null;
}

export async function updateCells(rowNumber, pairs) {
  const tab = await tabTitle();
  const data = pairs.map(([name, value]) => {
    const idx = HEADERS.indexOf(name);
    if (idx < 0) return null;
    const a1 = `${tab}!${colLetter(idx + 1)}${rowNumber}`;
    return { range: a1, values: [[value == null ? '' : value]] };
  }).filter(Boolean);
  if (!data.length) return;
  await api().spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: { valueInputOption: 'RAW', data },
  });
}
