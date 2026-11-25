import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import ProductCard from '../components/ProductCard'
import { useApp } from '../context/AppContext'
import { api } from '../lib/api'
import { hexA, money, stars } from '../lib/format'

export default function Product() {
  const [params] = useSearchParams()
  const id = params.get('id')
  const [product, setProduct] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [related, setRelated] = useState([])
  const [qty, setQty] = useState(1)
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState({ name: '', rating: 5, comment: '' })
  const { addToCart, notify } = useApp()

  useEffect(() => {
    document.title = 'Producto · Chuches.shop'
    return () => { document.title = 'Chuches.shop · Tu tienda de golosinas online' }
  }, [])

  useEffect(() => {
    if (!id) { setNotFound(true); return }
    let alive = true
    setNotFound(false)
    setProduct(null)
    api.get('/products/' + encodeURIComponent(id)).then(async (p) => {
      if (!alive) return
      setProduct(p)
      document.title = `${p.name} · Chuches.shop`
      if (p.category) {
        const rel = await api.get(`/products?category=${p.category.slug}&limit=4`)
        if (alive) setRelated((rel.data || []).filter((x) => x.id !== p.id).slice(0, 4))
      }
    }).catch(() => { if (alive) setNotFound(true) })
    return () => { alive = false }
  }, [id])

  async function buy() {
    setBusy(true)
    const ok = await addToCart(product.id, qty)
    setBusy(false)
    if (ok) notify(`${qty} × ${product.name} añadido 🛒`)
  }

  async function submitReview(e) {
    e.preventDefault()
    try {
      await api.post(`/products/${product.id}/reviews`, review)
      notify('¡Gracias por tu opinión! 💖')
      const p = await api.get('/products/' + encodeURIComponent(id))
      setProduct(p)
      setReview({ name: '', rating: 5, comment: '' })
    } catch (err) { notify(err.message, 'error') }
  }

  if (notFound) {
    return (
      <main className="container">
        <div className="empty-state">
          <span className="big">😕</span><h2>Producto no encontrado</h2>
          <p>Puede que se haya agotado o cambiado de nombre.</p>
          <Link className="btn" to="/tienda">Volver a la tienda</Link>
        </div>
      </main>
    )
  }
  if (!product) return <main className="container"><p style={{ padding: '3rem 0' }}>Cargando producto…</p></main>

  return (
    <>
      <div className="page-head">
        <div className="container">
          <div className="breadcrumb"><Link to="/">Inicio</Link> / <Link to="/tienda">Golosinas</Link> / <span>{product.name}</span></div>
        </div>
      </div>

      <main className="container">
        <section className="product-detail">
          <div className="product-art" style={{ background: hexA(product.color, 0.18) }}>
            <span className="emoji">{product.emoji}</span>
          </div>
          <div className="product-info">
            <div className="stars">{stars(product.rating)}<small>{product.rating.toFixed(1)} · {product.reviews.length} opiniones</small></div>
            <h1>{product.name}</h1>
            <div className="price-row">
              <span className="price">{money(product.price)}</span>
              {product.comparePrice && <span className="price-old">{money(product.comparePrice)}</span>}
            </div>
            <p className="unit-price">{product.weight ? `${money(product.price)} / ${product.weight}` : `Precio por ${product.unit}`}</p>
            <p className="desc">{product.description}</p>
            <div className="meta-list">
              <div>📦 <strong>Formato:</strong> {product.unit} ({product.weight || '—'})</div>
              <div>⚖️ <strong>Peso:</strong> {product.weight || '—'}</div>
              <div>🏷️ <strong>Categoría:</strong> {product.category
                ? <Link to={`/tienda?category=${product.category.slug}`} style={{ color: 'var(--pink)', fontWeight: 800 }}>{product.category.emoji} {product.category.name}</Link>
                : '—'}</div>
            </div>
            <div className="buy-row">
              <div className="qty">
                <button type="button" onClick={() => setQty((n) => Math.max(1, n - 1))}>−</button>
                <span>{qty}</span>
                <button type="button" onClick={() => setQty((n) => Math.min(product.stock, n + 1))}>+</button>
              </div>
              <button className="btn" onClick={buy} disabled={busy || product.stock <= 0}>
                {product.stock > 0 ? (busy ? 'Añadiendo…' : '🛒 Añadir al carrito') : 'Sin stock'}
              </button>
              <span className={`stock-pill ${product.stock < 25 ? 'low' : ''}`}>
                {product.stock <= 0 ? 'Agotado' : product.stock < 25 ? `¡Solo quedan ${product.stock}!` : 'En stock ✓'}
              </span>
            </div>
            <div className="features" style={{ border: 'none', padding: 0 }}>
              <div className="feature"><span className="f-ico">🚚</span><div><strong>Envío 36/72h</strong><small>Gratis desde 20€</small></div></div>
              <div className="feature" style={{ marginTop: '0.8rem' }}><span className="f-ico">↩️</span><div><strong>14 días de devolución</strong><small>Sin preguntas raras</small></div></div>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="section-head"><h2>💬 Opiniones</h2></div>
          <div className="reviews">
            {product.reviews.length ? product.reviews.map((r, i) => (
              <article className="review" key={i}>
                <header>
                  <span className="who">{r.name} <span className="stars" style={{ marginLeft: '.4rem' }}>{stars(r.rating)}</span></span>
                  <time>{new Date(r.createdAt).toLocaleDateString('es-ES')}</time>
                </header>
                <p>{r.comment || 'Sin comentarios'}</p>
              </article>
            )) : <p style={{ color: 'var(--muted)' }}>Todavía no hay opiniones. ¡Sé el primero!</p>}
          </div>
          <div className="panel" style={{ marginTop: '1.6rem', maxWidth: 560 }}>
            <h3>Deja tu valoración</h3>
            <form className="checkout-form" onSubmit={submitReview}>
              <div className="field-row">
                <div className="field"><label>Tu nombre</label><input required maxLength={60} value={review.name} onChange={(e) => setReview({ ...review, name: e.target.value })} /></div>
                <div className="field"><label>Valoración</label>
                  <select value={review.rating} onChange={(e) => setReview({ ...review, rating: Number(e.target.value) })}>
                    <option value={5}>★★★★★ Excelente</option><option value={4}>★★★★ Muy bueno</option>
                    <option value={3}>★★★ Regular</option><option value={2}>★★ Malo</option><option value={1}>★ Muy malo</option>
                  </select>
                </div>
              </div>
              <div className="field"><label>Comentario</label>
                <textarea rows={3} maxLength={1000} placeholder="Cuéntanos qué tal estuvieron…"
                  value={review.comment} onChange={(e) => setReview({ ...review, comment: e.target.value })} />
              </div>
              <button className="btn" type="submit">Publicar opinión</button>
            </form>
          </div>
        </section>
      </main>

      {related.length > 0 && (
        <section className="section" style={{ background: '#fff' }}>
          <div className="container">
            <div className="section-head"><h2>🍬 También te pueden gustar</h2></div>
            <div className="product-grid">{related.map((p) => <ProductCard key={p.id} product={p} />)}</div>
          </div>
        </section>
      )}
    </>
  )
}
