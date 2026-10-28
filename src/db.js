/* ═══ Capa de datos — PostgreSQL ═══
   Pool de conexiones con node-postgres ("pg") y una fachada asíncrona
   con la misma forma que la API síncrona de SQLite usada en el proyecto:

     await db.get(sql, ...params)   → primera fila o null
     await db.all(sql, ...params)   → array de filas
     await db.run(sql, ...params)   → { rowCount, rows }  (usar RETURNING para ids)
     await db.exec(sql)             → sentencias múltiples sin parámetros
     await db.tx(async (t) => ...)  → transacción (rollback automático si lanza)

   Los Placeholders "?": se convierten automáticamente a $1, $2, … de PostgreSQL,
   de modo que todo el SQL del proyecto se mantiene intacto.
   ═══════════════════════════════════════════════════════════ */
import './env.js';
import pg from 'pg';
import { config } from './env.js';

const { Pool, types } = pg;

// Tipos que node-postgres devuelve como string → numéricos (coherente con SQLite)
types.setTypeParser(20, (v) => parseInt(v, 10));   // int8 (COUNT, SUM enteros)
types.setTypeParser(700, (v) => parseFloat(v));    // float4
types.setTypeParser(701, (v) => parseFloat(v));    // float8
types.setTypeParser(1700, (v) => parseFloat(v));   // numeric (precios, AVG…)

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => console.error('[pg] Error de conexión:', err.message));

/** Convierte los "?" posicionales de SQLite en "$1..$n" de PostgreSQL. */
function bind(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function all(sql, ...params) {
  const res = await pool.query(bind(sql), params);
  return res.rows;
}

async function get(sql, ...params) {
  const res = await pool.query(bind(sql), params);
  return res.rows[0] ?? null;
}

async function run(sql, ...params) {
  const res = await pool.query(bind(sql), params);
  return { rowCount: res.rowCount, rows: res.rows, lastId: res.rows[0]?.id ?? null };
}

async function exec(sql) {
  await pool.query(sql);
}

/** Ejecuta una función dentro de una transacción (commit / rollback automático). */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = {
      get: async (sql, ...p) => (await client.query(bind(sql), p)).rows[0] ?? null,
      all: async (sql, ...p) => (await client.query(bind(sql), p)).rows,
      run: async (sql, ...p) => {
        const r = await client.query(bind(sql), p);
        return { rowCount: r.rowCount, rows: r.rows, lastId: r.rows[0]?.id ?? null };
      },
    };
    const result = await fn(t);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* conexión rota */ }
    throw err;
  } finally {
    client.release();
  }
}

export const db = { all, get, run, exec, tx };

export async function closePool() {
  await pool.end();
}

/* ═══ Esquema (idempotente, ejecutado en el arranque) ═══ */
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT           NOT NULL,
      email         TEXT           NOT NULL UNIQUE,
      password_hash TEXT           NOT NULL,
      role          TEXT           NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff','admin')),
      created_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      emoji       TEXT NOT NULL DEFAULT '🍬',
      color       TEXT NOT NULL DEFAULT '#ff4fa3',
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS products (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      description   TEXT NOT NULL DEFAULT '',
      price         NUMERIC(10,2) NOT NULL CHECK (price >= 0),
      compare_price NUMERIC(10,2),
      stock         INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      unit          TEXT NOT NULL DEFAULT 'uds',
      weight        TEXT NOT NULL DEFAULT '',
      category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      image_emoji   TEXT NOT NULL DEFAULT '🍬',
      color         TEXT NOT NULL DEFAULT '#ff4fa3',
      badge         TEXT NOT NULL DEFAULT '',
      featured      INTEGER NOT NULL DEFAULT 0,
      rating        NUMERIC(3,1) NOT NULL DEFAULT 4.5,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS carts (
      id          SERIAL PRIMARY KEY,
      token       TEXT NOT NULL UNIQUE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      coupon_code TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      id         SERIAL PRIMARY KEY,
      cart_id    INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity   INTEGER NOT NULL CHECK (quantity > 0),
      UNIQUE (cart_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      phone       TEXT NOT NULL,
      address     TEXT NOT NULL,
      city        TEXT NOT NULL,
      province    TEXT NOT NULL,
      postal      TEXT NOT NULL,
      notes       TEXT NOT NULL DEFAULT '',
      subtotal    NUMERIC(10,2) NOT NULL,
      shipping    NUMERIC(10,2) NOT NULL,
      discount    NUMERIC(10,2) NOT NULL DEFAULT 0,
      total       NUMERIC(10,2) NOT NULL,
      coupon_code TEXT,
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id         SERIAL PRIMARY KEY,
      order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      name       TEXT NOT NULL,
      price      NUMERIC(10,2) NOT NULL,
      quantity   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id         SERIAL PRIMARY KEY,
      code       TEXT NOT NULL UNIQUE,
      type       TEXT NOT NULL CHECK (type IN ('percent','fixed')),
      value      NUMERIC(10,2) NOT NULL CHECK (value > 0),
      min_total  NUMERIC(10,2) NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id         SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment    TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS newsletter (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    /* ── OAuth 2.0 (sin cookies ni sesiones: todo se guarda aquí) ── */

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id          TEXT PRIMARY KEY,
      client_secret_hash TEXT,                    -- NULL = cliente público (PKCE obligatorio)
      name               TEXT NOT NULL,
      redirect_uris      TEXT NOT NULL,           -- JSON array de URIs registradas
      grant_types        TEXT NOT NULL,           -- JSON array
      scopes             TEXT NOT NULL,           -- JSON array de scopes permitidos
      owner_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- "en nombre de" (client_credentials)
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS oauth_auth_codes (
      code                 TEXT PRIMARY KEY,
      client_id            TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redirect_uri         TEXT NOT NULL,
      scope                TEXT NOT NULL DEFAULT '',
      code_challenge       TEXT,                  -- PKCE (S256)
      code_challenge_method TEXT,
      expires_at           TIMESTAMPTZ NOT NULL,
      used                 INTEGER NOT NULL DEFAULT 0,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token_hash  TEXT PRIMARY KEY,               -- SHA-256 del token (nunca en claro)
      client_id   TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      scope       TEXT NOT NULL DEFAULT '',
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0,
      replaced_by TEXT,                           -- rotación: token nuevo que lo sustituye
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_cart_items_cart   ON cart_items(cart_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_codes_user        ON oauth_auth_codes(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_user       ON oauth_refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_client     ON oauth_refresh_tokens(client_id);
  `);

  // Migración del CHECK de roles: base creada antes de existir el rol 'staff'.
  // (CREATE TABLE IF NOT EXISTS no altera tablas ya creadas.)
  await pool.query(`
    DO $$
    DECLARE c RECORD;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'users'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%role%'
      LOOP
        EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END $$;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('customer','staff','admin'));
  `);
}

/** Vacía todas las tablas y reinicia los contadores (para tests/reset). */
export async function resetDatabase() {
  await pool.query(`
    TRUNCATE order_items, orders, cart_items, carts, reviews, newsletter,
             coupons, products, categories, users,
             oauth_auth_codes, oauth_refresh_tokens, oauth_clients
    RESTART IDENTITY CASCADE;
  `);
}
