import { CONFIG, POLICY } from '../lib/config.js';

export default function handler(req, res) {
  const departments = {};
  Object.keys(CONFIG.DEPARTMENTS).forEach((d) => {
    departments[d] = { head: CONFIG.DEPARTMENTS[d].head, email: CONFIG.DEPARTMENTS[d].email };
  });
  res.status(200).json({
    company: CONFIG.COMPANY_NAME,
    appName: CONFIG.APP_NAME,
    domain: CONFIG.COMPANY_DOMAIN,
    ceoName: CONFIG.CEO_NAME,
    departments,
    policy: POLICY,
    userEmail: '',
  });
}
