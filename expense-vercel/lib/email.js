import { Resend } from 'resend';
import { CONFIG, COL } from './config.js';

export function money(amount, cur) {
  cur = cur || 'INR';
  return cur + ' ' + Number(amount || 0).toLocaleString(cur === 'USD' ? 'en-US' : 'en-IN', { maximumFractionDigits: 0 });
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Best-effort email — never throws.
export async function sendEmail({ to, subject, html, cc }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || `${CONFIG.COMPANY_NAME} ${CONFIG.APP_NAME} <onboarding@resend.dev>`;
  if (!apiKey) { console.warn('RESEND_API_KEY missing — skipping email to', to); return { ok: false, skipped: true }; }
  try {
    const resend = new Resend(apiKey);
    const payload = { from, to: Array.isArray(to) ? to : [to], subject, html };
    if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
    const { data, error } = await resend.emails.send(payload);
    if (error) { console.error('Resend error (non-fatal) to', to, '->', error.message || JSON.stringify(error)); return { ok: false, error }; }
    return { ok: true, data };
  } catch (e) { console.error('Email send threw (non-fatal) to', to, '->', e.message || e); return { ok: false, error: e.message || String(e) }; }
}

function btn(url, label, color) {
  return `<a href="${url}" style="display:inline-block;padding:12px 26px;background:${color};color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;">${label}</a>`;
}
function kvTable(rows) {
  let html = '<table style="border-collapse:collapse;width:100%;font-size:14px;font-family:Arial,sans-serif;">';
  rows.forEach((r, i) => {
    if (r[1] == null || r[1] === '') return;
    const bg = i % 2 ? '#f7f7f7' : '#ffffff';
    html += `<tr style="background:${bg};"><td style="padding:7px 12px;border:1px solid #eee;color:#555;width:40%;">${esc(r[0])}</td>` +
            `<td style="padding:7px 12px;border:1px solid #eee;">${esc(String(r[1]))}</td></tr>`;
  });
  return html + '</table>';
}
function freqLabel(rec) { const f = rec[COL.FREQUENCY] || 'One-time'; return f === 'One-time' ? 'One-time' : f + ' (recurring)'; }

function requestSummary(rec) {
  const cur = rec[COL.CURRENCY] || 'INR';
  const recurring = (rec[COL.FREQUENCY] || 'One-time') !== 'One-time';
  const budget = String(rec[COL.BUDGET_TAKEN]) === 'Yes'
    ? 'Yes' + (rec[COL.BUDGET_LINE] ? ' · line: ' + rec[COL.BUDGET_LINE] : '')
    : 'No — out of budget' + (rec[COL.OOB_JUST] ? ' (' + rec[COL.OOB_JUST] + ')' : '');
  let quotes = '';
  if (rec[COL.QUOTES_AVAIL] === 'Yes') quotes = '3 quotations attached';
  else if (rec[COL.QUOTES_AVAIL] === 'No') quotes = 'Fewer than 3 — ' + (rec[COL.QUOTES_REASON] || 'reason given');
  return kvTable([
    ['Nature', rec[COL.NATURE]],
    ['Request Type', rec[COL.REQTYPE]],
    ['Category', rec[COL.CATEGORY]],
    ['Item / Service', rec[COL.ITEM]],
    ['Vendor / Supplier', rec[COL.VENDOR]],
    ['Vendor GST / PAN', rec[COL.VENDOR_GST]],
    ['Vendor contact', [rec[COL.VENDOR_PHONE], rec[COL.VENDOR_EMAIL]].filter(Boolean).join(' · ')],
    ...(Number(rec[COL.RATE]) > 0 ? [['Rate × Qty', money(rec[COL.RATE], cur) + ' × ' + rec[COL.QTY]]] : []),
    ['Amount', money(rec[COL.AMOUNT], cur) + ' · ' + freqLabel(rec)],
    ...(recurring ? [['Annualised value', money(rec[COL.ANNUAL], cur)]] : []),
    ['Expense month', rec[COL.EXPENSE_MONTH]],
    ['Needed by', rec[COL.NEEDBY]],
    ['Department', rec[COL.DEPT]],
    ['Budget taken', budget],
    ['Quotations', quotes],
    ['Purpose', rec[COL.PURPOSE]],
  ]);
}
function amountBanner(rec) {
  const cur = rec[COL.CURRENCY] || 'INR';
  const oob = String(rec[COL.BUDGET_TAKEN]) === 'No';
  const bg = oob ? '#FEE2E2' : '#EEF2FF', bd = oob ? '#FCA5A5' : '#C7D2FE', fg = oob ? '#991B1B' : '#3730A3';
  return `<div style="background:${bg};border:1px solid ${bd};border-radius:8px;padding:13px 16px;margin:0 0 14px;font-family:Arial,sans-serif;">` +
    `<div style="font-size:12px;color:${fg};font-weight:bold;text-transform:uppercase;letter-spacing:.4px;">Amount requested${oob ? ' · OUT OF BUDGET' : ''}</div>` +
    `<div style="font-size:24px;font-weight:900;color:#0D1B2A;margin-top:2px;">${esc(money(rec[COL.AMOUNT], cur))}<span style="font-size:13px;font-weight:600;color:#555;"> · ${esc(freqLabel(rec))}</span></div>` +
    `<div style="font-size:12px;color:${fg};margin-top:4px;font-weight:600;">${esc(rec[COL.TIER] || '')}</div></div>`;
}
function docsBlock(rec) {
  const links = [];
  [COL.QUOTE1, COL.QUOTE2, COL.QUOTE3].forEach((k, i) => { if (rec[k]) links.push(`<a href="${esc(rec[k])}" style="color:#0077CC;font-weight:bold;">Quotation ${i + 1}</a>`); });
  if (rec[COL.DOC_QUOTE]) links.push(`<a href="${esc(rec[COL.DOC_QUOTE])}" style="color:#0077CC;font-weight:bold;">Quotation / proforma</a>`);
  if (rec[COL.INVOICE_DOC]) links.push(`<a href="${esc(rec[COL.INVOICE_DOC])}" style="color:#0077CC;font-weight:bold;">e-Invoice</a>`);
  return links.length ? `<p style="font-size:13px;margin:14px 0 0;">📎 ${links.join(' &nbsp;·&nbsp; ')}</p>` : '';
}

export function approvalEmailHtml(rec, stageLabel, approverName, approveUrl, rejectUrl) {
  const greeting = approverName ? `<p style="margin:0 0 14px;font-size:15px;">Hi <b>${esc(approverName)}</b>,</p>` : '';
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;">Expense Request ${esc(rec[COL.ID])} — ${esc(stageLabel)} Approval</h2>` +
    `<p style="color:#555;margin:0 0 16px;">Raised by <b>${esc(rec[COL.NAME])}</b> (${esc(rec[COL.EMAIL])})${rec[COL.EMPID] ? ' · ' + esc(rec[COL.EMPID]) : ''}</p>` +
    greeting + amountBanner(rec) + requestSummary(rec) + docsBlock(rec) +
    `<div style="margin:22px 0;">${btn(approveUrl, 'APPROVE', '#0a8a0a')}&nbsp;&nbsp;${btn(rejectUrl, 'REJECT', '#c0392b')}</div>` +
    `<p style="color:#888;font-size:12px;">If the buttons don't work, paste these:<br>Approve: ${esc(approveUrl)}<br>Reject: ${esc(rejectUrl)}</p>` +
    `<p style="color:#aaa;font-size:11px;margin-top:18px;">${esc(CONFIG.COMPANY_NAME)} ${esc(CONFIG.APP_NAME)}</p></div>`;
}

export function rejectedEmailHtml(rec, stageLabel, comment) {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;color:#b00;">Expense Request ${esc(rec[COL.ID])} — Rejected</h2>` +
    `<p style="color:#555;margin:0 0 14px;">Your request for <b>${esc(rec[COL.ITEM])}</b> was rejected at the <b>${esc(stageLabel)}</b> stage.</p>` +
    (comment ? `<p style="background:#fff5f5;border:1px solid #f3c0c0;border-radius:6px;padding:10px 13px;font-size:13px;"><b>Remark:</b> ${esc(comment)}</p>` : '') +
    requestSummary(rec) + `</div>`;
}

// Generic operational notice (PO issued, approved, paid, etc.)
export function noticeEmailHtml(rec, heading, body, link) {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;">Expense Request ${esc(rec[COL.ID])}</h2>` +
    `<p style="font-size:16px;font-weight:700;margin:6px 0 4px;color:#0D1B2A;">${esc(heading)}</p>` +
    `<p style="color:#555;margin:0 0 14px;">${body || ''}</p>` +
    requestSummary(rec) +
    (link ? `<p style="margin:18px 0;"><a href="${esc(link)}" style="display:inline-block;padding:12px 24px;background:#0D1B2A;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Open Dashboard →</a></p>` : '') +
    `</div>`;
}

function reminderBanner(stageLabel, hours) {
  return `<div style="background:#FFF7E6;border:1px solid #F59E0B;color:#92400E;padding:11px 14px;border-radius:6px;margin:0 0 14px;font-family:Arial,sans-serif;">` +
    `<b>⏰ Reminder:</b> awaiting your <b>${esc(stageLabel)}</b> action for about <b>${hours} hours</b>.</div>`;
}
export function reminderEmailHtml(rec, stageLabel, approverName, approveUrl, rejectUrl, hours) {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;">` +
    reminderBanner(stageLabel, hours) + approvalEmailHtml(rec, stageLabel, approverName, approveUrl, rejectUrl) + `</div>`;
}
export function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

// Weekly digest: a compact table of the recipient's pending items (rows already formatted).
// cols: array of header strings; rows: array of arrays (cells, plain strings).
export function digestEmailHtml(heading, intro, cols, rows, link, linkLabel) {
  const th = cols.map((c) => `<th style="text-align:left;padding:7px 10px;border-bottom:2px solid #0D1B2A;font-size:12px;color:#0D1B2A;">${esc(c)}</th>`).join('');
  const body = rows.length
    ? rows.map((r, i) => `<tr style="background:${i % 2 ? '#f7f8fa' : '#fff'};">` + r.map((cell, ci) => `<td style="padding:7px 10px;border-bottom:1px solid #eee;font-size:13px;${ci === 0 ? 'font-weight:700;color:#0D1B2A;' : 'color:#333;'}">${esc(String(cell == null ? '' : cell))}</td>`).join('') + '</tr>').join('')
    : `<tr><td colspan="${cols.length}" style="padding:14px;text-align:center;color:#0a8a0a;font-size:14px;">🎉 Nothing pending — you're all caught up.</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;color:#0D1B2A;">${esc(heading)}</h2>` +
    `<p style="color:#555;margin:0 0 14px;font-size:14px;">${intro || ''}</p>` +
    `<table style="border-collapse:collapse;width:100%;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>` +
    (link ? `<p style="margin:18px 0;"><a href="${esc(link)}" style="display:inline-block;padding:12px 24px;background:#0D1B2A;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">${esc(linkLabel || 'Open Dashboard')} →</a></p>` : '') +
    `<p style="color:#aaa;font-size:11px;margin-top:18px;">${esc(CONFIG.COMPANY_NAME)} ${esc(CONFIG.APP_NAME)} · weekly digest. Reply to Finance to opt out.</p></div>`;
}
