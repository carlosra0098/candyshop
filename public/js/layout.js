/* ═══ Layout compartido: cabecera, footer, carrito, toasts ═══ */
(function () {
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  /* ── Toasts ── */
  function toast(message, type = 'success') {
    let box = $('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${type === 'error' ? '⚠️' : '✅'}</span><span>${escapeHtml(message)}</span>`;
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(120%)';
      setTimeout(() => el.remove(), 320);
    }, 3200);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ── Header / Footer ── */
  async function renderLayout() {
    const user = api.auth.user();
    const current = location.pathname.replace(/\.html$/, '');
    const catParam = new URLSearchParams(location.search).get('category') || '';
    const onShop = current === '/tienda';

    const headerHost = $('#site-header');
    if (headerHost) {
      headerHost.innerHTML = `
        <div class="announce">
          <div class="container">
            <span>🎁 REGALO: 1 caramelera y 1 pinza en pedidos +50€</span>
            <span>🚚 Envío gratis a partir de 20€</span>
            <span>⏱️ Envío en 36/72h laborables</span>
          </div>
        </div>
        <header class="header">
          <div class="container header-main">
            <a href="/" class="logo">Chuches<span class="logo-dot">.</span><em>shop</em></a>
            <form class="search" id="global-search">
              <input type="search" name="q" placeholder="Busca fresas, regalices, nubes…" aria-label="Buscar productos">
              <button type="submit">🔍 Buscar</button>
            </form>
            <div class="header-actions">
              <a href="/cuenta" class="icon-btn" title="Mi cuenta">
                <span>${user ? '👋' : '👤'}</span>
                <small>${user ? escapeHtml(user.name.split(' ')[0]) : 'Entrar'}</small>
              </a>
              <button class="icon-btn" id="open-cart" title="Carrito">
                <span>🛒</span>
                <small>Carrito</small>
                <span class="cart-badge" id="cart-count" hidden>0</span>
              </button>
            </div>
          </div>
          <nav class="nav">
            <div class="container">
              <ul class="nav-list" id="nav-list">
                <li><a href="/tienda" data-cat="" class="${onShop && !catParam ? 'active' : ''}">Todas las chuches</a></li>
              </ul>
            </div>
          </nav>
        </header>`;
    }

    const footerHost = $('#site-footer');
    if (footerHost) {
      footerHost.innerHTML = `
        <section class="newsletter-band">
          <div class="container">
            <div>
              <h2>¡Suscríbete!</h2>
              <p>Consigue un 10% de descuento en tu primer pedido y entérate antes que nadie de descuentos, novedades y sorpresas.</p>
            </div>
            <div>
              <form class="newsletter-form" id="newsletter-form">
                <input type="email" name="email" placeholder="Tu correo electrónico" required aria-label="Email">
                <button class="btn btn-yellow" type="submit">Suscribirme</button>
              </form>
              <p class="newsletter-legal">Al suscribirte aceptas recibir comunicaciones comerciales. Puedes darte de baja cuando quieras.</p>
            </div>
          </div>
        </section>
        <footer class="footer">
          <div class="container">
            <div class="footer-grid">
              <div>
                <h4>🍬 Chuches.shop</h4>
                <p>Tu tienda de golosinas online para fiestas, eventos y antojos. Bolsas, tarros y packs listos para compartir.</p>
              </div>
              <div>
                <h4>Productos</h4>
                <ul id="footer-cats"></ul>
              </div>
              <div>
                <h4>Ayuda</h4>
                <ul>
                  <li><a href="/tienda">Envío y entrega</a></li>
                  <li><a href="/tienda">Cambios y devoluciones</a></li>
                  <li><a href="/tienda">Preguntas frecuentes</a></li>
                  <li><a href="/admin">Área de administración</a></li>
                </ul>
              </div>
              <div>
                <h4>Síguenos</h4>
                <ul>
                  <li><a href="#">Instagram</a></li>
                  <li><a href="#">TikTok</a></li>
                  <li><a href="#">YouTube</a></li>
                  <li><a href="#">Facebook</a></li>
                </ul>
              </div>
            </div>
            <div class="footer-bottom">
              <span>© ${new Date().getFullYear()} Chuches.shop — Proyecto demo con API REST propia</span>
              <div class="pay-icons">
                <span>VISA</span><span>MASTERCARD</span><span>PayPal</span><span>Bizum</span><span>Apple Pay</span>
              </div>
            </div>
          </div>
        </footer>`;
    }

    // Navegación con categorías reales de la API
    try {
      const { data: cats } = await api.get('/categories');
      const navList = $('#nav-list');
      if (navList) {
        cats.slice(0, 6).forEach((c) => {
          const li = document.createElement('li');
          const active = onShop && catParam === c.slug ? 'active' : '';
          li.innerHTML = `<a href="/tienda?category=${c.slug}" data-cat="${c.slug}" class="${active}">${escapeHtml(c.name)}</a>`;
          navList.appendChild(li);
        });
      }
      const footCats = $('#footer-cats');
      if (footCats) {
        footCats.innerHTML = cats
          .map((c) => `<li><a href="/tienda?category=${c.slug}">${c.emoji} ${escapeHtml(c.name)}</a></li>`)
          .join('');
      }
    } catch { /* la navegación funciona sin categorías */ }

    // Búsqueda global
    const searchForm = $('#global-search');
    if (searchForm) {
      searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = new FormData(searchForm).get('q');
        location.href = `/tienda?q=${encodeURIComponent(q || '')}`;
      });
    }

    // Newsletter
    const nlForm = $('#newsletter-form');
    if (nlForm) {
      nlForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api.post('/newsletter', { email: new FormData(nlForm).get('email') });
          toast(r.message || '¡Suscripción confirmada! 🎉');
          nlForm.reset();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    renderDrawer();
    $('#open-cart')?.addEventListener('click', () => openDrawer(true));
    await refreshCart();
  }

  /* ── Mini carrito (drawer) ── */
  function renderDrawer() {
    const overlay = document.createElement('div');
    overlay.className = 'drawer-overlay';
    overlay.id = 'drawer-overlay';
    const drawer = document.createElement('aside');
    drawer.className = 'drawer';
    drawer.id = 'cart-drawer';
    drawer.innerHTML = `
      <div class="drawer-head">
        <h3>🛒 Tu carrito</h3>
        <button class="drawer-close" aria-label="Cerrar">×</button>
      </div>
      <div class="drawer-body" id="drawer-body"></div>
      <div class="drawer-foot" id="drawer-foot"></div>`;
    document.body.append(overlay, drawer);
    overlay.addEventListener('click', () => openDrawer(false));
    drawer.querySelector('.drawer-close').addEventListener('click', () => openDrawer(false));
  }

  function openDrawer(open) {
    $('#cart-drawer')?.classList.toggle('open', open);
    $('#drawer-overlay')?.classList.toggle('open', open);
    if (open) refreshCart();
  }

  let lastCart = null;

  /** Ruta de vuelta al panel de login/registro (?next=…). */
  function loginUrl() {
    const next = location.pathname + location.search;
    return next === '/cuenta' ? '/cuenta' : '/cuenta?next=' + encodeURIComponent(next);
  }

  async function refreshCart() {
    const body = $('#drawer-body');
    // Sin sesión no hay carrito: el flujo de compra exige iniciar sesión.
    if (!api.auth.token()) {
      lastCart = null;
      const badge = $('#cart-count');
      if (badge) badge.hidden = true;
      if (body) {
        body.innerHTML = `<div class="empty-state" style="padding:2rem 0">
          <span class="big">🔒</span><p>Inicia sesión para usar el carrito.</p>
          <a class="btn" href="${loginUrl()}">Entrar / Registrarse</a></div>`;
        const foot = $('#drawer-foot');
        if (foot) foot.innerHTML = '';
      }
      return null;
    }
    try {
      const cart = await api.get('/cart');
      lastCart = cart;
      const badge = $('#cart-count');
      const count = cart.items.reduce((s, i) => s + i.quantity, 0);
      if (badge) {
        badge.textContent = count;
        badge.hidden = count === 0;
      }
      paintDrawer(cart);
      return cart;
    } catch (err) {
      if (err.status === 401) {
        api.auth.clear?.();
        location.href = loginUrl(); // caducó la sesión: volver a entrar
        return null;
      }
      return lastCart;
    }
  }

  function paintDrawer(cart) {
    const body = $('#drawer-body');
    const foot = $('#drawer-foot');
    if (!body || !foot) return;

    if (!cart.items.length) {
      body.innerHTML = `<div class="empty-state" style="padding:2rem 0">
        <span class="big">🛍️</span><p>Tu carrito está vacío.<br>¡Es hora de endulzar el día!</p>
        <a class="btn" href="/tienda">Ver golosinas</a></div>`;
      foot.innerHTML = '';
      return;
    }

    body.innerHTML = cart.items
      .map(
        (i) => `
        <div class="mini-item" data-id="${i.productId}">
          <div class="mini-thumb" style="background:${i.color}22">${i.emoji}</div>
          <div>
            <h4>${escapeHtml(i.name)}</h4>
            <small>${i.quantity} × ${api.money(i.price)}</small>
          </div>
          <button class="mini-remove" data-remove="${i.productId}" title="Quitar">🗑️</button>
        </div>`
      )
      .join('');

    const missing = Math.max(0, 20 - cart.subtotal);
    foot.innerHTML = `
      <div class="free-shipping-bar ${missing === 0 ? 'done' : ''}">
        ${missing === 0 ? '✅ ¡Tienes ENVÍO GRATIS!' : `🚚 Te faltan <strong>${api.money(missing)}</strong> para el envío gratis`}
        <div class="progress"><i style="width:${Math.min(100, (cart.subtotal / 20) * 100)}%"></i></div>
      </div>
      <div class="totals-row"><span>Subtotal</span><strong>${api.money(cart.subtotal)}</strong></div>
      ${cart.discount ? `<div class="totals-row" style="color:var(--green)"><span>Descuento (${escapeHtml(cart.coupon.code)})</span><strong>-${api.money(cart.discount)}</strong></div>` : ''}
      <div class="totals-row grand"><span>Total</span><span>${api.money(cart.total)}</span></div>
      <a class="btn btn-block" href="/carrito">Tramitar pedido →</a>
      <button class="btn btn-ghost btn-block btn-sm" id="drawer-clear">Vaciar carrito</button>`;

    $$('[data-remove]', body).forEach((btn) =>
      btn.addEventListener('click', async () => {
        await api.del(`/cart/items/${btn.dataset.remove}`);
        await refreshCart();
        document.dispatchEvent(new CustomEvent('cart:changed'));
      })
    );
    $('#drawer-clear')?.addEventListener('click', async () => {
      await api.del('/cart');
      await refreshCart();
      document.dispatchEvent(new CustomEvent('cart:changed'));
      toast('Carrito vaciado');
    });
  }

  /* ── Añadir al carrito (flujo de compra: requiere sesión) ── */
  function requireLoginForPurchase() {
    toast('Inicia sesión para comprar 🍬', 'error');
    setTimeout(() => (location.href = loginUrl()), 900);
  }

  async function addToCart(productId, quantity = 1) {
    if (!api.auth.user()) {
      requireLoginForPurchase();
      return false;
    }
    try {
      await api.post('/cart/items', { productId, quantity });
      await refreshCart();
      openDrawer(true);
      document.dispatchEvent(new CustomEvent('cart:changed'));
      return true;
    } catch (err) {
      if (err.status === 401) {
        requireLoginForPurchase();
        return false;
      }
      toast(err.message, 'error');
      return false;
    }
  }

  /* ── Tarjeta de producto reutilizable ── */
  function stars(rating) {
    const full = Math.round(rating);
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  }

  function unitPrice(p) {
    if (!p.weight) return `Por ${p.unit}`;
    return `${api.money(p.price)} / ${p.weight}`;
  }

  function productCard(p) {
    const badge = p.badge
      ? `<span class="badge ${p.badge}">${{ nuevo: 'Novedad', top: 'Top ventas', hot: '🔥 En redes' }[p.badge] || p.badge}</span>`
      : '';
    return `
      <article class="card ${p.stock <= 0 ? 'sold-out' : ''}" data-product-id="${p.id}">
        <a href="/producto?id=${p.id}" class="card-media" style="background:${hexA(p.color, 0.16)}">
          ${badge}
          <span class="emoji">${p.emoji}</span>
        </a>
        <div class="card-body">
          <h3><a href="/producto?id=${p.id}">${escapeHtml(p.name)}</a></h3>
          <div class="stars">${stars(p.rating)}<small>${p.rating.toFixed(1)}</small></div>
          <div class="price-row">
            <span class="price">${api.money(p.price)}</span>
            ${p.comparePrice ? `<span class="price-old">${api.money(p.comparePrice)}</span>` : ''}
          </div>
          <span class="unit-price">${escapeHtml(unitPrice(p))}</span>
          <div class="card-actions">
            <div class="qty">
              <button type="button" data-qty="-" aria-label="Menos">−</button>
              <span data-qty-val>1</span>
              <button type="button" data-qty="+" aria-label="Más">+</button>
            </div>
            <button class="add-btn" data-add>Añadir 🛒</button>
          </div>
        </div>
      </article>`;
  }

  function hexA(hex, alpha) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  /** Activa los controles de cantidad y "Añadir" dentro de un contenedor. */
  function bindCardActions(container) {
    container.addEventListener('click', async (e) => {
      const qtyBtn = e.target.closest('[data-qty]');
      const card = e.target.closest('[data-product-id]');
      if (!card) return;
      const valEl = card.querySelector('[data-qty-val]');
      let qty = parseInt(valEl?.textContent) || 1;

      if (qtyBtn) {
        qty = Math.max(1, qty + (qtyBtn.dataset.qty === '+' ? 1 : -1));
        if (valEl) valEl.textContent = qty;
        return;
      }
      const addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        const original = addBtn.innerHTML;
        addBtn.disabled = true;
        addBtn.innerHTML = 'Añadiendo…';
        const okAdd = await addToCart(card.dataset.productId, qty);
        addBtn.disabled = false;
        addBtn.innerHTML = okAdd ? '¡Añadido! ✓' : original;
        if (okAdd) setTimeout(() => (addBtn.innerHTML = original), 1400);
      }
    });
  }

  /* ── Resaltado del menú de categorías ── */
  function setActiveNav(slug) {
    $$('#nav-list a').forEach((a) => {
      const linkCat = a.dataset.cat || '';
      a.classList.toggle('active', linkCat === (slug || ''));
    });
  }

  /* ── Exposición ── */
  window.layout = { renderLayout, refreshCart, addToCart, toast, escapeHtml, productCard, bindCardActions, stars, hexA, setActiveNav };

  document.addEventListener('DOMContentLoaded', renderLayout);
})();
