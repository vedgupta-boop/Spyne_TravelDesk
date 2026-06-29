// Runtime role assignments — a "Roles" tab (Key / Value / Updated By / Updated At) in the same
// Google Sheet. Finance assigns roles from the Users tab; this applies them on top of the config
// defaults so dashboard access + approval routing follow the assignment with no redeploy.
// Keys: ceo, finance, admin, forex (comma-separated emails) and dept:<DeptName> (single head email).
import { google } from 'googleapis';
import { setRoleOverrides, roleAssignments, departmentNames } from './config.js';

const TAB = 'Roles';
const HEADERS = ['Key', 'Value', 'Updated By', 'Updated At'];
const TTL_MS = 15000; // cache window — changes propagate within ~15s across warm instances

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
  if (!ss.data.sheets.find((s) => s.properties.title === TAB)) {
    await api().spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { columnCount: HEADERS.length } } } }] } });
  }
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `${TAB}!1:1` });
  const row = (got.data.values && got.data.values[0]) || [];
  if (!(row.length === HEADERS.length && HEADERS.every((h, i) => row[i] === h))) {
    await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', requestBody: { values: [HEADERS] } });
  }
}

async function readMap() {
  try {
    const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
    const v = got.data.values || [];
    const map = {};
    for (let i = 1; i < v.length; i++) { const k = String(v[i][0] || '').trim(); const val = String(v[i][1] || '').trim(); if (k && val) map[k] = val; }
    return map;
  } catch { return {}; } // tab not created yet → no overrides → defaults
}

let _cache = { map: null, exp: 0 };
// Refresh the override map (cached) and apply it to CONFIG/AUTH. Best-effort: on any error,
// applies an empty map (= config defaults). Call at the top of each request that checks roles/routes.
export async function applyRoleOverrides() {
  try {
    const now = Date.now();
    if (!_cache.map || _cache.exp < now) { _cache = { map: await readMap(), exp: now + TTL_MS }; }
    setRoleOverrides(_cache.map || {});
    return _cache.map || {};
  } catch (e) {
    setRoleOverrides({}); // safe fallback → config defaults
    return {};
  }
}

// Finance saves one role assignment. value: comma-separated emails (ceo/dept = single).
export async function setRole(key, value, byEmail) {
  await ensureTab();
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
  const v = got.data.values || [];
  const rowVals = [key, String(value || '').trim(), String(byEmail || '').split('@')[0], new Date().toISOString()];
  let rowIdx = -1;
  for (let i = 1; i < v.length; i++) { if (String(v[i][0]) === key) { rowIdx = i; break; } }
  if (rowIdx >= 0) await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A${rowIdx + 1}`, valueInputOption: 'RAW', requestBody: { values: [rowVals] } });
  else await api().spreadsheets.values.append({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [rowVals] } });
  _cache = { map: null, exp: 0 }; // bust local cache so this instance reflects it now
  await applyRoleOverrides();
  return { ok: true, key, value: rowVals[1] };
}

// Snapshot for the Users UI: current effective assignments + the department list.
export async function rolesView() {
  await applyRoleOverrides();
  return { assignments: roleAssignments(), departments: departmentNames() };
}
