import { issuePO, confirmDelivery, submitInvoice, withdrawRequest, recallRequest, recordPayment } from '../lib/workflow.js';
import { findById } from '../lib/sheets.js';
import { getSession, baseUrl, requireRole } from '../lib/auth.js';
import { COL } from '../lib/config.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  const s = getSession(req);
  if (!s) { res.status(401).json({ ok: false, error: 'Not signed in', authRequired: true }); return; }
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const action = b.action;
  try {
    if (action === 'po') {
      if (!(s.roles || []).includes('finance')) { res.status(403).json({ ok: false, error: 'Finance only' }); return; }
      res.status(200).json(await issuePO(b.id, b.poNumber, baseUrl(req)));
      return;
    }
    if (action === 'deliver' || action === 'invoice') {
      // requester (owner) or finance may complete these operational steps
      const rec = await findById(b.id);
      if (!rec) { res.status(200).json({ ok: false, error: 'Request not found' }); return; }
      const owner = String(rec[COL.EMAIL] || '').toLowerCase() === String(s.email || '').toLowerCase();
      if (!owner && !(s.roles || []).includes('finance')) { res.status(403).json({ ok: false, error: 'Only the requester or Finance can do this.' }); return; }
      if (action === 'deliver') res.status(200).json(await confirmDelivery(b.id, s.email));
      else res.status(200).json(await submitInvoice(b.id, { invoiceDoc: b.invoiceDoc, invoiceDocs: b.invoiceDocs, region: b.region, baseAmount: b.baseAmount, taxAmount: b.taxAmount || b.gstAmount, totalAmount: b.totalAmount, gstNumber: b.gstNumber, invoiceNumber: b.invoiceNumber, invoiceDate: b.invoiceDate, category: b.category }, baseUrl(req)));
      return;
    }
    if (action === 'pay') {
      if (!(s.roles || []).includes('finance')) { res.status(403).json({ ok: false, error: 'Finance only' }); return; }
      res.status(200).json(await recordPayment({ id: b.id, amount: b.amount, date: b.date, ref: b.ref, mode: b.mode, doc: b.doc, email: s.email, roles: s.roles }, baseUrl(req)));
      return;
    }
    if (action === 'withdraw') { res.status(200).json(await withdrawRequest(b.id, s.email)); return; }
    if (action === 'recall') { res.status(200).json(await recallRequest(b.id, s.email)); return; }
    res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('action error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
