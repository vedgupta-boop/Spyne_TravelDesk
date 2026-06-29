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

export function parseLines(rec) {
  try { const a = JSON.parse(rec[COL.LINES] || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function linesTable(rec) {
  const cur = rec[COL.CURRENCY] || 'INR';
  const lines = parseLines(rec);
  if (!lines.length) return '';
  let html = '<table style="border-collapse:collapse;width:100%;font-size:13px;font-family:Arial,sans-serif;margin:8px 0 0;">' +
    '<tr style="background:#0D1B2A;color:#fff;"><th style="padding:6px 10px;text-align:left;">Date</th><th style="padding:6px 10px;text-align:left;">Category</th>' +
    '<th style="padding:6px 10px;text-align:left;">Description</th><th style="padding:6px 10px;text-align:right;">Amount</th><th style="padding:6px 10px;text-align:center;">Receipt</th></tr>';
  lines.forEach((l, i) => {
    const bg = i % 2 ? '#f7f7f7' : '#ffffff';
    const r = l.receipt ? `<a href="${esc(l.receipt)}" style="color:#0077CC;">view</a>` : '—';
    html += `<tr style="background:${bg};"><td style="padding:6px 10px;border:1px solid #eee;">${esc(l.date || '')}</td>` +
      `<td style="padding:6px 10px;border:1px solid #eee;">${esc(l.category || '')}</td>` +
      `<td style="padding:6px 10px;border:1px solid #eee;">${esc(l.description || '')}</td>` +
      `<td style="padding:6px 10px;border:1px solid #eee;text-align:right;">${esc(money(l.amount, cur))}</td>` +
      `<td style="padding:6px 10px;border:1px solid #eee;text-align:center;">${r}</td></tr>`;
  });
  return html + '</table>';
}

function requestSummary(rec) {
  const cur = rec[COL.CURRENCY] || 'INR';
  const period = [rec[COL.PERIOD_FROM], rec[COL.PERIOD_TO]].filter(Boolean).join(' → ');
  return kvTable([
    ['Claim title', rec[COL.TITLE]],
    ['Project / cost center', rec[COL.PROJECT]],
    ['Department', rec[COL.DEPT]],
    ['Expense period', period],
    ['Line items', rec[COL.LINE_COUNT]],
    ['Total claimed', money(rec[COL.AMOUNT], cur)],
    ...(Number(rec[COL.ADVANCE]) > 0 ? [['Advance already taken', money(rec[COL.ADVANCE], cur)]] : []),
    ['Net reimbursable', money(rec[COL.NET], cur)],
    ['Pay via', [rec[COL.PAY_METHOD], rec[COL.PAY_DETAIL]].filter(Boolean).join(' · ')],
    ['Purpose', rec[COL.PURPOSE]],
    ['Notes', rec[COL.NOTES]],
  ]) + linesTable(rec);
}
function amountBanner(rec) {
  const cur = rec[COL.CURRENCY] || 'INR';
  return `<div style="background:#EEF2FF;border:1px solid #C7D2FE;border-radius:8px;padding:13px 16px;margin:0 0 14px;font-family:Arial,sans-serif;">` +
    `<div style="font-size:12px;color:#3730A3;font-weight:bold;text-transform:uppercase;letter-spacing:.4px;">Net reimbursement</div>` +
    `<div style="font-size:24px;font-weight:900;color:#0D1B2A;margin-top:2px;">${esc(money(rec[COL.NET], cur))}` +
    `<span style="font-size:13px;font-weight:600;color:#555;"> · total ${esc(money(rec[COL.AMOUNT], cur))}</span></div>` +
    `<div style="font-size:12px;color:#3730A3;margin-top:4px;font-weight:600;">${esc(rec[COL.TIER] || '')}</div></div>`;
}

export function approvalEmailHtml(rec, stageLabel, approverName, approveUrl, rejectUrl) {
  const greeting = approverName ? `<p style="margin:0 0 14px;font-size:15px;">Hi <b>${esc(approverName)}</b>,</p>` : '';
  return `<div style="font-family:Arial,sans-serif;max-width:660px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;">Reimbursement ${esc(rec[COL.ID])} — ${esc(stageLabel)} Approval</h2>` +
    `<p style="color:#555;margin:0 0 16px;">Claimed by <b>${esc(rec[COL.NAME])}</b> (${esc(rec[COL.EMAIL])})${rec[COL.EMPID] ? ' · ' + esc(rec[COL.EMPID]) : ''}</p>` +
    greeting + amountBanner(rec) + requestSummary(rec) +
    `<div style="margin:22px 0;">${btn(approveUrl, 'APPROVE', '#0a8a0a')}&nbsp;&nbsp;${btn(rejectUrl, 'REJECT', '#c0392b')}</div>` +
    `<p style="color:#888;font-size:12px;">If the buttons don't work, paste these:<br>Approve: ${esc(approveUrl)}<br>Reject: ${esc(rejectUrl)}</p>` +
    `<p style="color:#aaa;font-size:11px;margin-top:18px;">${esc(CONFIG.COMPANY_NAME)} ${esc(CONFIG.APP_NAME)}</p></div>`;
}

export function rejectedEmailHtml(rec, stageLabel, comment) {
  return `<div style="font-family:Arial,sans-serif;max-width:660px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;color:#b00;">Reimbursement ${esc(rec[COL.ID])} — Rejected</h2>` +
    `<p style="color:#555;margin:0 0 14px;">Your claim <b>${esc(rec[COL.TITLE])}</b> was rejected at the <b>${esc(stageLabel)}</b> stage.</p>` +
    (comment ? `<p style="background:#fff5f5;border:1px solid #f3c0c0;border-radius:6px;padding:10px 13px;font-size:13px;"><b>Remark:</b> ${esc(comment)}</p>` : '') +
    requestSummary(rec) + `</div>`;
}

// Generic operational notice (approved, paid, etc.). `body` may be raw HTML.
export function noticeEmailHtml(rec, heading, body, link) {
  return `<div style="font-family:Arial,sans-serif;max-width:660px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;">Reimbursement ${esc(rec[COL.ID])}</h2>` +
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
  return `<div style="font-family:Arial,sans-serif;max-width:660px;margin:auto;">` +
    reminderBanner(stageLabel, hours) + approvalEmailHtml(rec, stageLabel, approverName, approveUrl, rejectUrl) + `</div>`;
}
export function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
