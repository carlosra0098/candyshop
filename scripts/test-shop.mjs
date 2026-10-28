/* ═══ Smoke test: flujo de compra completo sobre PostgreSQL ═══
   Catálogo (público) → auth obligatoria en el flujo de compra →
   registro/login OAuth → carrito con sesión → cupón → pedido →
   consulta solo con token → admin cambia estado → stock repuesto →
   permisos del nuevo rol staff.
   Uso: node scripts/test-shop.mjs   ═══════════════════════════════ */
const OAUTH_BASE = process.env.BASE_URL || 'http://localhost:3000';
const BASE = OAUTH_BASE + '/api';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

const req = async (path, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

/* Login OAuth (Authorization Code + PKCE) */
const crypto = await import('node:crypto');
const b64url = (b) => Buffer.from(b).toString('base64url');
const form = (p) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(p) });
async function login(email, password, scope = 'profile email orders staff admin') {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const auth = await fetch(OAUTH_BASE + '/oauth/authorize', form({
    response_type: 'code', client_id: 'candyshop-web', redirect_uri: 'http://localhost:3000/cuenta',
    scope, state: 's', code_challenge: challenge, code_challenge_method: 'S256',
    email, password,
  })).then((r) => r.json());
  if (!auth.code) return { error: auth };
  const tok = await fetch(OAUTH_BASE + '/oauth/token', form({
    grant_type: 'authorization_code', client_id: 'candyshop-web', code: auth.code,
    redirect_uri: 'http://localhost:3000/cuenta', code_verifier: verifier,
  })).then((r) => r.json());
  return { ...tok, grantedScope: auth.scope };
}

// 1) Catálogo (público, no necesita token)
const cats = await req('/categories');
check('categorías desde PostgreSQL', cats.status === 200 && cats.data.total === 8, `${cats.data.total} categorías`);
const prods = await req('/products?limit=5');
check('productos con paginación', prods.status === 200 && prods.data.data.length === 5 && prods.data.pagination.total === 39);
const prod = await req('/products/fresa-salvaje-1kg');
check('producto por slug + reseñas', prod.status === 200 && prod.data.reviews.length >= 2);
const search = await req('/products?q=regaliz');
check('búsqueda "regaliz"', search.data.pagination.total > 0, `${search.data.pagination.total} resultados`);
const byCat = await req('/products?category=halloween&sort=price-desc');
check('filtro por categoría + orden', byCat.data.data.every((p) => p.category.slug === 'halloween'));

// 2) Reseña (pública)
const review = await req('/products/1/reviews', { method: 'POST', body: { name: 'Smoke', rating: 5, comment: 'Genial' } });
check('crear reseña + recálculo de rating', review.status === 201);

// 3) El flujo de compra SIN sesión está cerrado
const noCart = await req('/cart');
check('GET /cart sin token → 401', noCart.status === 401);
const noAdd = await req('/cart/items', { method: 'POST', body: { productId: prod.data.id, quantity: 1 } });
check('POST /cart/items sin token → 401', noAdd.status === 401);
const noOrders = await req('/orders');
check('GET /orders sin token → 401', noOrders.status === 401);
const noOrderPost = await req('/orders', { method: 'POST', body: { name: 'X', email: 'x@y.z', phone: '1', address: 'a', city: 'b', province: 'c', postal: '28001' } });
check('POST /orders sin token → 401', noOrderPost.status === 401);
const noCoupon = await req('/coupons/validate', { method: 'POST', body: { code: 'HOLA10' } });
check('POST /coupons/validate sin token → 401', noCoupon.status === 401);

// 4) Registro + login OAuth (cliente de prueba)
const email = `smoke${Date.now()}@test.es`;
const reg = await req('/auth/register', { method: 'POST', body: { name: 'Smoke Test', email, password: 'secret123' } });
check('registro crea usuario (sin tokens)', reg.status === 201 && reg.data.user.id > 0);

const user = await login(email, 'secret123');
check('login OAuth → access + refresh', !!user.access_token && !!user.refresh_token);
check('cliente NO recibe los scopes staff ni admin',
  !user.grantedScope.split(' ').includes('staff') && !user.grantedScope.split(' ').includes('admin'),
  user.grantedScope);
const utoken = user.access_token;

// 4b) Cambiar contraseña (apartado de la cuenta, cualquier rol)
const noTokPw = await req('/auth/change-password', { method: 'POST', body: { currentPassword: 'x', newPassword: 'y12345' } });
check('change-password sin token → 401', noTokPw.status === 401);
const badCur = await req('/auth/change-password', { method: 'POST', token: utoken, body: { currentPassword: 'equivocada', newPassword: 'nueva123456' } });
check('change-password: contraseña actual incorrecta → 400', badCur.status === 400);
const shortPw = await req('/auth/change-password', { method: 'POST', token: utoken, body: { currentPassword: 'secret123', newPassword: 'abc' } });
check('change-password: nueva muy corta → 400', shortPw.status === 400);
const samePw = await req('/auth/change-password', { method: 'POST', token: utoken, body: { currentPassword: 'secret123', newPassword: 'secret123' } });
check('change-password: igual a la actual → 400', samePw.status === 400);
const changePw = await req('/auth/change-password', { method: 'POST', token: utoken, body: { currentPassword: 'secret123', newPassword: 'chuche2026' } });
check('change-password con sesión → 200', changePw.status === 200 && changePw.data.updated);
const oldLogin = await login(email, 'secret123');
check('la contraseña antigua ya no entra', !oldLogin.access_token && !!oldLogin.error);
const newLogin = await login(email, 'chuche2026');
check('la contraseña nueva sí entra', !!newLogin.access_token);
const oldRefresh = await fetch(OAUTH_BASE + '/oauth/token', form({
  grant_type: 'refresh_token', client_id: 'candyshop-web', refresh_token: user.refresh_token,
})).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
check('el refresh antiguo queda revocado (otras sesiones cerradas)', oldRefresh.status === 400, oldRefresh.data?.error || '');

// 5) Carrito con sesión
const add = await req('/cart/items', { method: 'POST', body: { productId: prod.data.id, quantity: 2 }, token: utoken });
check('añadir al carrito (con sesión)', add.status === 201 && add.data.items.length === 1);
const coupon = await req('/coupons/validate', { method: 'POST', body: { code: 'HOLA10' }, token: utoken });
check('cupón HOLA10 aplica -10%', coupon.status === 200 && coupon.data.discount > 0, `descuento ${coupon.data.discount} €`);

// 6) Pedido con sesión
const order = await req('/orders', {
  method: 'POST', token: utoken,
  body: { name: 'Smoke Test', email, phone: '600000000', address: 'Calle Dulce 1', city: 'Madrid', province: 'Madrid', postal: '28001' },
});
check('crear pedido', order.status === 201 && order.data.code.startsWith('CDY-'), `total ${order.data.total} €`);

const stockAfter = await req(`/products/${prod.data.id}`);
check('stock descontado', stockAfter.data.stock === prod.data.stock - 2);

// 7) Consulta de pedidos: solo con token
const lookup = await req(`/orders/${order.data.code}`, { token: utoken });
check('dueño consulta su pedido con token', lookup.status === 200 && lookup.data.items.length === 1);
const lookupNoTok = await req(`/orders/${order.data.code}`);
check('pedido sin token → 401', lookupNoTok.status === 401);
const other = await login('cliente@candyshop.test', 'cliente123');
const lookupOther = await req(`/orders/${order.data.code}`, { token: other.access_token });
check('otro usuario → 403 en pedido ajeno', lookupOther.status === 403);
const list = await req('/orders', { token: utoken });
check('lista de pedidos solo los propios', list.status === 200 && list.data.data.every((o) => o.user_id === reg.data.user.id), `${list.data.total} pedidos`);

// 8) Admin: login OAuth y cambia el estado del pedido
const adm = await login('admin@candyshop.test', 'admin123');
check('admin obtiene scope admin', adm.grantedScope.split(' ').includes('admin'), adm.grantedScope);
const atoken = adm.access_token;

const stats = await req('/admin/stats', { token: atoken });
check('admin stats (facturación desde PG)', stats.status === 200 && stats.data.revenue > 0, `facturación ${stats.data.revenue} €`);
const cancel = await req(`/admin/orders/${order.data.id}`, { method: 'PATCH', body: { status: 'cancelled' }, token: atoken });
check('cancelar pedido', cancel.status === 200 && cancel.data.status === 'cancelled');
const stockRestored = await req(`/products/${prod.data.id}`);
check('stock repuesto al cancelar', stockRestored.data.stock === prod.data.stock);

// 9) CRUD admin de producto + cupón
const created = await req('/admin/products', { method: 'POST', token: atoken, body: { name: 'Chuche Temporal ' + Date.now(), price: 1.5, stock: 10 } });
check('crear producto (admin)', created.status === 201);
const edited = await req(`/admin/products/${created.data.id}`, { method: 'PUT', token: atoken, body: { name: 'Chuche Editada', price: 2.5, stock: 8 } });
check('editar producto (admin)', edited.status === 200 && edited.data.updated);
const removed = await req(`/admin/products/${created.data.id}`, { method: 'DELETE', token: atoken });
check('borrar producto (admin)', removed.status === 200 && removed.data.deleted);
const adminProducts = await req('/admin/products', { token: atoken });
check('listado admin de productos', adminProducts.status === 200 && adminProducts.data.total >= 39);
const newCoupon = await req('/admin/coupons', { method: 'POST', token: atoken, body: { code: 'SMOKE' + Date.now().toString(36).toUpperCase(), type: 'percent', value: 15 } });
check('crear cupón (admin)', newCoupon.status === 201);

// 9b) Admin restablece la contraseña de un usuario
const shortReset = await req(`/admin/users/${reg.data.user.id}/password`, { method: 'POST', token: atoken, body: { password: 'abc' } });
check('restablecer contraseña: muy corta → 400', shortReset.status === 400);
const reset404 = await req('/admin/users/999999/password', { method: 'POST', token: atoken, body: { password: 'nueva12345' } });
check('restablecer contraseña: usuario inexistente → 404', reset404.status === 404);
const resetPw = await req(`/admin/users/${reg.data.user.id}/password`, { method: 'POST', token: atoken, body: { password: 'reset12345' } });
check('admin restablece la contraseña de un usuario → 200', resetPw.status === 200 && resetPw.data.updated);
const resetLogin = await login(email, 'reset12345');
check('el usuario entra con la contraseña restablecida', !!resetLogin.access_token);

// 10) Rol staff: entre admin y cliente
const stf = await login('staff@candyshop.test', 'staff123');
check('login staff → scope "staff" concedido', !stf.error && stf.grantedScope.split(' ').includes('staff'), stf.grantedScope);
check('el scope "admin" NO se concede al staff', !stf.grantedScope.split(' ').includes('admin'));
const stoken = stf.access_token;
const stfMe = await req('/auth/me', { token: stoken });
check('/auth/me → role staff', stfMe.status === 200 && stfMe.data.user.role === 'staff');

const stfOrders = await req('/admin/orders', { token: stoken });
check('staff ve todos los pedidos', stfOrders.status === 200 && stfOrders.data.total > 0, `${stfOrders.data.total} pedidos`);
const stfPatch = await req(`/admin/orders/${order.data.id}`, { method: 'PATCH', body: { status: 'paid' }, token: stoken });
check('staff cambia estado de un pedido', stfPatch.status === 200 && stfPatch.data.status === 'paid');
const stfProd = await req('/admin/products', { method: 'POST', token: stoken, body: { name: 'Chuche Staff ' + Date.now(), price: 3, stock: 5 } });
check('staff crea producto', stfProd.status === 201);
const stfEdit = await req(`/admin/products/${stfProd.data.id}`, { method: 'PUT', token: stoken, body: { name: 'Chuche Staff Editada', price: 3.5, stock: 6 } });
check('staff edita producto', stfEdit.status === 200 && stfEdit.data.updated);
const stfDel = await req(`/admin/products/${stfProd.data.id}`, { method: 'DELETE', token: stoken });
check('staff borra producto', stfDel.status === 200 && stfDel.data.deleted);

const stfStats = await req('/admin/stats', { token: stoken });
check('staff SIN acceso a estadísticas → 403', stfStats.status === 403);
const stfUsers = await req('/admin/users', { token: stoken });
check('staff SIN acceso a usuarios → 403', stfUsers.status === 403);
const stfReset = await req(`/admin/users/${reg.data.user.id}/password`, { method: 'POST', token: stoken, body: { password: 'loquesea1' } });
check('staff SIN permiso para restablecer contraseñas → 403', stfReset.status === 403);
const stfCoupons = await req('/admin/coupons', { token: stoken });
check('staff SIN acceso a cupones → 403', stfCoupons.status === 403);
const stfCats = await req('/categories', { method: 'POST', token: stoken, body: { name: 'Hack' } });
check('staff SIN acceso a categorías → 403', stfCats.status === 403);

// 11) El cliente no pasa de customer en el panel
const custPanel = await req('/admin/orders', { token: utoken });
check('cliente SIN acceso a /admin/orders → 403', custPanel.status === 403);

console.log(`\n${pass} correctas, ${fail} fallos`);
process.exit(fail ? 1 : 0);
