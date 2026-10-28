"""Capa de datos — PostgreSQL (psycopg 3, pool de conexiones).

Misma fachada que la versión Node:
    q(sql, *params)   → lista de filas (dict)
    one(sql, *params) → primera fila o None
    run(sql, *params) → rowcount (usa RETURNING id para obtener el id)
    tx()              → transacción (commit/rollback automático)

Los Placeholders "?" se convierten automáticamente a $1..$n (PostgreSQL).
"""
from contextlib import contextmanager
from typing import Any, Iterator

from psycopg import rows
from psycopg_pool import ConnectionPool

from .config import config

_pool: ConnectionPool | None = None


def _bind(sql: str, params: tuple = ()) -> str:
    """Traduce el SQL al paramstyle de psycopg 3:
    · '?' (estilo SQLite/Node) → '%s' (placeholder)
    · '%' literal              → '%%' (escape de psycopg; solo si hay parámetros)
    Sin parámetros, el SQL se devuelve tal cual."""
    if not params:
        return sql
    out: list[str] = []
    for ch in sql:
        if ch == "?":
            out.append("%s")
        elif ch == "%":
            out.append("%%")
        else:
            out.append(ch)
    return "".join(out)


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            conninfo=config.database_url_psycopg,
            min_size=1,
            max_size=10,
            kwargs={"autocommit": True, "row_factory": rows.dict_row},
            open=True,
        )
    return _pool


def q(sql: str, *params: Any) -> list[dict]:
    with get_pool().connection() as conn:
        return conn.execute(_bind(sql, params), params).fetchall()


def one(sql: str, *params: Any) -> dict | None:
    with get_pool().connection() as conn:
        return conn.execute(_bind(sql, params), params).fetchone()


def run(sql: str, *params: Any) -> int:
    """Ejecuta y devuelve el nº de filas afectadas (rowcount)."""
    with get_pool().connection() as conn:
        cur = conn.execute(_bind(sql, params), params)
        return cur.rowcount


def returning_id(sql: str, *params: Any) -> int | None:
    """Ejecuta un INSERT/UPDATE ... RETURNING id y devuelve el id."""
    with get_pool().connection() as conn:
        row = conn.execute(_bind(sql, params), params).fetchone()
        return row["id"] if row else None


def exec_ddl(sql: str) -> None:
    """Sentencias múltiples sin parámetros (esquema)."""
    with get_pool().connection() as conn:
        conn.execute(sql)


class _TxHandle:
    """Manejador de transacción: mismos helpers que el módulo db (q/one/run/id)."""

    def __init__(self, conn):
        self._conn = conn

    def q(self, sql: str, *p) -> list[dict]:
        return self._conn.execute(_bind(sql, p), p).fetchall()

    def one(self, sql: str, *p) -> dict | None:
        return self._conn.execute(_bind(sql, p), p).fetchone()

    def run(self, sql: str, *p) -> int:
        return self._conn.execute(_bind(sql, p), p).rowcount

    def id(self, sql: str, *p) -> int | None:
        row = self._conn.execute(_bind(sql, p), p).fetchone()
        return row["id"] if row else None


@contextmanager
def tx() -> Iterator[_TxHandle]:
    """Transacción: commit si termina bien, rollback si lanza excepción."""
    with get_pool().connection() as conn:
        conn.execute("BEGIN")
        try:
            yield _TxHandle(conn)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


# ═══════════════════════════ Esquema (idempotente) ═══════════════════════════

SCHEMA_SQL = """
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT           NOT NULL,
    email         TEXT           NOT NULL UNIQUE,
    password_hash TEXT           NOT NULL,
    role          TEXT           NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff','admin')),
    github_id     BIGINT         UNIQUE,
    github_login  TEXT,
    created_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
  );

  /* Vínculo del login con GitHub (state CSRF de un solo uso — sin cookies) */
  ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id BIGINT UNIQUE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login TEXT;

  CREATE TABLE IF NOT EXISTS github_login_states (
    state        TEXT PRIMARY KEY,
    redirect_to  TEXT           NOT NULL DEFAULT '/cuenta',
    user_id      INTEGER        REFERENCES users(id) ON DELETE SET NULL,
    expires_at   TIMESTAMPTZ    NOT NULL,
    created_at   TIMESTAMPTZ    NOT NULL DEFAULT now()
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

  /* ── OAuth 2.0 (sin cookies ni sesiones) ── */

  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id          TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    name               TEXT NOT NULL,
    redirect_uris      TEXT NOT NULL,
    grant_types        TEXT NOT NULL,
    scopes             TEXT NOT NULL,
    owner_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code                 TEXT PRIMARY KEY,
    client_id            TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri         TEXT NOT NULL,
    scope                TEXT NOT NULL DEFAULT '',
    code_challenge       TEXT,
    code_challenge_method TEXT,
    expires_at           TIMESTAMPTZ NOT NULL,
    used                 INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_hash  TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    scope       TEXT NOT NULL DEFAULT '',
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    replaced_by TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
  CREATE INDEX IF NOT EXISTS idx_cart_items_cart   ON cart_items(cart_id);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_codes_user        ON oauth_auth_codes(user_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_user      ON oauth_refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_client    ON oauth_refresh_tokens(client_id);
"""


def init_schema() -> None:
    exec_ddl(SCHEMA_SQL)
    # Migración del CHECK de roles: base creada antes de existir el rol 'staff'.
    # (CREATE TABLE IF NOT EXISTS no altera tablas ya creadas.)
    exec_ddl("""
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
    """)


def reset_database() -> None:
    exec_ddl("""
      TRUNCATE order_items, orders, cart_items, carts, reviews, newsletter,
               coupons, products, categories, users,
               oauth_auth_codes, oauth_refresh_tokens, oauth_clients
      RESTART IDENTITY CASCADE;
    """)
