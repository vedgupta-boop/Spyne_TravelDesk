// ---------------------------------------------------------------------------
//  Keka HRMS lookup — resolve an employee's Name + Employee Number by work email.
//  Used to auto-fill the reimbursement form. Requires three secrets (set in Vercel):
//    KEKA_CLIENT_ID, KEKA_CLIENT_SECRET, KEKA_API_KEY
//  Optional overrides: KEKA_BASE_URL (default https://spyneai.keka.com),
//    KEKA_LOGIN_URL (default https://login.keka.com/connect/token), KEKA_SCOPE.
//  GRACEFUL: if not configured it returns { available:false } and the form
//  silently falls back to manual Name / Employee-ID entry. Never throws to caller.
//  API: POST {login}/connect/token (grant_type=kekaapi) → bearer; then
//       POST {base}/api/v1/hris/employees/search { workEmail } → EmployeeProfile.
// ---------------------------------------------------------------------------

let _token = null, _tokenExp = 0; // in-memory token cache (per warm lambda)

function cfg() {
  return {
    clientId: process.env.KEKA_CLIENT_ID,
    clientSecret: process.env.KEKA_CLIENT_SECRET,
    apiKey: process.env.KEKA_API_KEY,
    base: (process.env.KEKA_BASE_URL || 'https://spyneai.keka.com').replace(/\/$/, ''),
    loginUrl: process.env.KEKA_LOGIN_URL || 'https://login.keka.com/connect/token',
    scope: process.env.KEKA_SCOPE || 'kekaapi',
  };
}

export function kekaConfigured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret && c.apiKey);
}

async function getToken() {
  const c = cfg();
  const now = Date.now();
  if (_token && now < _tokenExp - 60000) return _token;
  const body = new URLSearchParams({
    grant_type: 'kekaapi', scope: c.scope,
    client_id: c.clientId, client_secret: c.clientSecret, api_key: c.apiKey,
  });
  const r = await fetch(c.loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = j.error_description || j.error || ''; } catch { try { detail = (await r.text()).slice(0, 80); } catch {} }
    throw new Error('Keka token request failed (' + r.status + (detail ? ': ' + detail : '') + ')');
  }
  const j = await r.json();
  _token = j.access_token;
  _tokenExp = now + (Number(j.expires_in || 3600) * 1000);
  return _token;
}

// Returns { available, ok, name, employeeId, email } | { available:false }.
export async function kekaEmployeeByEmail(email) {
  if (!kekaConfigured()) return { available: false };
  const e = String(email || '').trim();
  if (!e || e.indexOf('@') < 0) return { available: true, ok: false, error: 'Enter a valid email.' };
  try {
    const token = await getToken();
    const c = cfg();
    const r = await fetch(c.base + '/api/v1/hris/employees/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ workEmail: e }),
    });
    if (!r.ok) return { available: true, ok: false, error: 'Keka lookup failed (' + r.status + ')' };
    const j = await r.json();
    // EmployeeProfileResponse: { succeeded, message, data: EmployeeProfile }
    const d = (j && j.data) || (j && j.succeeded === undefined ? j : null);
    if (!d) return { available: true, ok: false, error: (j && j.message) || 'No employee found for that email.' };
    const name = d.displayName || [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || '';
    const employeeId = d.employeeNumber || d.id || '';
    if (!name && !employeeId) return { available: true, ok: false, error: 'No employee found for that email.' };
    return { available: true, ok: true, name, employeeId, email: d.email || e };
  } catch (err) {
    return { available: true, ok: false, error: String(err.message || err) };
  }
}
