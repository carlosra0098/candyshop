import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { api, auth } from '../lib/api'
import { hexA, money } from '../lib/format'

export default function Layout() {
  const { user, authReady, cart, refreshCart, cartOpen, setCartOpen, toasts, notify, loginUrl } = useApp()
  const [categories, setCategories] = useState([])
  const navigate = useNavigate()
  const location = useLocation()
  const activeCat = new URLSearchParams(location.search).get('category') || ''

  useEffect(() => {
    api.get('/categories').then((r) => setCategories(r.data || [])).catch(() => {})
  }, [])

  useEffect(() => {
    if (authReady && auth.token()) refreshCart()
  }, [authReady, refreshCart])

  function onSearch(e) {
    e.preventDefault()
    const q = new FormData(e.currentTarget).get('q') || ''
    navigate(`/tienda?q=${encodeURIComponent(q)}`)
  }

  async function onNewsletter(e) {
    e.preventDefault()
    const email = new FormData(e.currentTarget).get('email')
    try {
      const r = await api.post('/newsletter', { email })
      notify(r.message || '¡Suscripción confirmada! 🎉')
      e.currentTarget.reset()
    } catch (err) { notify(err.message, 'error') }
  }

  async function removeItem(id) {
    try {
      await api.del(`/cart/items/${id}`)
      await refreshCart()
    } catch (err) { notify(err.message, 'error') }
  }

  async function clearCart() {
    try {
      await api.del('/cart')
      await refreshCart()
      notify('Carrito vaciado')
    } catch (err) { notify(err.message, 'error') }
  }

  const count = cart ? cart.items.reduce((sum, i) => sum + i.quantity, 0) : 0
  const missing = cart ? Math.max(0, 20 - cart.subtotal) : 20

  return (
    <>
      <div className="announce">
        <div className="container">
          <span>🎁 REGALO: 1 caramelera y 1 pinza en pedidos +50€</span>
          <span>🚚 Envío gratis a partir de 20€</span>
          <span>⏱️ Envío en 36/72h laborables</span>
        </div>
      </div>
      <header className="header">
        <div className="container header-main">
          <Link to="/" className="logo">Chuches<span className="logo-dot">.</span><em>shop</em></Link>
          <form className="search" onSubmit={onSearch}>
            <input type="search" name="q" placeholder="Busca fresas, regalices, nubes…" aria-label="Buscar productos" />
            <button type="submit">🔍 Buscar</button>
          </form>
          <div className="header-actions">
            <Link to="/cuenta" className="icon-btn" title="Mi cuenta">
              <span>{user ? '👋' : '👤'}</span>
              <small>{user ? user.name.split(' ')[0] : 'Entrar'}</small>
            </Link>
            <button className="icon-btn" onClick={() => { setCartOpen(true); refreshCart() }} title="Carrito">
              <span>🛒</span><small>Carrito</small>
              {count > 0 && <span className="cart-badge">{count}</span>}
            </button>
          </div>
        </div>
        <nav className="nav">
          <div className="container">
            <ul className="nav-list">
              <li><Link to="/tienda" className={location.pathname === '/tienda' && !activeCat ? 'active' : ''}>Todas las chuches</Link></li>
              {categories.slice(0, 6).map((c) => (
                <li key={c.id}>
                  <Link to={`/tienda?category=${c.slug}`} className={activeCat === c.slug ? 'active' : ''}>{c.name}</Link>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </header>

      <Outlet />

      <section className="newsletter-band">
        <div className="container">
          <div>
            <h2>¡Suscríbete!</h2>
            <p>Consigue un 10% de descuento en tu primer pedido y entérate antes que nadie de descuentos, novedades y sorpresas.</p>
          </div>
          <div>
            <form className="newsletter-form" onSubmit={onNewsletter}>
              <input type="email" name="email" placeholder="Tu correo electrónico" required aria-label="Email" />
              <button className="btn btn-yellow" type="submit">Suscribirme</button>
            </form>
            <p className="newsletter-legal">Al suscribirte aceptas recibir comunicaciones comerciales. Puedes darte de baja cuando quieras.</p>
          </div>
        </div>
      </section>
      <footer className="footer">
        <div className="container">
          <div className="footer-grid">
            <div>
              <h4>🍬 Chuches.shop</h4>
              <p>Tu tienda de golosinas online para fiestas, eventos y antojos. Bolsas, tarros y packs listos para compartir.</p>
            </div>
            <div>
              <h4>Productos</h4>
              <ul>{categories.map((c) => (
                <li key={c.id}><Link to={`/tienda?category=${c.slug}`}>{c.emoji} {c.name}</Link></li>
              ))}</ul>
            </div>
            <div>
              <h4>Ayuda</h4>
              <ul>
                <li><Link to="/tienda">Envío y entrega</Link></li>
                <li><Link to="/tienda">Cambios y devoluciones</Link></li>
                <li><Link to="/tienda">Preguntas frecuentes</Link></li>
                <li><Link to="/admin">Área de administración</Link></li>
              </ul>
            </div>
            <div>
              <h4>Síguenos</h4>
              <ul><li>Instagram</li><li>TikTok</li><li>YouTube</li><li>Facebook</li></ul>
            </div>
          </div>
          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} Chuches.shop — Proyecto demo con API REST propia</span>
            <div className="pay-icons"><span>VISA</span><span>MASTERCARD</span><span>PayPal</span><span>Bizum</span><span>Apple Pay</span></div>
          </div>
        </div>
      </footer>

      <div className={`drawer-overlay ${cartOpen ? 'open' : ''}`} onClick={() => setCartOpen(false)} />
      <aside className={`drawer ${cartOpen ? 'open' : ''}`}>
        <div className="drawer-head">
          <h3>🛒 Tu carrito</h3>
          <button className="drawer-close" aria-label="Cerrar" onClick={() => setCartOpen(false)}>×</button>
        </div>
        <div className="drawer-body">
          {!user ? (
            <div className="empty-state" style={{ padding: '2rem 0' }}>
              <span className="big">🔒</span><p>Inicia sesión para usar el carrito.</p>
              <Link className="btn" to={loginUrl()}>Entrar / Registrarse</Link>
            </div>
          ) : !cart || !cart.items.length ? (
            <div className="empty-state" style={{ padding: '2rem 0' }}>
              <span className="big">🛍️</span><p>Tu carrito está vacío.<br />¡Es hora de endulzar el día!</p>
              <Link className="btn" to="/tienda">Ver golosinas</Link>
            </div>
          ) : cart.items.map((i) => (
            <div className="mini-item" key={i.productId}>
              <div className="mini-thumb" style={{ background: hexA(i.color, 0.13) }}>{i.emoji}</div>
              <div>
                <h4>{i.name}</h4>
                <small>{i.quantity} × {money(i.price)}</small>
              </div>
              <button className="mini-remove" onClick={() => removeItem(i.productId)} title="Quitar">🗑️</button>
            </div>
          ))}
        </div>
        <div className="drawer-foot">
          {user && cart && cart.items.length > 0 && (
            <>
              <div className={`free-shipping-bar ${missing === 0 ? 'done' : ''}`}>
                {missing === 0 ? '✅ ¡Tienes ENVÍO GRATIS!' : <>🚚 Te faltan <strong>{money(missing)}</strong> para el envío gratis</>}
                <div className="progress"><i style={{ width: `${Math.min(100, (cart.subtotal / 20) * 100)}%` }} /></div>
              </div>
              <div className="totals-row"><span>Subtotal</span><strong>{money(cart.subtotal)}</strong></div>
              {cart.discount > 0 && <div className="totals-row" style={{ color: 'var(--green)' }}>
                <span>Descuento ({cart.coupon?.code})</span><strong>-{money(cart.discount)}</strong>
              </div>}
              <div className="totals-row grand"><span>Total</span><span>{money(cart.total)}</span></div>
              <Link className="btn btn-block" to="/carrito" onClick={() => setCartOpen(false)}>Tramitar pedido →</Link>
              <button className="btn btn-ghost btn-block btn-sm" onClick={clearCart}>Vaciar carrito</button>
            </>
          )}
        </div>
      </aside>

      <div className="toasts">
        {toasts.map((t) => (
          <div className={`toast ${t.type}`} key={t.id}>
            <span>{t.type === 'error' ? '⚠️' : '✅'}</span><span>{t.message}</span>
          </div>
        ))}
      </div>
    </>
  )
}
