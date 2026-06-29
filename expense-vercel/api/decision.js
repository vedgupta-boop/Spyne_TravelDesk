import { handleDecision, approverData, approverDecision } from '../lib/workflow.js';
import { CONFIG, isApprover } from '../lib/config.js';
import { getSession, baseUrl } from '../lib/auth.js';

function requireApprover(req, res) {
  const s = getSession(req);
  if (!s) { res.status(401).json({ ok: false, error: 'Not signed in', authRequired: true }); return null; }
  if (!isApprover(s.roles || [])) { res.status(403).json({ ok: false, error: 'Not an approver' }); return null; }
  return s;
}

function page({ title, msg, color }) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#f4f4f4;margin:0;padding:40px;}
.card{max-width:480px;margin:40px auto;background:#fff;border-radius:10px;padding:34px;box-shadow:0 2px 10px rgba(0,0,0,.08);text-align:center;}
h1{color:${color};margin:0 0 12px;font-size:22px;}p{color:#444;font-size:15px;line-height:1.5;}</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(msg)}</p>
<p style="color:#999;font-size:12px;margin-top:20px;">${esc(CONFIG.COMPANY_NAME)} ${esc(CONFIG.APP_NAME)} · Expense Approval</p></div></body></html>`;
}

export default async function handler(req, res) {
  // Authenticated approver action (HOD / CEO / Finance) — approve / reject / hold + comment.
  if (req.method === 'POST') {
    const s = requireApprover(req, res); if (!s) return;
    try {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      res.status(200).json(await approverDecision({ id: b.id, decision: b.decision, comment: b.comment, email: s.email, roles: s.roles }, baseUrl(req)));
    } catch (err) {
      console.error('approver decision error:', err);
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
    return;
  }
  // Authenticated approvals dashboard data — scoped to what this approver can act on.
  if (req.query && req.query.view === 'approvals') {
    const s = requireApprover(req, res); if (!s) return;
    try { res.status(200).json(await approverData({ email: s.email, roles: s.roles, as: req.query && req.query.as })); }
    catch (err) { console.error('approver data error:', err); res.status(500).json({ ok: false, error: String(err.message || err) }); }
    return;
  }
  // Default: token-based approve/reject from the email links → HTML result page.
  const q = req.query || {};
  let result;
  try {
    result = await handleDecision({ id: q.id, stage: q.stage, decision: q.decision, token: q.token }, baseUrl(req));
  } catch (err) {
    console.error('decision error:', err);
    result = { title: 'Error', msg: String(err.message || err), color: '#b00' };
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(page(result));
}
