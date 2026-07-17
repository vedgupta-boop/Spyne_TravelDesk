import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, Header, Footer, ImageRun } from 'docx';
import { CONFIG, COL } from './config.js';
import { money } from './costs.js';
import { LETTERHEAD_LOGO_B64 } from './letterheadlogo.js';

const COMPANY = 'Eventila Technologies Pvt Ltd';

// ---- Spyne letterhead: logo header + a thin rule, and the Eventila footer block ----
function letterheadHeader() {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new ImageRun({ type: 'png', data: Buffer.from(LETTERHEAD_LOGO_B64, 'base64'), transformation: { width: 221, height: 53 } })],
      }),
      new Paragraph({ spacing: { after: 0 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'A0A0A0', space: 1 } }, children: [] }),
    ],
  });
}
function footLine(text, bold) {
  return new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 0, line: 200, lineRule: 'auto' },
    children: [new TextRun({ text, bold: !!bold, size: 15, font: 'Times New Roman', color: '595959' })],
  });
}
function letterheadFooter() {
  return new Footer({
    children: [
      new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 6, color: 'A0A0A0', space: 1 } }, spacing: { before: 40, after: 20 }, children: [] }),
      footLine('Eventila Technologies Private Limited', true),
      footLine('CIN: U72100DL2015PTC281740'),
      footLine('Registered office: Flat No. D-2, 3rd Floor, Metro Green Apartment, Plot Number 1063B, Ward 8, Mehrauli, New Delhi- 110030'),
      footLine('Correspondence Address: 601-612P, JMD Megapolis, Sec 48, Gurugram, Haryana 122018'),
      footLine('Phone: +91-8644 8644 61  |  Email: hr@spyne.ai  |  Web: www.spyne.ai'),
    ],
  });
}

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after != null ? opts.after : 120 },
    alignment: opts.align,
    children: [new TextRun({ text: text || '', bold: !!opts.bold, size: opts.size || 22 })],
  });
}

function row(label, value) {
  const cell = (txt, bold) => new TableCell({
    width: { size: 38, type: WidthType.PERCENTAGE },
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    children: [new Paragraph({ children: [new TextRun({ text: String(txt == null ? '' : txt), bold: !!bold, size: 20 })] })],
  });
  return new TableRow({ children: [cell(label, true), new TableCell({
    width: { size: 62, type: WidthType.PERCENTAGE },
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    children: [new Paragraph({ children: [new TextRun({ text: String(value == null ? '' : value), size: 20 })] })],
  })] });
}

// Verbatim BookMyForex declaration (latest format, 2026-06).
const DECLARATION =
  'It is certified that the expenses for the above trip are being borne by the firm/company and we undertake that the same shall be ' +
  'utilized for the purpose stated above. It is hereby declared that the transaction, the details of which are mentioned above does not ' +
  'involve, and is not designed for or in contravention or evasion of any provision of the Foreign Exchange Management Act, 1999, or of ' +
  'any Rule, Regulation, Notification, Direction or Order issued/made thereunder. We also hereby agree and undertake to submit ' +
  'information/documents as will reasonably satisfy you about this transaction in terms of the above declaration. I/We further confirm ' +
  'that the foreign exchange released for the above-mentioned purpose shall be used within 60 days of purchase. In case it is not possible ' +
  'to use the said foreign exchange within 60 days, the same shall be surrendered to an Authorized Person. We further declare that the ' +
  'undersigned has the authority to give this declaration on behalf of the firm/company. We also understand that if the complete details ' +
  'as required above in A to H and the required KYC documents are not furnished, BookMyForex shall refuse in writing to undertake the ' +
  'transaction and shall, if it has reason to believe, may report the matter to Reserve Bank of India (RBI) / Financial Intelligence Unit ' +
  '(FIU). This application for release of foreign exchange as above is being made following the provision of the RBI Master Circular on ' +
  'Miscellaneous Remittances from India – Facilities for Residents. We undertake that the foreign exchange released via this application ' +
  "shall be utilized for the employee's overseas travel only. We agree with Terms of use of BookMyForex.";

// A bulleted "label: value" line for the employee-details block.
function bullet(label, value) {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: '•  ', size: 22 }),
      new TextRun({ text: label + ': ', bold: true, size: 22 }),
      new TextRun({ text: String(value == null ? '' : value), size: 22 }),
    ],
  });
}

// "To," (left) and "Date: …" (right) on one line, in a borderless table.
function toDateTable(today) {
  const nb = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const cell = (runs, align) => new TableCell({
    width: { size: 50, type: WidthType.PERCENTAGE },
    borders: { top: nb, bottom: nb, left: nb, right: nb },
    children: [new Paragraph({ alignment: align, children: runs })],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: nb, bottom: nb, left: nb, right: nb, insideHorizontal: nb, insideVertical: nb },
    rows: [new TableRow({ children: [
      cell([new TextRun({ text: 'To,', size: 22 })], AlignmentType.LEFT),
      cell([new TextRun({ text: 'Date: ' + today, size: 22 })], AlignmentType.RIGHT),
    ] })],
  });
}

const GREY = 'BFBFBF';
function borderedTable(rows) {
  const b = { style: BorderStyle.SINGLE, size: 4, color: GREY };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b },
    rows,
  });
}

function parseTopups(rec) {
  try { const a = JSON.parse(rec[COL.FOREX_TOPUPS] || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

export async function buildForexLetter(rec, opts) {
  opts = opts || {};
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  // opts.amount → a letter for a SPECIFIC amount (e.g. a single top-up); otherwise the full total.
  const totalForex = (opts.amount != null && opts.amount !== '') ? Number(opts.amount)
    : Number(rec[COL.FOREX] || 0) + parseTopups(rec).reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const exchange = money(totalForex, 'USD');
  const fmtDate = (v) => { const d = new Date(v); return isNaN(d) ? (v || '') : d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }); };
  const ticket = rec[COL.TICKET_INFO] || '____________________';
  const airlines = rec[COL.AIRLINES] || '________________';
  const travelDate = rec[COL.START] ? fmtDate(rec[COL.START]) : '________________';

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 1800, bottom: 1400, left: 1440, right: 1440, header: 480, footer: 360 } } },
      headers: { default: letterheadHeader() },
      footers: { default: letterheadFooter() },
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
          children: [new TextRun({ text: 'Application cum Declaration Form for release of Foreign Exchange under Business Travel', bold: true, size: 24 })] }),
        toDateTable(today),
        p('The Manager', { after: 0 }),
        p('Book My Forex Pvt Ltd', { after: 160 }),
        p('We request you to release foreign exchange to our employee for his/her business travel abroad as mentioned below.', { after: 160 }),

        bullet('Name of Person', rec[COL.NAME]),
        bullet('Designation', rec[COL.DESIGNATION]),
        bullet('Residential Address', rec[COL.ADDRESS]),
        bullet('Residential Status', 'Resident'),
        bullet('PAN No.', rec[COL.PAN_NO] || ''),

        p('Passport Details:', { bold: true, after: 60 }),
        borderedTable([
          row('Passport No.', rec[COL.PASSPORT_NO]),
          row('Date & Place of Issue', rec[COL.PASSPORT_ISSUE]),
          row('Expiry Date', rec[COL.PASSPORT_EXPIRY] ? fmtDate(rec[COL.PASSPORT_EXPIRY]) : ''),
        ]),
        p('', { after: 80 }),

        p('Foreign Exchange Requirement:', { bold: true, after: 60 }),
        borderedTable([
          row('Country/Countries to be visited', rec[COL.TO]),
          row('Purpose of visit', rec[COL.PURPOSE]),
          row('Duration of stay abroad (No. of days)', rec[COL.DAYS]),
          row('Total foreign-exchange required', exchange),
          row('Cash', ''),
          row('Card', exchange),
        ]),
        p('', { after: 120 }),

        p(`Air ticket no.: ${ticket}    Airlines: ${airlines}    Date of Travel: ${travelDate}`, { after: 160 }),

        p('Declaration:', { bold: true, after: 60 }),
        p(DECLARATION, { after: 160, size: 18 }),
        p('We enclose our payment advice towards the cost of the foreign exchange.', { after: 300 }),

        p(COMPANY, { bold: true, after: 60 }),
        p('Name & Designation: ____________________', { after: 60 }),
        p('(company stamp with signature)', { after: 0 }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

export function forexLetterFilename(rec, opts) {
  opts = opts || {};
  const suffix = (opts.amount != null && opts.amount !== '') ? `-TopUp-USD${Math.round(Number(opts.amount) || 0)}` : '';
  return `Forex-Letter-${rec[COL.ID] || 'request'}${suffix}.docx`;
}
