import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import ProductCard from '../components/ProductCard'
import { useApp } from '../context/AppContext'
import { api } from '../lib/api'

const BADGES = [
  ['', 'Todos'], ['nuevo', '✨ Novedades'], ['top', '🏆 Top ventas'], ['hot', '🔥 En redes'],
]

export default function Shop() {
  const [params, setParams] = useSearchParams()
  const [categories, setCategories] = useState([])
  const [totalCount, setTotalCount] = useState(0)
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [result, setResult] = useState(null)
  const { notify } = useApp()

  const q = params.get('q') || ''
  const category = params.get('category') || ''
  const badge = params.get('badge') || ''
  const sort = params.get('sort') || 'popular'
  const page = Number(params.get('page') || 1)

  useEffect(() => {
    Promise.all([api.get('/categories'), api.get('/products?limit=1')])
      .then(([cats, counts]) => {
        setCategories(cats.data || [])
        setTotalCount(counts?.pagination?.total || 0)
      }).catch((err) => notify(err.message, 'error'))
  }, [notify])

  useEffect(() => {
    const query = new URLSearchParams({ limit: 12, page, sort })
    if (q) query.set('q', q)
    if (category) query.set('category', category)
    if (badge) query.set('badge', badge)
    if (minPrice) query.set('minPrice', minPrice)
    if (maxPrice) query.set('maxPrice', maxPrice)
    let alive = true
    api.get('/products?' + query)
      .then((res) => { if (alive) setResult(res) })
      .catch((err) => notify(err.message, 'error'))
    return () => { alive = false }
  }, [q, category, badge, sort, page, minPrice, maxPrice, notify])

  function setFilter(key, value) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'page') next.delete('page')
    setParams(next)
  }

  function reset() {
    setParams(new URLSearchParams())
    setMinPrice(''); setMaxPrice('')
  }

  const total = result?.pagination?.total ?? 0
  const pages = result?.pagination?.pages ?? 1
  const catName = categories.find((c) => c.slug === category)?.name
  let title = '🍭 Todas las chuches'
  let sub = 'Golosinas para todos los gustos: bolsas, tarros, cajas y packs.'
  if (q) { title = `🔎 Resultados para “${q}”`; sub = `${total} productos encontrados` }
  else if (catName) { title = `${catName}`; sub = `${total} productos en esta categoría` }

  return (
    <>
      <div className="page-head">
        <div className="container">
          <div className="breadcrumb"><Link to="/">Inicio</Link> / <span>{title}</span></div>
          <h1>{title}</h1><p>{sub}</p>
        </div>
      </div>

      <main className="container shop-layout">
        <aside className="filters">
          <div>
            <h3>Categorías</h3>
            <ul className="filter-list">
              <li><button className={!category ? 'active' : ''} onClick={() => setFilter('category', '')}>Todos <span className="count">{totalCount}</span></button></li>
              {categories.map((c) => (
                <li key={c.id}>
                  <button className={category === c.slug ? 'active' : ''} onClick={() => setFilter('category', c.slug)}>
                    {c.emoji} {c.name} <span className="count">{c.productCount}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Precio</h3>
            <div className="price-inputs">
              <div><label htmlFor="min-price">Mín.</label><input id="min-price" type="number" min="0" step="0.5" placeholder="0 €" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} /></div>
              <div><label htmlFor="max-price">Máx.</label><input id="max-price" type="number" min="0" step="0.5" placeholder="99 €" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} /></div>
            </div>
          </div>
          <div>
            <h3>Especiales</h3>
            <ul className="filter-list">
              {BADGES.map(([value, label]) => (
                <li key={label}><button className={badge === value ? 'active' : ''} onClick={() => setFilter('badge', value)}>{label}</button></li>
              ))}
            </ul>
          </div>
          <button className="btn btn-ghost btn-sm btn-block" onClick={reset}>Limpiar filtros</button>
        </aside>

        <section>
          <div className="shop-toolbar">
            <span className="result-count">{result ? `${total} producto${total === 1 ? '' : 's'} · Página ${page} de ${pages}` : 'Cargando…'}</span>
            <select value={sort} onChange={(e) => setFilter('sort', e.target.value)} aria-label="Ordenar">
              <option value="popular">Más populares</option>
              <option value="price-asc">Precio: de menor a mayor</option>
              <option value="price-desc">Precio: de mayor a menor</option>
              <option value="newest">Novedades primero</option>
              <option value="name">Nombre A → Z</option>
            </select>
          </div>

          {result?.data?.length ? (
            <div className="product-grid">{result.data.map((p) => <ProductCard key={p.id} product={p} />)}</div>
          ) : result ? (
            <div className="empty-state">
              <span className="big">🔍</span><h2>No hemos encontrado chuches</h2>
              <p>Prueba con otro término o quita algún filtro.</p>
              <button className="btn" onClick={reset}>Ver todos los productos</button>
            </div>
          ) : null}

          {pages > 1 && (
            <nav className="pagination" aria-label="Paginación">
              <button disabled={page === 1} onClick={() => setFilter('page', Math.max(1, page - 1))}>←</button>
              {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                <button key={n} className={n === page ? 'active' : ''} onClick={() => setFilter('page', n)}>{n}</button>
              ))}
              <button disabled={page === pages} onClick={() => setFilter('page', Math.min(pages, page + 1))}>→</button>
            </nav>
          )}
        </section>
      </main>
    </>
  )
}
