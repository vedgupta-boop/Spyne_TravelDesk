// Minimal RFC-5545 VCALENDAR generator (no dependencies) — one all-day VEVENT for a trip.
// Used to attach a calendar invite to the "booking confirmed" itinerary email.

function pad(n) { return String(n).padStart(2, '0'); }

function dateOnly(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}

function stampUTC(d) {
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T` +
         `${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// { uid, summary, description, location, start, end } → ICS text (CRLF-terminated).
export function tripICS({ uid, summary, description, location, start, end }) {
  const dtStart = dateOnly(start);
  // All-day DTEND is exclusive, so add one day to the (return or start) date.
  const endBase = new Date(end || start);
  endBase.setUTCDate(endBase.getUTCDate() + 1);
  const dtEnd = dateOnly(endBase);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Spyne TravelDesk//Travel//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${esc(uid)}`,
    `DTSTAMP:${stampUTC(new Date())}`,
    `DTSTART;VALUE=DATE:${dtStart}`,
    `DTEND;VALUE=DATE:${dtEnd}`,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    location ? `LOCATION:${esc(location)}` : null,
    'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n');
}
