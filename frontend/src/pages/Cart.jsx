import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { api } from '../lib/api'
import { hexA, money } from '../lib/format'

const EMPTY_FORM = {
  name: '', email: '', phone: '', postal: '', address: '', city: '', province: '', notes: '',
}

export default function Cart() {
  const { user, authReady, cart, refreshCart, notify } = useApp()
  const navigate = useNavigate()
  const formRef = useRef(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [coupon, setCoupon] = useState('')
  const [processing, setProcessing] = useState(false)
  const [order, setOrder] = useState(null)

  useEffect(() => {
    if (authReady && !user) navigate('/cuenta?next=' + encodeURIComponent('/carrito'), { replace: true })
  }, [authReady, user, navigate])

  useEffect(() => { if (user) refreshCart() }, [user, refreshCart])
  useEffect(() => {
    if (user) setForm((f) => ({ ...f, name: user.name, email: user.email }))
  }, [user])
  useEffect(() => { if (cart?.coupon?.code) setCoupon(cart.coupon.code) }, [cart?.coupon?.code])

  if (!authReady || !user) return null

  async function changeItem(item, action) {
    try {
      if (action === 'del' || (action === 'dec' && item.quantity <= 1)) {
        await api.del(`/cart/items/${item.productId}`)
      } else {
        await api.patch(`/cart/items/${item.productId}`, { quantity: item.quantity + (action === 'inc' ? 1 : -1) })
      }
      await refreshCart()
    } catch (err) { notify(err.message, 'error') }
  }

  async function applyCoupon() {
    const code = coupon.trim()
    if (!code) return notify('Escribe un código de cupón', 'error')
    try {
      const res = await api.post('/coupons/validate', { code })
      await refreshCart()
      notify(res.coupon?.applied ? `Cupón ${res.coupon.code} aplicado 🎉` : 'Cupón registrado')
    } catch (err) { notify(err.message, 'error') }
  }

  async function clear() {
    try {
      await api.del('/cart')
      await refreshCart()
      notify('Carrito vaciado')
    } catch (err) { notify(err.message, 'error') }
  }

  async function checkout() {
    if (!formRef.current.reportValidity()) {
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return notify('Completa los datos de envío', 'error')
    }
    setProcessing(true)
    try {
      const placed = await api.post('/orders', form)
      setOrder(placed)
      notify(`🎉 ¡Pedido procesado! Será enviado en 36/72 h · Código ${placed.code}`)
      await refreshCart()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      notify(err.message, 'error')
    } finally {
      setProcessing(false) // el botón vuelve siempre a su estado inicial
    }
  }

  if (order) {
    return (
      <main className="container">
        <div className="empty-state">
          <span className="big">🎉</span><h2>¡Pedido confirmado!</h2>
          <p>Tu pedido <strong>{order.code}</strong> <strong>ha sido procesado y será enviado</strong> en 36/72 h laborables.<br />
            Te enviaremos la confirmación a <strong>{order.email}</strong>.</p>
          <Link className="btn" to="/tienda">Seguir comprando</Link>
        </div>
      </main>
    )
  }

  const hasItems = !!cart?.items?.length
  const missing = Math.max(0, 20 - (cart?.subtotal || 0))

  return (
    <>
      <div className="page-head">
        <div className="container">
          <div className="breadcrumb"><Link to="/">Inicio</Link> / <span>Carrito</span></div>
          <h1>🛒 Tu carrito</h1><p>Revisa tus golosinas antes de finalizar el pedido.</p>
        </div>
      </div>
      <main className="container">
        {!hasItems ? (
          <div className="empty-state">
            <span className="big">🛍️</span><h2>Tu carrito está vacío</h2>
            <p>¡Es hora de endulzar el día! Echa un vistazo a nuestras golosinas.</p>
            <Link className="btn" to="/tienda">Ver golosinas</Link>
          </div>
        ) : (
          <div className="cart-layout">
            <div>
              <div className="cart-items">
                {cart.items.map((i) => (
                  <div className="cart-line" key={i.productId}>
                    <div className="cart-thumb" style={{ background: hexA(i.color, 0.16) }}>{i.emoji}</div>
                    <div>
                      <h3><Link to={`/producto?id=${i.productId}`}>{i.name}</Link></h3>
                      <small>{money(i.price)} / ud. {i.weight ? `· ${i.weight}` : ''}</small>
                    </div>
                    <div className="qty">
                      <button type="button" onClick={() => changeItem(i, 'dec')}>−</button>
                      <span>{i.quantity}</span>
                      <button type="button" onClick={() => changeItem(i, 'inc')}>+</button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '.9rem' }}>
                      <span className="line-total">{money(i.lineTotal)}</span>
                      <button className="remove-link" onClick={() => changeItem(i, 'del')} title="Eliminar">🗑️</button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="panel" style={{ marginTop: '1.6rem' }}>
                <h3>📍 Datos de envío</h3>
                <form className="checkout-form" ref={formRef} onSubmit={(e) => { e.preventDefault(); checkout() }}>
                  <div className="field-row">
                    <div className="field"><label>Nombre y apellidos *</label>
                      <input required maxLength={80} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                    <div className="field"><label>Email *</label>
                      <input type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                  </div>
                  <div className="field-row">
                    <div className="field"><label>Teléfono *</label>
                      <input required maxLength={15} autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                    <div className="field"><label>Código postal *</label>
                      <input required maxLength={5} inputMode="numeric" autoComplete="postal-code" value={form.postal} onChange={(e) => setForm({ ...form, postal: e.target.value })} /></div>
                  </div>
                  <div className="field"><label>Dirección *</label>
                    <input required maxLength={120} autoComplete="street-address" placeholder="Calle, número, piso, puerta"
                      value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
                  <div className="field-row">
                    <div className="field"><label>Ciudad *</label>
                      <input required maxLength={60} autoComplete="address-level2" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
                    <div className="field"><label>Provincia *</label>
                      <input required maxLength={60} autoComplete="address-level1" value={form.province} onChange={(e) => setForm({ ...form, province: e.target.value })} /></div>
                  </div>
                  <div className="field"><label>Notas para la entrega (opcional)</label>
                    <textarea rows={2} maxLength={300} placeholder="Ej: llamar antes de subir, dejar en portería…"
                      value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
                </form>
              </div>
            </div>

            <aside className="summary-card">
              <h3>Resumen del pedido</h3>
              <div className={`free-shipping-bar ${missing === 0 ? 'done' : ''}`}>
                {missing === 0 ? '✅ ¡Tienes envío gratis!' : <>🚚 Te faltan <strong>{money(missing)}</strong> para el envío gratis
                  <div className="progress"><i style={{ width: `${Math.min(100, (cart.subtotal / 20) * 100)}%` }} /></div></>}
              </div>
              <div className="coupon-row">
                <input placeholder="CÓDIGO CUPÓN" maxLength={20} value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
                <button className="btn btn-dark btn-sm" onClick={applyCoupon}>Aplicar</button>
              </div>
              <div className="totals-row"><span>Subtotal</span><strong>{money(cart.subtotal)}</strong></div>
              {cart.discount > 0 && <div className="totals-row" style={{ color: 'var(--green)' }}>
                <span>Descuento ({cart.coupon?.code})</span><strong>-{money(cart.discount)}</strong></div>}
              <div className="totals-row"><span>Envío</span><strong>{cart.shipping === 0 ? 'Gratis ✓' : money(cart.shipping)}</strong></div>
              <div className="totals-row grand"><span>Total</span><span>{money(cart.total)}</span></div>
              <button className="btn btn-block" onClick={checkout} disabled={processing}>
                {processing ? 'Procesando…' : '🔒 Finalizar pedido'}
              </button>
              <small style={{ color: 'var(--muted)', textAlign: 'center' }}>Demo de pago: no se realiza ningún cargo real.</small>
              <button className="btn btn-ghost btn-block btn-sm" onClick={clear}>Vaciar carrito</button>
            </aside>
          </div>
        )}
      </main>
    </>
  )
}
