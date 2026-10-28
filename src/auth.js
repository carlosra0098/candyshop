import crypto from 'node:crypto';
import './env.js';
import { config } from './env.js';

/* ═══════════════════════════════════════════════════════════
   Autenticación OAuth 2.0 + JWT (HS256) — SIN cookies ni sesiones.
   El cliente obtiene sus tokens en /oauth/token y los envía en
   cada petición con:  Authorization: Bearer <access_token>
   · Access token:  JWT corto (15 min por defecto), verificado localmente.
   · Refresh token: opaco, aleatorio, se guarda hasheado en PostgreSQL
     y rota en cada uso (detección de reutilización → revocación).
   Implementación propia sin dependencias externas (RFC 6749/7519/7636).
   ═══════════════════════════════════════════════════════════ */

const SECRET = config.jwtSecret;
const ISSUER = config.issuer;
const AUDIENCE = config.audience;
const CLOCK_SKEW = 30; // tolerancia de reloj en segundos

/* ── Hash de contraseñas con scrypt (nativo de Node) ── */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* ── Utilidades criptográficas ── */

/** Token aleatorio opaco en base64url (refresh tokens, códigos de autorización). */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** SHA-256 en hex (para guardar refresh tokens hasheados). */
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** PKCE: challenge = BASE64URL(SHA256(verifier)) — RFC 7636. */
export const pkceChallenge = (verifier) =>
  crypto.createHash('sha256').update(String(verifier)).digest('base64url');

/** Comparación en tiempo constante. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ── JWT: firma y verificación HS256 (access tokens) ── */
const b64url = (data) => Buffer.from(data).toString('base64url');

function sign(signingInput) {
  return crypto.createHmac('sha256', SECRET).update(signingInput).digest('base64url');
}

/**
 * Crea un access token JWT (RFC 9068, typ "at+jwt").
 * @param {object} claims  { sub, email?, role, scope, clientId }
 */
export function createAccessToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'at+jwt' }));
  const payload = b64url(
    JSON.stringify({
      sub: claims.sub,                       // subject: id de usuario (o cliente)
      email: claims.email ?? undefined,
      role: claims.role ?? 'client',         // 'customer' | 'staff' | 'admin' | 'client'
      scope: claims.scope ?? '',             // scopes espaciados
      client_id: claims.clientId ?? null,    // cliente OAuth que emitió el token
      jti: crypto.randomUUID(),              // id único del token
      iss: ISSUER,                           // emisor
      aud: AUDIENCE,                         // audiencia
      iat: now,                              // emitted at
      exp: now + config.accessTtl,           // expiration
    })
  );
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(signingInput)}`;
}

/** Devuelve el payload del access token o null si es inválido/caducado/falsificado. */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signature] = parts;

  // 1) El header debe ser un JWT HS256 (bloquea "alg: none" y confusión de algoritmos)
  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256' || header.typ !== 'at+jwt') return null;

  // 2) Firma: comparación en tiempo constante sobre el mismo input
  const expected = sign(`${headerB64}.${payloadB64}`);
  if (!safeEqual(signature, expected)) return null;

  // 3) Payload y claims
  let data;
  try {
    data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (data.sub === undefined || data.sub === null) return null;
  if (typeof data.exp !== 'number' || now >= data.exp + CLOCK_SKEW) return null;
  if (typeof data.iat === 'number' && data.iat > now + CLOCK_SKEW) return null;
  if (data.iss !== ISSUER) return null;
  if (data.aud !== undefined && data.aud !== AUDIENCE) return null;
  return data;
}

/** Decodifica sin verificar (solo para debug/tests). */
export function decodeToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Extrae el token de las cabeceras (Bearer o X-Access-Token). */
export function extractToken(req) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.headers['x-access-token'] || null;
}

/** ¿Tiene el scope indicado? (space-delimited, RFC 6749 §3.3) */
export function hasScope(payload, scope) {
  return String(payload?.scope || '').split(/\s+/).includes(scope);
}
