import { CONFIG, POLICY } from '../lib/config.js';
import { applyPolicyOverrides } from '../lib/policystore.js';
import { flightsAvailable } from '../lib/flights.js';
import { amadeusAvailable } from '../lib/amadeus.js';

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
    // Live flight search panel: hidden by default. Only shows when explicitly opted in
    // (FLIGHT_SEARCH_UI=true) AND a flight provider key is configured. Set the env flag
    // in Vercel when you're ready to turn it on; leave it unset to keep the panel hidden.
    flightSearch: (String(process.env.FLIGHT_SEARCH_UI || '').toLowerCase() === 'true') && (flightsAvailable() || amadeusAvailable()),
    userEmail: '',
  });
}
