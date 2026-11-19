# 🍬 CandyShop — API REST + Frontend (Python + FastAPI)

Enlace para entrar a la página publicada en Render --> https://candyshop-api.onrender.com/

Backend en **Python 3.14 + FastAPI** con **PostgreSQL + OAuth 2.0**, frontend vanilla servido desde `backend-python/app/static/`.

## 🚀 Arranque rápido

```bash
cd candyshop/backend-python
.\.venv\Scripts\pip install -r requirements.txt   # solo la primera vez
.\run.ps1                                          # arranca en http://localhost:8000
```

Abre **http://localhost:8000** 🎉

> **Requisitos**
> - Python 3.14
> - **PostgreSQL 17** corriendo en `localhost:5432` con base de datos `candyshop` (rol `candyshop`).
>   La URL de conexión va en `.env` de la raíz (`DATABASE_URL`); copia `.env.example` → `.env` y ajusta.
>
> El esquema se crea automáticamente en el primer arranque y, si la BD está vacía, se puebla con datos de ejemplo. Para regenerar datos: usa los scripts del backend o `seed`.

### Cuentas de prueba

| Rol | Email | Contraseña |
|------|---------------------------|-------------|
| Admin| `admin@candyshop.test` | `admin123` |
| Staff | `staff@candyshop.test` | `staff123` |
| Cliente | `cliente@candyshop.test` | `cliente123` |

**Jerarquía de roles:** `customer` < `staff` < `admin`. El rol se valida siempre contra la BD (el JWT solo aporta el scope).

- `customer`: compra y consulta sus propios pedidos.
- `staff`: gestiona **pedidos** (ver todos + cambiar estado) y **productos** (CRUD). No accede a estadísticas, usuarios, cupones ni categorías.
- `admin`: todo lo anterior + estadísticas, usuarios, cupones y categorías.

- Panel admin: http://localhost:8000/admin
- Cupones de ejemplo: `HOLA10` (−10 %), `BIENVENIDA5` (−5 € desde 20 €), `MESA20` (−20 % desde 60 €)

### Clientes OAuth 2.0

| client_id | Tipo | Secreto | Grants |
|-----------|------|---------|--------|
| `candyshop-web` | público (SPA) | — (PKCE obligatorio) | `authorization_code`, `refresh_token` |
| `candyshop-server` | confidencial | `candyshop-secret-2026` | `client_credentials` (actúa en nombre del admin) |

## 🔐 Autenticación: OAuth 2.0 + JWT (sin cookies ni sesiones)

- **Access token**: JWT `HS256` con `typ: at+jwt`, TTL **15 min**, claims `sub/iss/aud/scope/client_id/jti/iat/exp`.
- **Scopes** (`scope`): `profile`, `email`, `orders` para cualquier usuario; `staff` solo si el rol es `staff`/`admin`; `admin` solo si el rol es `admin`.
- **Refresh token**: opaco y aleatorio (30 días), guardado **hasheado** en BD, **rota en cada uso**. Reutilizarlo tras la rotación revoca **toda la familia**.
- **PKCE (S256)** obligatorio en el flujo de authorization code.
- Nunca se usa una cookie ni una sesión de servidor.

### Flujo del frontend (Authorization Code + PKCE)

```
POST /oauth/authorize  (credenciales + code_challenge)  →  { code }
POST /oauth/token      (code + code_verifier)           →  { access_token, refresh_token }
GET  /api/...          Authorization: Bearer <access_token>
POST /oauth/token      (grant_type=refresh_token)       →  rotación automática
```

Si el cliente envía `Accept: application/json`, `/oauth/authorize` devuelve `{code, state}` sin redireccionar; los navegadores (Accept: text/html) reciben el formulario de login y un `302` al `redirect_uri` registrado.

### Endpoints OAuth

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/oauth/authorize` | Pantalla de login HTML |
| POST | `/oauth/authorize` | Valida credenciales y emite el `code` |
| POST | `/oauth/token` | Grants: `authorization_code` (+PKCE), `refresh_token` (rotación), `client_credentials` |
| POST | `/oauth/revoke` | Revoca un refresh token (RFC 7009) |
| POST | `/oauth/introspect` | Consulta de tokens (RFC 7662, requiere cliente confidencial) |
| GET | `/oauth/.well-known/openid-configuration` | Metadatos del servidor |

### Ejemplo con curl (server-to-server)

```bash
# 1) Token por client_credentials (cliente confidencial)
curl -u candyshop-server:candyshop-secret-2026 \
     -d grant_type=client_credentials http://localhost:8000/oauth/token

# 2) Usarlo contra la API
curl -H "Authorization: Bearer <access_token>" http://localhost:8000/api/admin/stats
```

## 🐙 Login con GitHub

Botón **🐙 Entrar con GitHub** en `/cuenta` y `/admin`. Federación de identidad: CandyShop valida la sesión con GitHub y emite sus propios tokens.

- `GET /auth/github/login?redirect=/cuenta` → guarda `state` de un solo uso y redirige a GitHub.
- `GET /auth/github/callback?code&state` → canjea el code, obtiene perfil/emails, vincula o crea la cuenta local y devuelve tokens en el `#fragment`.
- Vinculación automática si existe cuenta con mismo email. Anti open-redirect.
- Variables en `.env`: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`.

## 🗂️ Estructura

```
candyshop/
├── .env / .env.example
├── README.md
└── backend-python/
    ├── requirements.txt
    ├── run.ps1
    └── app/
        ├── main.py      # FastAPI app, estáticos, rutas
        ├── api.py       # Endpoints de la tienda
        ├── oauth.py     # Servidor OAuth 2.0
        ├── auth.py      # scrypt + JWT + PKCE + refresh tokens
        ├── db.py        # Pool PostgreSQL + esquema + helpers
        ├── seed.py      # Datos de ejemplo
        ├── config.py    # Configuración
        ├── errors.py    # Errores
        ├── github.py    # OAuth GitHub
        └── static/      # Frontend vanilla (HTML/CSS/JS)
```

## 🔌 API REST

Base: `http://localhost:8000/api` · Respuestas JSON · Auth por `Authorization: Bearer <access_token>`.

> Todo el flujo de compra exige sesión: carrito, cupones y pedidos devuelven `401` sin token. El catálogo, el registro y el login son públicos.

Ver README completo en el código para el listado detallado de endpoints.

## 🎨 Frontend

Diseño propio inspirado en tiendas de golosinas online. Servido por FastAPI desde `app/static/`. Login con flujo OAuth completo (PKCE), renovación de access token con refresh token, panel administrativo con métricas y CRUD completo.

## 🔧 Configuración por entorno

| Variable | Por defecto | Uso |
|----------|-------------|-----|
| `PORT` | `8000` | Puerto del servidor |
| `DATABASE_URL` | `postgres://candyshop:CandyShop_PG_2026@localhost:5432/candyshop` | Conexión PostgreSQL |
| `JWT_SECRET` | valor dev | Secreto HMAC de los access tokens |
| `ACCESS_TOKEN_TTL` | `900` (15 min) | Vida del access token (s) |
| `REFRESH_TOKEN_TTL` | `2592000` (30 días) | Vida del refresh token (s) |
| `CORS_ORIGIN` | `*` | Origen permitido |
| `GITHUB_CLIENT_ID` | — | GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth App |
| `GITHUB_CALLBACK_URL` | `http://localhost:8000/auth/github/callback` | Callback URL |
