import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <main className="container">
      <div className="empty-state" style={{ padding: '4rem 0' }}>
        <span className="big">🍭</span>
        <h2>404 · Página no encontrada</h2>
        <p>Parece que esta chuche se ha escapado de la tienda.</p>
        <Link className="btn" to="/">Volver al inicio</Link>
      </div>
    </main>
  )
}
