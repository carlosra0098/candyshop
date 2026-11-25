import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { badgeLabel, hexA, money, stars } from '../lib/format'

export default function ProductCard({ product: p }) {
  const [qty, setQty] = useState(1)
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('Añadir 🛒')
  const { addToCart } = useApp()

  async function add() {
    if (busy || p.stock <= 0) return
    setBusy(true)
    setLabel('Añadiendo…')
    const ok = await addToCart(p.id, qty)
    setBusy(false)
    setLabel(ok ? '¡Añadido! ✓' : 'Añadir 🛒')
    if (ok) setTimeout(() => setLabel('Añadir 🛒'), 1400)
  }

  return (
    <article className={`card ${p.stock <= 0 ? 'sold-out' : ''}`}>
      <Link to={`/producto?id=${p.id}`} className="card-media" style={{ background: hexA(p.color, 0.16) }}>
        {p.badge && <span className={`badge ${p.badge}`}>{badgeLabel[p.badge] || p.badge}</span>}
        <span className="emoji">{p.emoji}</span>
      </Link>
      <div className="card-body">
        <h3><Link to={`/producto?id=${p.id}`}>{p.name}</Link></h3>
        <div className="stars">{stars(p.rating)}<small>{Number(p.rating).toFixed(1)}</small></div>
        <div className="price-row">
          <span className="price">{money(p.price)}</span>
          {p.comparePrice && <span className="price-old">{money(p.comparePrice)}</span>}
        </div>
        <span className="unit-price">{p.weight ? `${money(p.price)} / ${p.weight}` : `Por ${p.unit}`}</span>
        <div className="card-actions">
          <div className="qty">
            <button type="button" onClick={() => setQty((n) => Math.max(1, n - 1))} aria-label="Menos">−</button>
            <span>{qty}</span>
            <button type="button" onClick={() => setQty((n) => n + 1)} aria-label="Más">+</button>
          </div>
          <button className="add-btn" onClick={add} disabled={busy || p.stock <= 0}>{label}</button>
        </div>
      </div>
    </article>
  )
}
