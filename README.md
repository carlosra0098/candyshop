# 🍬 CandyShop — API REST (FastAPI) + Frontend (React)

Enlace para entrar a la página publicada en Render --> https://candyshop-api.onrender.com/

Proyecto separado en dos aplicaciones independientes:

- **`backend-python/`** → API REST con **Python 3.14 + FastAPI + PostgreSQL + OAuth 2.0**. Ya no sirve HTML.
- **`frontend/`** → SPA con **React 18 + Vite**, servida en otro origen (5173 en desarrollo).

## 🚀 Arranque rápido (dos terminales)

**1. Backend** (API en `http://localhost:8000`):

```bash
cd candyshop/backend-python
.\.venv\Scripts\pip install -r requirements.txt   # solo la primera vez
.\run.ps1                                          # http://localhost:8000/docs
```

**2. Frontend** (web en `http://localhost:5173`):

```bash
cd candyshop/frontend
npm install                                        # solo la primera vez
copy .env.example .env                             # VITE_API_URL=http://localhost:8000
npm run dev
```

Abre **http://localhost:5173** 🎉

> **Requisitos**
> - Python 3.14 y Node 20+ (probado con Node 24).
> - PostgreSQL 17 en `localhost:5432` con la base `candyshop` (rol `candyshop`). Copia `.env.example` → `.env` en la raíz y ajusta `DATABASE_URL`.
> - El esquema y los datos de ejemplo se crean automáticamente en el primer arranque del backend.

### Cuentas de prueba

| Rol | Email | Contraseña |
|------|---------------------------|-------------|
| Admin | `admin@candyshop.test` | `admin123` |
| Staff | `staff@candyshop.test` | `staff123` |
| Cliente | `cliente@candyshop.test` | `cliente123` |

**Jerarquía:** `customer` < `staff` < `admin`. El rol se valida siempre contra la BD (el JWT solo aporta el scope).

- `customer`: compra y consulta sus propios pedidos.
- `staff`: gestiona **pedidos** (ver todos + cambiar estado) y **productos** (CRUD). Sin estadísticas, usuarios, cupones ni categorías.
- `admin`: todo lo anterior + estadísticas, usuarios, cupones y categorías.

- Panel admin: http://localhost:5173/admin (el botón "🛠️ Panel admin" en `/cuenta` aparece solo para `admin`).
- Cupones de ejemplo: `HOLA10` (−10 %), `BIENVENIDA5` (−5 € desde 20 €), `MESA20` (−20 % desde 60 €).

## 🔐 Autenticación: OAuth 2.0 + JWT (sin cookies ni sesiones)

- **Access token**: JWT `HS256` (`typ: at+jwt`), TTL **15 min**, claims `sub/iss/aud/scope/client_id/jti/iat/exp`.
- **Scopes**: `profile`, `email`, `orders` para cualquier usuario; `staff` para `staff`/`admin`; `admin` solo para `admin`.
- **Refresh token**: opaco, guardado **hasheado** en BD, **rota en cada uso**; reutilizar uno antiguo revoca la familia.
- **PKCE (S256)** obligatorio en `authorization_code`.

Flujo del frontend React (`frontend/src/lib/api.js`):

```
POST /oauth/authorize  (credenciales + code_challenge)  →  { code }
POST /oauth/token      (code + code_verifier)           →  { access_token, refresh_token }
GET  /api/...          Authorization: Bearer <access_token>
POST /oauth/token      (grant_type=refresh_token)       →  rotación automática en 401
```

### Clientes OAuth

| client_id | Tipo | Secreto | Grants |
|-----------|------|---------|--------|
| `candyshop-web` | público (SPA React) | — (PKCE) | `authorization_code`, `refresh_token` |
| `candyshop-server` | confidencial | `candyshop-secret-2026` | `client_credentials` |

Redirect URIs registradas: `http://localhost:5173/cuenta`, `http://localhost:5173/admin` (y `4173`/`8000` legados). En producción se añaden las de `FRONTEND_ORIGIN`.

```bash
curl -u candyshop-server:candyshop-secret-2026 -d grant_type=client_credentials \
     http://localhost:8000/oauth/token
```

## 🐙 Login con GitHub

El botón aparece en `/cuenta` y `/admin` solo si el backend tiene configuradas las variables `GITHUB_*`.

- `GET /auth/github/login?redirect=/cuenta` → `state` de un solo uso → GitHub.
- `GET /auth/github/callback?code&state` → emite los tokens de CandyShop y vuelve a **`FRONTEND_ORIGIN`** con los tokens en el `#fragment` (anti open-redirect).
- Callback URL a configurar en GitHub: `http://localhost:8000/auth/github/callback` (o la URL pública del backend).

## 🗂️ Estructura

```
candyshop/
├── .env / .env.example          # configuración del backend
├── README.md
├── netlify.toml                 # despliegue de la SPA (rewrite a /index.html)
├── backend-python/
│   ├── requirements.txt
│   ├── run.ps1
│   └── app/
│       ├── main.py      # FastAPI: CORS, errores, routers (sin estáticos)
│       ├── api.py       # Endpoints de la tienda
│       ├── oauth.py     # Servidor OAuth 2.0
│       ├── auth.py      # scrypt + JWT + refresh tokens
│       ├── db.py        # Pool PostgreSQL + esquema
│       ├── seed.py      # Datos de ejemplo + clientes OAuth
│       ├── config.py    # Configuración
│       ├── errors.py
│       └── github.py
└── frontend/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    ├── netlify.toml / .env.example
    └── src/
        ├── main.jsx / App.jsx / styles.css
        ├── lib/api.js          # Cliente API + OAuth/PKCE + GitHub
        ├── context/AppContext.jsx
        ├── components/         # Layout, ProductCard, Modal
        └── pages/              # Home, Shop, Product, Cart, Account, Admin, NotFound
```

> La carpeta antigua `public/` (HTML/CSS/JS vanilla) se conserva solo como referencia histórica: **FastAPI ya no la sirve**. Puedes borrarla cuando quieras.

## 🔌 API REST

Base: `http://localhost:8000/api` · Respuestas JSON · `Authorization: Bearer <access_token>`.

> Todo el flujo de compra exige sesión: carrito, cupones y pedidos devuelven `401` sin token. Catálogo, registro y login son públicos.

| Grupo | Endpoints |
|-------|-----------|
| Públicos | `GET /api/health`, `/api/categories`, `/api/products`, `/api/products/{id}`, `POST /api/products/{id}/reviews`, `POST /api/auth/register`, `POST /api/newsletter` |
| Sesión | `GET /api/auth/me`, `POST /api/auth/change-password`, `GET/POST /api/cart`, `GET/POST/DELETE /api/cart/items`, `PATCH /api/cart/items/{id}`, `POST /api/coupons/validate`, `DELETE /api/cart/coupon`, `GET/POST /api/orders`, `GET /api/orders/{code}` |
| Staff + admin | `GET/PATCH /api/admin/orders`, `GET/POST/PUT/DELETE /api/admin/products` |
| Solo admin | `GET /api/admin/stats`, `GET /api/admin/users`, `POST /api/admin/users/{id}/password`, `GET/POST/DELETE /api/admin/coupons`, `POST/PATCH/DELETE /api/admin/categories` |

Documentación interactiva: http://localhost:8000/docs

## 🌐 Despliegue

**Backend (Render u otro PaaS):** Root Directory `backend-python`, build `pip install -r requirements.txt` y Start Command:

```
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Variables de entorno del backend: `DATABASE_URL` (Internal Database URL de PostgreSQL), `JWT_SECRET`, `CORS_ORIGIN` (URL del frontend), `FRONTEND_ORIGIN` (misma URL; se usa para redirects y OAuth). **No añadas `:10000` al `--port`**: Render ya inyecta `$PORT`.

**Frontend (Netlify/Vercel/Render Static):** raíz del build `frontend`, comando `npm run build`, salida `frontend/dist`, variable `VITE_API_URL=https://tu-backend`. Necesita rewrite SPA (`/*` → `/index.html`); ya viene en `netlify.toml`. En Vercel, añade `vercel.json` con el mismo rewrite.

## 🔧 Configuración por entorno

| Variable | Por defecto | Uso |
|----------|-------------|-----|
| `PORT` | `3000` (`run.ps1` usa `8000`) | Puerto del backend |
| `DATABASE_URL` | `postgres://candyshop:...@localhost:5432/candyshop` | Conexión PostgreSQL |
| `JWT_SECRET` | valor dev | Secreto HMAC de los access tokens |
| `ACCESS_TOKEN_TTL` | `900` | Vida del access token (s) |
| `REFRESH_TOKEN_TTL` | `2592000` | Vida del refresh token (s) |
| `CORS_ORIGIN` | `*` | Origen(es) permitidos (separados por comas) |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | URL de la SPA (redirects OAuth/GitHub) |
| `VITE_API_URL` | `http://localhost:8000` | URL del backend en el frontend React |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` | — | Login con GitHub |
