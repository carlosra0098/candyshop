"""Autenticación OAuth 2.0 + JWT (HS256) — SIN cookies ni sesiones.

· Contraseñas: scrypt con los MISMOS parámetros que la versión Node
  (N=16384, r=8, p=1, dklen=64, salt hex de 16 bytes → "salt:hash" hex),
  así las cuentas son compatibles entre ambas implementaciones.
· Access token: JWT corto (15 min), typ "at+jwt", verificado localmente.
· Refresh token: opaco, aleatorio, guardado hasheado (SHA-256) en PostgreSQL
  y rotado en cada uso (detección de reutilización → revocación de familia).
"""
import base64
import hashlib
import hmac
import secrets
import time
from typing import Any

import jwt

from .config import config

CLOCK_SKEW = 30  # tolerancia de reloj (s)


# ── Contraseñas (scrypt) ──

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    # Nota: como en la versión Node, el salt viaja como TEXTO hex (no bytes)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
    return f"{salt}:{digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, digest_hex = str(stored).split(":", 1)
        candidate = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
        return hmac.compare_digest(candidate.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


# ── Utilidades criptográficas ──

def random_token(nbytes: int = 32) -> str:
    """Token aleatorio opaco base64url (refresh tokens, códigos de autorización)."""
    return secrets.token_urlsafe(nbytes)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def pkce_challenge(verifier: str) -> str:
    """PKCE S256: BASE64URL(SHA256(verifier)) — RFC 7636."""
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def safe_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(str(a), str(b))


# ── JWT: access tokens HS256 (RFC 9068, typ "at+jwt") ──

def create_access_token(claims: dict[str, Any]) -> str:
    now = int(time.time())
    payload = {
        "sub": str(claims["sub"]) if not isinstance(claims["sub"], str) else claims["sub"],
        "email": claims.get("email"),
        "role": claims.get("role", "client"),
        "scope": claims.get("scope", ""),
        "client_id": claims.get("client_id"),
        "jti": secrets.token_hex(16),
        "iss": config.issuer,
        "aud": config.audience,
        "iat": now,
        "exp": now + config.access_ttl,
    }
    # El 'sub' numérico se emite como número (paridad con la versión Node)
    if isinstance(claims["sub"], int):
        payload["sub"] = claims["sub"]
    return jwt.encode(payload, config.jwt_secret, algorithm="HS256", headers={"typ": "at+jwt"})


def verify_token(token: str | None) -> dict[str, Any] | None:
    """Devuelve el payload del access token o None si es inválido/caducado/falsificado."""
    if not token or not isinstance(token, str):
        return None
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "HS256" or header.get("typ") != "at+jwt":
            return None
        payload = jwt.decode(
            token,
            config.jwt_secret,
            algorithms=["HS256"],
            issuer=config.issuer,
            audience=config.audience,
            leeway=CLOCK_SKEW,
            # verify_sub desactivado: emite sub numérico como la versión Node
            # (paridad de contrato; la seguridad no depende del tipo de sub)
            options={"require": ["exp", "iat", "iss", "aud", "sub"], "verify_sub": False},
        )
        if payload.get("sub") is None:
            return None
        return payload
    except jwt.PyJWTError:
        return None


def decode_unverified(token: str) -> dict[str, Any] | None:
    """Decodifica sin verificar (solo debug/tests)."""
    try:
        parts = str(token or "").split(".")
        if len(parts) != 3:
            return None
        raw = parts[1] + "=" * (-len(parts[1]) % 4)
        import json
        return json.loads(base64.urlsafe_b64decode(raw))
    except Exception:
        return None


def extract_token(authorization: str | None, x_access_token: str | None = None) -> str | None:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:].strip()
    return x_access_token or None


def has_scope(payload: dict | None, scope: str) -> bool:
    return scope in str((payload or {}).get("scope", "")).split()
