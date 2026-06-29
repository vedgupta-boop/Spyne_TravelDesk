import { CONFIG, POLICY } from '../lib/config.js';
import { applyPolicyOverrides } from '../lib/policystore.js';

export default async function handler(req, res) {
  try { await applyPolicyOverrides(); } catch (e) { /* best-effort: fall back to code defaults */ }
  const departments = {};
  Object.keys(CONFIG.DEPARTMENTS).forEach((d) => {
    departments[d] = { head: CONFIG.DEPARTMENTS[d].head, email: CONFIG.DEPARTMENTS[d].email };
  });
  res.status(200).json({
    company: CONFIG.COMPANY_NAME,
    domain: CONFIG.COMPANY_DOMAIN,
    departments,
    policy: POLICY,
    // Reporting config for the Finance analytics tab.
    fx: CONFIG.FX,
    reportingCurrency: CONFIG.REPORTING_CURRENCY,
    deptBudgets: CONFIG.DEPT_BUDGETS,
    userEmail: '',
  });
}
