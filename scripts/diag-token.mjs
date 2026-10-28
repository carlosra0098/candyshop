// Diagnóstico: login OAuth 2.0 (Authorization Code + PKCE) + decodificación del JWT
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

const form = (params) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params),
});

// 1) /oauth/authorize → code
const auth = await fetch(`${BASE}/oauth/authorize`, form({
  response_type: 'code',
  client_id: 'candyshop-web',
  redirect_uri: `${BASE}/cuenta`,
  scope: 'profile email orders admin',
  state: 'diag',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  email: 'admin@candyshop.test',
  password: 'admin123',
})).then((r) => r.json());

// 2) /oauth/token → access token JWT
const tok = await fetch(`${BASE}/oauth/token`, form({
  grant_type: 'authorization_code',
  client_id: 'candyshop-web',
  code: auth.code,
  redirect_uri: `${BASE}/cuenta`,
  code_verifier: verifier,
})).then((r) => r.json());

const token = tok.access_token;
console.log('token length:', token.length);
console.log('ASCII?', /^[\x21-\x7E]+$/.test(token));

const parts = token.split('.');
parts.forEach((x, i) => {
  const buf = Buffer.from(x, 'base64url');
  const txt = buf.toString('utf8');
  console.log(`part[${i}] len=${x.length} decoded=${buf.length}B validUTF8=${!txt.includes('\uFFFD')}`);
  if (i < 2) {
    try {
      console.log(`  -> ${JSON.stringify(JSON.parse(txt))}`);
    } catch (e) {
      console.log(`  -> JSON ERROR: ${e.message}`);
      console.log('  hex:', buf.toString('hex'));
    }
  }
});
