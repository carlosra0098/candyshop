"""Configuración: carga el .env de la raíz del proyecto (compartido con la versión Node)."""
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent  # …/candyshop
ENV_FILE = PROJECT_ROOT / ".env"


def _load_env_file() -> None:
    """Parseo mínimo de .env (KEY=VALUE). Las variables del entorno tienen prioridad."""
    if not ENV_FILE.exists():
        return
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


_load_env_file()


class Config:
    port: int = int(os.environ.get("PORT", "3000"))
    database_url: str = os.environ.get(
        "DATABASE_URL",
        "postgres://candyshop:CandyShop_PG_2026@localhost:5432/candyshop",
    )
    jwt_secret: str = os.environ.get("JWT_SECRET", "candyshop-dev-secret-change-me")
    cors_origin: str = os.environ.get("CORS_ORIGIN", "*")
    frontend_origin: str = os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")
    access_ttl: int = int(os.environ.get("ACCESS_TOKEN_TTL", str(60 * 15)))          # 15 min
    refresh_ttl: int = int(os.environ.get("REFRESH_TOKEN_TTL", str(60 * 60 * 24 * 30)))  # 30 días
    issuer: str = os.environ.get("OAUTH_ISSUER", "candyshop")
    audience: str = os.environ.get("OAUTH_AUDIENCE", "candyshop-api")

    # ── GitHub OAuth ("Entrar con GitHub") — OAuth App creada por el usuario ──
    github_client_id: str = os.environ.get("GITHUB_CLIENT_ID", "")
    github_client_secret: str = os.environ.get("GITHUB_CLIENT_SECRET", "")
    github_callback_url: str = os.environ.get("GITHUB_CALLBACK_URL", "")
    # URLs sobreescribibles (para tests con un GitHub falso)
    github_authorize_url: str = os.environ.get("GITHUB_AUTHORIZE_URL", "https://github.com/login/oauth/authorize")
    github_token_url: str = os.environ.get("GITHUB_TOKEN_URL", "https://github.com/login/oauth/access_token")
    github_api_url: str = os.environ.get("GITHUB_API_URL", "https://api.github.com")

    @property
    def github_configured(self) -> bool:
        return bool(self.github_client_id and self.github_client_secret)

    @property
    def github_callback(self) -> str:
        return self.github_callback_url or f"http://localhost:{self.port}/auth/github/callback"

    @property
    def database_url_psycopg(self) -> str:
        """psycopg exige el esquema postgres:// (acepta también postgresql://)."""
        return self.database_url.replace("postgres://", "postgresql://", 1)


config = Config()
