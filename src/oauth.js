import { Router, json, readForm } from './router.js';
import { db } from './db.js';
import { config } from './env.js';
import {
  createAccessToken,
  verifyPassword,
  hashPassword,
  randomToken,
  sha256,
  pkceChallenge,
  safeEqual,
} from './auth.js';

/* ═══════════════════════════════════════════════════════════════════
   Servidor de autorización OAuth 2.0 (RFC 6749) — SIN cookies ni sesiones.

   · GET  /oauth/authorize   → pantalla de login (HTML). El POST valida
                              credenciales y devuelve un *code* (PKCE S256).
   · POST /oauth/token       → grant "authorization_code" (+PKCE),
                              "client_credentials" y "refresh_token" (rotación).
   · POST /oauth/revoke      → revoca refresh tokens (RFC 7009).
   · POST /oauth/introspect  → consulta de tokens (RFC 7662).
   · GET  /oauth/.well-known/openid-configuration → metadatos.

   Todo el estado (códigos, refresh tokens) vive en PostgreSQL:
   jamás se usa una cookie ni una sesión de servidor.
   ═══════════════════════════════════════════════════════════════════ */

export const oauth = new Router();

const CODE_TTL_SECONDS = 120;          // vida del código de autorización
const ALL_SCOPES = ['profile', 'email', 'orders', 'staff', 'admin'];
const DEFAULT_SCOPE = 'profile email orders';

/* ───────────────────────── helpers ───────────────────────── */

const parseList = (raw, fallback = []) => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
};

async function getClient(clientId) {
  if (!clientId) return null;
  return db.get('SELECT * FROM oauth_clients WHERE client_id = ?', clientId);
}

/** Respuesta de error conforme a RFC 6749 §5.2. */
function tokenError(res, status, error, description, extraHeaders = {}) {
  res.setHeader('WWW-Authenticate', 'Bearer');
  return json(res, status, { error, error_description: description, ...extraHeaders });
}

/** Negociación: ¿el cliente espera JSON (fetch/Postman) o HTML (navegador)? */
function wantsJson(req) {
  const accept = String(req.headers.accept || '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/**
 * Autentica al cliente OAuth (§2.3): Basic, o client_id/client_secret en el body.
 * Cliente público (sin secret): solo client_id.
 * @returns {{client}|{error:[status, error, description]}}
 */
async function authenticateClient(req, body) {
  let clientId = body.client_id || null;
  let clientSecret = body.client_secret || null;

  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      clientId = decoded.slice(0, idx);
      clientSecret = decodeURIComponent(decoded.slice(idx + 1));
    } catch {
      return { error: [401, 'invalid_client', 'Cabecera Authorization Basic inválida'] };
    }
  }

  const client = await getClient(clientId);
  if (!client) return { error: [401, 'invalid_client', 'Cliente desconocido'] };

  const secretHash = client.client_secret_hash;
  if (secretHash) {
    // Cliente confidencial: exige secreto válido
    if (!clientSecret || !verifyPassword(clientSecret, secretHash)) {
      return { error: [401, 'invalid_client', 'Credenciales de cliente inválidas'] };
    }
  } else if (clientSecret) {
    return { error: [401, 'invalid_client', 'Este cliente es público y no lleva secreto'] };
  }
  return { client };
}

/** Recorta los scopes pedidos a los permitidos por el cliente y el usuario.
    · 'admin'  → solo rol admin.
    · 'staff'  → rol staff o admin (permisos intermedios de gestión). */
function clampScope(requested, clientScopes, role) {
  const asked = String(requested || DEFAULT_SCOPE).trim().split(/\s+/).filter(Boolean);
  const allowed = asked.filter(
    (s) =>
      clientScopes.includes(s) &&
      (s !== 'admin' || role === 'admin') &&
      (s !== 'staff' || role === 'staff' || role === 'admin')
  );
  return [...new Set(allowed)].join(' ');
}

/** Emite un access token (+ refresh token si hay usuario y withRefresh). */
async function issueTokens(client, user, scope, withRefresh = true) {
  const access = createAccessToken({
    sub: user ? user.id : `client:${client.client_id}`,
    email: user?.email,
    role: user?.role ?? 'client',
    scope,
    clientId: client.client_id,
  });
  const body = {
    access_token: access,
    token_type: 'Bearer',
    expires_in: config.accessTtl,
    scope,
  };
  if (user && withRefresh) {
    const refresh = randomToken(48);
    await db.run(
      'INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, now() + make_interval(secs => ?))',
      sha256(refresh), client.client_id, user.id, scope, config.refreshTtl
    );
    body.refresh_token = refresh;
  }
  return body;
}

/* ─────────── metadatos del servidor ─────────── */

function baseUrl(req) {
  return `http://${req.headers.host || `localhost:${config.port}`}`;
}

oauth.get('/oauth/.well-known/openid-configuration', (req, res) => {
  const base = baseUrl(req);
  ok200(res, {
    issuer: config.issuer,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    introspection_endpoint: `${base}/oauth/introspect`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: ALL_SCOPES,
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  });
});

const ok200 = (res, data) => json(res, 200, data);

/* ───────────────────────── pantalla de login ───────────────────────── */

function loginPage({ params, error = '', email = '', hideEmail = false }) {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method']
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k] ?? '')}">`)
    .join('\n        ');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Iniciar sesión · CandyShop OAuth</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
         background: radial-gradient(1200px 600px at 20% -10%, #ffe066 0%, transparent 55%),
                     radial-gradient(900px 500px at 110% 20%, #ff8fc7 0%, transparent 60%), #1b0f1a; padding: 24px; }
  .card { width: 100%; max-width: 420px; background:#fff; border-radius: 24px; padding: 32px;
          box-shadow: 0 30px 70px rgba(0,0,0,.45); }
  .logo { font-size: 40px; text-align:center; }
  h1 { margin: 8px 0 4px; text-align:center; font-size: 22px; color:#2b0d20; }
  .sub { text-align:center; color:#7a5c6e; font-size: 13px; margin-bottom: 22px; }
  label { display:block; font-size: 13px; font-weight:600; color:#4b2b3c; margin: 14px 0 6px; }
  input[type=email], input[type=password], input[type=text] {
      width:100%; padding: 12px 14px; border: 2px solid #f0d7e4; border-radius: 12px; font-size: 15px; outline:none; }
  input:focus { border-color:#ff2d95; }
  button { width:100%; margin-top: 22px; padding: 13px; border:0; border-radius: 12px; cursor:pointer;
           font-size: 15px; font-weight: 700; color:#fff; background: linear-gradient(90deg,#ff2d95,#ff6ec7);
           box-shadow: 0 10px 24px rgba(255,45,149,.35); }
  button:hover { filter: brightness(1.05); }
  .error { background:#ffe3ec; color:#a3123f; border:1px solid #ffc2d6; border-radius:10px;
           padding:10px 12px; font-size:13px; margin-bottom: 6px; }
  .hint { margin-top:16px; font-size:11.5px; color:#9b7f8f; text-align:center; line-height:1.5; }
  code { background:#f6edf3; padding:1px 6px; border-radius:6px; }
</style>
</head>
<body>
  <form class="card" method="post" action="/oauth/authorize">
    <div class="logo">🍬</div>
    <h1>CandyShop</h1>
    <div class="sub">Inicia sesión para autorizar la aplicación</div>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    ${hideEmail ? '' : `<label for="email">Email</label>
        <input id="email" name="email" type="email" required autofocus value="${escapeHtml(email)}" placeholder="tucorreo@ejemplo.com">`}
    <label for="password">Contraseña</label>
        <input id="password" name="password" type="password" required placeholder="••••••••">
        ${hidden}
    <button type="submit">Entrar y autorizar</button>
    <div class="hint">
      Flujo OAuth 2.0 <b>Authorization Code + PKCE</b><br>
      Sin cookies y sin sesiones: solo tokens Bearer.
    </div>
  </form>
</body>
</html>`;
}

function html(res, status, markup) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(markup);
}

/* ───────────────────────── GET /oauth/authorize ───────────────────────── */

oauth.get('/oauth/authorize', async (req, res) => {
  const u = new URL(req.url, baseUrl(req));
  const params = Object.fromEntries(u.searchParams);
  const check = await validateAuthorizeParams(params);
  if (check.error) {
    if (wantsJson(req)) return json(res, check.status, { error: check.error, error_description: check.description });
    return html(res, check.status, loginPage({ params, error: check.description }));
  }
  html(res, 200, loginPage({ params, email: u.searchParams.get('login_hint') || '' }));
});

/** Valida client_id/redirect_uri/response_type/PKCE (común a GET y POST). */
async function validateAuthorizeParams(params) {
  if (params.response_type !== 'code') {
    return { status: 400, error: 'unsupported_response_type', description: 'response_type debe ser "code"' };
  }
  const client = await getClient(params.client_id);
  if (!client) {
    return { status: 400, error: 'invalid_client', description: 'client_id desconocido' };
  }
  const redirects = parseList(client.redirect_uris);
  if (!params.redirect_uri || !redirects.includes(params.redirect_uri)) {
    return { status: 400, error: 'invalid_request', description: 'redirect_uri no está registrado para este cliente' };
  }
  if (!parseList(client.grant_types).includes('authorization_code')) {
    return { status: 400, error: 'unauthorized_client', description: 'Este cliente no puede usar el flujo authorization_code' };
  }
  // PKCE obligatorio (S256) — RFC 7636
  if (!params.code_challenge) {
    return { status: 400, error: 'invalid_request', description: 'code_challenge (PKCE) es obligatorio' };
  }
  if ((params.code_challenge_method || 'plain') !== 'S256') {
    return { status: 400, error: 'invalid_request', description: 'code_challenge_method debe ser S256' };
  }
  return { client };
}

/* ───────────────────────── POST /oauth/authorize ───────────────────────── */

oauth.post('/oauth/authorize', async (req, res) => {
  let body;
  try {
    body = await readForm(req);
  } catch (e) {
    return json(res, e.statusCode || 400, { error: 'invalid_request', error_description: e.message });
  }
  // Acepta parámetros en query (GET-style) además del cuerpo
  const u = new URL(req.url, baseUrl(req));
  const params = { ...Object.fromEntries(u.searchParams), ...body };

  const check = await validateAuthorizeParams(params);
  if (check.error) {
    if (wantsJson(req)) return json(res, check.status, { error: check.error, error_description: check.description });
    // Error de parámetros OAuth → se devuelve al redirect_uri con ?error= (RFC 6749 §4.1.2.1)
    if (params.redirect_uri && params.response_type) {
      const target = new URL(params.redirect_uri);
      target.searchParams.set('error', check.error);
      target.searchParams.set('error_description', check.description);
      if (params.state) target.searchParams.set('state', params.state);
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }
    return html(res, check.status, loginPage({ params, error: check.description }));
  }
  const client = check.client;

  // ── Credenciales del usuario (sin cookie/sesión: viajan en cada POST) ──
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = email
    ? await db.get("SELECT id, name, email, password_hash, role FROM users WHERE email = ?", email)
    : null;

  const badCreds = !user || !verifyPassword(password, user.password_hash);
  if (badCreds) {
    if (wantsJson(req)) {
      return json(res, 401, { error: 'access_denied', error_description: 'Email o contraseña incorrectos' });
    }
    return html(res, 401, loginPage({ params, email, error: 'Email o contraseña incorrectos' }));
  }

  // ── Emisión del código de autorización ──
  const scope = clampScope(params.scope, parseList(client.scopes, ALL_SCOPES), user.role);
  const code = randomToken(48);
  await db.run(
    `INSERT INTO oauth_auth_codes
       (code, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'S256', now() + make_interval(secs => ?))`,
    code, client.client_id, user.id, params.redirect_uri, scope, params.code_challenge, CODE_TTL_SECONDS
  );

  if (wantsJson(req)) {
    // Uso desde el frontend (fetch): devuelve el code sin redireccionar
    return json(res, 200, { code, state: params.state || '', scope, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  }

  const target = new URL(params.redirect_uri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', params.state);
  res.writeHead(302, { Location: target.toString() });
  res.end();
});

/* ───────────────────────── POST /oauth/token ───────────────────────── */

oauth.post('/oauth/token', async (req, res) => {
  let body;
  try {
    body = await readForm(req);
  } catch (e) {
    return tokenError(res, e.statusCode || 400, 'invalid_request', e.message);
  }

  const auth = await authenticateClient(req, body);
  if (auth.error) {
    const [status, error, description] = auth.error;
    return tokenError(res, status, error, description);
  }
  const client = auth.client;
  const grants = parseList(client.grant_types);
  const grantType = String(body.grant_type || '');

  if (!grantType) return tokenError(res, 400, 'invalid_request', 'Falta grant_type');
  if (!grants.includes(grantType)) {
    return tokenError(res, 400, 'unauthorized_client', `El cliente no puede usar grant_type "${grantType}"`);
  }

  try {
    switch (grantType) {
      case 'authorization_code':
        return await grantAuthorizationCode(res, client, body);
      case 'client_credentials':
        return await grantClientCredentials(res, client, body);
      case 'refresh_token':
        return await grantRefreshToken(res, client, body);
      default:
        return tokenError(res, 400, 'unsupported_grant_type', `grant_type "${grantType}" no soportado`);
    }
  } catch (e) {
    console.error('[oauth/token]', e);
    return tokenError(res, 500, 'server_error', 'Error interno al emitir el token');
  }
});

/* grant: authorization_code + PKCE */
async function grantAuthorizationCode(res, client, body) {
  const { code, redirect_uri: redirectUri, code_verifier: verifier } = body;

  if (!code) return tokenError(res, 400, 'invalid_request', 'Falta el parámetro code');
  if (!verifier) return tokenError(res, 400, 'invalid_request', 'Falta el code_verifier (PKCE)');

  const row = await db.get('SELECT * FROM oauth_auth_codes WHERE code = ?', code);
  if (!row) return tokenError(res, 400, 'invalid_grant', 'Código de autorización no válido');
  if (row.client_id !== client.client_id) {
    return tokenError(res, 400, 'invalid_grant', 'El código no pertenece a este cliente');
  }
  if (row.used) {
    // Reutilización de un código → posible robo: revoca la familia de tokens del usuario
    await db.run(
      'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ? AND revoked = 0',
      row.user_id, client.client_id
    );
    return tokenError(res, 400, 'invalid_grant', 'Código de autorización ya utilizado (posible robo: tokens revocados)');
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return tokenError(res, 400, 'invalid_grant', 'Código de autorización caducado');
  }
  if (redirectUri !== row.redirect_uri) {
    return tokenError(res, 400, 'invalid_grant', 'redirect_uri no coincide con el del código');
  }
  // PKCE: S256(verifier) debe coincidir con el challenge entregado en /authorize
  if (!safeEqual(pkceChallenge(verifier), row.code_challenge)) {
    return tokenError(res, 400, 'invalid_grant', 'El code_verifier no coincide con el code_challenge (PKCE)');
  }

  // Uso único atómico
  const used = await db.run('UPDATE oauth_auth_codes SET used = 1 WHERE code = ? AND used = 0', code);
  if (used.rowCount === 0) return tokenError(res, 400, 'invalid_grant', 'Código de autorización ya utilizado');

  const user = await db.get('SELECT id, name, email, role FROM users WHERE id = ?', row.user_id);
  if (!user) return tokenError(res, 400, 'invalid_grant', 'El usuario del código ya no existe');

  json(res, 200, await issueTokens(client, user, row.scope));
}

/* grant: client_credentials (máquinas/apps; "en nombre de" owner_user_id si existe) */
async function grantClientCredentials(res, client, body) {
  if (!client.client_secret_hash) {
    return tokenError(res, 401, 'invalid_client', 'client_credentials requiere un cliente confidencial');
  }
  const clientScopes = parseList(client.scopes, ALL_SCOPES);
  let owner = null;
  if (client.owner_user_id) {
    owner = await db.get('SELECT id, name, email, role FROM users WHERE id = ?', client.owner_user_id);
  }
  const role = owner ? owner.role : 'client';
  // Sin scope explícito, el cliente usa todos los suyos (es su propia identidad)
  const scope = clampScope(body.scope || clientScopes.join(' '), clientScopes, role === 'client' ? null : role);
  // client_credentials no emite refresh token (RFC 6749 §4.4.3)
  json(res, 200, await issueTokens(client, owner, scope, false));
}

/* grant: refresh_token con rotación + detección de reutilización */
async function grantRefreshToken(res, client, body) {
  const token = body.refresh_token;
  if (!token) return tokenError(res, 400, 'invalid_request', 'Falta refresh_token');

  const hash = sha256(token);
  const row = await db.get('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?', hash);

  if (!row || row.client_id !== client.client_id) {
    return tokenError(res, 400, 'invalid_grant', 'Refresh token no válido');
  }
  if (row.revoked) {
    // Reutilización tras rotación → robo probable: revoca toda la familia
    await db.run(
      'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id IS NOT DISTINCT FROM ? AND client_id = ? AND revoked = 0',
      row.user_id, client.client_id
    );
    return tokenError(res, 400, 'invalid_grant', 'Refresh token ya usado o revocado (familia revocada)');
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return tokenError(res, 400, 'invalid_grant', 'Refresh token caducado');
  }

  const user = row.user_id
    ? await db.get('SELECT id, name, email, role FROM users WHERE id = ?', row.user_id)
    : null;
  if (row.user_id && !user) return tokenError(res, 400, 'invalid_grant', 'El usuario ya no existe');

  // Rotación: el refresh antiguo se marca usado y se enlaza con el nuevo
  const fresh = randomToken(48);
  await db.run(
    'INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, now() + make_interval(secs => ?))',
    sha256(fresh), client.client_id, user?.id ?? null, row.scope, config.refreshTtl
  );
  await db.run(
    'UPDATE oauth_refresh_tokens SET revoked = 1, replaced_by = ? WHERE token_hash = ?',
    sha256(fresh), hash
  );

  const access = createAccessToken({
    sub: user ? user.id : `client:${client.client_id}`,
    email: user?.email,
    role: user?.role ?? 'client',
    scope: row.scope,
    clientId: client.client_id,
  });
  json(res, 200, {
    access_token: access,
    token_type: 'Bearer',
    expires_in: config.accessTtl,
    refresh_token: fresh,
    scope: row.scope,
  });
}

/* ───────────────────────── POST /oauth/revoke (RFC 7009) ───────────────────────── */

oauth.post('/oauth/revoke', async (req, res) => {
  let body;
  try {
    body = await readForm(req);
  } catch (e) {
    return tokenError(res, e.statusCode || 400, 'invalid_request', e.message);
  }
  const auth = await authenticateClient(req, body);
  if (auth.error) {
    const [status, error, description] = auth.error;
    return tokenError(res, status, error, description);
  }
  const client = auth.client;
  if (body.token) {
    // Solo se revoca si el token pertenece al cliente que lo solicita (§2.1)
    await db.run(
      'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ? AND revoked = 0',
      sha256(body.token), client.client_id
    );
  }
  json(res, 200, {}); // RFC 7009: siempre 200 aunque el token no exista
});

/* ───────────────────────── POST /oauth/introspect (RFC 7662) ───────────────────────── */

oauth.post('/oauth/introspect', async (req, res) => {
  let body;
  try {
    body = await readForm(req);
  } catch (e) {
    return tokenError(res, e.statusCode || 400, 'invalid_request', e.message);
  }
  const auth = await authenticateClient(req, body);
  if (auth.error) {
    const [status, error, description] = auth.error;
    return tokenError(res, status, error, description);
  }
  const token = String(body.token || '');
  if (!token) return json(res, 200, { active: false });

  // Access token JWT (se verifica localmente)
  if (token.split('.').length === 3) {
    const { verifyToken } = await import('./auth.js');
    const payload = verifyToken(token);
    if (!payload) return json(res, 200, { active: false });
    return json(res, 200, {
      active: true,
      scope: payload.scope,
      client_id: payload.client_id,
      sub: String(payload.sub),
      username: payload.email,
      token_type: 'Bearer',
      exp: payload.exp,
      iat: payload.iat,
      iss: payload.iss,
    });
  }

  // Refresh token opaco (consulta por hash)
  const row = await db.get(
    `SELECT token_hash, client_id, user_id, scope, expires_at, revoked
       FROM oauth_refresh_tokens WHERE token_hash = ?`, sha256(token)
  );
  const active = !!row && !row.revoked && new Date(row.expires_at).getTime() > Date.now();
  if (!active) return json(res, 200, { active: false });
  json(res, 200, {
    active: true,
    token_type: 'refresh_token',
    client_id: row.client_id,
    sub: row.user_id != null ? String(row.user_id) : null,
    scope: row.scope,
    exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
  });
});

/* ───────────────────────── clientes OAuth de ejemplo ───────────────────────── */

/**
 * Alta idempotente de los clientes OAuth del proyecto.
 * Se ejecuta en cada arranque (UPSERT), así los cambios de configuración aplican siempre.
 */
export async function ensureOAuthClients() {
  const web = {
    clientId: 'candyshop-web',
    secretHash: null, // cliente público → PKCE obligatorio
    name: 'CandyShop Web (SPA)',
    redirects: ['http://localhost:3000/cuenta', 'http://localhost:3000/cuenta.html',
                'http://localhost:3000/admin', 'http://localhost:3000/admin.html',
                'http://localhost:8000/cuenta', 'http://localhost:8000/cuenta.html',
                'http://localhost:8000/admin', 'http://localhost:8000/admin.html'],
    grants: ['authorization_code', 'refresh_token'],
    scopes: ALL_SCOPES,
    owner: null,
  };
  const server = {
    clientId: 'candyshop-server',
    secretHash: hashPassword('candyshop-secret-2026'), // secreto de ejemplo (cámbialo en producción)
    name: 'CandyShop Server-to-Server',
    redirects: [],
    grants: ['client_credentials'],
    scopes: ALL_SCOPES,
    ownerEmail: 'admin@candyshop.test', // actúa en nombre del admin
  };

  const admin = await db.get("SELECT id FROM users WHERE email = 'admin@candyshop.test'");

  await db.run(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, name, redirect_uris, grant_types, scopes, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client_id) DO UPDATE SET
       client_secret_hash = EXCLUDED.client_secret_hash,
       name = EXCLUDED.name,
       redirect_uris = EXCLUDED.redirect_uris,
       grant_types = EXCLUDED.grant_types,
       scopes = EXCLUDED.scopes,
       owner_user_id = EXCLUDED.owner_user_id`,
    web.clientId, web.secretHash, web.name, JSON.stringify(web.redirects),
    JSON.stringify(web.grants), JSON.stringify(web.scopes), null
  );

  await db.run(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, name, redirect_uris, grant_types, scopes, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client_id) DO UPDATE SET
       client_secret_hash = EXCLUDED.client_secret_hash,
       name = EXCLUDED.name,
       redirect_uris = EXCLUDED.redirect_uris,
       grant_types = EXCLUDED.grant_types,
       scopes = EXCLUDED.scopes,
       owner_user_id = EXCLUDED.owner_user_id`,
    server.clientId, server.secretHash, server.name, JSON.stringify(server.redirects),
    JSON.stringify(server.grants), JSON.stringify(server.scopes), admin?.id ?? null
  );
}
