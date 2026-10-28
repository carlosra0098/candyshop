import { Router, ok, created, fail, readBody } from './router.js';
import { db } from './db.js';
import { verifyToken, extractToken, hasScope, hashPassword, verifyPassword } from './auth.js';

/* ═══════════════════════════════════════════════════════════════════
   API REST de CandyShop — PostgreSQL + OAuth 2.0 (JWT Bearer, sin cookies)
   Todas las consultas son asíncronas sobre el pool de node-postgres.
   ═══════════════════════════════════════════════════════════════════ */

/* ───────────────────────── helpers ───────────────────────── */

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const round2 = (n) => Math.round(n * 100) / 100;
const FREE_SHIPPING_FROM = 20;
const SHIPPING_COST = 3.95;

const isId = (v) => /^\d+$/.test(String(v ?? '').trim());
const toInt = (v, fallback = null) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : fallback;
};

/** Lee el body JSON y, si falla, responde 400 y devuelve null (el handler hace return). */
const readJson = (req, res) =>
  readBody(req).catch((e) => {
    fail(res, e.statusCode || 400, e.message);
    return null;
  });

/* Búsqueda insensible a acentos y mayúsculas */
const ACCENTS = [['á', 'a'], ['é', 'e'], ['í', 'i'], ['ó', 'o'], ['ú', 'u'], ['ü', 'u'], ['ñ', 'n']];
const normCol = (col) => {
  let expr = `LOWER(${col})`;
  for (const [from, to] of ACCENTS) {
    expr = `REPLACE(REPLACE(${expr}, '${from}', '${to}'), '${from.toUpperCase()}', '${to}')`;
  }
  return expr;
};
const normalizeText = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

async function getUser(req) {
  const payload = verifyToken(extractToken(req));
  if (!payload) return null;
  const id = Number(payload.sub);
  if (!Number.isInteger(id)) return null; // token de client_credentials sin usuario
  return (await db.get('SELECT id, name, email, role FROM users WHERE id = ?', id)) || null;
}

async function requireAuth(req, res) {
  const user = await getUser(req);
  if (!user) {
    fail(res, 401, 'Debes iniciar sesión para realizar esta acción');
    return null;
  }
  return user;
}

/* Jerarquía de roles: customer < staff < admin.
   El rol se lee SIEMPRE de la BD (no del token): degradar un usuario surte
   efecto inmediato aunque su JWT siga siendo válido. */
const ROLE_LEVEL = { customer: 1, staff: 2, admin: 3 };

async function requireRole(req, res, minRole) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if ((ROLE_LEVEL[user.role] ?? 0) < ROLE_LEVEL[minRole]) {
    fail(res, 403, minRole === 'staff'
      ? 'Se requieren permisos de personal (staff)'
      : 'Se requieren permisos de administrador');
    return null;
  }
  return user;
}

/** Rol staff o admin + scope 'staff' o 'admin' (gestión de pedidos/productos). */
async function requireStaff(req, res) {
  const user = await requireRole(req, res, 'staff');
  if (!user) return null;
  const payload = verifyToken(extractToken(req));
  if (!hasScope(payload, 'staff') && !hasScope(payload, 'admin')) {
    fail(res, 403, 'El token no tiene el scope "staff"');
    return null;
  }
  return user;
}

/** Solo rol admin + scope 'admin' (usuarios, cupones, estadísticas, categorías). */
async function requireAdmin(req, res) {
  const user = await requireRole(req, res, 'admin');
  if (!user) return null;
  if (!hasScope(verifyToken(extractToken(req)), 'admin')) {
    fail(res, 403, 'El token no tiene el scope "admin"');
    return null;
  }
  return user;
}

/** El carrito se identifica por token (invitado) o usuario logueado. */
async function getCart(req, mustExist = false) {
  const user = await getUser(req);
  const token = req.headers['x-cart-token'] || null;

  if (user) {
    let cart = await db.get('SELECT * FROM carts WHERE user_id = ?', user.id);
    if (!cart && !mustExist) {
      const t = token || `u-${user.id}-${Date.now()}`;
      await db.run('INSERT INTO carts (token, user_id) VALUES (?, ?) ON CONFLICT (token) DO NOTHING', t, user.id);
      cart = await db.get('SELECT * FROM carts WHERE user_id = ?', user.id);
    }
    return cart || null;
  }

  if (!token) return null;
  let cart = await db.get('SELECT * FROM carts WHERE token = ?', token);
  if (!cart && !mustExist) {
    await db.run('INSERT INTO carts (token) VALUES (?) ON CONFLICT (token) DO NOTHING', token);
    cart = await db.get('SELECT * FROM carts WHERE token = ?', token);
  }
  return cart || null;
}

async function cartView(cart) {
  if (!cart) return { token: null, items: [], subtotal: 0, shipping: 0, discount: 0, total: 0, coupon: null };
  const items = (
    await db.all(
      `SELECT ci.product_id AS "productId", ci.quantity, p.name, p.slug, p.price, p.compare_price AS "comparePrice",
              p.image_emoji AS emoji, p.color, p.stock, p.weight, p.unit
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = ? ORDER BY ci.id`,
      cart.id
    )
  ).map((i) => ({ ...i, lineTotal: round2(i.price * i.quantity) }));

  const subtotal = round2(items.reduce((s, i) => s + i.price * i.quantity, 0));
  const coupon = cart.coupon_code
    ? await db.get('SELECT * FROM coupons WHERE code = ? AND active = 1', cart.coupon_code)
    : null;

  let discount = 0;
  if (coupon && subtotal >= coupon.min_total) {
    discount = round2(coupon.type === 'percent' ? (subtotal * coupon.value) / 100 : Math.min(coupon.value, subtotal));
  }
  const afterDiscount = round2(subtotal - discount);
  const shipping = items.length === 0 || afterDiscount >= FREE_SHIPPING_FROM ? 0 : SHIPPING_COST;
  return {
    token: cart.token,
    items,
    subtotal,
    shipping,
    discount,
    total: round2(afterDiscount + shipping),
    coupon: coupon
      ? { code: coupon.code, type: coupon.type, value: coupon.value, minTotal: coupon.min_total, applied: discount > 0 }
      : null,
  };
}

function productView(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    price: p.price,
    comparePrice: p.compare_price,
    stock: p.stock,
    unit: p.unit,
    weight: p.weight,
    emoji: p.image_emoji,
    color: p.color,
    badge: p.badge,
    featured: !!p.featured,
    rating: p.rating,
    createdAt: p.created_at,
    category: p.category_name
      ? { id: p.category_id, name: p.category_name, slug: p.category_slug, emoji: p.category_emoji, color: p.category_color }
      : null,
  };
}

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug, c.emoji AS category_emoji, c.color AS category_color
  FROM products p LEFT JOIN categories c ON c.id = p.category_id
`;

/* ───────────────────────── rutas ───────────────────────── */

export const api = new Router();

/* Salud del sistema */
api.get('/api/health', (req, res) => ok(res, { status: 'ok', time: new Date().toISOString(), db: 'postgresql' }));

/* Categorías */
api.get('/api/categories', async (req, res) => {
  const rows = (
    await db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS "productCount"
         FROM categories c ORDER BY c.id`
    )
  ).map((c) => ({
    id: c.id, name: c.name, slug: c.slug, emoji: c.emoji, color: c.color,
    description: c.description, productCount: c.productCount,
  }));
  ok(res, { data: rows, total: rows.length });
});

api.post('/api/categories', async (req, res) => {
  if (!requireAdminGuard(await requireAdmin(req, res), res)) return;
  const b = await readJson(req, res);
  if (b === null) return;
  if (!b.name) return fail(res, 400, 'El nombre es obligatorio');
  const slug = b.slug || slugify(b.name);
  const exists = await db.get('SELECT id FROM categories WHERE slug = ?', slug);
  if (exists) return fail(res, 409, 'Ya existe una categoría con ese slug');
  const info = await db.run(
    'INSERT INTO categories (name, slug, emoji, color, description) VALUES (?, ?, ?, ?, ?) RETURNING id',
    b.name, slug, b.emoji || '🍬', b.color || '#ff2d95', b.description || ''
  );
  created(res, { id: info.lastId, slug });
});

api.patch('/api/categories/:id', async (req, res, params) => {
  if (!requireAdminGuard(await requireAdmin(req, res), res)) return;
  const id = toInt(params.id);
  if (id == null) return fail(res, 404, 'Categoría no encontrada');
  const b = await readJson(req, res);
  if (b === null) return;
  const cat = await db.get('SELECT * FROM categories WHERE id = ?', id);
  if (!cat) return fail(res, 404, 'Categoría no encontrada');
  await db.run(
    'UPDATE categories SET name = ?, emoji = ?, color = ?, description = ? WHERE id = ?',
    b.name ?? cat.name, b.emoji ?? cat.emoji, b.color ?? cat.color, b.description ?? cat.description, cat.id
  );
  ok(res, { updated: true });
});

api.delete('/api/categories/:id', async (req, res, params) => {
  if (!requireAdminGuard(await requireAdmin(req, res), res)) return;
  const id = toInt(params.id);
  if (id == null) return fail(res, 404, 'Categoría no encontrada');
  const info = await db.run('DELETE FROM categories WHERE id = ?', id);
  info.rowCount ? ok(res, { deleted: true }) : fail(res, 404, 'Categoría no encontrada');
});

/** Truco para no repetir "if (!user) return" tras helpers asíncronos. */
function requireAdminGuard(user) {
  return !!user;
}

/* Productos (público) */
api.get('/api/products', async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const q = u.searchParams.get('q')?.trim() || '';
  // Palabras de búsqueda (mín. 2 letras, sin acentos ni mayúsculas)
  const words = q
    ? [...new Set(normalizeText(q).split(/\s+/).filter((w) => w.length >= 2))]
    : [];
  const category = u.searchParams.get('category') || '';
  const minPrice = parseFloat(u.searchParams.get('minPrice')) || 0;
  const maxPrice = parseFloat(u.searchParams.get('maxPrice')) || Infinity;
  const badge = u.searchParams.get('badge') || '';
  const sort = u.searchParams.get('sort') || 'popular';
  const page = Math.max(1, parseInt(u.searchParams.get('page')) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(u.searchParams.get('limit')) || 12));
  const includeHidden = u.searchParams.get('all') === '1';

  const baseWhere = ['p.price BETWEEN ? AND ?'];
  const baseArgs = [minPrice, maxPrice];
  if (category) {
    // Puede venir el slug ("golosinas") o el id ("3")
    const cat = isId(category)
      ? await db.get('SELECT id FROM categories WHERE id = ?', Number(category))
      : await db.get('SELECT id FROM categories WHERE slug = ?', category);
    if (cat) {
      baseWhere.push('p.category_id = ?');
      baseArgs.push(cat.id);
    }
  }
  if (badge) {
    baseWhere.push('p.badge = ?');
    baseArgs.push(badge);
  }
  if (!includeHidden) baseWhere.push('p.stock >= 0');

  const NAME_COL = normCol('p.name');
  const CAT_COL = normCol('c.name');
  const DESC_COL = normCol('p.description');

  // Cada palabra del buscador debe aparecer en el nombre o la categoría del producto.
  // La descripción solo se consulta como último recurso si el nombre/categoría no da resultados.
  const searchClause = (w, withDesc) =>
    withDesc
      ? `(${NAME_COL} LIKE ? OR ${CAT_COL} LIKE ? OR ${DESC_COL} LIKE ?)`
      : `(${NAME_COL} LIKE ? OR ${CAT_COL} LIKE ?)`;

  const buildWhere = (withDesc) => {
    const where = [...baseWhere];
    const args = [...baseArgs];
    for (const w of words) {
      where.push(searchClause(w, withDesc));
      args.push(`%${w}%`, `%${w}%`);
      if (withDesc) args.push(`%${w}%`);
    }
    return { whereSql: `WHERE ${where.join(' AND ')}`, args };
  };

  const countSql = 'SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id ';
  let { whereSql, args } = buildWhere(false);
  let total = (await db.get(countSql + whereSql, ...args)).n;

  // Relevancia: coincidir en nombre (2 pts) o categoría (1 pt) pesa más que la descripción
  let rankExpr = '';
  let rankArgs = [];
  if (words.length) {
    rankExpr =
      '(' +
      words
        .map(() => `CASE WHEN ${NAME_COL} LIKE ? THEN 2 ELSE 0 END + CASE WHEN ${CAT_COL} LIKE ? THEN 1 ELSE 0 END`)
        .join(') + (') +
      ')';
    rankArgs = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
    if (total === 0) {
      ({ whereSql, args } = buildWhere(true));
      total = (await db.get(countSql + whereSql, ...args)).n;
    }
  }

  const orderBy = {
    popular: 'p.featured DESC, p.rating DESC, p.id ASC',
    'price-asc': 'p.price ASC',
    'price-desc': 'p.price DESC',
    newest: 'p.created_at DESC, p.id DESC',
    name: 'p.name ASC',
  }[sort] || 'p.featured DESC, p.rating DESC';

  // Con búsqueda, los productos cuyo nombre/categoría coincide van primero
  const finalOrder = words.length && sort === 'popular' ? `${rankExpr} DESC, ${orderBy}` : orderBy;

  const rows = await db.all(
    `${PRODUCT_SELECT} ${whereSql} ORDER BY ${finalOrder} LIMIT ? OFFSET ?`,
    ...args, ...rankArgs, limit, (page - 1) * limit
  );

  ok(res, {
    data: rows.map(productView),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

api.get('/api/products/:id', async (req, res, params) => {
  const row = isId(params.id)
    ? await db.get(`${PRODUCT_SELECT} WHERE p.id = ?`, Number(params.id))
    : await db.get(`${PRODUCT_SELECT} WHERE p.slug = ?`, params.id);
  if (!row) return fail(res, 404, 'Producto no encontrado');
  const reviews = await db.all(
    'SELECT id, name, rating, comment, created_at AS "createdAt" FROM reviews WHERE product_id = ? ORDER BY id DESC LIMIT 20',
    row.id
  );
  ok(res, { ...productView(row), reviews });
});

/* Reseñas */
api.post('/api/products/:id/reviews', async (req, res, params) => {
  const b = await readJson(req, res);
  if (b === null) return;
  const product = isId(params.id)
    ? await db.get('SELECT id, rating FROM products WHERE id = ?', Number(params.id))
    : null;
  if (!product) return fail(res, 404, 'Producto no encontrado');
  if (!b.name?.trim()) return fail(res, 400, 'Indica tu nombre');
  const rating = parseInt(b.rating);
  if (!(rating >= 1 && rating <= 5)) return fail(res, 400, 'La valoración debe ser entre 1 y 5');

  await db.run('INSERT INTO reviews (product_id, name, rating, comment) VALUES (?, ?, ?, ?)',
    product.id, b.name.trim(), rating, String(b.comment || '').trim().slice(0, 1000));
  // Recalcular media del producto
  const agg = await db.get('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE product_id = ?', product.id);
  const global = product.rating;
  await db.run('UPDATE products SET rating = ? WHERE id = ?',
    round2((avg_with_default(agg.avg, global) * agg.n + global * 4) / (agg.n + 4)), product.id);
  created(res, { ok: true });
});

function avg_with_default(avg, fallback) {
  return avg == null ? fallback : avg;
}

/* ───────────────────────── autenticación (compat) ─────────────────────────
   La autenticación principal es OAuth 2.0 (ver src/oauth.js):
   POST /oauth/authorize → code (PKCE) → POST /oauth/token → access + refresh.
   Estos endpoints auxiliares crean la cuenta / informan del usuario. */

api.post('/api/auth/register', async (req, res) => {
  const b = await readJson(req, res);
  if (b === null) return;
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!name) return fail(res, 400, 'El nombre es obligatorio');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'El email no es válido');
  if (password.length < 6) return fail(res, 400, 'La contraseña debe tener al menos 6 caracteres');
  if (await db.get('SELECT id FROM users WHERE email = ?', email)) {
    return fail(res, 409, 'Ya existe una cuenta con ese email');
  }
  const info = await db.run(
    'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?) RETURNING id',
    name, email, hashPassword(password)
  );
  const user = await db.get('SELECT id, name, email, role FROM users WHERE id = ?', info.lastId);
  // Sin tokens: el cliente debe obtenerlos por OAuth (authorization_code + PKCE)
  created(res, { user, message: 'Cuenta creada. Inicia sesión con OAuth2.' });
});

api.get('/api/auth/me', async (req, res) => {
  const user = await requireAuth(req, res);
  if (user) ok(res, { user });
});

/* Cambiar la propia contraseña (cualquier rol autenticado).
   Al cambiarla se revocan todos los refresh tokens del usuario:
   el resto de sesiones debe volver a entrar (la actual renueva
   automáticamente sus tokens tras el cambio). */
api.post('/api/auth/change-password', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const b = await readJson(req, res);
  if (b === null) return;
  const current = String(b.currentPassword || '');
  const next = String(b.newPassword || '');
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!row || !verifyPassword(current, row.password_hash)) {
    return fail(res, 400, 'La contraseña actual no es correcta');
  }
  if (next.length < 6) return fail(res, 400, 'La nueva contraseña debe tener al menos 6 caracteres');
  if (next === current) return fail(res, 400, 'La nueva contraseña debe ser distinta a la actual');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), user.id);
  await db.run('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', user.id);
  ok(res, { updated: true, message: 'Contraseña actualizada. Las demás sesiones se han cerrado.' });
});

/* Fusionar carrito de invitado al hacer login */
api.post('/api/cart/merge', async (req, res) => {
  const b = await readJson(req, res);
  if (b === null) return;
  const user = await requireAuth(req, res);
  if (!user) return;
  const guest = await db.get('SELECT * FROM carts WHERE token = ?', b.token || '');
  let own = await db.get('SELECT * FROM carts WHERE user_id = ?', user.id);
  if (guest && own && guest.id !== own.id) {
    const items = await db.all('SELECT * FROM cart_items WHERE cart_id = ?', guest.id);
    for (const item of items) {
      const existing = await db.get('SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ?', own.id, item.product_id);
      if (existing) {
        await db.run('UPDATE cart_items SET quantity = ? WHERE id = ?', existing.quantity + item.quantity, existing.id);
      } else {
        await db.run('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)', own.id, item.product_id, item.quantity);
      }
    }
    await db.run('DELETE FROM carts WHERE id = ?', guest.id);
  } else if (guest && !own) {
    await db.run('UPDATE carts SET user_id = ? WHERE id = ?', user.id, guest.id);
    own = await db.get('SELECT * FROM carts WHERE id = ?', guest.id);
  }
  if (!own) return fail(res, 404, 'Carrito no encontrado');
  await db.run("UPDATE carts SET updated_at = now() WHERE id = ?", own.id);
  ok(res, await cartView(own));
});

/* Carrito — flujo de compra: requiere sesión (sin carritos de invitado) */
api.get('/api/cart', async (req, res) => {
  const user = await requireAuth(req, res);
  if (user) ok(res, await cartView(await getCart(req)));
});

api.post('/api/cart/items', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const b = await readJson(req, res);
  if (b === null) return;
  const productId = toInt(b.productId);
  const quantity = Math.max(1, parseInt(b.quantity) || 1);
  const product = productId != null ? await db.get('SELECT * FROM products WHERE id = ?', productId) : null;
  if (!product) return fail(res, 404, 'Producto no encontrado');

  const cart = await getCart(req);
  if (!cart) return fail(res, 404, 'Carrito no encontrado');
  const current = await db.get('SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ?', cart.id, product.id);
  const wanted = (current?.quantity || 0) + quantity;
  if (wanted > product.stock) return fail(res, 409, `Solo quedan ${product.stock} unidades de "${product.name}"`, { stock: product.stock });

  await db.run(
    `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
     ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    cart.id, product.id, wanted
  );
  await db.run("UPDATE carts SET updated_at = now() WHERE id = ?", cart.id);
  created(res, await cartView(await db.get('SELECT * FROM carts WHERE id = ?', cart.id)));
});

api.patch('/api/cart/items/:productId', async (req, res, params) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const b = await readJson(req, res);
  if (b === null) return;
  const cart = await getCart(req, true);
  if (!cart) return fail(res, 404, 'Carrito no encontrado');
  const quantity = parseInt(b.quantity);
  const productId = toInt(params.productId);
  const product = productId != null ? await db.get('SELECT * FROM products WHERE id = ?', productId) : null;
  if (!product) return fail(res, 404, 'Producto no encontrado');
  if (!(quantity >= 1)) return fail(res, 400, 'La cantidad debe ser al menos 1');
  if (quantity > product.stock) return fail(res, 409, `Solo quedan ${product.stock} unidades`, { stock: product.stock });

  await db.run('UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND product_id = ?', quantity, cart.id, product.id);
  await db.run("UPDATE carts SET updated_at = now() WHERE id = ?", cart.id);
  ok(res, await cartView(await db.get('SELECT * FROM carts WHERE id = ?', cart.id)));
});

api.delete('/api/cart/items/:productId', async (req, res, params) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const cart = await getCart(req, true);
  if (!cart) return fail(res, 404, 'Carrito no encontrado');
  const productId = toInt(params.productId);
  if (productId == null) return fail(res, 404, 'Producto no encontrado');
  await db.run('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?', cart.id, productId);
  ok(res, await cartView(await db.get('SELECT * FROM carts WHERE id = ?', cart.id)));
});

api.delete('/api/cart', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const cart = await getCart(req, true);
  if (!cart) return fail(res, 404, 'Carrito no encontrado');
  await db.run('DELETE FROM cart_items WHERE cart_id = ?', cart.id);
  await db.run('UPDATE carts SET coupon_code = NULL WHERE id = ?', cart.id);
  ok(res, await cartView(await db.get('SELECT * FROM carts WHERE id = ?', cart.id)));
});

/* Cupones — solo con sesión (forman parte del flujo de compra) */
api.post('/api/coupons/validate', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const b = await readJson(req, res);
  if (b === null) return;
  const code = String(b.code || '').trim().toUpperCase();
  const coupon = await db.get('SELECT * FROM coupons WHERE code = ? AND active = 1', code);
  if (!coupon) return fail(res, 404, 'El cupón no existe o ya no está disponible');
  const cart = await getCart(req, true);
  if (!cart) return fail(res, 404, 'Carrito no encontrado');
  const subtotal = round2(
    (await db.get('SELECT COALESCE(SUM(p.price * ci.quantity), 0) AS s FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = ?', cart.id)).s
  );
  if (subtotal < coupon.min_total) {
    return fail(res, 400, `Este cupón requiere un pedido mínimo de ${Number(coupon.min_total).toFixed(2)} €`, { minTotal: coupon.min_total });
  }
  await db.run('UPDATE carts SET coupon_code = ? WHERE id = ?', coupon.code, cart.id);
  ok(res, await cartView(await db.get('SELECT * FROM carts WHERE id = ?', cart.id)));
});

api.delete('/api/cart/coupon', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const cart = await getCart(req, true);
  if (!cart) return fail(res, 404, 'Carrito no encontrado');
  await db.run('UPDATE carts SET coupon_code = NULL WHERE id = ?', cart.id);
  ok(res, await cartView(await db.get('SELECT * FROM carts WHERE id = ?', cart.id)));
});

/* Pedidos — requieren sesión: cada usuario ve los suyos (admin, todos) */
api.get('/api/orders', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;

  if (user.role === 'admin') {
    const rows = await db.all('SELECT * FROM orders ORDER BY id DESC');
    return ok(res, { data: rows, total: rows.length });
  }
  const rows = await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', user.id);
  ok(res, { data: rows, total: rows.length });
});

api.post('/api/orders', async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const b = await readJson(req, res);
  if (b === null) return;
  const required = ['name', 'email', 'phone', 'address', 'city', 'province', 'postal'];
  for (const field of required) {
    if (!String(b[field] || '').trim()) return fail(res, 400, `El campo "${field}" es obligatorio`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return fail(res, 400, 'El email no es válido');

  const cart = await getCart(req, true);
  if (!cart) return fail(res, 404, 'Carrito no encontrado');
  const view = await cartView(cart);
  if (!view.items.length) return fail(res, 400, 'Tu carrito está vacío');

  for (const item of view.items) {
    if (item.quantity > item.stock) {
      return fail(res, 409, `Se han agotado unidades de "${item.name}" (quedan ${item.stock})`, { productId: item.productId });
    }
  }

  const code = `CDY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

  // Alta del pedido + líneas + descuento de stock en una única transacción
  const order = await db.tx(async (t) => {
    const info = await t.run(
      `INSERT INTO orders (code, user_id, name, email, phone, address, city, province, postal, notes,
                           subtotal, shipping, discount, total, coupon_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      code, user?.id ?? null, b.name.trim(), b.email.trim().toLowerCase(), b.phone.trim(),
      b.address.trim(), b.city.trim(), b.province.trim(), b.postal.trim(), String(b.notes || '').trim(),
      view.subtotal, view.shipping, view.discount, view.total, view.coupon?.applied ? view.coupon.code : null
    );
    const orderId = info.lastId;

    for (const item of view.items) {
      await t.run('INSERT INTO order_items (order_id, product_id, name, price, quantity) VALUES (?, ?, ?, ?, ?)',
        orderId, item.productId, item.name, item.price, item.quantity);
      // Descuento de stock con control de carrera
      const dec = await t.run('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
        item.quantity, item.productId, item.quantity);
      if (dec.rowCount === 0) {
        throw Object.assign(new Error(`Se han agotado unidades de "${item.name}"`), { statusCode: 409 });
      }
    }
    if (view.coupon?.applied) {
      await t.run('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', view.coupon.code);
    }
    await t.run('DELETE FROM cart_items WHERE cart_id = ?', cart.id);
    await t.run("UPDATE carts SET coupon_code = NULL, updated_at = now() WHERE id = ?", cart.id);
    return { id: orderId };
  });

  created(res, {
    id: order.id, code, status: 'pending',
    subtotal: view.subtotal, shipping: view.shipping, discount: view.discount, total: view.total,
    items: view.items.map(({ name, price, quantity, lineTotal }) => ({ name, price, quantity, lineTotal })),
  });
});

api.get('/api/orders/:code', async (req, res, params) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const order = await db.get('SELECT * FROM orders WHERE code = ?', params.code);
  if (!order) return fail(res, 404, 'Pedido no encontrado');
  const isOwner = order.user_id === user.id;
  const canSeeAll = user.role === 'admin' || user.role === 'staff';
  if (!isOwner && !canSeeAll) return fail(res, 403, 'Este pedido no te pertenece');
  const items = await db.all('SELECT product_id AS "productId", name, price, quantity FROM order_items WHERE order_id = ?', order.id);
  ok(res, { ...order, items });
});

/* Newsletter */
api.post('/api/newsletter', async (req, res) => {
  const b = await readJson(req, res);
  if (b === null) return;
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'El email no es válido');
  const exists = await db.get('SELECT id FROM newsletter WHERE email = ?', email);
  if (exists) return ok(res, { subscribed: true, message: '¡Ya estabas suscrito!' });
  await db.run('INSERT INTO newsletter (email) VALUES (?)', email);
  created(res, { subscribed: true, message: '¡Bienvenido a la familia! Usa el cupón HOLA10 en tu primer pedido.' });
});

/* ───────────────────────── admin ───────────────────────── */

api.get('/api/admin/stats', async (req, res) => {
  if (!requireAdminGuard(await requireAdmin(req, res), res)) return;
  const stats = {
    products: (await db.get('SELECT COUNT(*) AS n FROM products')).n,
    customers: (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'")).n,
    orders: (await db.get('SELECT COUNT(*) AS n FROM orders')).n,
    revenue: round2((await db.get("SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE status != 'cancelled'")).s),
    pendingOrders: (await db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'")).n,
    newsletter: (await db.get('SELECT COUNT(*) AS n FROM newsletter')).n,
    lowStock: (await db.get('SELECT COUNT(*) AS n FROM products WHERE stock < 25')).n,
    topProducts: await db.all(
      `SELECT p.name, p.image_emoji AS emoji, SUM(oi.quantity) AS units
         FROM order_items oi JOIN products p ON p.id = oi.product_id
        GROUP BY p.id ORDER BY units DESC LIMIT 5`
    ),
    recentOrders: await db.all(
      'SELECT code, name, total, status, created_at AS "createdAt" FROM orders ORDER BY id DESC LIMIT 5'
    ),
  };
  ok(res, stats);
});

api.get('/api/admin/orders', async (req, res) => {
  if (!requireAdminGuard(await requireStaff(req, res), res)) return;
  const rows = await db.all('SELECT * FROM orders ORDER BY id DESC');
  ok(res, { data: rows, total: rows.length });
});

api.patch('/api/admin/orders/:id', async (req, res, params) => {
  if (!requireAdminGuard(await requireStaff(req, res), res)) return;
  const b = await readJson(req, res);
  if (b === null) return;
  const allowed = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
  if (!allowed.includes(b.status)) return fail(res, 400, `Estado inválido. Usa: ${allowed.join(', ')}`);
  const id = toInt(params.id);
  const order = id != null ? await db.get('SELECT * FROM orders WHERE id = ?', id) : null;
  if (!order) return fail(res, 404, 'Pedido no encontrado');
  if (b.status === 'cancelled' && order.status !== 'cancelled') {
    const items = await db.all('SELECT product_id, quantity FROM order_items WHERE order_id = ?', order.id);
    for (const i of items) await db.run('UPDATE products SET stock = stock + ? WHERE id = ?', i.quantity, i.product_id);
  }
  await db.run('UPDATE orders SET status = ? WHERE id = ?', b.status, order.id);
  ok(res, { updated: true, status: b.status });
});

api.get('/api/admin/users', async (req, res) => {
  if (!requireAdminGuard(await requireAdmin(req, res), res)) return;
  const rows = await db.all('SELECT id, name, email, role, created_at AS "createdAt" FROM users ORDER BY id DESC');
  ok(res, { data: rows, total: rows.length });
});

/* Restablecer la contraseña de un usuario (solo admin).
   Revoca también sus refresh tokens: el usuario debe volver a entrar. */
api.post('/api/admin/users/:id/password', async (req, res, params) => {
  if (!requireAdminGuard(await requireAdmin(req, res), res)) return;
  if (!isId(params.id)) return fail(res, 400, 'ID inválido');
  const b = await readJson(req, res);
  if (b === null) return;
  const password = String(b.password || '');
  if (password.length < 6) return fail(res, 400, 'La contraseña debe tener al menos 6 caracteres');
  const target = await db.get('SELECT id, email FROM users WHERE id = ?', Number(params.id));
  if (!target) return fail(res, 404, 'Usuario no encontrado');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), target.id);
  await db.run('UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', target.id);
  ok(res, {
    updated: true,
    user_id: target.id,
    message: `Contraseña de ${target.email} actualizada. Sus sesiones abiertas se han cerrado.`,
  });
});

/* CRUD de productos (staff o admin) */
api.get('/api/admin/products', async (req, res) => {
  if (!requireAdminGuard(await requireStaff(req, res), res)) return;
  const rows = await db.all(`${PRODUCT_SELECT} ORDER BY p.id DESC`);
  ok(res, { data: rows.map(productView), total: rows.length });
});

const validateProduct = (b) => {
  if (!b.name?.trim()) return 'El nombre es obligatorio';
  if (!(parseFloat(b.price) >= 0)) return 'El precio debe ser un número positivo';
  if (b.stock != null && parseInt(b.stock) < 0) return 'El stock no puede ser negativo';
  return null;
};

const parseProduct = (b, existingSlug = null) => [
  b.name.trim(),
  b.slug ? slugify(b.slug) : existingSlug || slugify(b.name),
  String(b.description || '').trim(),
  round2(parseFloat(b.price)),
  b.comparePrice != null && b.comparePrice !== '' ? round2(parseFloat(b.comparePrice)) : null,
  b.stock != null ? parseInt(b.stock) : 0,
  b.unit || 'uds',
  b.weight || '',
  b.categoryId ? parseInt(b.categoryId) : null,
  b.emoji || '🍬',
  b.color || '#ff2d95',
  b.badge || '',
  b.featured ? 1 : 0,
];

api.post('/api/admin/products', async (req, res) => {
  if (!requireAdminGuard(await requireStaff(req, res), res)) return;
  const b = await readJson(req, res);
  if (b === null) return;
  const error = validateProduct(b);
  if (error) return fail(res, 400, error);
  const slug = b.slug ? slugify(b.slug) : slugify(b.name);
  if (await db.get('SELECT id FROM products WHERE slug = ?', slug)) {
    return fail(res, 409, 'Ya existe un producto con ese slug');
  }
  const [name, s, desc, price, comparePrice, stock, unit, weight, categoryId, emoji, color, badge, featured] = parseProduct(b);
  const info = await db.run(
    `INSERT INTO products (name, slug, description, price, compare_price, stock, unit, weight,
                           category_id, image_emoji, color, badge, featured)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    name, s, desc, price, comparePrice, stock, unit, weight, categoryId, emoji, color, badge, featured
  );
  created(res, { id: info.lastId, slug: s });
});

api.put('/api/admin/products/:id', async (req, res, params) => {
  if (!requireAdminGuard(await requireStaff(req, res), res)) return;
  const id = toInt(params.id);
  const existing = id != null ? await db.get('SELECT * FROM products WHERE id = ?', id) : null;
  if (!existing) return fail(res, 404, 'Producto no encontrado');
  const b = await readJson(req, res);
  if (b === null) return;
  const error = validateProduct(b);
  if (error) return fail(res, 400, error);
  const [name, slug, desc, price, comparePrice, stock, unit, weight, categoryId, emoji, color, badge, featured] =
    parseProduct(b, existing.slug);
  if (slug !== existing.slug && await db.get('SELECT id FROM products WHERE slug = ? AND id != ?', slug, existing.id)) {
    return fail(res, 409, 'Ya existe un producto con ese slug');
  }
  await db.run(
    `UPDATE products SET name = ?, slug = ?, description = ?, price = ?, compare_price = ?, stock = ?,
        unit = ?, weight = ?, category_id = ?, image_emoji = ?, color = ?, badge = ?, featured = ?
      WHERE id = ?`,
    name, slug, desc, price, comparePrice, stock, unit, weight, categoryId, emoji, color, badge, featured, existing.id
  );
  ok(res, { updated: true, id: existing.id });
});

api.delete('/api/admin/products/:id', async (req, res, params) => {
  if (!requireAdminGuard(await requireStaff(req, res), res)) return;
  const id = toInt(params.id);
  if (id == null) return fail(res, 404, 'Producto no encontrado');
  const info = await db.run('DELETE FROM products WHERE id = ?', id);
  info.rowCount ? ok(res, { deleted: true }) : fail(res, 404, 'Producto no encontrado');
});

/* Cupones (admin) */
api.get('/api/admin/coupons', async (req, res) => {
  if (!requireAdminGuard(await requireAdmin(req, res), res)) return;
  const rows = await db.all('SELECT * FROM coupons ORDER BY id');
  ok(res, { data: rows, total: rows.length });
});

api.post('/api/admin/coupons', async (req, res) => {
  if (!requireAdminGuard(await requireAdmin(req, res), res)) return;
  const b = await readJson(req, res);
  if (b === null) return;
  const code = String(b.code || '').trim().toUpperCase();
  if (!code) return fail(res, 400, 'El código es obligatorio');
  if (!['percent', 'fixed'].includes(b.type)) return fail(res, 400, 'El tipo debe ser "percent" o "fixed"');
  if (!(parseFloat(b.value) > 0)) return fail(res, 400, 'El valor debe ser positivo');
  if (await db.get('SELECT id FROM coupons WHERE code = ?', code)) return fail(res, 409, 'Ese cupón ya existe');
  const info = await db.run(
    'INSERT INTO coupons (code, type, value, min_total) VALUES (?, ?, ?, ?) RETURNING id',
    code, b.type, parseFloat(b.value), parseFloat(b.minTotal) || 0
  );
  created(res, { id: info.lastId, code });
});

api.delete('/api/admin/coupons/:id', async (req, res, params) => {
  if (!requireAdminGuard(await requireAdmin(req, res), res)) return;
  const id = toInt(params.id);
  if (id == null) return fail(res, 404, 'Cupón no encontrado');
  const info = await db.run('DELETE FROM coupons WHERE id = ?', id);
  info.rowCount ? ok(res, { deleted: true }) : fail(res, 404, 'Cupón no encontrado');
});
