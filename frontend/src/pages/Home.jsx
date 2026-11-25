import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import ProductCard from '../components/ProductCard'
import { useApp } from '../context/AppContext'
import { api } from '../lib/api'
import { hexA } from '../lib/format'

const SLIDES = [
  {
    bg: 'linear-gradient(115deg,#e6007e,#ff5fae 55%,#ff9dd4)',
    kicker: 'La tienda más dulce',
    title: <>Chuches que enamoran<br />a la primera chupada</>,
    text: 'Bolsas de 1 kg, tarros de 200 uds y packs completos para tu mesa de chuches. Envío gratis desde 20€.',
    cta: '🛒 Comprar ahora', to: '/tienda', art: '🍓',
  },
  {
    bg: 'linear-gradient(115deg,#2b1b2a,#5e2a52 55%,#9c3d84)',
    kicker: 'Fans del regaliz',
    title: <>Regaliz intenso<br />para valientes</>,
    text: 'Tiras, tubes, espirales y bobas de regaliz negro. Textura perfecta y sabor que no se olvida.',
    cta: '🖤 Ver regalices', to: '/tienda?category=regalices', art: '🐍',
  },
  {
    bg: 'linear-gradient(115deg,#7c4dff,#b388ff 55%,#e1bee7)',
    kicker: 'Candy bar ready',
    title: <>Monta la mesa<br />de chuches perfecta</>,
    text: 'Packs para 30, 60 y 100 personas con todos los sabores, conos y decoración a juego.',
    cta: '🎉 Ver packs', to: '/tienda?category=packs-fiesta', art: '🥳',
  },
]

function ProductSection({ title, subtitle, linkTo, products }) {
  if (!products?.length) return null
  return (
    <section className="section" style={{ background: '#fff' }}>
      <div className="container">
        <div className="section-head">
          <div><h2>{title}</h2><p>{subtitle}</p></div>
          <Link className="link" to={linkTo}>Ver todas →</Link>
        </div>
        <div className="product-grid">{products.map((p) => <ProductCard key={p.id} product={p} />)}</div>
      </div>
    </section>
  )
}

export default function Home() {
  const [slide, setSlide] = useState(0)
  const [categories, setCategories] = useState([])
  const [top, setTop] = useState([])
  const [packs, setPacks] = useState([])
  const [news, setNews] = useState([])
  const { notify } = useApp()

  useEffect(() => {
    const timer = setInterval(() => setSlide((i) => (i + 1) % SLIDES.length), 6000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    Promise.all([
      api.get('/categories'),
      api.get('/products?sort=popular&limit=8'),
      api.get('/products?category=packs-fiesta&limit=4'),
      api.get('/products?badge=nuevo&limit=4'),
    ]).then(([cats, a, b, c]) => {
      setCategories(cats.data || [])
      setTop(a.data || [])
      setPacks(b.data || [])
      setNews(c.data || [])
    }).catch((err) => notify(err.message, 'error'))
  }, [notify])

  return (
    <>
      <section className="hero">
        <div className="hero-track" style={{ transform: `translateX(-${slide * 100}%)` }}>
          {SLIDES.map((s, i) => (
            <div className="hero-slide" key={i} style={{ background: s.bg }}>
              <div className="container">
                <div className="hero-copy">
                  <span className="kicker">{s.kicker}</span>
                  <h1>{s.title}</h1>
                  <p>{s.text}</p>
                  <Link className="btn btn-yellow" to={s.to}>{s.cta}</Link>
                </div>
                <div className="hero-art">{s.art}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="hero-nav">
          {SLIDES.map((s, i) => (
            <button className={`hero-dot ${i === slide ? 'active' : ''}`} key={i}
              aria-label={`Ir al slide ${i + 1}`} onClick={() => setSlide(i)} />
          ))}
        </div>
      </section>

      <div className="strip-newsletter">
        <div className="container">
          <strong>10% de descuento en tu primer pedido</strong>
          <span>¡Suscríbete a nuestra newsletter y usa el cupón <b>HOLA10</b>! 👇</span>
        </div>
      </div>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <div>
              <h2>🍬 ¿Preparando una mesa dulce?</h2>
              <p>Descubre las categorías favoritas de chuches y golosinas.</p>
            </div>
            <Link className="link" to="/tienda">Ver todas →</Link>
          </div>
          <div className="cat-grid">
            {categories.map((c) => (
              <Link className="cat-card" key={c.id} to={`/tienda?category=${c.slug}`}>
                <div className="cat-emoji" style={{ background: hexA(c.color, 0.16) }}>{c.emoji}</div>
                <h3>{c.name}</h3>
                <small>{c.productCount} productos</small>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <ProductSection title="🏆 Productos más vendidos" subtitle="Los favoritos de la comunidad, semana tras semana."
        linkTo="/tienda?sort=popular" products={top} />

      <section className="section">
        <div className="container promo-grid">
          <div className="promo" style={{ background: 'linear-gradient(120deg,#ff6d00,#ffa040)' }}>
            <h3>🎃 Halloween se acerca</h3><p>Calabazas, arañitas ácidas y surtidos terroríficos.</p>
            <Link className="btn btn-dark btn-sm" to="/tienda?category=halloween">Ver colección</Link>
            <span className="promo-emoji">👻</span>
          </div>
          <div className="promo" style={{ background: 'linear-gradient(120deg,#00b8d9,#4dd0e1)' }}>
            <h3>🌀 Rollers para reventar</h3><p>Gominolas enrollables de fresa, mora y limón ácido.</p>
            <Link className="btn btn-dark btn-sm" to="/tienda?category=rollers">Ver rollers</Link>
            <span className="promo-emoji">🍥</span>
          </div>
          <div className="promo" style={{ background: 'linear-gradient(120deg,#8e24aa,#ce93d8)' }}>
            <h3>☁️ Nubes para todos</h3><p>Tarros de 200 uds de fresa con nata, limón y más.</p>
            <Link className="btn btn-dark btn-sm" to="/tienda?category=nubes">Ver nubes</Link>
            <span className="promo-emoji">🍭</span>
          </div>
        </div>
      </section>

      <ProductSection title="🎉 Packs para candy bar" subtitle="Todo montado para tu fiesta: solo tienes que abrir y servir."
        linkTo="/tienda?category=packs-fiesta" products={packs} />

      <section className="features">
        <div className="container">
          <div className="feature"><span className="f-ico">🚚</span><div><strong>Envío en 36/72h laborables</strong><small>Gratis a partir de 20€</small></div></div>
          <div className="feature"><span className="f-ico">↩️</span><div><strong>Devolución disponible</strong><small>Tienes 14 días para pensártelo</small></div></div>
          <div className="feature"><span className="f-ico">✅</span><div><strong>Calidad garantizada</strong><small>Siempre frescas y bien cerradas</small></div></div>
          <div className="feature"><span className="f-ico">🔒</span><div><strong>Pago seguro</strong><small>Fácil, rápido y fiable</small></div></div>
        </div>
      </section>

      <ProductSection title="✨ Novedades" subtitle="Acaban de llegar a la tienda: no te las pierdas."
        linkTo="/tienda?badge=nuevo" products={news} />
    </>
  )
}
