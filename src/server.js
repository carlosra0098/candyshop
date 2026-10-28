import './env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './env.js';
import { api } from './api.js';
import { oauth, ensureOAuthClients } from './oauth.js';
import { initSchema } from './db.js';
import { fail } from './router.js';
import { seed, ensureDemoUsers } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = config.port;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Acceso denegado');

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // Enrutado del frontend (URLs limpias tipo /tienda → tienda.html)
    const candidate = path.join(PUBLIC_DIR, `${pathname.replace(/^\/+/, '')}.html`);
    if (fs.existsSync(candidate)) filePath = candidate;
    else {
      filePath = path.join(PUBLIC_DIR, '404.html');
      res.statusCode = 404;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => fail(res, 404, 'No encontrado'));
  res.writeHead(res.statusCode === 404 ? 404 : 200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  stream.pipe(res);
}

/** Convierte errores de PostgreSQL en códigos HTTP coherentes. */
function httpStatusFor(err) {
  if (err.statusCode) return err.statusCode;          // errores propios (readBody, validaciones)
  switch (err.code) {
    case '23505': return 409; // unique_violation
    case '23503': return 409; // foreign_key_violation
    case '23514': return 400; // check_violation
    case '22P02': return 400; // invalid_text_representation (ej. id no numérico)
    case 'ECONNREFUSED':
    case '57P01': return 503; // base de datos no disponible
    default: return 500;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Cabeceras CORS para desarrollo (frontend separado / Postman)
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Access-Token, X-Cart-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname.startsWith('/api/') || pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/')) {
      const match = oauth.match(req.method, pathname) || api.match(req.method, pathname);
      if (!match) return fail(res, 404, `Endpoint no encontrado: ${req.method} ${pathname}`);
      await match.handler(req, res, match.params);
      return;
    }
    return serveStatic(req, res, pathname);
  } catch (err) {
    if (res.headersSent) return; // la respuesta ya empezó: no se puede enmendar
    const status = httpStatusFor(err);
    if (status >= 500) console.error(`[error] ${req.method} ${pathname}:`, err);
    return fail(res, status, status >= 500 ? 'Error interno del servidor' : err.message);
  }
});

async function main() {
  // PostgreSQL: esquema → datos de ejemplo → clientes OAuth
  await initSchema();
  const result = await seed();
  await ensureDemoUsers();
  await ensureOAuthClients();

  server.listen(PORT, () => {
    console.log('');
    console.log('  🍬 CandyShop API + Frontend  (PostgreSQL + OAuth 2.0)');
    console.log('  ─────────────────────────────────────────────────────');
    console.log(`  Tienda:   http://localhost:${PORT}`);
    console.log(`  API:      http://localhost:${PORT}/api`);
    console.log(`  OAuth:    http://localhost:${PORT}/oauth/authorize`);
    console.log(`  Meta:     http://localhost:${PORT}/oauth/.well-known/openid-configuration`);
    console.log(`  Admin:    http://localhost:${PORT}/admin  (admin@candyshop.test / admin123)`);
    console.log(`  Staff:    http://localhost:${PORT}/admin  (staff@candyshop.test / staff123)`);
    console.log(`  Datos:    ${result.skipped ? `ya existían (${result.products} productos)` : `seed creado (${result.products} productos)`}`);
    console.log('');
  });
}

main().catch((err) => {
  console.error('No se pudo arrancar el servidor:', err);
  process.exit(1);
});
