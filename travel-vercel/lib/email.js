import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { CONFIG, COL } from './config.js';
import { money } from './costs.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// SMTP transport (Gmail / Google Workspace App Password). Cached across warm invocations.
let _smtp = null;
function smtpTransport() {
  if (_smtp) return _smtp;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  _smtp = nodemailer.createTransport({
    host, port, secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _smtp;
}

// Best-effort email. Never throws — a blocked/failed send is logged but must NOT break a
// submission or approval. Prefers SMTP (Gmail App Password, e.g. traveldesk@spyne.ai) when
// SMTP_USER + SMTP_PASS are set; otherwise falls back to Resend.
export async function sendEmail({ to, subject, html, cc, attachments }) {
  const toList = Array.isArray(to) ? to : [to];
  const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : undefined;
  // From must be the authenticated Gmail user (or a verified send-as alias) → default to SMTP_USER.
  const from = process.env.FROM_EMAIL || process.env.SMTP_USER || `${CONFIG.COMPANY_NAME} Travel <onboarding@resend.dev>`;

  // --- Preferred: SMTP via Gmail App Password ---
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      // attachments arrive as [{ filename, content }] with content = base64 string.
      const att = Array.isArray(attachments) && attachments.length
        ? attachments.map((a) => ({ filename: a.filename, content: a.content, encoding: 'base64' }))
        : undefined;
      const info = await smtpTransport().sendMail({ from, to: toList, cc: ccList, subject, html, attachments: att });
      return { ok: true, data: info };
    } catch (e) {
      console.error('SMTP send failed (non-fatal) to', to, '->', e.message || e);
      return { ok: false, error: e.message || String(e) };
    }
  }

  // --- Fallback: Resend ---
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('No SMTP_USER/SMTP_PASS and no RESEND_API_KEY — skipping email to', to); return { ok: false, skipped: true }; }
  try {
    const resend = new Resend(apiKey);
    const payload = { from, to: toList, subject, html };
    if (ccList) payload.cc = ccList;
    if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
    const { data, error } = await resend.emails.send(payload);
    if (error) { console.error('Resend error (non-fatal) to', to, '->', error.message || JSON.stringify(error)); return { ok: false, error }; }
    return { ok: true, data };
  } catch (e) {
    console.error('Email send threw (non-fatal) to', to, '->', e.message || e);
    return { ok: false, error: e.message || String(e) };
  }
}

function btn(url, label, color) {
  return `<a href="${url}" style="display:inline-block;padding:12px 26px;background:${color};color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px;">${label}</a>`;
}

function kvTable(rows) {
  let html = '<table style="border-collapse:collapse;width:100%;font-size:14px;font-family:Arial,sans-serif;">';
  rows.forEach((r, i) => {
    const bg = i % 2 ? '#f7f7f7' : '#ffffff';
    html += `<tr style="background:${bg};"><td style="padding:7px 12px;border:1px solid #eee;color:#555;width:34%;">${esc(r[0])}</td>` +
            `<td style="padding:7px 12px;border:1px solid #eee;">${esc(String(r[1] == null ? '' : r[1]))}</td></tr>`;
  });
  return html + '</table>';
}

function passengerNames(rec) {
  try { const a = JSON.parse(rec[COL.PASSENGERS] || '[]'); return Array.isArray(a) ? a.map((x) => x && x.name).filter(Boolean) : []; }
  catch { return []; }
}

function tripSummary(rec) {
  const names = passengerNames(rec);
  const reqBy = String(rec[COL.REQUESTED_BY] || '').trim();
  const traveller = String(rec[COL.EMAIL] || '').trim();
  const onBehalf = reqBy && traveller && reqBy.toLowerCase() !== traveller.toLowerCase();
  return kvTable([
    ['Traveller', (rec[COL.NAME] || '') + (traveller ? ` <${traveller}>` : '')],
    ...(onBehalf ? [['Requested by', reqBy]] : []),
    ...(names.length > 1 ? [['Passengers (' + names.length + ')', names.join(', ')]] : []),
    ['Travel Type', cap(rec[COL.TYPE]) + ' · ' + rec[COL.TRIP]],
    ['Outbound', rec[COL.FROM] + ' → ' + rec[COL.TO]],
    ...(rec[COL.RETFROM] || rec[COL.RETTO] ? [['Return', (rec[COL.RETFROM] || rec[COL.TO]) + ' → ' + (rec[COL.RETTO] || rec[COL.FROM])]] : []),
    ['Dates', rec[COL.START] + (rec[COL.RET] ? ' to ' + rec[COL.RET] : '') + `  (${rec[COL.DAYS]} day(s), ${rec[COL.NIGHTS]} night(s))`],
    ['Department', rec[COL.DEPT]],
    ['Purpose', rec[COL.PURPOSE]],
    ['Transport', rec[COL.MODE]],
  ]);
}

export function breakdownTable(rec) {
  const cur = rec[COL.CURRENCY];
  const line = (label, amount, sub) =>
    `<tr><td style="padding:8px 12px;border:1px solid #eee;">${label}${sub ? ` <span style="color:#999;font-size:12px;">${sub}</span>` : ''}</td>` +
    `<td style="padding:8px 12px;border:1px solid #eee;text-align:right;white-space:nowrap;">${money(amount, cur)}</td></tr>`;
  let html = '<table style="border-collapse:collapse;width:100%;font-size:14px;font-family:Arial,sans-serif;margin-top:6px;">';
  html += `<tr style="background:#0D1B2A;color:#fff;"><th style="padding:8px 12px;text-align:left;">Cost Breakdown</th><th style="padding:8px 12px;text-align:right;">${esc(cur)}</th></tr>`;
  html += line('🚆 Travel / Transport', rec[COL.C_TRANSPORT]);
  html += line('🏨 Hotel', rec[COL.C_HOTEL], rec[COL.HOTEL_REQ] === 'Yes' ? `${money(rec[COL.HOTEL_RATE], cur)}/night × ${rec[COL.HOTEL_NIGHTS]}` : 'not required');
  html += line('🍽️ Meals', rec[COL.C_MEALS], `${money(rec[COL.MEAL_RATE], cur)}/day × ${rec[COL.DAYS]}`);
  html += line('🚖 Local Travel', rec[COL.C_LOCAL]);
  // itemised additional allowances (visa, insurance, phone, laundry, deposit, baggage)
  let extras = {}; try { extras = JSON.parse(rec[COL.C_EXTRAS] || '{}') || {}; } catch (e) { extras = {}; }
  const EXLBL = { visa: 'Visa fee', insurance: 'Travel insurance', phone: 'Phone / communication', laundry: 'Laundry', baggage: 'Baggage (US domestic)' };
  Object.keys(EXLBL).forEach((k) => { if (Number(extras[k]) > 0) html += line('➕ ' + EXLBL[k], extras[k]); });
  html += `<tr style="background:#f3f6fb;font-weight:bold;font-size:15px;"><td style="padding:10px 12px;border:1px solid #e3e8f0;">TOTAL EXPENSES</td>` +
          `<td style="padding:10px 12px;border:1px solid #e3e8f0;text-align:right;">${money(rec[COL.C_TOTAL], cur)}</td></tr>`;
  // Advances shown SEPARATELY (refundable, not trip expenses): forex advance + hotel security deposit.
  if (Number(rec[COL.FOREX]) > 0) html += `<tr style="background:#eef2ff;color:#3730a3;font-weight:bold;"><td style="padding:8px 12px;border:1px solid #e3e8f0;">💱 Forex advance (meals &amp; local) — advance</td>` +
          `<td style="padding:8px 12px;border:1px solid #e3e8f0;text-align:right;">${money(rec[COL.FOREX], 'USD')}</td></tr>`;
  if (Number(rec[COL.C_DEPOSIT]) > 0) html += `<tr style="background:#eef2ff;color:#3730a3;font-weight:bold;"><td style="padding:8px 12px;border:1px solid #e3e8f0;">🏨 Hotel security deposit — advance</td>` +
          `<td style="padding:8px 12px;border:1px solid #e3e8f0;text-align:right;">${money(rec[COL.C_DEPOSIT], 'USD')}</td></tr>`;
  html += '</table>';
  html += `<p style="font-size:12px;color:#555;margin:8px 0 0;"><b>Budget check:</b> ${esc(rec[COL.FLAG])}</p>`;
  if (rec[COL.NOTES]) html += `<p style="font-size:13px;color:#333;margin:8px 0 0;"><b>Notes:</b> ${esc(rec[COL.NOTES])}</p>`;
  return html;
}

export function approvalEmailHtml(rec, stageLabel, approveUrl, rejectUrl) {
  const banner = /^(OVER BUDGET|POLICY BREAK)/.test(String(rec[COL.FLAG]))
    ? `<div style="background:#ffe5e5;border:1px solid #b00;color:#900;padding:10px;border-radius:6px;margin:0 0 14px;font-family:Arial,sans-serif;"><b>⚠ ${esc(rec[COL.FLAG])}</b></div>`
    : '';
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;">Travel Request ${esc(rec[COL.ID])} — ${esc(stageLabel)} Approval</h2>` +
    `<p style="color:#555;margin:0 0 16px;">Requested by <b>${esc(rec[COL.NAME])}</b> (${esc(rec[COL.EMAIL])})</p>` +
    banner + tripSummary(rec) + breakdownTable(rec) +
    `<div style="margin:22px 0;">${btn(approveUrl, 'APPROVE', '#0a8a0a')}&nbsp;&nbsp;${btn(rejectUrl, 'REJECT', '#c0392b')}</div>` +
    `<p style="color:#888;font-size:12px;">If the buttons don't work, paste these:<br>Approve: ${esc(approveUrl)}<br>Reject: ${esc(rejectUrl)}</p></div>`;
}

export function adminEmailHtml(rec, base) {
  const portal = base ? `<p style="margin:18px 0;"><a href="${esc(base)}/admin" style="display:inline-block;padding:12px 24px;background:#0D1B2A;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Open in Admin portal →</a></p>` : '';
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;">Travel Request ${esc(rec[COL.ID])} — APPROVED ✅</h2>` +
    `<p style="color:#555;margin:0 0 16px;">Fully approved. Please make arrangements per policy.</p>` +
    `<p style="margin:0 0 16px;">Traveller: <b>${esc(rec[COL.NAME])}</b> (${esc(rec[COL.EMAIL])})</p>` +
    tripSummary(rec) + breakdownTable(rec) + portal +
    `<p style="color:#888;font-size:12px;margin-top:8px;">Sign in to make the booking and update the status.</p></div>`;
}

// Sent to the requester once Admin completes booking. Lists each flight/hotel leg with the
// booking reference + document link. A .ics calendar invite is attached separately.
export function itineraryEmailHtml(rec, itinerary, bookings) {
  const flights = (itinerary && itinerary.flights) || [];
  const hotels = (itinerary && itinerary.hotels) || [];
  const bf = (bookings && bookings.flights) || [];
  const bh = (bookings && bookings.hotels) || [];
  const cell = (s) => `<td style="padding:7px 10px;border:1px solid #eee;font-size:13px;">${esc(s == null ? '' : s)}</td>`;
  const docLink = (d) => d ? `<a href="${esc(d)}" style="color:#0077CC;">View</a>` : '—';
  let html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;">Your trip is booked ✈️ · ${esc(rec[COL.ID])}</h2>` +
    `<p style="color:#555;margin:0 0 16px;">Traveller: <b>${esc(rec[COL.NAME])}</b>. A calendar invite is attached. Booking details below — safe travels!</p>`;
  if (flights.length) {
    html += `<h3 style="margin:16px 0 6px;font-size:15px;">Flights</h3><table style="border-collapse:collapse;width:100%;">` +
      `<tr style="background:#0D1B2A;color:#fff;"><th style="padding:7px 10px;text-align:left;font-size:12px;">Leg</th><th style="padding:7px 10px;text-align:left;font-size:12px;">Route</th><th style="padding:7px 10px;text-align:left;font-size:12px;">Date &amp; time</th><th style="padding:7px 10px;text-align:left;font-size:12px;">Booking</th><th style="padding:7px 10px;text-align:left;font-size:12px;">Ticket</th></tr>`;
    flights.forEach((f, i) => {
      const dt = f.date + (f.timeLabel ? `<br><span style="color:#777;font-size:11px;">${esc(f.timeLabel)}</span>` : '');
      html += `<tr>${cell(f.label)}${cell((f.from || '') + ' → ' + (f.to || ''))}<td style="padding:7px 10px;border:1px solid #eee;font-size:13px;">${dt}</td>${cell((bf[i] && bf[i].info) || 'TBA')}<td style="padding:7px 10px;border:1px solid #eee;font-size:13px;">${docLink(bf[i] && bf[i].doc)}</td></tr>`;
    });
    html += `</table>`;
  }
  if (hotels.length) {
    html += `<h3 style="margin:16px 0 6px;font-size:15px;">Hotels</h3><table style="border-collapse:collapse;width:100%;">` +
      `<tr style="background:#0D1B2A;color:#fff;"><th style="padding:7px 10px;text-align:left;font-size:12px;">Stay</th><th style="padding:7px 10px;text-align:left;font-size:12px;">City</th><th style="padding:7px 10px;text-align:left;font-size:12px;">Check-in → out</th><th style="padding:7px 10px;text-align:left;font-size:12px;">Booking</th><th style="padding:7px 10px;text-align:left;font-size:12px;">Voucher</th></tr>`;
    hotels.forEach((h, i) => {
      html += `<tr>${cell(h.label)}${cell(h.city)}${cell((h.checkIn || '') + ' → ' + (h.checkOut || ''))}${cell((bh[i] && bh[i].info) || 'TBA')}<td style="padding:7px 10px;border:1px solid #eee;font-size:13px;">${docLink(bh[i] && bh[i].doc)}</td></tr>`;
    });
    html += `</table>`;
  }
  html += tripSummary(rec) + `</div>`;
  return html;
}

export function forexOfficerEmailHtml(rec, link) {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">` +
    `<h2 style="margin:0 0 4px;">Forex Card — Issuance Required · ${esc(rec[COL.ID])}</h2>` +
    `<p style="color:#555;margin:0 0 14px;">Flight booking is complete. Please verify the details, issue the forex card, upload the confirmation, and mark Completed.<br><b>KYC:</b> collect the traveller's original passport at handover.</p>` +
    `<p style="margin:0 0 14px;">Traveller: <b>${esc(rec[COL.NAME])}</b> (${esc(rec[COL.EMAIL])})</p>` +
    tripSummary(rec) + breakdownTable(rec) +
    `<p style="margin:18px 0;"><a href="${esc(link)}" style="display:inline-block;padding:12px 24px;background:#0D1B2A;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Open Forex View →</a></p></div>`;
}

function reminderBanner(stageLabel, hours) {
  return `<div style="background:#FFF7E6;border:1px solid #F59E0B;color:#92400E;padding:11px 14px;border-radius:6px;margin:0 0 14px;font-family:Arial,sans-serif;">` +
    `<b>⏰ Reminder:</b> this request has been awaiting your <b>${esc(stageLabel)}</b> action for about <b>${hours} hours</b>. Please action it at the earliest.</div>`;
}

// Reminder for an APPROVAL stage (HOD / CEO / Finance / Admin) — reuses the live approve/reject links.
export function reminderEmailHtml(rec, stageLabel, approveUrl, rejectUrl, hours) {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;">` +
    reminderBanner(stageLabel, hours) + approvalEmailHtml(rec, stageLabel, approveUrl, rejectUrl) + `</div>`;
}

// Reminder for a TASK stage (Admin arrangements / Forex card issuance) — links to the dashboard.
export function taskReminderEmailHtml(rec, title, link, hours) {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1a2332;">` +
    reminderBanner(title, hours) +
    `<h2 style="margin:0 0 4px;">Travel Request ${esc(rec[COL.ID])} — ${esc(title)}</h2>` +
    `<p style="color:#555;margin:0 0 14px;">Traveller: <b>${esc(rec[COL.NAME])}</b> (${esc(rec[COL.EMAIL])})</p>` +
    tripSummary(rec) +
    `<p style="margin:18px 0;"><a href="${esc(link)}" style="display:inline-block;padding:12px 24px;background:#0D1B2A;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Open Dashboard →</a></p></div>`;
}

export function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
