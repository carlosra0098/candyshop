"""API REST de la tienda (idéntica a la versión Node: mismos JSON y códigos)."""
import datetime
import math
import re
import secrets
import time
import unicodedata
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import db
from .auth import extract_token, has_scope, hash_password, verify_password, verify_token
from .errors import ApiError

api = APIRouter()

_BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def base36(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = _BASE36[r] + s
    return s or "0"

# ───────────────────────── helpers ─────────────────────────

FREE_SHIPPING_FROM = 20
SHIPPING_COST = 3.95


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s).lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def round2(n: Any) -> float:
    return round(float(n) * 100) / 100


def is_id(v: Any) -> bool:
    return bool(re.fullmatch(r"\d+", str(v if v is not None else "").strip()))


def to_int(v: Any) -> int | None:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


async def read_json(request: Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise ApiError(400, "JSON inválido")
    return data if isinstance(data, dict) else {}


_ACCENTS = [("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"), ("ü", "u"), ("ñ", "n")]


def norm_col(col: str) -> str:
    """Expresión SQL: LOWER + quita acentos (búsqueda insensible, igual que en Node)."""
    expr = f"LOWER({col})"
    for frm, to in _ACCENTS:
        expr = f"REPLACE(REPLACE({expr}, '{frm}', '{to}'), '{frm.upper()}', '{to}')"
    return expr


def normalize_text(s: str) -> str:
    s = unicodedata.normalize("NFD", s.lower())
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


def get_user(request: Request) -> dict | None:
    payload = verify_token(extract_token(request.headers.get("authorization"), request.headers.get("x-access-token")))
    if not payload:
        return None
    try:
        uid = int(payload["sub"])
    except (TypeError, ValueError):
        return None  # token de client_credentials sin usuario
    return db.one("SELECT id, name, email, role, github_login FROM users WHERE id = ?", uid)


def require_auth(request: Request) -> dict:
    user = get_user(request)
    if not user:
        raise ApiError(401, "Debes iniciar sesión para realizar esta acción")
    return user


# Jerarquía de roles: customer < staff < admin.
# El rol se lee SIEMPRE de la BD (no del token): degradar un usuario surte
# efecto inmediato aunque su JWT siga siendo válido.
ROLE_LEVEL = {"customer": 1, "staff": 2, "admin": 3}


def require_role(request: Request, min_role: str) -> dict:
    user = require_auth(request)
    if ROLE_LEVEL.get(user["role"], 0) < ROLE_LEVEL[min_role]:
        raise ApiError(
            403,
            "Se requieren permisos de personal (staff)" if min_role == "staff"
            else "Se requieren permisos de administrador",
        )
    return user


def require_staff(request: Request) -> dict:
    """Rol staff o admin + scope 'staff' o 'admin' (gestión de pedidos/productos)."""
    user = require_role(request, "staff")
    payload = verify_token(extract_token(request.headers.get("authorization")))
    if not has_scope(payload, "staff") and not has_scope(payload, "admin"):
        raise ApiError(403, 'El token no tiene el scope "staff"')
    return user


def require_admin(request: Request) -> dict:
    """Solo rol admin + scope 'admin' (usuarios, cupones, estadísticas, categorías)."""
    user = require_role(request, "admin")
    payload = verify_token(extract_token(request.headers.get("authorization")))
    if not has_scope(payload, "admin"):
        raise ApiError(403, 'El token no tiene el scope "admin"')
    return user


def get_cart(request: Request, must_exist: bool = False) -> dict | None:
    """El carrito se identifica por token (invitado) o usuario logueado."""
    user = get_user(request)
    token = request.headers.get("x-cart-token")

    if user:
        cart = db.one("SELECT * FROM carts WHERE user_id = ?", user["id"])
        if not cart and not must_exist:
            t = token or f"u-{user['id']}-{int(time.time() * 1000)}"
            db.run("INSERT INTO carts (token, user_id) VALUES (?, ?) ON CONFLICT (token) DO NOTHING", t, user["id"])
            cart = db.one("SELECT * FROM carts WHERE user_id = ?", user["id"])
        return cart

    if not token:
        return None
    cart = db.one("SELECT * FROM carts WHERE token = ?", token)
    if not cart and not must_exist:
        db.run("INSERT INTO carts (token) VALUES (?) ON CONFLICT (token) DO NOTHING", token)
        cart = db.one("SELECT * FROM carts WHERE token = ?", token)
    return cart


def cart_view(cart: dict | None) -> dict:
    if not cart:
        return {"token": None, "items": [], "subtotal": 0, "shipping": 0, "discount": 0, "total": 0, "coupon": None}
    rows = db.q(
        """SELECT ci.product_id AS "productId", ci.quantity, p.name, p.slug, p.price, p.compare_price AS "comparePrice",
                  p.image_emoji AS emoji, p.color, p.stock, p.weight, p.unit
             FROM cart_items ci JOIN products p ON p.id = ci.product_id
            WHERE ci.cart_id = ? ORDER BY ci.id""",
        cart["id"],
    )
    items = [{**row, "price": float(row["price"]), "lineTotal": round2(row["price"] * row["quantity"])} for row in rows]

    subtotal = round2(sum(i["price"] * i["quantity"] for i in items))
    coupon = db.one("SELECT * FROM coupons WHERE code = ? AND active = 1", cart["coupon_code"]) if cart["coupon_code"] else None

    discount = 0.0
    if coupon and subtotal >= float(coupon["min_total"]):
        discount = round2(subtotal * float(coupon["value"]) / 100) if coupon["type"] == "percent" \
            else min(float(coupon["value"]), subtotal)
    after_discount = round2(subtotal - discount)
    shipping = 0 if not items or after_discount >= FREE_SHIPPING_FROM else SHIPPING_COST
    return {
        "token": cart["token"],
        "items": items,
        "subtotal": subtotal,
        "shipping": shipping,
        "discount": discount,
        "total": round2(after_discount + shipping),
        "coupon": {
            "code": coupon["code"], "type": coupon["type"], "value": float(coupon["value"]),
            "minTotal": float(coupon["min_total"]), "applied": discount > 0,
        } if coupon else None,
    }


def product_view(p: dict | None) -> dict | None:
    if not p:
        return None
    return {
        "id": p["id"],
        "name": p["name"],
        "slug": p["slug"],
        "description": p["description"],
        "price": float(p["price"]),
        "comparePrice": float(p["compare_price"]) if p["compare_price"] is not None else None,
        "stock": p["stock"],
        "unit": p["unit"],
        "weight": p["weight"],
        "emoji": p["image_emoji"],
        "color": p["color"],
        "badge": p["badge"],
        "featured": bool(p["featured"]),
        "rating": float(p["rating"]),
        "createdAt": p["created_at"],
        "category": {
            "id": p["category_id"], "name": p["category_name"], "slug": p["category_slug"],
            "emoji": p["category_emoji"], "color": p["category_color"],
        } if p["category_name"] else None,
    }


PRODUCT_SELECT = """
  SELECT p.*, c.name AS category_name, c.slug AS category_slug, c.emoji AS category_emoji, c.color AS category_color
  FROM products p LEFT JOIN categories c ON c.id = p.category_id
"""


# ───────────────────────── salud ─────────────────────────

@api.get("/api/health")
def health() -> dict:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    return {"status": "ok", "time": now, "db": "postgresql"}


# ───────────────────────── categorías ─────────────────────────

@api.get("/api/categories")
def list_categories() -> dict:
    rows = db.q(
        """SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS "productCount"
             FROM categories c ORDER BY c.id"""
    )
    data = [
        {"id": c["id"], "name": c["name"], "slug": c["slug"], "emoji": c["emoji"], "color": c["color"],
         "description": c["description"], "productCount": c["productCount"]}
        for c in rows
    ]
    return {"data": data, "total": len(data)}


@api.post("/api/categories", status_code=201)
async def create_category(request: Request):
    require_admin(request)
    b = await read_json(request)
    if not b.get("name"):
        raise ApiError(400, "El nombre es obligatorio")
    slug = b.get("slug") or slugify(b["name"])
    if db.one("SELECT id FROM categories WHERE slug = ?", slug):
        raise ApiError(409, "Ya existe una categoría con ese slug")
    cid = db.returning_id(
        "INSERT INTO categories (name, slug, emoji, color, description) VALUES (?, ?, ?, ?, ?) RETURNING id",
        b["name"], slug, b.get("emoji") or "🍬", b.get("color") or "#ff2d95", b.get("description") or "",
    )
    return JSONResponse(status_code=201, content={"id": cid, "slug": slug})


@api.patch("/api/categories/{cat_id}")
async def update_category(cat_id: str, request: Request):
    require_admin(request)
    b = await read_json(request)
    cat = db.one("SELECT * FROM categories WHERE id = ?", int(cat_id)) if is_id(cat_id) else None
    if not cat:
        raise ApiError(404, "Categoría no encontrada")
    db.run(
        "UPDATE categories SET name = ?, emoji = ?, color = ?, description = ? WHERE id = ?",
        b.get("name") if b.get("name") is not None else cat["name"],
        b.get("emoji") if b.get("emoji") is not None else cat["emoji"],
        b.get("color") if b.get("color") is not None else cat["color"],
        b.get("description") if b.get("description") is not None else cat["description"],
        cat["id"],
    )
    return {"updated": True}


@api.delete("/api/categories/{cat_id}")
def delete_category(cat_id: str, request: Request):
    require_admin(request)
    if not is_id(cat_id) or db.run("DELETE FROM categories WHERE id = ?", int(cat_id)) == 0:
        raise ApiError(404, "Categoría no encontrada")
    return {"deleted": True}


# ───────────────────────── productos ─────────────────────────

@api.get("/api/products")
def list_products(request: Request) -> dict:
    params = request.query_params
    q_text = (params.get("q") or "").strip()
    words = list(dict.fromkeys(w for w in normalize_text(q_text).split() if len(w) >= 2)) if q_text else []
    category = params.get("category") or ""
    min_price = float(params.get("minPrice") or 0)
    max_raw = params.get("maxPrice")
    max_price = float(max_raw) if max_raw else float("inf")
    badge = params.get("badge") or ""
    sort = params.get("sort") or "popular"
    page = max(1, to_int(params.get("page")) or 1)
    limit = min(50, max(1, to_int(params.get("limit")) or 12))
    include_hidden = params.get("all") == "1"

    base_where = ["p.price BETWEEN ? AND ?"]
    base_args: list[Any] = [min_price, max_price]
    if category:
        cat = db.one("SELECT id FROM categories WHERE id = ?", int(category)) if is_id(category) \
            else db.one("SELECT id FROM categories WHERE slug = ?", category)
        if cat:
            base_where.append("p.category_id = ?")
            base_args.append(cat["id"])
    if badge:
        base_where.append("p.badge = ?")
        base_args.append(badge)
    if not include_hidden:
        base_where.append("p.stock >= 0")

    name_col, cat_col, desc_col = norm_col("p.name"), norm_col("c.name"), norm_col("p.description")

    def search_clause(w: str, with_desc: bool) -> str:
        clause = f"({name_col} LIKE ? OR {cat_col} LIKE ?)"
        return f"{clause[:-1]} OR {desc_col} LIKE ?)" if with_desc else clause

    def build_where(with_desc: bool) -> tuple[str, list]:
        where, args = list(base_where), list(base_args)
        for w in words:
            where.append(search_clause(w, with_desc))
            args.extend([f"%{w}%", f"%{w}%"])
            if with_desc:
                args.append(f"%{w}%")
        return "WHERE " + " AND ".join(where), args

    count_sql = "SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id "
    where_sql, args = build_where(False)
    total = db.one(count_sql + where_sql, *args)["n"]

    rank_expr, rank_args = "", []
    if words:
        rank_expr = "(" + ") + (".join(
            f"CASE WHEN {name_col} LIKE ? THEN 2 ELSE 0 END + CASE WHEN {cat_col} LIKE ? THEN 1 ELSE 0 END"
            for _ in words
        ) + ")"
        rank_args = [f"%{w}%" for w in words for _ in range(2)]
        if total == 0:
            where_sql, args = build_where(True)
            total = db.one(count_sql + where_sql, *args)["n"]

    order_by = {
        "popular": "p.featured DESC, p.rating DESC, p.id ASC",
        "price-asc": "p.price ASC",
        "price-desc": "p.price DESC",
        "newest": "p.created_at DESC, p.id DESC",
        "name": "p.name ASC",
    }.get(sort, "p.featured DESC, p.rating DESC")

    final_order = f"{rank_expr} DESC, {order_by}" if words and sort == "popular" else order_by

    rows = db.q(
        f"{PRODUCT_SELECT} {where_sql} ORDER BY {final_order} LIMIT ? OFFSET ?",
        *args, *rank_args, limit, (page - 1) * limit,
    )
    return {
        "data": [product_view(r) for r in rows],
        "pagination": {"page": page, "limit": limit, "total": total, "pages": max(1, math.ceil(total / limit))},
    }


@api.get("/api/products/{ident}")
def get_product(ident: str) -> dict:
    row = db.one(f"{PRODUCT_SELECT} WHERE p.id = ?", int(ident)) if is_id(ident) \
        else db.one(f"{PRODUCT_SELECT} WHERE p.slug = ?", ident)
    if not row:
        raise ApiError(404, "Producto no encontrado")
    reviews = db.q(
        'SELECT id, name, rating, comment, created_at AS "createdAt" FROM reviews WHERE product_id = ? ORDER BY id DESC LIMIT 20',
        row["id"],
    )
    return {**product_view(row), "reviews": reviews}


@api.post("/api/products/{ident}/reviews", status_code=201)
async def create_review(ident: str, request: Request):
    b = await read_json(request)
    product = db.one("SELECT id, rating FROM products WHERE id = ?", int(ident)) if is_id(ident) else None
    if not product:
        raise ApiError(404, "Producto no encontrado")
    if not str(b.get("name") or "").strip():
        raise ApiError(400, "Indica tu nombre")
    try:
        rating = int(b.get("rating"))
    except (TypeError, ValueError):
        rating = 0
    if not 1 <= rating <= 5:
        raise ApiError(400, "La valoración debe ser entre 1 y 5")

    db.run("INSERT INTO reviews (product_id, name, rating, comment) VALUES (?, ?, ?, ?)",
           product["id"], str(b["name"]).strip(), rating, str(b.get("comment") or "").strip()[:1000])
    # Recalcular media del producto (misma fórmula que la versión Node)
    agg = db.one("SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE product_id = ?", product["id"])
    global_rating = float(product["rating"])
    avg = float(agg["avg"]) if agg["avg"] is not None else global_rating
    db.run("UPDATE products SET rating = ? WHERE id = ?",
           round2((avg * agg["n"] + global_rating * 4) / (agg["n"] + 4)), product["id"])
    return JSONResponse(status_code=201, content={"ok": True})


# ───────────────────────── autenticación (compat) ─────────────────────────

@api.post("/api/auth/register", status_code=201)
async def register(request: Request):
    b = await read_json(request)
    name = str(b.get("name") or "").strip()
    email = str(b.get("email") or "").strip().lower()
    password = str(b.get("password") or "")
    if not name:
        raise ApiError(400, "El nombre es obligatorio")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ApiError(400, "El email no es válido")
    if len(password) < 6:
        raise ApiError(400, "La contraseña debe tener al menos 6 caracteres")
    if db.one("SELECT id FROM users WHERE email = ?", email):
        raise ApiError(409, "Ya existe una cuenta con ese email")
    uid = db.returning_id("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?) RETURNING id",
                          name, email, hash_password(password))
    user = db.one("SELECT id, name, email, role, github_login FROM users WHERE id = ?", uid)
    # Sin tokens: el cliente debe obtenerlos por OAuth (authorization_code + PKCE)
    return JSONResponse(status_code=201, content={"user": user, "message": "Cuenta creada. Inicia sesión con OAuth2."})


@api.get("/api/auth/me")
def me(request: Request) -> dict:
    return {"user": require_auth(request)}


@api.post("/api/auth/change-password")
async def change_password(request: Request):
    """Cambiar la propia contraseña. Al hacerlo se revocan todos los refresh
    tokens del usuario: el resto de sesiones debe volver a entrar."""
    user = require_auth(request)
    b = await read_json(request)
    current = str(b.get("currentPassword") or "")
    new = str(b.get("newPassword") or "")
    row = db.one("SELECT password_hash FROM users WHERE id = ?", user["id"])
    if not row or not verify_password(current, row["password_hash"]):
        raise ApiError(400, "La contraseña actual no es correcta")
    if len(new) < 6:
        raise ApiError(400, "La nueva contraseña debe tener al menos 6 caracteres")
    if new == current:
        raise ApiError(400, "La nueva contraseña debe ser distinta a la actual")
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", hash_password(new), user["id"])
    db.run("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0", user["id"])
    return {"updated": True, "message": "Contraseña actualizada. Las demás sesiones se han cerrado."}


@api.post("/api/cart/merge")
async def cart_merge(request: Request):
    b = await read_json(request)
    user = require_auth(request)
    guest = db.one("SELECT * FROM carts WHERE token = ?", str(b.get("token") or ""))
    own = db.one("SELECT * FROM carts WHERE user_id = ?", user["id"])
    if guest and own and guest["id"] != own["id"]:
        for item in db.q("SELECT * FROM cart_items WHERE cart_id = ?", guest["id"]):
            existing = db.one("SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ?",
                              own["id"], item["product_id"])
            if existing:
                db.run("UPDATE cart_items SET quantity = ? WHERE id = ?", existing["quantity"] + item["quantity"], existing["id"])
            else:
                db.run("INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)",
                       own["id"], item["product_id"], item["quantity"])
        db.run("DELETE FROM carts WHERE id = ?", guest["id"])
    elif guest and not own:
        db.run("UPDATE carts SET user_id = ? WHERE id = ?", user["id"], guest["id"])
        own = db.one("SELECT * FROM carts WHERE id = ?", guest["id"])
    if not own:
        raise ApiError(404, "Carrito no encontrado")
    db.run("UPDATE carts SET updated_at = now() WHERE id = ?", own["id"])
    return cart_view(own)


# ───────────────────────── carrito ─────────────────────────

@api.get("/api/cart")
def get_cart_endpoint(request: Request) -> dict:
    require_auth(request)  # el flujo de compra exige sesión
    return cart_view(get_cart(request))


@api.post("/api/cart/items", status_code=201)
async def add_cart_item(request: Request):
    require_auth(request)
    b = await read_json(request)
    product_id = to_int(b.get("productId"))
    quantity = max(1, to_int(b.get("quantity")) or 1)
    product = db.one("SELECT * FROM products WHERE id = ?", product_id) if product_id is not None else None
    if not product:
        raise ApiError(404, "Producto no encontrado")

    cart = get_cart(request)
    if not cart:
        raise ApiError(404, "Carrito no encontrado")
    current = db.one("SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ?", cart["id"], product["id"])
    wanted = (current["quantity"] if current else 0) + quantity
    if wanted > product["stock"]:
        raise ApiError(409, f'Solo quedan {product["stock"]} unidades de "{product["name"]}"', stock=product["stock"])

    db.run(
        """INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
           ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity""",
        cart["id"], product["id"], wanted,
    )
    db.run("UPDATE carts SET updated_at = now() WHERE id = ?", cart["id"])
    return JSONResponse(status_code=201, content=cart_view(db.one("SELECT * FROM carts WHERE id = ?", cart["id"])))


@api.patch("/api/cart/items/{product_id}")
async def patch_cart_item(product_id: str, request: Request):
    require_auth(request)
    b = await read_json(request)
    cart = get_cart(request, must_exist=True)
    if not cart:
        raise ApiError(404, "Carrito no encontrado")
    try:
        quantity = int(b.get("quantity"))
    except (TypeError, ValueError):
        quantity = 0
    product = db.one("SELECT * FROM products WHERE id = ?", int(product_id)) if is_id(product_id) else None
    if not product:
        raise ApiError(404, "Producto no encontrado")
    if quantity < 1:
        raise ApiError(400, "La cantidad debe ser al menos 1")
    if quantity > product["stock"]:
        raise ApiError(409, f'Solo quedan {product["stock"]} unidades', stock=product["stock"])

    db.run("UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND product_id = ?", quantity, cart["id"], product["id"])
    db.run("UPDATE carts SET updated_at = now() WHERE id = ?", cart["id"])
    return cart_view(db.one("SELECT * FROM carts WHERE id = ?", cart["id"]))


@api.delete("/api/cart/items/{product_id}")
def delete_cart_item(product_id: str, request: Request):
    require_auth(request)
    cart = get_cart(request, must_exist=True)
    if not cart:
        raise ApiError(404, "Carrito no encontrado")
    if not is_id(product_id):
        raise ApiError(404, "Producto no encontrado")
    db.run("DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?", cart["id"], int(product_id))
    return cart_view(db.one("SELECT * FROM carts WHERE id = ?", cart["id"]))


@api.delete("/api/cart")
def clear_cart(request: Request):
    require_auth(request)
    cart = get_cart(request, must_exist=True)
    if not cart:
        raise ApiError(404, "Carrito no encontrado")
    db.run("DELETE FROM cart_items WHERE cart_id = ?", cart["id"])
    db.run("UPDATE carts SET coupon_code = NULL WHERE id = ?", cart["id"])
    return cart_view(db.one("SELECT * FROM carts WHERE id = ?", cart["id"]))


# ───────────────────────── cupones ─────────────────────────

@api.post("/api/coupons/validate")
async def validate_coupon(request: Request):
    require_auth(request)  # los cupones forman parte del flujo de compra con sesión
    b = await read_json(request)
    code = str(b.get("code") or "").strip().upper()
    coupon = db.one("SELECT * FROM coupons WHERE code = ? AND active = 1", code)
    if not coupon:
        raise ApiError(404, "El cupón no existe o ya no está disponible")
    cart = get_cart(request, must_exist=True)
    if not cart:
        raise ApiError(404, "Carrito no encontrado")
    subtotal = round2(db.one(
        "SELECT COALESCE(SUM(p.price * ci.quantity), 0) AS s FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = ?",
        cart["id"])["s"])
    if subtotal < float(coupon["min_total"]):
        raise ApiError(400, f"Este cupón requiere un pedido mínimo de {float(coupon['min_total']):.2f} €",
                       minTotal=float(coupon["min_total"]))
    db.run("UPDATE carts SET coupon_code = ? WHERE id = ?", coupon["code"], cart["id"])
    return cart_view(db.one("SELECT * FROM carts WHERE id = ?", cart["id"]))


@api.delete("/api/cart/coupon")
def remove_coupon(request: Request):
    require_auth(request)
    cart = get_cart(request, must_exist=True)
    if not cart:
        raise ApiError(404, "Carrito no encontrado")
    db.run("UPDATE carts SET coupon_code = NULL WHERE id = ?", cart["id"])
    return cart_view(db.one("SELECT * FROM carts WHERE id = ?", cart["id"]))


# ───────────────────────── pedidos ─────────────────────────

@api.get("/api/orders")
def list_orders(request: Request) -> dict:
    user = require_auth(request)
    if user["role"] == "admin":
        rows = db.q("SELECT * FROM orders ORDER BY id DESC")
    else:
        rows = db.q("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", user["id"])
    return {"data": rows, "total": len(rows)}


@api.post("/api/orders", status_code=201)
async def create_order(request: Request):
    require_auth(request)
    b = await read_json(request)
    for field in ("name", "email", "phone", "address", "city", "province", "postal"):
        if not str(b.get(field) or "").strip():
            raise ApiError(400, f'El campo "{field}" es obligatorio')
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", str(b.get("email") or "")):
        raise ApiError(400, "El email no es válido")

    cart = get_cart(request, must_exist=True)
    if not cart:
        raise ApiError(404, "Carrito no encontrado")
    view = cart_view(cart)
    if not view["items"]:
        raise ApiError(400, "Tu carrito está vacío")
    for item in view["items"]:
        if item["quantity"] > item["stock"]:
            raise ApiError(409, f'Se han agotado unidades de "{item["name"]}" (quedan {item["stock"]})',
                           productId=item["productId"])

    user = get_user(request)
    code = f"CDY-{base36(int(time.time() * 1000)).upper()}-{secrets.token_hex(2).upper()}"

    # Alta del pedido + líneas + descuento de stock en una única transacción
    with db.tx() as t:
        order_id = t.id(
            """INSERT INTO orders (code, user_id, name, email, phone, address, city, province, postal, notes,
                                   subtotal, shipping, discount, total, coupon_code)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""",
            code, user["id"] if user else None, str(b["name"]).strip(), str(b["email"]).strip().lower(),
            str(b["phone"]).strip(), str(b["address"]).strip(), str(b["city"]).strip(),
            str(b["province"]).strip(), str(b["postal"]).strip(), str(b.get("notes") or "").strip(),
            view["subtotal"], view["shipping"], view["discount"], view["total"],
            view["coupon"]["code"] if view["coupon"] and view["coupon"]["applied"] else None,
        )
        for item in view["items"]:
            t.run("INSERT INTO order_items (order_id, product_id, name, price, quantity) VALUES (?, ?, ?, ?, ?)",
                  order_id, item["productId"], item["name"], item["price"], item["quantity"])
            # Descuento de stock con control de carrera
            if t.run("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?",
                     item["quantity"], item["productId"], item["quantity"]) == 0:
                raise ApiError(409, f'Se han agotado unidades de "{item["name"]}"')
        if view["coupon"] and view["coupon"]["applied"]:
            t.run("UPDATE coupons SET used_count = used_count + 1 WHERE code = ?", view["coupon"]["code"])
        t.run("DELETE FROM cart_items WHERE cart_id = ?", cart["id"])
        t.run("UPDATE carts SET coupon_code = NULL, updated_at = now() WHERE id = ?", cart["id"])

    return JSONResponse(status_code=201, content={
        "id": order_id, "code": code, "status": "pending",
        "subtotal": view["subtotal"], "shipping": view["shipping"],
        "discount": view["discount"], "total": view["total"],
        "items": [{"name": i["name"], "price": i["price"], "quantity": i["quantity"], "lineTotal": i["lineTotal"]}
                  for i in view["items"]],
    })


@api.get("/api/orders/{code}")
def get_order(code: str, request: Request) -> dict:
    user = require_auth(request)
    order = db.one("SELECT * FROM orders WHERE code = ?", code)
    if not order:
        raise ApiError(404, "Pedido no encontrado")
    is_owner = order["user_id"] == user["id"]
    can_see_all = user["role"] in ("admin", "staff")
    if not is_owner and not can_see_all:
        raise ApiError(403, "Este pedido no te pertenece")
    items = db.q('SELECT product_id AS "productId", name, price, quantity FROM order_items WHERE order_id = ?', order["id"])
    return {**order, "items": items}


# ───────────────────────── newsletter ─────────────────────────

@api.post("/api/newsletter", status_code=201)
async def newsletter_subscribe(request: Request):
    b = await read_json(request)
    email = str(b.get("email") or "").strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ApiError(400, "El email no es válido")
    if db.one("SELECT id FROM newsletter WHERE email = ?", email):
        return {"subscribed": True, "message": "¡Ya estabas suscrito!"}
    db.run("INSERT INTO newsletter (email) VALUES (?)", email)
    return JSONResponse(status_code=201, content={
        "subscribed": True, "message": "¡Bienvenido a la familia! Usa el cupón HOLA10 en tu primer pedido."})


# ───────────────────────── admin ─────────────────────────

@api.get("/api/admin/stats")
def admin_stats(request: Request) -> dict:
    require_admin(request)
    return {
        "products": db.one("SELECT COUNT(*) AS n FROM products")["n"],
        "customers": db.one("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'")["n"],
        "orders": db.one("SELECT COUNT(*) AS n FROM orders")["n"],
        "revenue": round2(db.one("SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE status != 'cancelled'")["s"]),
        "pendingOrders": db.one("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'")["n"],
        "newsletter": db.one("SELECT COUNT(*) AS n FROM newsletter")["n"],
        "lowStock": db.one("SELECT COUNT(*) AS n FROM products WHERE stock < 25")["n"],
        "topProducts": db.q(
            """SELECT p.name, p.image_emoji AS emoji, SUM(oi.quantity) AS units
                 FROM order_items oi JOIN products p ON p.id = oi.product_id
                GROUP BY p.id ORDER BY units DESC LIMIT 5"""),
        "recentOrders": db.q('SELECT code, name, total, status, created_at AS "createdAt" FROM orders ORDER BY id DESC LIMIT 5'),
    }


@api.get("/api/admin/orders")
def admin_orders(request: Request) -> dict:
    require_staff(request)
    rows = db.q("SELECT * FROM orders ORDER BY id DESC")
    return {"data": rows, "total": len(rows)}


@api.patch("/api/admin/orders/{order_id}")
async def admin_patch_order(order_id: str, request: Request):
    require_staff(request)
    b = await read_json(request)
    allowed = ["pending", "paid", "shipped", "delivered", "cancelled"]
    if b.get("status") not in allowed:
        raise ApiError(400, f'Estado inválido. Usa: {", ".join(allowed)}')
    order = db.one("SELECT * FROM orders WHERE id = ?", int(order_id)) if is_id(order_id) else None
    if not order:
        raise ApiError(404, "Pedido no encontrado")
    if b["status"] == "cancelled" and order["status"] != "cancelled":
        for i in db.q("SELECT product_id, quantity FROM order_items WHERE order_id = ?", order["id"]):
            db.run("UPDATE products SET stock = stock + ? WHERE id = ?", i["quantity"], i["product_id"])
    db.run("UPDATE orders SET status = ? WHERE id = ?", b["status"], order["id"])
    return {"updated": True, "status": b["status"]}


@api.get("/api/admin/users")
def admin_users(request: Request) -> dict:
    require_admin(request)
    rows = db.q('SELECT id, name, email, role, created_at AS "createdAt" FROM users ORDER BY id DESC')
    return {"data": rows, "total": len(rows)}


@api.post("/api/admin/users/{user_id}/password")
async def admin_reset_password(user_id: str, request: Request):
    require_admin(request)
    if not is_id(user_id):
        raise ApiError(400, "ID inválido")
    b = await read_json(request)
    password = str(b.get("password") or "")
    if len(password) < 6:
        raise ApiError(400, "La contraseña debe tener al menos 6 caracteres")
    target = db.one("SELECT id, email FROM users WHERE id = ?", int(user_id))
    if not target:
        raise ApiError(404, "Usuario no encontrado")
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", hash_password(password), target["id"])
    db.run("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0", target["id"])
    return {
        "updated": True,
        "user_id": target["id"],
        "message": f"Contraseña de {target['email']} actualizada. Sus sesiones abiertas se han cerrado.",
    }


# ───────────────────────── CRUD productos (admin) ─────────────────────────

@api.get("/api/admin/products")
def admin_list_products(request: Request) -> dict:
    require_staff(request)
    rows = db.q(f"{PRODUCT_SELECT} ORDER BY p.id DESC")
    return {"data": [product_view(r) for r in rows], "total": len(rows)}


def _validate_product(b: dict) -> None:
    if not str(b.get("name") or "").strip():
        raise ApiError(400, "El nombre es obligatorio")
    try:
        price = float(b.get("price"))
    except (TypeError, ValueError):
        price = -1
    if price < 0:
        raise ApiError(400, "El precio debe ser un número positivo")
    if b.get("stock") is not None and (to_int(b["stock"]) or 0) < 0:
        raise ApiError(400, "El stock no puede ser negativo")


def _parse_product(b: dict, existing_slug: str | None = None) -> tuple:
    compare = None
    if b.get("comparePrice") is not None and b.get("comparePrice") != "":
        compare = round2(float(b["comparePrice"]))
    return (
        str(b["name"]).strip(),
        slugify(b["slug"]) if b.get("slug") else (existing_slug or slugify(b["name"])),
        str(b.get("description") or "").strip(),
        round2(float(b["price"])),
        compare,
        to_int(b.get("stock")) or 0,
        b.get("unit") or "uds",
        b.get("weight") or "",
        to_int(b.get("categoryId")) if b.get("categoryId") else None,
        b.get("emoji") or "🍬",
        b.get("color") or "#ff2d95",
        b.get("badge") or "",
        1 if b.get("featured") else 0,
    )


@api.post("/api/admin/products", status_code=201)
async def admin_create_product(request: Request):
    require_staff(request)
    b = await read_json(request)
    _validate_product(b)
    slug = slugify(b["slug"]) if b.get("slug") else slugify(b["name"])
    if db.one("SELECT id FROM products WHERE slug = ?", slug):
        raise ApiError(409, "Ya existe un producto con ese slug")
    fields = _parse_product(b)
    pid = db.returning_id(
        """INSERT INTO products (name, slug, description, price, compare_price, stock, unit, weight,
                                 category_id, image_emoji, color, badge, featured)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""",
        *fields)
    return JSONResponse(status_code=201, content={"id": pid, "slug": slug})


@api.put("/api/admin/products/{product_id}")
async def admin_update_product(product_id: str, request: Request):
    require_staff(request)
    existing = db.one("SELECT * FROM products WHERE id = ?", int(product_id)) if is_id(product_id) else None
    if not existing:
        raise ApiError(404, "Producto no encontrado")
    b = await read_json(request)
    _validate_product(b)
    name, slug, desc, price, compare, stock, unit, weight, cat_id, emoji, color, badge, featured = \
        _parse_product(b, existing["slug"])
    if slug != existing["slug"] and db.one("SELECT id FROM products WHERE slug = ? AND id != ?", slug, existing["id"]):
        raise ApiError(409, "Ya existe un producto con ese slug")
    db.run(
        """UPDATE products SET name = ?, slug = ?, description = ?, price = ?, compare_price = ?, stock = ?,
               unit = ?, weight = ?, category_id = ?, image_emoji = ?, color = ?, badge = ?, featured = ?
             WHERE id = ?""",
        name, slug, desc, price, compare, stock, unit, weight, cat_id, emoji, color, badge, featured, existing["id"])
    return {"updated": True, "id": existing["id"]}


@api.delete("/api/admin/products/{product_id}")
def admin_delete_product(product_id: str, request: Request):
    require_staff(request)
    if not is_id(product_id) or db.run("DELETE FROM products WHERE id = ?", int(product_id)) == 0:
        raise ApiError(404, "Producto no encontrado")
    return {"deleted": True}


# ───────────────────────── cupones (admin) ─────────────────────────

@api.get("/api/admin/coupons")
def admin_list_coupons(request: Request) -> dict:
    require_admin(request)
    rows = db.q("SELECT * FROM coupons ORDER BY id")
    return {"data": rows, "total": len(rows)}


@api.post("/api/admin/coupons", status_code=201)
async def admin_create_coupon(request: Request):
    require_admin(request)
    b = await read_json(request)
    code = str(b.get("code") or "").strip().upper()
    if not code:
        raise ApiError(400, "El código es obligatorio")
    if b.get("type") not in ("percent", "fixed"):
        raise ApiError(400, 'El tipo debe ser "percent" o "fixed"')
    try:
        value = float(b.get("value"))
    except (TypeError, ValueError):
        value = 0
    if value <= 0:
        raise ApiError(400, "El valor debe ser positivo")
    if db.one("SELECT id FROM coupons WHERE code = ?", code):
        raise ApiError(409, "Ese cupón ya existe")
    try:
        min_total = float(b.get("minTotal") or 0)
    except (TypeError, ValueError):
        min_total = 0
    cid = db.returning_id("INSERT INTO coupons (code, type, value, min_total) VALUES (?, ?, ?, ?) RETURNING id",
                          code, b["type"], value, min_total)
    return JSONResponse(status_code=201, content={"id": cid, "code": code})


@api.delete("/api/admin/coupons/{coupon_id}")
def admin_delete_coupon(coupon_id: str, request: Request):
    require_admin(request)
    if not is_id(coupon_id) or db.run("DELETE FROM coupons WHERE id = ?", int(coupon_id)) == 0:
        raise ApiError(404, "Cupón no encontrado")
    return {"deleted": True}
