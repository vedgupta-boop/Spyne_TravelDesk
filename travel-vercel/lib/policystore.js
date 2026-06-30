import { google } from 'googleapis';
import { POLICY, CONFIG } from './config.js';

// ---------------------------------------------------------------------------
//  Editable policy values (Finance can tweak individual numbers without
//  re-uploading the whole policy). Changes are appended to a "Policy Changes"
//  tab as an immutable AUDIT LOG (when / who / what / old → new). The CURRENT
//  effective value for a field = the latest logged change, else the code default.
//  FORWARD-ONLY: requests freeze their costs at submit, so historical requests
//  keep their original numbers — only new submissions use the changed value.
// ---------------------------------------------------------------------------

const TAB = 'Policy Changes';
const PH = { TS: 'Timestamp', BY: 'Changed By', PATH: 'Field Path', LABEL: 'Label', OLD: 'Old Value', NEW: 'New Value' };
const PHEADERS = [PH.TS, PH.BY, PH.PATH, PH.LABEL, PH.OLD, PH.NEW];

// Whitelist of editable numeric fields → where they live (dotted path) + a label.
export const EDITABLE = [
  { path: 'POLICY.HOTEL.india.1', label: 'Hotel cap — India Tier 1 (₹/night)', group: 'Hotel caps' },
  { path: 'POLICY.HOTEL.india.2', label: 'Hotel cap — India Tier 2 (₹/night)', group: 'Hotel caps' },
  { path: 'POLICY.HOTEL.india.3', label: 'Hotel cap — India Tier 3 (₹/night)', group: 'Hotel caps' },
  { path: 'POLICY.HOTEL.us.1', label: 'Hotel cap — US Tier 1 ($/night)', group: 'Hotel caps' },
  { path: 'POLICY.HOTEL.us.2', label: 'Hotel cap — US Tier 2 ($/night)', group: 'Hotel caps' },
  { path: 'POLICY.HOTEL.us.3', label: 'Hotel cap — US Tier 3 ($/night)', group: 'Hotel caps' },
  { path: 'POLICY.HOTEL.us.4', label: 'Hotel cap — US Tier 4 ($/night)', group: 'Hotel caps' },
  { path: 'POLICY.HOTEL.intl_default', label: 'Hotel cap — international, non-US ($/night)', group: 'Hotel caps' },
  { path: 'POLICY.MEALS.domestic', label: 'Meals — India domestic (₹/day)', group: 'Meal per-diem' },
  { path: 'POLICY.MEALS.overseas', label: 'Meals — overseas, no breakfast ($/day)', group: 'Meal per-diem' },
  { path: 'POLICY.MEALS.overseas_breakfast', label: 'Meals — overseas, breakfast incl. ($/day)', group: 'Meal per-diem' },
  { path: 'POLICY.LOCAL_DAILY_CAP.international', label: 'Intl local transport cap ($/day)', group: 'Local & forex' },
  { path: 'POLICY.FOREX_PER_DAY.international', label: 'Forex advance ($/day)', group: 'Local & forex' },
  { path: 'POLICY.CAPS.FLIGHT.domestic', label: 'Flight cap — domestic (₹)', group: 'Policy-break caps' },
  { path: 'POLICY.CAPS.FLIGHT.us_domestic', label: 'Flight cap — US domestic ($)', group: 'Policy-break caps' },
  { path: 'POLICY.CAPS.FLIGHT.international', label: 'Flight cap — international ($)', group: 'Policy-break caps' },
  { path: 'POLICY.CAPS.TOTAL.domestic', label: 'Total cap — domestic (₹)', group: 'Policy-break caps' },
  { path: 'POLICY.CAPS.TOTAL.international', label: 'Total cap — international ($)', group: 'Policy-break caps' },
  { path: 'POLICY.NOTICE_DAYS.domestic', label: 'Advance notice — domestic (days)', group: 'Advance notice' },
  { path: 'POLICY.NOTICE_DAYS.international', label: 'Advance notice — international (days)', group: 'Advance notice' },
  { path: 'POLICY.EXTRAS.VISA_FEE', label: 'Default visa fee ($)', group: 'Overseas extras' },
  { path: 'POLICY.EXTRAS.INSURANCE_PER_DAY', label: 'Travel insurance ($/day)', group: 'Overseas extras' },
  { path: 'POLICY.EXTRAS.PHONE_PER_DAY', label: 'Phone / comms ($/day)', group: 'Overseas extras' },
  { path: 'POLICY.EXTRAS.LAUNDRY_PER_BLOCK', label: 'Laundry ($/10-day block)', group: 'Overseas extras' },
  { path: 'POLICY.EXTRAS.BAGGAGE_PER_LEG', label: 'Baggage — US domestic ($/leg)', group: 'Overseas extras' },
  { path: 'POLICY.EXTRAS.SECURITY_DEPOSIT', label: 'Hotel security deposit ($/hotel)', group: 'Overseas extras' },
  { path: 'POLICY.ESTIMATES.FLIGHT.domestic', label: 'Flight estimate — domestic (₹)', group: 'Transport estimates' },
  { path: 'POLICY.ESTIMATES.FLIGHT.us_domestic', label: 'Flight estimate — US domestic ($)', group: 'Transport estimates' },
  { path: 'POLICY.ESTIMATES.FLIGHT.international', label: 'Flight estimate — international ($)', group: 'Transport estimates' },
  { path: 'CONFIG.FX.USD_INR', label: 'USD → INR rate', group: 'FX' },
];
const EDITABLE_PATHS = new Set(EDITABLE.map((e) => e.path));
const ROOTS = { POLICY, CONFIG };

function getByPath(path) {
  const parts = path.split('.');
  let o = ROOTS[parts[0]];
  for (let i = 1; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
  return o;
}
function setByPath(path, value) {
  const parts = path.split('.');
  let o = ROOTS[parts[0]];
  for (let i = 1; i < parts.length - 1; i++) { if (o == null) return; o = o[parts[i]]; }
  if (o) o[parts[parts.length - 1]] = value;
}

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

// All change rows, oldest first.
export async function readChanges() {
  try {
    const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
    const v = got.data.values || [];
    if (v.length < 2) return [];
    const h = v[0];
    const ix = (n) => h.indexOf(n);
    return v.slice(1).map((r) => ({
      ts: r[ix(PH.TS)] || '', by: r[ix(PH.BY)] || '', path: r[ix(PH.PATH)] || '',
      label: r[ix(PH.LABEL)] || '', old: r[ix(PH.OLD)] || '', new: r[ix(PH.NEW)] || '',
    }));
  } catch { return []; } // tab not created yet
}

// Latest value per path (overrides over defaults).
async function loadOverrides() {
  const changes = await readChanges();
  const map = {};
  for (const c of changes) { if (EDITABLE_PATHS.has(c.path)) map[c.path] = Number(c.new); }
  return map;
}

// Mutate the in-memory POLICY/CONFIG with the saved overrides. Deterministic
// (every request applies the same values) → safe under concurrency. Call before pricing.
export async function applyPolicyOverrides() {
  const map = await loadOverrides();
  for (const path of Object.keys(map)) { if (Number.isFinite(map[path])) setByPath(path, map[path]); }
  return map;
}

// Snapshot of the editable fields' CURRENT effective values (for the Finance UI).
export function editableSnapshot() {
  return EDITABLE.map((e) => ({ path: e.path, label: e.label, group: e.group, value: getByPath(e.path) }));
}

// Finance saves a single change: validates, records the audit row, applies it in memory.
export async function recordPolicyChange({ by, path, value }) {
  if (!EDITABLE_PATHS.has(path)) return { ok: false, error: 'That policy field is not editable.' };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Enter a valid non-negative number.' };
  await ensureTab();
  await applyPolicyOverrides();            // make sure "old" reflects the current effective value
  const spec = EDITABLE.find((e) => e.path === path);
  const old = getByPath(path);
  if (Number(old) === n) return { ok: false, error: 'That value is unchanged.' };
  const rec = { [PH.TS]: new Date().toISOString(), [PH.BY]: String(by || '').split('@')[0], [PH.PATH]: path, [PH.LABEL]: spec.label, [PH.OLD]: old, [PH.NEW]: n };
  await api().spreadsheets.values.append({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [PHEADERS.map((h) => (rec[h] == null ? '' : rec[h]))] } });
  setByPath(path, n);
  return { ok: true, path, label: spec.label, old, value: n };
}
