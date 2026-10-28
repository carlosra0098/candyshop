# 🍬 CandyShop — API REST + Frontend de tienda de golosinas

Proyecto completo y funcional: una **API REST propia** (Node.js + **PostgreSQL** + **OAuth 2.0**) y un **frontend visual** de tienda de golosinas inspirado en el diseño de tiendas tipo Fini Store.

## 🚀 Arranque rápido

```bash
cd candyshop
npm install      # solo la primera vez (instala el driver "pg")
npm start        # o: npm run dev  (recarga automática)
```

Abre **http://localhost:3000** 🎉

> **Requisitos**
> - Node.js ≥ 22.5
> - **PostgreSQL 17** corriendo en `localhost:5432` con base de datos `candyshop` (rol `candyshop`).
>   La URL de conexión va en `.env` (`DATABASE_URL`); copia `.env.example` → `.env` y ajusta.
>
> El esquema se crea automáticamente en el primer arranque y, si la BD está vacía,
> se puebla con datos de ejemplo. Para regenerar: `npm run reset`.
> Para migrar datos de la versión SQLite antigua: `npm run migrate`.

### Cuentas de prueba

| Rol  | Email                     | Contraseña  |
|------|---------------------------|-------------|
| Admin| `admin@candyshop.test`    | `admin123`  |
| Staff | `staff@candyshop.test`   | `staff123`  |
| Cliente | `cliente@candyshop.test` | `cliente123` |

**Jerarquía de roles:** `customer` < `staff` < `admin`. El rol se valida siempre contra la BD (el JWT solo aporta el scope).

- `customer`: compra y consulta sus propios pedidos.
- `staff`: gestiona **pedidos** (ver todos + cambiar estado) y **productos** (CRUD). No accede a estadísticas, usuarios, cupones ni categorías.
- `admin`: todo lo anterior + estadísticas, usuarios, cupones y categorías.

- Panel admin: http://localhost:3000/admin
- Cupones de ejemplo: `HOLA10` (−10 %), `BIENVENIDA5` (−5 € desde 20 €), `MESA20` (−20 % desde 60 €)

### Clientes OAuth 2.0

| client_id | Tipo | Secreto | Grants |
|-----------|------|---------|--------|
| `candyshop-web` | público (SPA) | — (PKCE obligatorio) | `authorization_code`, `refresh_token` |
| `candyshop-server` | confidencial | `candyshop-secret-2026` | `client_credentials` (actúa en nombre del admin) |

## 🔐 Autenticación: OAuth 2.0 + JWT (sin cookies ni sesiones)

Toda la autenticación es **stateless en el cliente** (Bearer tokens) y **stateful solo en PostgreSQL** (códigos y refresh tokens):

- **Access token**: JWT `HS256` con `typ: at+jwt` (RFC 9068), TTL **15 min**, claims `sub/iss/aud/scope/client_id/jti/iat/exp`. Se verifica localmente, sin consultas.
- **Scopes** (`scope` del token): `profile`, `email`, `orders` para cualquier usuario; `staff` solo si el rol es `staff`/`admin`; `admin` solo si el rol es `admin`.
- **Refresh token**: opaco y aleatorio (30 días), guardado **hasheado** (SHA-256) en la BD, **rota en cada uso**. Reutilizarlo tras la rotación revoca **toda la familia** (detección de robo).
- **PKCE (S256)** obligatorio en el flujo de authorization code.
- Nunca se usa una cookie ni una sesión de servidor.

### Flujo del frontend (Authorization Code + PKCE)

```
POST /oauth/authorize  (credenciales + code_challenge)  →  { code }
POST /oauth/token      (code + code_verifier)           →  { access_token, refresh_token }
GET  /api/...          Authorization: Bearer <access_token>
POST /oauth/token      (grant_type=refresh_token)       →  rotación automática al caducar
```

Si el cliente envía `Accept: application/json`, `/oauth/authorize` devuelve `{code, state}` sin redireccionar; los navegadores (Accept: text/html) reciben el formulario de login y un `302` al `redirect_uri` registrado.

### Endpoints OAuth

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/oauth/authorize` | Pantalla de login HTML (parámetros: `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`) |
| POST | `/oauth/authorize` | Valida credenciales y emite el `code` (JSON o 302) |
| POST | `/oauth/token` | Grants: `authorization_code` (+PKCE), `refresh_token` (rotación), `client_credentials` |
| POST | `/oauth/revoke` | Revoca un refresh token (RFC 7009) |
| POST | `/oauth/introspect` | Consulta de tokens (RFC 7662, requiere cliente confidencial) |
| GET | `/oauth/.well-known/openid-configuration` | Metadatos del servidor |

### Ejemplo con curl (server-to-server)

```bash
# 1) Token por client_credentials (cliente confidencial)
curl -u candyshop-server:candyshop-secret-2026 \
     -d grant_type=client_credentials http://localhost:3000/oauth/token

# 2) Usarlo contra la API
curl -H "Authorization: Bearer <access_token>" http://localhost:3000/api/admin/stats
```

## 🐍 Backend alternativo: Python + FastAPI

`backend-python/` es un **port completo** del backend Node a **Python 3.14 + FastAPI**: mismo contrato de API (mismos JSON, códigos HTTP y rutas limpias `/tienda` → `tienda.html`), misma base de datos PostgreSQL y **mismas contraseñas** (scrypt compatible entre ambas versiones). Ambos backends conviven sin pisarse: Node en el 3000 y Python en el 8000.

```bash
cd candyshop/backend-python
.\.venv\Scripts\pip install -r requirements.txt   # solo la primera vez
.\run.ps1                                          # arranca en http://localhost:8000
```

- Comparte el `.env` de la raíz (`DATABASE_URL`, `JWT_SECRET`, TTLs, `GITHUB_*`).
- Al arrancar crea/actualiza el esquema, los datos de ejemplo, las cuentas demo y los clientes OAuth (idempotente).
- Mismas suites de tests: `BASE_URL=http://localhost:8000 npm run test:oauth` (47 ✔) y `BASE_URL=http://localhost:8000 npm run test:shop` (57 ✔).
- Estructura: `app/{main,api,oauth,auth,db,seed,config,errors,github}.py`.

## 🐙 Login con GitHub ("Entrar con GitHub") — backend Python

Junto al login clásico (email/contraseña) hay un botón **🐙 Entrar con GitHub** en `/cuenta` y `/admin` (se oculta solo si no está configurado). Es **federación de identidad**: CandyShop valida tu sesión con GitHub y luego emite **sus mismos tokens** (access JWT + refresh rotativo), así que el resto de la app —scopes, roles, carrito, pedidos— funciona igual que al entrar con contraseña.

- `GET /auth/github/login?redirect=/cuenta` → guarda un `state` de un solo uso en PostgreSQL (anti-CSRF, sin cookies) y redirige a GitHub.
- `GET /auth/github/callback?code&state` → canjea el code, baja el perfil (`/user` + `/user/emails`, con email privado incluido), **busca/vincula/crea** la cuenta local y devuelve los tokens en el `#fragment` de la vuelta al frontend.
- **Vinculación**: si ya tienes sesión iniciada al pulsar el botón, GitHub se vincula a tu cuenta; si no, una cuenta existente con el mismo email se vincula automáticamente (conserva su contraseña); si no existe, se crea una cuenta nueva (entra solo con GitHub).
- Anti open-redirect: el parámetro `redirect` solo acepta rutas locales (`/...`).
- Variables en `.env`: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`.

> ⚠️ **Importante**: la *Authorization callback URL* registrada en tu OAuth App de GitHub debe coincidir **exactamente** con `GITHUB_CALLBACK_URL` del `.env`: `http://localhost:8000/auth/github/callback`. Si cambias de puerto, actualízala en ambos lados (GitHub → Settings → Developer settings → OAuth Apps).

## 🗂️ Estructura

```
candyshop/
├── package.json
├── .env / .env.example   # DATABASE_URL, JWT_SECRET, TTLs…
├── src/
│   ├── server.js      # HTTP + estáticos + /api + /oauth + mapeo de errores PG
│   ├── env.js         # carga de .env (sin dependencias)
│   ├── db.js          # pool PostgreSQL (pg) + esquema idempotente
│   ├── api.js         # endpoints de la tienda (async/await)
│   ├── oauth.js       # servidor OAuth 2.0 (authorize/token/revoke/introspect)
│   ├── auth.js        # scrypt + JWT HS256 + PKCE + refresh tokens
│   ├── router.js      # enrutador minimalista + JSON/form bodies
│   └── seed.js        # datos de ejemplo (8 categorías, 39 productos…)
├── public/            # Frontend vanilla (HTML/CSS/JS) con login OAuth
├── backend-python/    # Port a Python + FastAPI (mismo contrato API, puerto 8000)
├── scripts/
│   ├── test-oauth.mjs     # suite OAuth2 + JWT (38 tests)
│   ├── test-shop.mjs      # smoke test del flujo de compra (20 tests)
│   ├── migrate-sqlite.mjs # migración SQLite → PostgreSQL
│   ├── diag-token.mjs     # diagnóstico del JWT
│   └── check-inline.js    # verificador de sintaxis de scripts inline
└── data/candyshop.db  # (opcional) base SQLite original, ya no se usa
```

## 🔌 API REST

Base: `http://localhost:3000/api` · Respuestas JSON · Auth por `Authorization: Bearer <access_token>`.

> ⛔ **Todo el flujo de compra exige sesión**: carrito, cupones y pedidos devuelven `401` sin token (ya no existen carritos de invitado ni consulta de pedidos por email). El catálogo, el registro y el login son públicos.

### Público (sin token)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servidor |
| GET | `/categories` | Categorías con nº de productos |
| GET | `/products` | Lista. Filtros: `q`, `category`, `minPrice`, `maxPrice`, `badge`, `sort` (`popular`\|`price-asc`\|`price-desc`\|`newest`\|`name`), `page`, `limit` |
| GET | `/products/:idOrSlug` | Detalle + reseñas |
| POST | `/products/:id/reviews` | Crear reseña `{name, rating 1-5, comment}` |
| POST | `/auth/register` | `{name, email, password}` → crea la cuenta (los tokens se obtienen por OAuth) |
| POST | `/newsletter` | `{email}` |

### Autenticados (cualquier rol con sesión)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/auth/me` | Usuario del access token |
| POST | `/auth/change-password` | `{currentPassword, newPassword}` → cambia la contraseña (mín. 6) y revoca los refresh tokens de las demás sesiones |
| GET | `/cart` | Carrito del usuario con totales calculados |
| POST | `/cart/items` | `{productId, quantity}` |
| PATCH | `/cart/items/:productId` | `{quantity}` |
| DELETE | `/cart/items/:productId` | Quitar línea |
| DELETE | `/cart` | Vaciar carrito |
| POST | `/cart/merge` | Fusionar carrito previo al login `{token}` |
| POST | `/coupons/validate` | `{code}` → aplica y recalcula |
| DELETE | `/cart/coupon` | Quita cupón |
| POST | `/orders` | Crea pedido desde el carrito (transaccional: pedido + líneas + stock) |
| GET | `/orders` | Pedidos del usuario (o todos si eres admin) |
| GET | `/orders/:code` | Detalle del pedido: solo el dueño o staff/admin |

### Staff o admin (rol `staff` + scope `staff`/`admin`)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/admin/orders` | Todos los pedidos |
| PATCH | `/admin/orders/:id` | `{status}` pending/paid/shipped/delivered/cancelled (cancelar repone stock) |
| GET | `/admin/products` | Listado completo para gestión |
| POST | `/admin/products` | Crear producto |
| PUT/DELETE | `/admin/products/:id` | Editar / eliminar |

### Solo admin (rol `admin` + scope `admin`)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/admin/stats` | KPIs: facturación, pedidos, clientes, top ventas… |
| GET | `/admin/users` | Lista de usuarios |
| POST | `/admin/users/:id/password` | `{password}` → restablece la contraseña de un usuario y cierra sus sesiones |
| GET/POST/DELETE | `/admin/coupons[/:id]` | Gestión de cupones |
| POST/PATCH/DELETE | `/categories[/:id]` | Gestión de categorías |

### Lógica de negocio

- **Envío gratis** a partir de 20 € (subtotal tras descuento); si no, 3,95 €.
- Stock validado y descontado **en transacción** al confirmar el pedido; se repone si el pedido se cancela.
- Contraseñas con `scrypt` + salt; access tokens firmados con HMAC-SHA256 (15 min); refresh tokens rotativos (30 días).
- Errores coherentes: `400` validación, `401` sin sesión/token, `403` sin permisos, `404` no existe, `409` conflicto (duplicados/stock), `503` BD caída.

## 🎨 Frontend

Diseño propio inspirado en tiendas de golosinas online: paleta magenta/amarillo, tarjetas redondeadas, barra de anuncios, navegación por categorías reales de la API, mini-carrito lateral con barra de "faltan X € para envío gratis", toasts, slider en portada, panel administrativo con métricas y CRUD completo. Sin frameworks ni build: HTML + CSS + JS puro.

**El flujo de compra pide sesión**: sin login, "Añadir al carrito", el carrito (`/carrito`) y el checkout redirigen al panel de registro/inicio de sesión con `?next=` para volver al punto de compra tras entrar. En `/admin`, el rol `staff` solo ve las pestañas de Productos y Pedidos (Resumen, Usuarios y Cupones son de admin). La pestaña **👥 Usuarios** (solo admin) permite restablecer la contraseña de cualquier usuario desde un modal.

**Acceso al panel admin**: en la página de cuenta (`/cuenta`), el botón "🛠️ Panel admin" aparece **solo cuando inicias sesión con rol admin** (cliente y staff no lo ven; el staff accede al panel por el enlace del pie "Área de administración" o directamente en `http://localhost:3000/admin`).

**Cambiar contraseña**: en `/cuenta` (zona logueada) hay un apartado **🔒 Cambiar contraseña** disponible para **cualquier rol** (cliente, staff y admin): valida la contraseña actual, exige mínimo 6 caracteres y distinta de la anterior, y al guardar revoca los refresh tokens para cerrar las demás sesiones (la sesión actual se renueva sola con la contraseña nueva).

El login del frontend usa el flujo OAuth completo (PKCE incluido) y **renueva el access token solo** cuando caduca, usando el refresh token guardado en `localStorage`. Al cerrar sesión se revoca el refresh token en el servidor.

## 🔧 Configuración por entorno

| Variable | Por defecto | Uso |
|----------|-------------|-----|
| `PORT` | `3000` | Puerto del servidor |
| `DATABASE_URL` | `postgres://candyshop:CandyShop_PG_2026@localhost:5432/candyshop` | Conexión PostgreSQL |
| `JWT_SECRET` | valor dev | Secreto HMAC de los access tokens (cámbialo en producción) |
| `ACCESS_TOKEN_TTL` | `900` (15 min) | Vida del access token (s) |
| `REFRESH_TOKEN_TTL` | `2592000` (30 días) | Vida del refresh token (s) |
| `CORS_ORIGIN` | `*` | Origen permitido |

## ✅ Tests ejecutados

```bash
npm test           # sintaxis + OAuth + compra
npm run test:oauth # 47 tests: authorize/token/PKCE/rotación/scopes/roles/JWT
npm run test:shop  # 57 tests: catálogo, auth del flujo de compra, cambio/restablecimiento de contraseñas, carrito, cupones, pedidos, admin, staff
```

Las mismas suites corren contra el backend Python: `BASE_URL=http://localhost:8000 npm run test:oauth` → 47/47 y `BASE_URL=http://localhost:8000 npm run test:shop` → 57/57 (paridad total de contrato).

- Metadatos OAuth, authorize (JSON y 302), PKCE: challenge/verifier, code de un solo uso ✔
- Rotación de refresh tokens + detección de reutilización (revocación de familia) ✔
- `client_credentials` con cliente confidencial (en nombre del dueño) ✔
- Introspección y revocación de tokens ✔
- Seguridad JWT: firma, `alg:none`, payload alterado, caducidad ✔
- Scopes: cliente sin `admin` → 403; admin con `admin` → OK; al staff se le concede `staff` y nunca `admin` ✔
- Roles: `customer` < `staff` < `admin`, validados siempre contra la BD ✔
- Catálogo: categorías, paginación, búsqueda, filtros, reseñas ✔
- Flujo de compra con sesión obligatoria: carrito/cupones/pedidos → 401 sin token, cupones, pedido transaccional, stock ± ✔
- Cambiar contraseña: sin token → 401, validaciones → 400, contraseña antigua fuera de servicio y refresh revocado ✔
- Admin restablece contraseñas de usuarios: validaciones → 400/404, el usuario entra con la nueva y staff → 403 ✔
- Pedidos: solo el dueño (o staff/admin) puede verlos; sin consulta por email anónima ✔
- Admin: stats, CRUD productos, cambio de estado con repuesto de stock ✔
- Staff: lista/parchea pedidos y hace CRUD de productos → 403 en stats/usuarios/cupones/categorías ✔
