"""CandyShop con FastAPI — arranque, middlewares, estáticos y lifecycle."""
import mimetypes
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# La consola de Windows suele ser cp1252: forzamos UTF-8 para los emojis del banner
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .api import api
from .config import config
from .db import close_pool, init_schema
from .errors import ApiError
from .github import github
from .oauth import oauth
from .seed import ensure_demo_users, ensure_oauth_clients, seed

PUBLIC_DIR = Path(__file__).resolve().parent.parent.parent / "public"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # PostgreSQL: esquema → datos de ejemplo → cuentas demo → clientes OAuth
    init_schema()
    result = seed()
    ensure_demo_users()
    ensure_oauth_clients()
    estado = f"ya existían ({result['products']} productos)" if result["skipped"] \
        else f"seed creado ({result['products']} productos)"
    print("")
    print("  🍬 CandyShop API + Frontend  (FastAPI/Python + PostgreSQL + OAuth 2.0)")
    print("  ─────────────────────────────────────────────────────────────────────")
    print(f"  Tienda:   http://localhost:{config.port}")
    print(f"  API:      http://localhost:{config.port}/api")
    print(f"  Docs:     http://localhost:{config.port}/docs")
    print(f"  OAuth:    http://localhost:{config.port}/oauth/authorize")
    gh = "configurado ✔" if config.github_configured else "sin configurar (GITHUB_CLIENT_ID/SECRET en .env)"
    print(f"  GitHub:   {gh}")
    print(f"  Meta:     http://localhost:{config.port}/oauth/.well-known/openid-configuration")
    print(f"  Admin:    http://localhost:{config.port}/admin  (admin@candyshop.test / admin123)")
    print(f"  Datos:    {estado}")
    print("")
    yield
    close_pool()


app = FastAPI(title="CandyShop API", version="2.0.0", lifespan=lifespan, docs_url="/docs", openapi_url="/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in config.cors_origin.split(",")] if config.cors_origin != "*" else ["*"],
    allow_origin_regex=r".*" if config.cors_origin == "*" else None,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Access-Token", "X-Cart-Token"],
)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"error": exc.message, **exc.extra})


app.include_router(oauth)
app.include_router(github)
app.include_router(api)


# ───────────────────────── frontend estático ─────────────────────────
# Mismo enrutado limpio que la versión Node: /tienda → public/tienda.html,
# cualquier fichero real (css/js/…) se sirve tal cual, y si no existe → 404.html.

_SAFE_SUFFIXES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
}


@app.get("/{full_path:path}", include_in_schema=False)
async def static_site(full_path: str):
    base = PUBLIC_DIR.resolve()

    def safe_file(rel: str) -> Path | None:
        candidate = (base / rel).resolve()
        if candidate.is_relative_to(base) and candidate.is_file():
            return candidate
        return None

    target = safe_file(full_path or "index.html")
    if target is None and full_path:
        target = safe_file(f"{full_path}.html")  # URL limpia: /tienda → tienda.html
    if target is not None:
        media = _SAFE_SUFFIXES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        headers = {"Cache-Control": "no-cache" if target.suffix == ".html" else "public, max-age=300"}
        return FileResponse(target, media_type=media, headers=headers)

    not_found = safe_file("404.html")
    if not_found:
        return FileResponse(not_found, status_code=404, media_type="text/html; charset=utf-8")
    return JSONResponse(status_code=404, content={"error": "No encontrado"})


def main() -> None:
    import uvicorn
    uvicorn.run("app.main:app", host="127.0.0.1", port=config.port, log_level="info")


if __name__ == "__main__":
    main()
