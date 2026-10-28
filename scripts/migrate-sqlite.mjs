/* ═══ Migración SQLite → PostgreSQL ═══
   Copia los datos existentes de data/candyshop.db (SQLite) a la base
   de datos PostgreSQL configurada en DATABASE_URL (.env).

   Uso:  npm run migrate
   Idempotente: usa ON CONFLICT (id) DO NOTHING y luego reajusta las secuencias.
   ═══════════════════════════════════════════════════════════════════ */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { pool, db, initSchema } from '../src/db.js';
import { closePool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_FILE = path.join(__dirname, '..', 'data', 'candyshop.db');

// Orden respetando las claves ajenas
const TABLES = [
  'categories', 'users', 'products', 'coupons', 'reviews',
  'carts', 'cart_items', 'orders', 'order_items', 'newsletter',
];

/** 'YYYY-MM-DD HH:MM:SS' (UTC, formato SQLite) → ISO 8601 con zona. */
function fixDate(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
    return `${v.replace(' ', 'T')}Z`;
  }
  return v;
}

async function main() {
  if (!fs.existsSync(SQLITE_FILE)) {
    console.log('No existe data/candyshop.db — nada que migrar.');
    return;
  }
  const sqlite = new DatabaseSync(SQLITE_FILE, { readOnly: true });

  // El esquema debe existir en PostgreSQL antes de copiar
  await initSchema();

  let total = 0;
  for (const table of TABLES) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    if (!rows.length) {
      console.log(`  · ${table}: 0 filas`);
      continue;
    }
    for (const row of rows) {
      const values = cols.map((c) => fixDate(row[c]));
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      await db.run(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
         ON CONFLICT (id) DO NOTHING`,
        ...values
      );
      total++;
    }
    console.log(`  · ${table}: ${rows.length} filas`);
  }

  // Reajustar las secuencias para que los próximos ids no colisionen
  for (const table of TABLES) {
    await db.run(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
    );
  }

  sqlite.close();
  console.log(`\n✅ Migración completada: ${total} filas copiadas de SQLite a PostgreSQL.`);
  await closePool();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ Error durante la migración:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
