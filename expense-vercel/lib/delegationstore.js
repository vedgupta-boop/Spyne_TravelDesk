// Delegation / out-of-office assignments — a "Delegations" tab (Approver / Delegate / From / To /
// Note / Updated By / Updated At) in the same Google Sheet. Finance manages these from the User
// Access page; they're applied on top of role routing so an active stand-in can approve for the
// principal during the window, and notifications also reach the stand-in. No redeploy needed.
import { google } from 'googleapis';
import { setDelegations, allDelegations } from './config.js';

const TAB = 'Delegations';
const HEADERS = ['Approver', 'Delegate', 'From', 'To', 'Note', 'Updated By', 'Updated At'];
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

async function readList() {
  try {
    const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
    const v = got.data.values || [];
    const list = [];
    for (let i = 1; i < v.length; i++) {
      const r = v[i] || [];
      const approver = String(r[0] || '').trim(), delegate = String(r[1] || '').trim();
      if (!approver || !delegate) continue;
      list.push({ approver, delegate, from: String(r[2] || '').trim(), to: String(r[3] || '').trim(), note: String(r[4] || '').trim(), by: String(r[5] || '').trim(), at: String(r[6] || '').trim() });
    }
    return list;
  } catch { return []; } // tab not created yet → no delegations
}

let _cache = { list: null, exp: 0 };
// Refresh the delegation list (cached) and apply it to CONFIG. Best-effort: on any error,
// applies an empty list (= no delegations). Call at the top of each request that routes approvals.
export async function applyDelegations() {
  try {
    const now = Date.now();
    if (!_cache.list || _cache.exp < now) { _cache = { list: await readList(), exp: now + TTL_MS }; }
    setDelegations(_cache.list || []);
    return _cache.list || [];
  } catch (e) {
    setDelegations([]); // safe fallback → no delegations
    return [];
  }
}

// Finance adds/updates a delegation (one row per approver+delegate pair). Empty delegate removes it.
export async function setDelegation({ approver, delegate, from, to, note }, byEmail) {
  approver = String(approver || '').trim().toLowerCase();
  delegate = String(delegate || '').trim().toLowerCase();
  if (!approver) return { ok: false, error: 'Pick the approver going out of office' };
  if (delegate && approver === delegate) return { ok: false, error: 'Approver and delegate must differ' };
  await ensureTab();
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
  const v = got.data.values || [];
  let rowIdx = -1;
  for (let i = 1; i < v.length; i++) { if (String(v[i][0] || '').toLowerCase() === approver && String(v[i][1] || '').toLowerCase() === delegate) { rowIdx = i; break; } }
  if (!delegate) { // remove all delegations for this approver
    for (let i = v.length - 1; i >= 1; i--) {
      if (String(v[i][0] || '').toLowerCase() === approver) {
        await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A${i + 1}:G${i + 1}`, valueInputOption: 'RAW', requestBody: { values: [['', '', '', '', '', '', '']] } });
      }
    }
    _cache = { list: null, exp: 0 }; await applyDelegations();
    return { ok: true, removed: true, approver };
  }
  const rowVals = [approver, delegate, String(from || '').trim(), String(to || '').trim(), String(note || '').trim(), String(byEmail || '').split('@')[0], new Date().toISOString()];
  if (rowIdx >= 0) await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A${rowIdx + 1}`, valueInputOption: 'RAW', requestBody: { values: [rowVals] } });
  else await api().spreadsheets.values.append({ spreadsheetId: sheetId(), range: `${TAB}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [rowVals] } });
  _cache = { list: null, exp: 0 }; await applyDelegations();
  return { ok: true, approver, delegate };
}

// Remove a single delegation pair.
export async function removeDelegation({ approver, delegate }) {
  approver = String(approver || '').trim().toLowerCase();
  delegate = String(delegate || '').trim().toLowerCase();
  await ensureTab();
  const got = await api().spreadsheets.values.get({ spreadsheetId: sheetId(), range: TAB });
  const v = got.data.values || [];
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][0] || '').toLowerCase() === approver && (!delegate || String(v[i][1] || '').toLowerCase() === delegate)) {
      await api().spreadsheets.values.update({ spreadsheetId: sheetId(), range: `${TAB}!A${i + 1}:G${i + 1}`, valueInputOption: 'RAW', requestBody: { values: [['', '', '', '', '', '', '']] } });
    }
  }
  _cache = { list: null, exp: 0 }; await applyDelegations();
  return { ok: true, approver, delegate };
}

// Snapshot for the User Access UI (with an `active` flag per row).
export async function delegationsView() {
  await applyDelegations();
  return { delegations: allDelegations() };
}
