import { requireRole } from '../lib/auth.js';
import { uploadToDrive, driveConfigured } from '../lib/drive.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  if (!requireRole(req, res, 'requester')) return;
  if (!driveConfigured()) { res.status(200).json({ ok: false, error: 'Uploads not configured yet (GDRIVE_FOLDER_ID missing).' }); return; }
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!b.filename || !b.base64) throw new Error('filename and base64 are required');
    const r = await uploadToDrive({ filename: b.filename, mimeType: b.mimeType, base64: b.base64 });
    res.status(200).json({ ok: true, link: r.link, id: r.id });
  } catch (err) {
    console.error('upload error:', err);
    res.status(200).json({ ok: false, error: String(err.message || err) });
  }
}
