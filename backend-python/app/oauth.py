"""Servidor de autorización OAuth 2.0 (RFC 6749) — SIN cookies ni sesiones.

· GET  /oauth/authorize   → pantalla de login (HTML); el POST valida credenciales
                            y emite un code (PKCE S256 obligatorio).
· POST /oauth/token       → grants "authorization_code" (+PKCE), "client_credentials"
                            y "refresh_token" (rotación + detección de reutilización).
· POST /oauth/revoke      → revoca refresh tokens (RFC 7009).
· POST /oauth/introspect  → consulta de tokens (RFC 7662).
· GET  /oauth/.well-known/openid-configuration → metadatos.

Todo el estado vive en PostgreSQL: jamás se usa cookie ni sesión de servidor.
"""
import json
from html import escape
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from . import db
from .auth import (
    create_access_token,
    hash_password,
    pkce_challenge,
    random_token,
    safe_equal,
    sha256_hex,
    verify_password,
    verify_token,
)
from .config import config

oauth = APIRouter()

CODE_TTL_SECONDS = 120
ALL_SCOPES = ["profile", "email", "orders", "staff", "admin"]
DEFAULT_SCOPE = "profile email orders"


# ───────────────────────── helpers ─────────────────────────

def _parse_list(raw: str | None, fallback: list | None = None) -> list:
    try:
        value = json.loads(raw or "[]")
        return value if isinstance(value, list) else (fallback or [])
    except (json.JSONDecodeError, TypeError):
        return fallback or []


def _get_client(client_id: str | None) -> dict | None:
    if not client_id:
        return None
    return db.one("SELECT * FROM oauth_clients WHERE client_id = ?", client_id)


def _wants_json(request: Request) -> bool:
    accept = request.headers.get("accept", "")
    return "application/json" in accept and "text/html" not in accept


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


def _json(request: Request, status: int, data: dict) -> JSONResponse:
    return JSONResponse(status_code=status, content=data)


def _token_error(request: Request, status: int, error: str, description: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": error, "error_description": description},
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _read_params(request: Request) -> dict[str, Any]:
    """Cuerpo JSON o form (OAuth usa application/x-www-form-urlencoded)."""
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            body = await request.json()
        except Exception:
            body = {}
        return {**dict(request.query_params), **(body if isinstance(body, dict) else {})}
    form = await request.form()
    return {**dict(request.query_params), **dict(form)}


async def _authenticate_client(request: Request, body: dict) -> tuple[dict | None, tuple | None]:
    """Autentica al cliente OAuth (§2.3): Basic o client_id/client_secret en el body."""
    client_id = body.get("client_id")
    client_secret = body.get("client_secret")

    authorization = request.headers.get("authorization", "")
    if authorization.startswith("Basic "):
        try:
            import base64
            decoded = base64.b64decode(authorization[6:].strip()).decode()
            client_id, _, client_secret = decoded.partition(":")
            from urllib.parse import unquote
            client_secret = unquote(client_secret)
        except Exception:
            return None, (401, "invalid_client", "Cabecera Authorization Basic inválida")

    client = _get_client(client_id)
    if not client:
        return None, (401, "invalid_client", "Cliente desconocido")

    secret_hash = client["client_secret_hash"]
    if secret_hash:
        if not client_secret or not verify_password(client_secret, secret_hash):
            return None, (401, "invalid_client", "Credenciales de cliente inválidas")
    elif client_secret:
        return None, (401, "invalid_client", "Este cliente es público y no lleva secreto")
    return client, None


def _clamp_scope(requested: str | None, client_scopes: list[str], role: str | None) -> str:
    """· 'admin' → solo rol admin.  · 'staff' → rol staff o admin."""
    asked = (requested or DEFAULT_SCOPE).split()
    allowed = [
        s for s in dict.fromkeys(asked)
        if s in client_scopes
        and (s != "admin" or role == "admin")
        and (s != "staff" or role in ("staff", "admin"))
    ]
    return " ".join(allowed)


def _issue_tokens(client: dict, user: dict | None, scope: str, with_refresh: bool = True) -> dict:
    access = create_access_token({
        "sub": user["id"] if user else f"client:{client['client_id']}",
        "email": user["email"] if user else None,
        "role": user["role"] if user else "client",
        "scope": scope,
        "client_id": client["client_id"],
    })
    body = {"access_token": access, "token_type": "Bearer", "expires_in": config.access_ttl, "scope": scope}
    if user and with_refresh:
        refresh = random_token(48)
        db.run(
            """INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at)
               VALUES (?, ?, ?, ?, now() + make_interval(secs => ?))""",
            sha256_hex(refresh), client["client_id"], user["id"], scope, config.refresh_ttl,
        )
        body["refresh_token"] = refresh
    return body


# ───────────────────────── metadatos ─────────────────────────

@oauth.get("/oauth/.well-known/openid-configuration")
def openid_configuration(request: Request) -> dict:
    base = _base_url(request)
    return {
        "issuer": config.issuer,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "revocation_endpoint": f"{base}/oauth/revoke",
        "introspection_endpoint": f"{base}/oauth/introspect",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "client_credentials", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
        "scopes_supported": ALL_SCOPES,
        "revocation_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
        "introspection_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
    }


# ───────────────────────── pantalla de login ─────────────────────────

def _login_page(params: dict, error: str = "", email: str = "") -> str:
    hidden = "\n        ".join(
        f'<input type="hidden" name="{key}" value="{escape(str(params.get(key) or ""))}">'
        for key in ("response_type", "client_id", "redirect_uri", "scope", "state",
                    "code_challenge", "code_challenge_method")
    )
    error_html = f'<div class="error">{escape(error)}</div>' if error else ""
    return f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Iniciar sesión · CandyShop OAuth</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
         background: radial-gradient(1200px 600px at 20% -10%, #ffe066 0%, transparent 55%),
                     radial-gradient(900px 500px at 110% 20%, #ff8fc7 0%, transparent 60%), #1b0f1a; padding: 24px; }}
  .card {{ width: 100%; max-width: 420px; background:#fff; border-radius: 24px; padding: 32px;
          box-shadow: 0 30px 70px rgba(0,0,0,.45); }}
  .logo {{ font-size: 40px; text-align:center; }}
  h1 {{ margin: 8px 0 4px; text-align:center; font-size: 22px; color:#2b0d20; }}
  .sub {{ text-align:center; color:#7a5c6e; font-size: 13px; margin-bottom: 22px; }}
  label {{ display:block; font-size: 13px; font-weight:600; color:#4b2b3c; margin: 14px 0 6px; }}
  input[type=email], input[type=password], input[type=text] {{
      width:100%; padding: 12px 14px; border: 2px solid #f0d7e4; border-radius: 12px; font-size: 15px; outline:none; }}
  input:focus {{ border-color:#ff2d95; }}
  button {{ width:100%; margin-top: 22px; padding: 13px; border:0; border-radius: 12px; cursor:pointer;
           font-size: 15px; font-weight: 700; color:#fff; background: linear-gradient(90deg,#ff2d95,#ff6ec7);
           box-shadow: 0 10px 24px rgba(255,45,149,.35); }}
  button:hover {{ filter: brightness(1.05); }}
  .error {{ background:#ffe3ec; color:#a3123f; border:1px solid #ffc2d6; border-radius:10px;
           padding:10px 12px; font-size:13px; margin-bottom: 6px; }}
  .hint {{ margin-top:16px; font-size:11.5px; color:#9b7f8f; text-align:center; line-height:1.5; }}
  code {{ background:#f6edf3; padding:1px 6px; border-radius:6px; }}
</style>
</head>
<body>
  <form class="card" method="post" action="/oauth/authorize">
    <div class="logo">🍬</div>
    <h1>CandyShop</h1>
    <div class="sub">Inicia sesión para autorizar la aplicación</div>
    {error_html}
    <label for="email">Email</label>
        <input id="email" name="email" type="email" required autofocus value="{escape(email)}" placeholder="tucorreo@ejemplo.com">
    <label for="password">Contraseña</label>
        <input id="password" name="password" type="password" required placeholder="••••••••">
        {hidden}
    <button type="submit">Entrar y autorizar</button>
    <div class="hint">
      Flujo OAuth 2.0 <b>Authorization Code + PKCE</b><br>
      Sin cookies y sin sesiones: solo tokens Bearer.
    </div>
  </form>
</body>
</html>"""


async def _validate_authorize(params: dict) -> tuple[dict | None, tuple | None]:
    if params.get("response_type") != "code":
        return None, (400, "unsupported_response_type", 'response_type debe ser "code"')
    client = _get_client(params.get("client_id"))
    if not client:
        return None, (400, "invalid_client", "client_id desconocido")
    redirects = _parse_list(client["redirect_uris"])
    if not params.get("redirect_uri") or params["redirect_uri"] not in redirects:
        return None, (400, "invalid_request", "redirect_uri no está registrado para este cliente")
    if "authorization_code" not in _parse_list(client["grant_types"]):
        return None, (400, "unauthorized_client", "Este cliente no puede usar el flujo authorization_code")
    if not params.get("code_challenge"):
        return None, (400, "invalid_request", "code_challenge (PKCE) es obligatorio")
    if params.get("code_challenge_method", "plain") != "S256":
        return None, (400, "invalid_request", "code_challenge_method debe ser S256")
    return client, None


# ───────────────────────── GET /oauth/authorize ─────────────────────────

@oauth.get("/oauth/authorize", response_class=HTMLResponse)
async def authorize_form(request: Request) -> HTMLResponse:
    params = dict(request.query_params)
    client, error = await _validate_authorize(params)
    if error:
        status, code, description = error
        if _wants_json(request):
            return _json(request, status, {"error": code, "error_description": description})
        return HTMLResponse(_login_page(params, description), status_code=status)
    return HTMLResponse(_login_page(params, email=params.get("login_hint") or ""))


# ───────────────────────── POST /oauth/authorize ─────────────────────────

@oauth.post("/oauth/authorize")
async def authorize_submit(request: Request):
    body = await _read_params(request)
    params = body  # query ya fusionado en _read_params
    client, error = await _validate_authorize(params)
    if error:
        status, code, description = error
        if _wants_json(request):
            return _json(request, status, {"error": code, "error_description": description})
        # Error de parámetros OAuth → vuelve al redirect_uri con ?error= (RFC 6749 §4.1.2.1)
        if params.get("redirect_uri") and params.get("response_type"):
            target = urlparse(params["redirect_uri"])
            from urllib.parse import urlencode, urlunparse
            target = urlunparse(target._replace(query=urlencode({
                "error": code,
                "error_description": description,
                **({"state": params["state"]} if params.get("state") else {}),
            })))
            return RedirectResponse(target, status_code=302)
        return HTMLResponse(_login_page(params, description), status_code=status)

    # ── Credenciales del usuario (sin cookie/sesión: viajan en cada POST) ──
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    user = db.one("SELECT id, name, email, password_hash, role FROM users WHERE email = ?", email) if email else None

    if not user or not verify_password(password, user["password_hash"]):
        if _wants_json(request):
            return _json(request, 401, {"error": "access_denied", "error_description": "Email o contraseña incorrectos"})
        return HTMLResponse(_login_page(params, "Email o contraseña incorrectos", email), status_code=401)

    # ── Emisión del código de autorización ──
    scope = _clamp_scope(params.get("scope"), _parse_list(client["scopes"], ALL_SCOPES), user["role"])
    code = random_token(48)
    db.run(
        """INSERT INTO oauth_auth_codes
             (code, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'S256', now() + make_interval(secs => ?))""",
        code, client["client_id"], user["id"], params["redirect_uri"], scope,
        params["code_challenge"], CODE_TTL_SECONDS,
    )

    if _wants_json(request):
        return _json(request, 200, {
            "code": code,
            "state": params.get("state") or "",
            "scope": scope,
            "user": {"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]},
        })

    from urllib.parse import urlencode, urlunparse
    target = urlparse(params["redirect_uri"])
    target = urlunparse(target._replace(query=urlencode({
        "code": code,
        **({"state": params["state"]} if params.get("state") else {}),
    })))
    return RedirectResponse(target, status_code=302)


# ───────────────────────── POST /oauth/token ─────────────────────────

@oauth.post("/oauth/token")
async def token_endpoint(request: Request):
    try:
        body = await _read_params(request)
    except Exception as exc:
        return _token_error(request, 400, "invalid_request", "Cuerpo inválido")

    client, error = await _authenticate_client(request, body)
    if error:
        status, code, description = error
        return _token_error(request, status, code, description)

    grants = _parse_list(client["grant_types"])
    grant_type = str(body.get("grant_type") or "")
    if not grant_type:
        return _token_error(request, 400, "invalid_request", "Falta grant_type")
    if grant_type not in grants:
        return _token_error(request, 400, "unauthorized_client", f'El cliente no puede usar grant_type "{grant_type}"')

    try:
        if grant_type == "authorization_code":
            return _grant_authorization_code(request, client, body)
        if grant_type == "client_credentials":
            return _grant_client_credentials(request, client, body)
        if grant_type == "refresh_token":
            return _grant_refresh_token(request, client, body)
        return _token_error(request, 400, "unsupported_grant_type", f'grant_type "{grant_type}" no soportado')
    except Exception as exc:  # pragma: no cover
        print("[oauth/token]", exc)
        return _token_error(request, 500, "server_error", "Error interno al emitir el token")


def _grant_authorization_code(request: Request, client: dict, body: dict):
    code = body.get("code")
    redirect_uri = body.get("redirect_uri")
    verifier = body.get("code_verifier")

    if not code:
        return _token_error(request, 400, "invalid_request", "Falta el parámetro code")
    if not verifier:
        return _token_error(request, 400, "invalid_request", "Falta el code_verifier (PKCE)")

    row = db.one("SELECT * FROM oauth_auth_codes WHERE code = ?", code)
    if not row:
        return _token_error(request, 400, "invalid_grant", "Código de autorización no válido")
    if row["client_id"] != client["client_id"]:
        return _token_error(request, 400, "invalid_grant", "El código no pertenece a este cliente")
    if row["used"]:
        # Reutilización de un código → posible robo: revoca la familia del usuario
        db.run("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ? AND revoked = 0",
               row["user_id"], client["client_id"])
        return _token_error(request, 400, "invalid_grant",
                            "Código de autorización ya utilizado (posible robo: tokens revocados)")
    if row["expires_at"].timestamp() <= __import__("time").time():
        return _token_error(request, 400, "invalid_grant", "Código de autorización caducado")
    if redirect_uri != row["redirect_uri"]:
        return _token_error(request, 400, "invalid_grant", "redirect_uri no coincide con el del código")
    if not safe_equal(pkce_challenge(verifier), row["code_challenge"]):
        return _token_error(request, 400, "invalid_grant", "El code_verifier no coincide con el code_challenge (PKCE)")

    # Uso único atómico
    if db.run("UPDATE oauth_auth_codes SET used = 1 WHERE code = ? AND used = 0", code) == 0:
        return _token_error(request, 400, "invalid_grant", "Código de autorización ya utilizado")

    user = db.one("SELECT id, name, email, role FROM users WHERE id = ?", row["user_id"])
    if not user:
        return _token_error(request, 400, "invalid_grant", "El usuario del código ya no existe")

    return _json(request, 200, _issue_tokens(client, user, row["scope"]))


def _grant_client_credentials(request: Request, client: dict, body: dict):
    if not client["client_secret_hash"]:
        return _token_error(request, 401, "invalid_client", "client_credentials requiere un cliente confidencial")
    client_scopes = _parse_list(client["scopes"], ALL_SCOPES)
    owner = None
    if client["owner_user_id"]:
        owner = db.one("SELECT id, name, email, role FROM users WHERE id = ?", client["owner_user_id"])
    role = owner["role"] if owner else "client"
    # Sin scope explícito, el cliente usa todos los suyos (es su propia identidad)
    scope = _clamp_scope(body.get("scope") or " ".join(client_scopes), client_scopes, None if role == "client" else role)
    # client_credentials no emite refresh token (RFC 6749 §4.4.3)
    return _json(request, 200, _issue_tokens(client, owner, scope, with_refresh=False))


def _grant_refresh_token(request: Request, client: dict, body: dict):
    import time
    token = body.get("refresh_token")
    if not token:
        return _token_error(request, 400, "invalid_request", "Falta refresh_token")

    token_hash = sha256_hex(token)
    row = db.one("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?", token_hash)

    if not row or row["client_id"] != client["client_id"]:
        return _token_error(request, 400, "invalid_grant", "Refresh token no válido")
    if row["revoked"]:
        # Reutilización tras rotación → robo probable: revoca toda la familia
        db.run("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id IS NOT DISTINCT FROM ? AND client_id = ? AND revoked = 0",
               row["user_id"], client["client_id"])
        return _token_error(request, 400, "invalid_grant", "Refresh token ya usado o revocado (familia revocada)")
    if row["expires_at"].timestamp() <= time.time():
        return _token_error(request, 400, "invalid_grant", "Refresh token caducado")

    user = db.one("SELECT id, name, email, role FROM users WHERE id = ?", row["user_id"]) if row["user_id"] else None
    if row["user_id"] and not user:
        return _token_error(request, 400, "invalid_grant", "El usuario ya no existe")

    # Rotación: el refresh antiguo se marca usado y se enlaza con el nuevo
    fresh = random_token(48)
    db.run(
        """INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at)
           VALUES (?, ?, ?, ?, now() + make_interval(secs => ?))""",
        sha256_hex(fresh), client["client_id"], user["id"] if user else None, row["scope"], config.refresh_ttl,
    )
    db.run("UPDATE oauth_refresh_tokens SET revoked = 1, replaced_by = ? WHERE token_hash = ?",
           sha256_hex(fresh), token_hash)

    access = create_access_token({
        "sub": user["id"] if user else f"client:{client['client_id']}",
        "email": user["email"] if user else None,
        "role": user["role"] if user else "client",
        "scope": row["scope"],
        "client_id": client["client_id"],
    })
    return _json(request, 200, {
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": config.access_ttl,
        "refresh_token": fresh,
        "scope": row["scope"],
    })


# ───────────────────────── POST /oauth/revoke (RFC 7009) ─────────────────────────

@oauth.post("/oauth/revoke")
async def revoke_endpoint(request: Request):
    try:
        body = await _read_params(request)
    except Exception:
        return _token_error(request, 400, "invalid_request", "Cuerpo inválido")
    client, error = await _authenticate_client(request, body)
    if error:
        status, code, description = error
        return _token_error(request, status, code, description)
    if body.get("token"):
        # Solo se revoca si el token pertenece al cliente que lo solicita (§2.1)
        db.run("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ? AND revoked = 0",
               sha256_hex(body["token"]), client["client_id"])
    return _json(request, 200, {})  # RFC 7009: siempre 200 aunque el token no exista


# ───────────────────────── POST /oauth/introspect (RFC 7662) ─────────────────────────

@oauth.post("/oauth/introspect")
async def introspect_endpoint(request: Request):
    try:
        body = await _read_params(request)
    except Exception:
        return _token_error(request, 400, "invalid_request", "Cuerpo inválido")
    _, error = await _authenticate_client(request, body)
    if error:
        status, code, description = error
        return _token_error(request, status, code, description)

    import time
    token = str(body.get("token") or "")
    if not token:
        return _json(request, 200, {"active": False})

    # Access token JWT (se verifica localmente)
    if token.count(".") == 2:
        payload = verify_token(token)
        if not payload:
            return _json(request, 200, {"active": False})
        return _json(request, 200, {
            "active": True,
            "scope": payload.get("scope"),
            "client_id": payload.get("client_id"),
            "sub": str(payload.get("sub")),
            "username": payload.get("email"),
            "token_type": "Bearer",
            "exp": payload.get("exp"),
            "iat": payload.get("iat"),
            "iss": payload.get("iss"),
        })

    # Refresh token opaco (consulta por hash)
    row = db.one("SELECT token_hash, client_id, user_id, scope, expires_at, revoked FROM oauth_refresh_tokens WHERE token_hash = ?",
                 sha256_hex(token))
    active = bool(row) and not row["revoked"] and row["expires_at"].timestamp() > time.time()
    if not active:
        return _json(request, 200, {"active": False})
    return _json(request, 200, {
        "active": True,
        "token_type": "refresh_token",
        "client_id": row["client_id"],
        "sub": str(row["user_id"]) if row["user_id"] is not None else None,
        "scope": row["scope"],
        "exp": int(row["expires_at"].timestamp()),
    })
