import { google } from 'googleapis';
import { Readable } from 'stream';

// Uploads (quotations / invoices) go to a Drive folder shared (Editor) with the service account.
// Env: GDRIVE_FOLDER_ID (+ the same GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY).
function driveAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').replace(/\r/g, '');
  if (!email || !key) throw new Error('Missing service-account credentials');
  return new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/drive']);
}

export function driveConfigured() { return !!process.env.GDRIVE_FOLDER_ID; }

export async function uploadToDrive({ filename, mimeType, base64 }) {
  const folderId = process.env.GDRIVE_FOLDER_ID;
  if (!folderId) throw new Error('GDRIVE_FOLDER_ID not set');
  const drive = google.drive({ version: 'v3', auth: driveAuth() });
  const buffer = Buffer.from(base64, 'base64');

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buffer) },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  // Restrict viewing to the company domain only — anyone signed in with an @<domain> Google
  // account can open the doc, but a leaked link is useless to outsiders.
  const domain = process.env.ALLOWED_DOMAIN || 'spyne.ai';
  try {
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: 'reader', type: 'domain', domain, allowFileDiscovery: false },
      supportsAllDrives: true,
    });
  } catch (e) { /* non-fatal: Shared Drive membership still governs access */ }
  return { id: res.data.id, link: res.data.webViewLink };
}
