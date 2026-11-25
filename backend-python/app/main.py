"""CandyShop FastAPI — solo API (el frontend vive en ../frontend con React)."""
import sys
from contextlib import asynccontextmanager

# La consola de Windows suele ser cp1252: forzamos UTF-8 para los emojis del banner
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import api
from .config import config
from .db import close_pool, init_schema
from .errors import ApiError
from .github import github
from .oauth import oauth
from .seed import ensure_demo_users, ensure_oauth_clients, seed


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
    print("  🍬 CandyShop API  (FastAPI/Python + PostgreSQL + OAuth 2.0)")
    print("  ─────────────────────────────────────────────────────────────────────")
    print(f"  API:      http://localhost:{config.port}/api")
    print(f"  Docs:     http://localhost:{config.port}/docs")
    print(f"  OAuth:    http://localhost:{config.port}/oauth/authorize")
    gh = "configurado ✔" if config.github_configured else "sin configurar (GITHUB_CLIENT_ID/SECRET en .env)"
    print(f"  GitHub:   {gh}")
    print(f"  Meta:     http://localhost:{config.port}/oauth/.well-known/openid-configuration")
    print(f"  Frontend: {config.frontend_origin}  (React, servido por separado)")
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


@app.get("/api/root", include_in_schema=False)
def api_root() -> dict:
    """El backend ya no sirve HTML: el frontend React está en otro origen."""
    return {"name": "CandyShop API", "docs": "/docs", "frontend": config.frontend_origin}


def main() -> None:
    import uvicorn
    uvicorn.run("app.main:app", host="127.0.0.1", port=config.port, log_level="info")


if __name__ == "__main__":
    main()
