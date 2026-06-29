import crypto from 'crypto';
import { authUrl, setStateCookie } from '../../lib/auth.js';

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

export default function handler(req, res) {
  try {
    const next = safeNext(req.query && req.query.next);
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = Buffer.from(JSON.stringify({ n: nonce, next })).toString('base64url');
    setStateCookie(res, nonce);
    res.writeHead(302, { Location: authUrl(req, state) });
    res.end();
  } catch (err) {
    res.status(500).send('Login error: ' + (err.message || err));
  }
}
