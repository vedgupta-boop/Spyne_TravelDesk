import { google } from 'googleapis';

// ---------------------------------------------------------------------------
//  Cross-app reconciliation: read ACTUAL spend from the sibling ExpenseDesk
//  Google Sheet (expense-vercel) and group it by the linked travel request
//  (TRF-…). Same service account as this app; only the spreadsheet differs.
//  Env: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, EXPENSE_SHEET_ID.
//  Best-effort: if the sheet/env is missing or the read fails, returns empty.
// ---------------------------------------------------------------------------

function normalizeKey(raw) {
  let k = (raw || '').trim();
  k = k.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').replace(/\r/g, '');
  return k;
}

function auth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = normalizeKey(process.env.GOOGLE_PRIVATE_KEY);
  if (!email || !key) return null;
  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
}

// ExpenseDesk header labels (must match expense-vercel/lib/config.js COL values).
const EH = {
  ID: 'Request ID', TRAVEL_ID: 'Linked Travel Request (TRF)',
  AMOUNT_INR: 'Amount (INR equiv)', AMOUNT: 'Amount', CURRENCY: 'Currency',
  ITEM: 'Item / Service', VENDOR: 'Vendor / Supplier',
  STATUS: 'Status', STAGE: 'Stage', CATEGORY: 'Category',
};

function num(v) { return Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0; }

// → { byTrf: { 'TRF-…': { actualINR, paidINR, count, items:[…] } }, available, total }
export async function expenseActualsByTrf() {
  const sheetId = process.env.EXPENSE_SHEET_ID;
  const a = auth();
  if (!sheetId || !a) return { byTrf: {}, available: false };
  try {
    const sheets = google.sheets({ version: 'v4', auth: a });
    const m = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const tab = m.data.sheets[0].properties.title;
    const got = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: tab });
    const values = got.data.values || [];
    if (values.length < 2) return { byTrf: {}, available: true };
    const headers = values[0];
    const ix = (name) => headers.indexOf(name);
    const iTrf = ix(EH.TRAVEL_ID), iId = ix(EH.ID), iAmtINR = ix(EH.AMOUNT_INR), iAmt = ix(EH.AMOUNT),
          iCur = ix(EH.CURRENCY), iItem = ix(EH.ITEM), iVen = ix(EH.VENDOR), iStatus = ix(EH.STATUS),
          iStage = ix(EH.STAGE), iCat = ix(EH.CATEGORY);
    if (iTrf < 0) return { byTrf: {}, available: true }; // expense sheet not yet upgraded with the link column
    const byTrf = {};
    for (let r = 1; r < values.length; r++) {
      const row = values[r]; if (!row) continue;
      const trf = String(row[iTrf] || '').trim().toUpperCase();
      if (!trf) continue;
      const status = String(row[iStatus] || ''); const stage = String(row[iStage] || '');
      if (/reject/i.test(status) || stage === 'rejected') continue; // exclude rejected claims
      const amtINR = num(row[iAmtINR]);
      const paid = /paid|done|closed|completed/i.test(status) || stage === 'done';
      const b = byTrf[trf] || (byTrf[trf] = { actualINR: 0, paidINR: 0, count: 0, items: [] });
      b.actualINR += amtINR; if (paid) b.paidINR += amtINR; b.count++;
      b.items.push({
        id: iId >= 0 ? row[iId] : '', item: iItem >= 0 ? row[iItem] : '', vendor: iVen >= 0 ? row[iVen] : '',
        category: iCat >= 0 ? row[iCat] : '', amount: iAmt >= 0 ? num(row[iAmt]) : 0,
        currency: iCur >= 0 ? row[iCur] : '', amountINR: amtINR, status, paid,
      });
    }
    return { byTrf, available: true };
  } catch (e) {
    console.error('expenseActuals read failed (non-fatal):', e.message);
    return { byTrf: {}, available: false };
  }
}
