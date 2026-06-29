import { approverData, approverDecision, delegateRequest, approveReimbursement, requestClarification } from '../lib/workflow.js';
import { isApprover } from '../lib/config.js';
import { getSession, baseUrl } from '../lib/auth.js';
import { applyRoleOverrides } from '../lib/rolesstore.js';

function requireApprover(req, res) {
  const s = getSession(req);
  if (!s) { res.status(401).json({ ok: false, error: 'Not signed in', authRequired: true }); return null; }
  if (!isApprover(s.roles || [])) { res.status(403).json({ ok: false, error: 'Not an approver' }); return null; }
  return s;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  const s = String(req.body);
  if (s.trim().startsWith('{')) { try { return JSON.parse(s); } catch { return {}; } }
  const o = {}; new URLSearchParams(s).forEach((v, k) => { o[k] = v; }); return o;
}

export default async function handler(req, res) {
  await applyRoleOverrides(); // current role assignments before approver check / routing
  // Approver action — ALWAYS requires an authenticated, authorized session (no token one-click).
  // The approval is gated by the signed-in user's role + the no-self-approval rule (myStageFor).
  if (req.method === 'POST') {
    const s = requireApprover(req, res); if (!s) return;
    try {
      const b = parseBody(req);
      if (b.action === 'delegate') { res.status(200).json(await delegateRequest({ id: b.id, to: b.to, email: s.email, roles: s.roles }, baseUrl(req))); return; }
      if (b.action === 'reimburse') { res.status(200).json(await approveReimbursement(b.id, s.email, s.roles)); return; }
      if (b.action === 'clarify') { res.status(200).json(await requestClarification({ id: b.id, comment: b.comment, email: s.email, roles: s.roles }, baseUrl(req))); return; }
      res.status(200).json(await approverDecision({ id: b.id, decision: b.decision, comment: b.comment, email: s.email, roles: s.roles }, baseUrl(req)));
    } catch (err) {
      console.error('approver decision error:', err);
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
    return;
  }
  // Approvals dashboard data — scoped to what this approver can act on.
  if (req.query && (req.query.view === 'hod' || req.query.view === 'approvals')) {
    const s = requireApprover(req, res); if (!s) return;
    try { res.status(200).json(await approverData({ email: s.email, roles: s.roles })); }
    catch (err) { console.error('approver data error:', err); res.status(500).json({ ok: false, error: String(err.message || err) }); }
    return;
  }
  // Email "Approve/Reject" links (and any legacy token links) → send the approver to the
  // login-gated portal page. The decision is made there, signed in. Nothing approves on GET.
  const q = req.query || {};
  const base = baseUrl(req);
  if (q.id && q.stage && q.decision) {
    const url = `${base}/approve?id=${encodeURIComponent(q.id)}&stage=${encodeURIComponent(q.stage)}&decision=${encodeURIComponent(q.decision)}`;
    res.writeHead(302, { Location: url }); res.end(); return;
  }
  res.writeHead(302, { Location: `${base}/hod` }); res.end();
}
