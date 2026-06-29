import { createBudget, createReallocation, addVendorMapping, createClaim, budgetDecision, budgetData, lockedBudgetsFor, closeBudget, financeAddExpense } from '../lib/budget.js';
import { getSession, baseUrl } from '../lib/auth.js';

export default async function handler(req, res) {
  const s = getSession(req);
  if (!s) { res.status(401).json({ ok: false, error: 'Not signed in', authRequired: true }); return; }
  try {
    if (req.method === 'GET') {
      // Picker mode for the expense form: locked budgets (+ line items) for a department.
      if (req.query && req.query.dept !== undefined) {
        res.status(200).json({ budgets: await lockedBudgetsFor(req.query.dept) });
        return;
      }
      res.status(200).json(await budgetData({ email: s.email, roles: s.roles }));
      return;
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      b.email = s.email;
      const base = baseUrl(req);
      if (b.action === 'create') { res.status(200).json(await createBudget(b, base)); return; }
      if (b.action === 'realloc') { res.status(200).json(await createReallocation(b, base)); return; }
      if (b.action === 'vendor') { res.status(200).json(await addVendorMapping(b)); return; }
      if (b.action === 'claim') { res.status(200).json(await createClaim(b, base)); return; }
      if (b.action === 'decision') { res.status(200).json(await budgetDecision({ id: b.id, decision: b.decision, comment: b.comment, email: s.email, roles: s.roles }, base)); return; }
      if (b.action === 'close') { res.status(200).json(await closeBudget({ id: b.id, lineId: b.lineId, carryForward: b.carryForward, newPeriod: b.newPeriod, email: s.email, roles: s.roles }, base)); return; }
      if (b.action === 'financeadd') { res.status(200).json(await financeAddExpense({ id: b.id, lineId: b.lineId, amount: b.amount, vendor: b.vendor, note: b.note, email: s.email, roles: s.roles })); return; }
      res.status(400).json({ ok: false, error: 'Unknown action' });
      return;
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('budget error:', err);
    res.status(200).json({ ok: false, error: String(err.message || err) });
  }
}
