import { google } from 'googleapis';
import { POLICY_VERSIONS } from './config.js';

// ---------------------------------------------------------------------------
//  Self-service policy DOCUMENT versions. Finance can publish a new version
//  (version + effective date + note + PDF link) from the dashboard — stored in
//  a "Policy Versions" tab — WITHOUT a code change. These are merged with the
//  code-seeded POLICY_VERSIONS (the registry in config.js) for display; stored
//  entries win on a version-number clash. The newest effective date = current.
// ---------------------------------------------------------------------------

const TAB = 'Policy Versions';
const PH = { TS: 'Timestamp', BY: 'Added By', VERSION: 'Version', EFFECTIVE: 'Effective Date', FILE: 'PDF Link', SUMMARY: 'Summary' };
const PHEADERS = [PH.TS, PH.BY, PH.VERSION, PH.EFFECTIVE, PH.FILE, PH.SUMMARY];

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

async function ensureTab() {
  const ss = await api().spreadsheets.get({ spreadsheetId: sheetId() });
  const sheet = ss.data.sheets.find((s) => s.properties.title === TAB);
  if (!sheet) {
    await api().spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { columnCount: PHEADERS.length } } } }] } });
  }
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `${TAB}!1:1` });
  const row = (got.data.values && got.data.values[0]) || [];
  if (!(row.length === PHEADERS.length && PHEADERS.every((h, i) => row[i] === h))) {
    await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [PHEADERS] } });
  }
}

// Versions added via the dashboard (each with its sheet row index).
export async function readStoredVersions() {
  try {
    const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
    const v = got.data.values || [];
    if (v.length < 2) return [];
    const h = v[0]; const ix = (n) => h.indexOf(n);
    return v.slice(1).map((r, i) => ({
      _row: i + 2,
      version: String(r[ix(PH.VERSION)] || '').trim(),
      effective: String(r[ix(PH.EFFECTIVE)] || '').trim(),
      file: r[ix(PH.FILE)] || '', summary: r[ix(PH.SUMMARY)] || '',
      by: r[ix(PH.BY)] || '', ts: r[ix(PH.TS)] || '', stored: true,
    })).filter((e) => e.version);
  } catch { return []; } // tab not created yet
}

// Code-seeded versions (config.js) + dashboard-added versions, newest effective date first,
// the newest marked current. Stored entries override a code entry with the same version number.
export async function mergedVersions() {
  const stored = await readStoredVersions();
  const seen = new Set(stored.map((s) => String(s.version)));
  const code = (POLICY_VERSIONS || []).filter((c) => !seen.has(String(c.version))).map((c) => ({ ...c, stored: false }));
  const all = stored.concat(code);
  all.sort((a, b) => String(b.effective || '').localeCompare(String(a.effective || '')));
  return all.map((e, i) => ({ version: e.version, effective: e.effective, file: e.file || '', summary: e.summary || '', stored: !!e.stored, current: i === 0 }));
}

// Finance publishes (or corrects) a version. Upsert by version number.
export async function addPolicyVersion({ version, effective, file, summary, by }) {
  version = String(version || '').trim();
  effective = String(effective || '').trim();
  if (!version) return { ok: false, error: 'Version number is required (e.g. 2.1).' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) return { ok: false, error: 'Effective date must be a valid date (YYYY-MM-DD).' };
  await ensureTab();
  const existing = await readStoredVersions();
  const dup = existing.find((e) => String(e.version) === version);
  const rowVals = [new Date().toISOString(), String(by || '').split('@')[0], version, effective, String(file || ''), String(summary || '')];
  if (dup) {
    await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A${dup._row}`, valueInputOption: 'RAW', requestBody: { values: [rowVals] } });
  } else {
    await api().spreadsheets.values.append({ spreadsheetId: sheetId(), range: TAB, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [rowVals] } });
  }
  return { ok: true, versions: await mergedVersions() };
}

// Remove a dashboard-added version (code-seeded versions can't be deleted here).
export async function deletePolicyVersion(version, by) {
  const existing = await readStoredVersions();
  const dup = existing.find((e) => String(e.version) === String(version || '').trim());
  if (!dup) return { ok: false, error: 'Only versions added from the dashboard can be removed; built-in versions are fixed in code.' };
  const ss = await api().spreadsheets.get({ spreadsheetId: sheetId() });
  const sheet = ss.data.sheets.find((s) => s.properties.title === TAB);
  const sid = sheet.properties.sheetId;
  await api().spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: [{ deleteDimension: { range: { sheetId: sid, dimension: 'ROWS', startIndex: dup._row - 1, endIndex: dup._row } } }] } });
  return { ok: true, versions: await mergedVersions() };
}
