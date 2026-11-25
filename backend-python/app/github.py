"""Login con GitHub ("Entrar con GitHub") — OAuth 2.0 de tercero, SIN cookies ni sesiones.

Flujo:
  1. GET  /auth/github/login?redirect=/cuenta
     → guarda un state de un solo uso en PostgreSQL y redirige a GitHub.
  2. GitHub redirige a /auth/github/callback?code=…&state=…
     → se valida el state (CSRF), se canjea el code por un token de GitHub y
       se descarga el perfil (/user + /user/emails).
  3. Se busca/crea/vincula la cuenta local y se emiten los MISMOS tokens de
       CandyShop (access JWT 15 min + refresh rotativo) que el login por
       contraseña: el resto de la app no distingue cómo entraste.
  4. Se redirige al frontend con los tokens en el #fragment:
       /cuenta#access_token=…&refresh_token=…
     (el frontend los guarda en localStorage — nunca hay cookie).

El state cumple el papel del anti-CSRF sin necesidad de cookie: se guarda
server-side, caduca en 10 minutos y solo sirve una vez.
"""
import json
import urllib.error
import urllib.request
from html import escape
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from . import db
from .api import get_user
from .auth import hash_password, random_token
from .config import config
from .errors import ApiError
from .oauth import _clamp_scope, _issue_tokens, _parse_list, _wants_json

github = APIRouter()

STATE_TTL_SECONDS = 600  # 10 minutos


# ───────────────────────── helpers ─────────────────────────

def _safe_redirect(target: str | None) -> str:
    """Solo rutas locales de esta misma web (anti open-redirect)."""
    t = str(target or "").strip()
    return t if t.startswith("/") and not t.startswith("//") else "/cuenta"


def _error_page(title: str, detail: str) -> HTMLResponse:
    return HTMLResponse(f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>{escape(title)}</title>
<style>body{{font-family:system-ui,sans-serif;background:#1b0f1a;color:#fff;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}}
.card{{background:#fff;color:#2b0d20;border-radius:20px;padding:2rem;max-width:440px;text-align:center}}
a{{color:#ff2d95;font-weight:700}}</style></head>
<body><div class="card"><div style="font-size:42px">🍬</div>
<h2>{escape(title)}</h2><p>{escape(detail)}</p>
<a href="/cuenta">← Volver a la cuenta</a></div></body></html>""", status_code=400)


def _gh_post_form(url: str, fields: dict) -> dict:
    """POST form a GitHub (stdlib: sin dependencias extra)."""
    req = urllib.request.Request(
        url,
        data=urlencode(fields).encode(),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "CandyShop",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode() or "{}")
        except Exception:
            return {}
    except (urllib.error.URLError, TimeoutError) as e:
        raise ApiError(502, f"No se pudo contactar con GitHub: {e}")


def _gh_get_json(url: str, token: str) -> object | None:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "CandyShop",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode() or "null")
    except Exception:
        return None


# ───────────────────────── endpoints ─────────────────────────

@github.get("/auth/github/status")
def github_status() -> dict:
    """El frontend consulta esto para mostrar u ocultar el botón."""
    return {"configured": config.github_configured}


@github.get("/auth/github/login")
async def github_login(request: Request, redirect: str = "/cuenta"):
    target = _safe_redirect(redirect)

    if not config.github_configured:
        if _wants_json(request):
            return JSONResponse(status_code=503, content={
                "error": "github_not_configured",
                "error_description": "Falta GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET en el .env",
            })
        return _error_page(
            "Login con GitHub sin configurar",
            "Crea una OAuth App en GitHub y completa GITHUB_CLIENT_ID, "
            "GITHUB_CLIENT_SECRET y GITHUB_CALLBACK_URL en el archivo .env.",
        )

    # Si ya hay sesión abierta, el callback vinculará GitHub a ese usuario
    user = get_user(request)
    state = random_token(32)
    db.run(
        """INSERT INTO github_login_states (state, redirect_to, user_id, expires_at)
           VALUES (?, ?, ?, now() + make_interval(secs => ?))""",
        state, target, user["id"] if user else None, STATE_TTL_SECONDS,
    )

    params = urlencode({
        "client_id": config.github_client_id,
        "redirect_uri": config.github_callback,
        "scope": "read:user user:email",
        "state": state,
    })
    url = f"{config.github_authorize_url}?{params}"
    return RedirectResponse(url, status_code=302)


@github.get("/auth/github/callback")
async def github_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
):
    row = db.one("SELECT * FROM github_login_states WHERE state = ?", state or "")
    target = _safe_redirect(row["redirect_to"] if row else None)
    if row:  # el state es de un solo uso (se consume pase lo que pase)
        db.run("DELETE FROM github_login_states WHERE state = ?", state)

    # El frontend ya no está en este origen: la vuelta debe apuntar a la SPA React
    def fail_redirect(msg: str):
        return RedirectResponse(f"{config.frontend_origin}{target}#{urlencode({'error': msg})}", status_code=302)

    if error:
        return fail_redirect(error_description or error)
    if not row:
        return _error_page("State inválido", "El enlace de login caducó o ya se usó. Vuelve a intentarlo.")
    if row["expires_at"].timestamp() <= __import__("time").time():
        return _error_page("State caducado", "El enlace de login caducó. Vuelve a intentarlo.")
    if not code:
        return _error_page("Falta el código", "GitHub no devolvió el parámetro code.")

    # 1) Canje del code por un token de GitHub
    tok = _gh_post_form(config.github_token_url, {
        "client_id": config.github_client_id,
        "client_secret": config.github_client_secret,
        "code": code,
        "redirect_uri": config.github_callback,
    })
    gh_token = tok.get("access_token")
    if not gh_token:
        return fail_redirect(tok.get("error_description") or tok.get("error") or "GitHub no concedió acceso")

    # 2) Perfil de GitHub (email puede ser privado → /user/emails como alternativa)
    profile = _gh_get_json(f"{config.github_api_url}/user", gh_token)
    if not isinstance(profile, dict) or not profile.get("id"):
        return fail_redirect("No se pudo leer tu perfil de GitHub")
    gh_id = int(profile["id"])
    gh_login = str(profile.get("login") or "")
    email = str(profile.get("email") or "").strip().lower()
    if not email:
        emails = _gh_get_json(f"{config.github_api_url}/user/emails", gh_token)
        if isinstance(emails, list):
            primary = next((e for e in emails if e.get("primary") and e.get("verified")),
                           next((e for e in emails if e.get("verified")), None))
            email = str(primary.get("email", "")).strip().lower() if primary else ""
    if not email:
        email = f"{gh_login or gh_id}@users.noreply.github.com"

    # 3) Buscar / vincular / crear la cuenta local
    user = None
    link_user_id = row["user_id"]

    if link_user_id:
        # Login con sesión abierta → vincular GitHub a ESTA cuenta
        user = db.one("SELECT * FROM users WHERE id = ?", link_user_id)
        other = db.one("SELECT id FROM users WHERE github_id = ? AND id != ?", gh_id, link_user_id)
        if user and other:
            return fail_redirect("Esa cuenta de GitHub ya está vinculada a otra cuenta de CandyShop")
        if user:
            db.run("UPDATE users SET github_id = ?, github_login = ? WHERE id = ?", gh_id, gh_login, user["id"])
    else:
        user = db.one("SELECT * FROM users WHERE github_id = ?", gh_id)
        if not user:
            by_email = db.one("SELECT * FROM users WHERE email = ?", email)
            if by_email:
                # Mismo email → se vincula automáticamente (conserva contraseña)
                if by_email["github_id"] and by_email["github_id"] != gh_id:
                    return fail_redirect("Ese email ya está vinculado a otra cuenta de GitHub")
                db.run("UPDATE users SET github_id = ?, github_login = ? WHERE id = ?",
                       gh_id, gh_login, by_email["id"])
                user = by_email
            else:
                name = str(profile.get("name") or gh_login or email).strip()
                uid = db.returning_id(
                    """INSERT INTO users (name, email, password_hash, role, github_id, github_login)
                       VALUES (?, ?, ?, 'customer', ?, ?) RETURNING id""",
                    name, email, hash_password(random_token(24)), gh_id, gh_login,
                )
                user = db.one("SELECT * FROM users WHERE id = ?", uid)

    if not user:
        return fail_redirect("No se pudo crear la cuenta")

    # 4) Emisión de los tokens de CandyShop (mismo esquema que el login clásico)
    client = db.one("SELECT * FROM oauth_clients WHERE client_id = 'candyshop-web'")
    if not client:
        return _error_page("Cliente OAuth no disponible", "Falta el cliente candyshop-web en la BD.")
    scope = _clamp_scope(None, _parse_list(client["scopes"], []), user["role"])
    tokens = _issue_tokens(client, user, scope)

    # 5) Vuelta al frontend con los tokens en el #fragment (sin cookie)
    fragment = urlencode({
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token", ""),
        "token_type": "Bearer",
        "expires_in": str(tokens.get("expires_in", "")),
        "scope": scope,
    })
    return RedirectResponse(f"{config.frontend_origin}{target}#{fragment}", status_code=302)
