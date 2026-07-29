import { financeData, scrapRequests, vendorDirectory } from '../lib/workflow.js';
import { readAll } from '../lib/sheets.js';
import { rolesView, setRole, applyRoleOverrides } from '../lib/rolesstore.js';
import { delegationsView, setDelegation, removeDelegation, applyDelegations } from '../lib/delegationstore.js';
import { rolesFor, COL } from '../lib/config.js';
import { requireRole } from '../lib/auth.js';

// Finance master tracker + User Access + Delegations + Vendor master
// (folded in here to stay under the Hobby 12-function cap).
//   GET (default)            → financeData()
//   GET ?view=access         → role assignments + users + delegations + vendor master
//   POST {action:'role'}     → assign a role   |   POST {action:'scrap'} → soft-delete requests
//   POST {action:'delegate'} → set an OOO delegation | {action:'undelegate'} → remove one
export default async function handler(req, res) {
  const s = requireRole(req, res, 'finance');
  if (!s) return;
  try {
    try { await applyRoleOverrides(); } catch (e) { /* defaults */ }
    try { await applyDelegations(); } catch (e) { /* none */ }

    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.action === 'role') { res.status(200).json(await setRole(b.key, b.value, s.email)); return; }
      if (b.action === 'scrap') { res.status(200).json(await scrapRequests(b.ids)); return; }
      if (b.action === 'delegate') { res.status(200).json(await setDelegation({ approver: b.approver, delegate: b.delegate, from: b.from, to: b.to, note: b.note }, s.email)); return; }
      if (b.action === 'undelegate') { res.status(200).json(await removeDelegation({ approver: b.approver, delegate: b.delegate })); return; }
      res.status(400).json({ ok: false, error: 'Unknown action' });
      return;
    }

    if (req.query && req.query.view === 'access') {
      const view = await rolesView();
      let users = [];
      try {
        const all = await readAll();
        const map = {};
        all.forEach((r) => { const e = String(r[COL.EMAIL] || '').toLowerCase(); if (!e) return; const c = map[e] || { email: e, name: '', count: 0 }; c.count++; if (!c.name && r[COL.NAME]) c.name = r[COL.NAME]; map[e] = c; });
        const a = view.assignments;
        const add = (e) => { e = String(e || '').toLowerCase(); if (e && !map[e]) map[e] = { email: e, name: '', count: 0 }; };
        add(a.ceo); (a.finance || []).forEach(add); Object.values(a.depts || {}).forEach(add);
        users = Object.values(map).map((u) => ({ ...u, roles: rolesFor(u.email) })).sort((x, y) => y.count - x.count || x.email.localeCompare(y.email));
      } catch (e) { users = []; }
      let delegations = [], vendors = [];
      try { delegations = (await delegationsView()).delegations; } catch (e) { delegations = []; }
      try { vendors = await vendorDirectory(); } catch (e) { vendors = []; }
      res.status(200).json({ ok: true, assignments: view.assignments, departments: view.departments, users, delegations, vendors });
      return;
    }

    const data = await financeData();
    res.status(200).json(data);
  } catch (err) {
    console.error('finance error:', err);
    res.status(500).json({ error: String(err.message || err), currencySummaries: {}, rows: [] });
  }
}
