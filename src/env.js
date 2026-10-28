/* ═══ Configuración de entorno ═══
   Carga el archivo .env (si existe) en process.env sin dependencias externas.
   Las variables ya definidas en el entorno tienen prioridad sobre el archivo.
   ═══════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');

if (fs.existsSync(ENV_FILE)) {
  for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Quita comillas envolventes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  databaseUrl: process.env.DATABASE_URL || 'postgres://candyshop:CandyShop_PG_2026@localhost:5432/candyshop',
  jwtSecret: process.env.JWT_SECRET || 'candyshop-dev-secret-change-me',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  /** TTL del access token JWT (segundos) */
  accessTtl: parseInt(process.env.ACCESS_TOKEN_TTL, 10) || 60 * 15,
  /** TTL del refresh token (segundos) */
  refreshTtl: parseInt(process.env.REFRESH_TOKEN_TTL, 10) || 60 * 60 * 24 * 30,
  issuer: process.env.OAUTH_ISSUER || 'candyshop',
  audience: process.env.OAUTH_AUDIENCE || 'candyshop-api',
};
