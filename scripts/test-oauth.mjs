/* ═══ Suite OAuth 2.0 + JWT contra el servidor en marcha ═══
   Cubre: authorize (PKCE), token (code/refresh/client_credentials),
   rotación y reutilización de refresh, revocación, introspección,
   scopes y seguridad de los JWT.   Uso: npm run test:oauth
   Compatible con ambos backends: BASE_URL=http://localhost:8000 npm run test:oauth
   ═══════════════════════════════════════════════════════════════ */
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CLIENT_ID = 'candyshop-web';
const SERVER_CLIENT = 'candyshop-server';
const SERVER_SECRET = 'candyshop-secret-2026';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const pkce = () => {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
};
const redirectUri = `${BASE}/cuenta`;

const postForm = async (path, params, headers = {}) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const getJson = async (path, token) => {
  const res = await fetch(BASE + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const postJson = async (path, body, token) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

/** Paso 1 del flujo: authorize con credenciales + PKCE → code */
async function authorize({ email, password, verifier, challenge, state = 'xyz', scope = 'profile email orders admin', redirect = redirectUri }) {
  return postForm('/oauth/authorize', {
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirect, scope, state,
    code_challenge: challenge, code_challenge_method: 'S256', email, password,
  }, { Accept: 'application/json' });
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

console.log('\n── Metadatos OAuth ──');
const meta = await getJson('/oauth/.well-known/openid-configuration');
check('openid-configuration accesible', meta.status === 200 && !!meta.data.token_endpoint);
check('soporta PKCE S256', meta.data?.code_challenge_methods_supported?.includes('S256'));
check('scopes_supported incluye staff y admin', meta.data?.scopes_supported?.includes('staff') && meta.data?.scopes_supported?.includes('admin'));

console.log('\n── Flujo Authorization Code + PKCE (cliente) ──');
const A = pkce();
const auth = await authorize({ email: 'cliente@candyshop.test', password: 'cliente123', ...A });
check('authorize devuelve code + state', auth.status === 200 && !!auth.data.code && auth.data.state === 'xyz', `state=${auth.data.state}`);
check('scope recortado sin admin (cliente)', auth.data.scope === 'profile email orders', auth.data.scope);

const tok = await postForm('/oauth/token', {
  grant_type: 'authorization_code', client_id: CLIENT_ID, code: auth.data.code,
  redirect_uri: redirectUri, code_verifier: A.verifier,
});
check('token: access + refresh + expires_in', tok.status === 200 && !!tok.data.access_token && !!tok.data.refresh_token && tok.data.expires_in === 900);

const claims = decode(tok.data.access_token);
check('claims JWT (sub/iss/aud/typ/scope)', claims.sub === 2 && claims.iss === 'candyshop' && claims.aud === 'candyshop-api' && claims.scope === 'profile email orders' && typeof claims.jti === 'string');
check('header HS256 + typ at+jwt', (() => { const h = JSON.parse(Buffer.from(tok.data.access_token.split('.')[0], 'base64url')); return h.alg === 'HS256' && h.typ === 'at+jwt'; })());

const me = await getJson('/api/auth/me', tok.data.access_token);
check('/auth/me con el access token', me.status === 200 && me.data.user.email === 'cliente@candyshop.test');

console.log('\n── PKCE y validaciones del authorize ──');
const noPkce = await authorize({ email: 'cliente@candyshop.test', password: 'cliente123', verifier: '', challenge: '' });
check('authorize sin code_challenge → 400', noPkce.status === 400 && noPkce.data.error === 'invalid_request');

const badCreds = await authorize({ email: 'cliente@candyshop.test', password: 'mala', ...pkce() });
check('credenciales incorrectas → 401 access_denied', badCreds.status === 401 && badCreds.data.error === 'access_denied');

const badRedirect = await authorize({ email: 'cliente@candyshop.test', password: 'cliente123', ...pkce(), redirect: 'http://evil.test/steal' });
check('redirect_uri no registrado → 400', badRedirect.status === 400);

const B = pkce();
const authB = await authorize({ email: 'cliente@candyshop.test', password: 'cliente123', ...B });
const badVerifier = await postForm('/oauth/token', {
  grant_type: 'authorization_code', client_id: CLIENT_ID, code: authB.data.code,
  redirect_uri: redirectUri, code_verifier: 'verificador-falso',
});
check('code_verifier incorrecto → invalid_grant', badVerifier.status === 400 && badVerifier.data.error === 'invalid_grant');

const badRedirectTok = await postForm('/oauth/token', {
  grant_type: 'authorization_code', client_id: CLIENT_ID, code: authB.data.code,
  redirect_uri: `${BASE}/admin`, code_verifier: B.verifier,
});
check('redirect_uri distinto al authorize → invalid_grant', badRedirectTok.status === 400 && badRedirectTok.data.error === 'invalid_grant');
// (la clave PKCE es válida, pero el redirect no coincide: el code NO se consume)

// La clave PKCE de B es válida y el code sigue sin canjear (el redirect malo no lo consume)
const goodTok = await postForm('/oauth/token', {
  grant_type: 'authorization_code', client_id: CLIENT_ID, code: authB.data.code,
  redirect_uri: redirectUri, code_verifier: B.verifier,
});
check('con el verifier bueno funciona', goodTok.status === 200);

console.log('\n── Refresh token: rotación y reutilización ──');
const r1 = await postForm('/oauth/token', {
  grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: tok.data.refresh_token,
});
check('refresh → access + refresh nuevo (rotación)', r1.status === 200 && !!r1.data.refresh_token && r1.data.refresh_token !== tok.data.refresh_token);

const me2 = await getJson('/api/auth/me', r1.data.access_token);
check('el access renovado funciona', me2.status === 200);

const reuse = await postForm('/oauth/token', {
  grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: tok.data.refresh_token,
});
check('refresh antiguo (ya rotado) → invalid_grant', reuse.status === 400 && reuse.data.error === 'invalid_grant');
const family = await postForm('/oauth/token', {
  grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: r1.data.refresh_token,
});
check('la reutilización revoca toda la familia', family.status === 400);

console.log('\n── Robo de código de autorización ──');
const replay = await postForm('/oauth/token', {
  grant_type: 'authorization_code', client_id: CLIENT_ID, code: authB.data.code,
  redirect_uri: redirectUri, code_verifier: B.verifier,
});
check('reutilización del code → invalid_grant (y familia revocada)', replay.status === 400 && replay.data.error === 'invalid_grant');
const replayFamily = await postForm('/oauth/token', {
  grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: goodTok.data.refresh_token,
});
check('tras el robo, el refresh de esa familia está revocado', replayFamily.status === 400);

console.log('\n── client_credentials (server-to-server) ──');
const basic = 'Basic ' + Buffer.from(`${SERVER_CLIENT}:${SERVER_SECRET}`).toString('base64');
const cc = await postForm('/oauth/token', { grant_type: 'client_credentials' }, { Authorization: basic });
check('client_credentials → access token', cc.status === 200 && !!cc.data.access_token && !cc.data.refresh_token);
const ccClaims = decode(cc.data.access_token);
check('actúa en nombre del admin (sub del dueño)', ccClaims.sub === 1 && ccClaims.role === 'admin' && ccClaims.client_id === SERVER_CLIENT);
const ccStats = await getJson('/api/admin/stats', cc.data.access_token);
check('el token de cliente accede a /admin/stats', ccStats.status === 200 && typeof ccStats.data.revenue === 'number');

const badSecret = await postForm('/oauth/token', { grant_type: 'client_credentials', client_id: SERVER_CLIENT, client_secret: 'malo' });
check('client_secret incorrecto → 401 invalid_client', badSecret.status === 401 && badSecret.data.error === 'invalid_client');

const pubCc = await postForm('/oauth/token', { grant_type: 'client_credentials', client_id: CLIENT_ID });
check('cliente público no puede client_credentials → unauthorized_client', pubCc.status === 400 && pubCc.data.error === 'unauthorized_client');

console.log('\n── Autorización / scopes ──');
const custToken = tok.data.access_token; // cliente (sin scope admin)
const custStats = await getJson('/api/admin/stats', custToken);
check('cliente con token válido → 403 en admin', custStats.status === 403);

const D = pkce();
const authD = await authorize({ email: 'admin@candyshop.test', password: 'admin123', ...D });
check('scope admin concedido al admin', authD.data.scope.split(' ').includes('admin'), authD.data.scope);
const tokD = await postForm('/oauth/token', {
  grant_type: 'authorization_code', client_id: CLIENT_ID, code: authD.data.code,
  redirect_uri: redirectUri, code_verifier: D.verifier,
});
const adminStats = await getJson('/api/admin/stats', tokD.data.access_token);
check('admin accede a /admin/stats', adminStats.status === 200);

console.log('\n── Rol staff (permisos intermedios) ──');
const S = pkce();
const authS = await authorize({ email: 'staff@candyshop.test', password: 'staff123', ...S, scope: 'profile email orders staff admin' });
check('authorize staff → scope "staff" concedido', authS.status === 200 && authS.data.scope.split(' ').includes('staff'), authS.data.scope);
check('scope "admin" denegado al staff', !authS.data.scope.split(' ').includes('admin'), authS.data.scope);
const tokS = await postForm('/oauth/token', {
  grant_type: 'authorization_code', client_id: CLIENT_ID, code: authS.data.code,
  redirect_uri: redirectUri, code_verifier: S.verifier,
});
check('token staff → claims role=staff', tokS.status === 200 && decode(tokS.data.access_token).role === 'staff');
const staffOrders = await getJson('/api/admin/orders', tokS.data.access_token);
check('staff accede a /admin/orders', staffOrders.status === 200);
const staffProducts = await postJson('/api/admin/products', { name: 'Staff OAuth Test', price: 1, stock: 1 }, tokS.data.access_token);
check('staff crea producto', staffProducts.status === 201);
if (staffProducts.status === 201) {
  await fetch(BASE + '/api/admin/products/' + staffProducts.data.id, { method: 'DELETE', headers: { Authorization: `Bearer ${tokS.data.access_token}` } });
}
const staffUsers = await getJson('/api/admin/users', tokS.data.access_token);
check('staff SIN acceso a /admin/users → 403', staffUsers.status === 403);
const staffStats = await getJson('/api/admin/stats', tokS.data.access_token);
check('staff SIN acceso a /admin/stats → 403', staffStats.status === 403);

const C = pkce();
const authC = await authorize({ email: 'cliente@candyshop.test', password: 'cliente123', ...C, scope: 'profile email orders staff admin' });
check('al cliente se le deniega el scope "staff"', !authC.data.scope.split(' ').includes('staff'), authC.data.scope);

console.log('\n── Seguridad JWT ──');
const forged = (() => {
  const [h] = tokD.data.access_token.split('.');
  const evil = b64url(JSON.stringify({ sub: 1, role: 'admin', scope: 'admin', iss: 'candyshop', aud: 'candyshop-api', exp: 9999999999 }));
  return `${h}.${evil}.${tokD.data.access_token.split('.')[2]}`;
})();
const rForged = await getJson('/api/auth/me', forged);
check('payload alterado rechazado', rForged.status === 401);

const noneHdr = b64url(JSON.stringify({ alg: 'none', typ: 'at+jwt' }));
const rNone = await getJson('/api/auth/me', `${noneHdr}.${tokD.data.access_token.split('.')[1]}.`);
check('ataque alg:none rechazado', rNone.status === 401);

const expired = (() => {
  const c = { ...claims, iat: claims.iat - 7200, exp: claims.exp - 7200 };
  const h = tok.data.access_token.split('.')[0];
  const p = b64url(JSON.stringify(c));
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'candyshop-dev-secret-change-me').update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
})();
const rExpired = await getJson('/api/auth/me', expired);
check('token caducado rechazado', rExpired.status === 401);

const rNoToken = await getJson('/api/auth/me');
const rGarbage = await getJson('/api/auth/me', 'hola.mundo');
check('sin token → 401', rNoToken.status === 401);
check('token basura → 401', rGarbage.status === 401);

console.log('\n── Introspección y revocación ──');
const intro = await postForm('/oauth/introspect', { token: tokD.data.access_token }, { Authorization: basic });
check('introspect: access token activo', intro.status === 200 && intro.data.active === true && intro.data.client_id === CLIENT_ID);
const introBad = await postForm('/oauth/introspect', { token: 'no-existe' }, { Authorization: basic });
check('introspect: token inventado → active=false', introBad.status === 200 && introBad.data.active === false);

const E = pkce();
const authE = await authorize({ email: 'cliente@candyshop.test', password: 'cliente123', ...E });
const tokE = await postForm('/oauth/token', {
  grant_type: 'authorization_code', client_id: CLIENT_ID, code: authE.data.code,
  redirect_uri: redirectUri, code_verifier: E.verifier,
});
const revoke = await postForm('/oauth/revoke', {
  token: tokE.data.refresh_token, token_type_hint: 'refresh_token', client_id: CLIENT_ID,
});
check('revocación responde 200', revoke.status === 200);
const afterRevoke = await postForm('/oauth/token', {
  grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: tokE.data.refresh_token,
});
check('refresh revocado → invalid_grant', afterRevoke.status === 400);

console.log('\n── Pantalla de login HTML (sin JS) ──');
const htmlRes = await fetch(`${BASE}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=profile&code_challenge=abc&code_challenge_method=S256`);
const htmlText = await htmlRes.text();
check('GET /authorize renderiza el formulario', htmlRes.status === 200 && htmlText.includes('code_challenge') && htmlText.includes('password'));

console.log(`\n${pass} correctas, ${fail} fallos`);
process.exit(fail ? 1 : 0);
