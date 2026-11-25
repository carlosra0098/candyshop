import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { api, auth, login as oauthLogin } from '../lib/api'
import { money, statusLabel } from '../lib/format'

const BLANK_PASSWORD = { currentPassword: '', newPassword: '', confirm: '' }

export default function Account() {
  const { user, authReady, setUser, signIn, signOut, notify } = useApp()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [mode, setMode] = useState('login')
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [password, setPassword] = useState(BLANK_PASSWORD)
  const [busy, setBusy] = useState(false)
  const [orders, setOrders] = useState([])
  const [loadingOrders, setLoadingOrders] = useState(false)
  const [githubConfigured, setGithubConfigured] = useState(false)

  const rawNext = params.get('next')
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : null

  useEffect(() => {
    auth.githubStatus().then((s) => setGithubConfigured(!!s.configured))
  }, [])

  useEffect(() => {
    if (authReady && user && next) navigate(next, { replace: true })
  }, [authReady, user, next, navigate])

  useEffect(() => {
    if (!user) return
    let alive = true
    setLoadingOrders(true)
    api.get('/orders').then((r) => { if (alive) setOrders(r.data || []) })
      .catch(() => {}).finally(() => { if (alive) setLoadingOrders(false) })
    return () => { alive = false }
  }, [user])

  async function submitAuth(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await signIn(form, mode)
      if (next) return navigate(next, { replace: true })
      notify(mode === 'register' ? '¡Cuenta creada! 🎉' : `¡Bienvenido, ${res.user.name.split(' ')[0]}! 👋`)
      setForm({ name: '', email: '', password: '' })
    } catch (err) {
      notify(err.message, 'error')
    } finally { setBusy(false) }
  }

  async function changePassword(e) {
    e.preventDefault()
    if (password.newPassword !== password.confirm) {
      return notify('Las contraseñas nuevas no coinciden', 'error')
    }
    setBusy(true)
    try {
      await api.post('/auth/change-password', {
        currentPassword: password.currentPassword,
        newPassword: password.newPassword,
      })
      // El servidor revocó los refresh tokens: renovamos la sesión actual
      try {
        const res = await oauthLogin(user.email, password.newPassword)
        auth.set(res.access_token, res.user, res.refresh_token)
        setUser(res.user)
      } catch { /* si falla, la sesión actual sigue válida */ }
      setPassword(BLANK_PASSWORD)
      notify('🔒 Contraseña actualizada correctamente. Las demás sesiones se han cerrado.')
    } catch (err) { notify(err.message, 'error') }
    finally { setBusy(false) }
  }

  async function logout() {
    await signOut()
    notify('Sesión cerrada')
  }

  if (!authReady) return <main className="container"><p style={{ padding: '3rem 0' }}>Cargando…</p></main>

  if (!user) {
    const isReg = mode === 'register'
    return (
      <main className="container">
        <section className="auth-card">
          <h1>{isReg ? '🍬 Crea tu cuenta' : '👋 ¡Hola de nuevo!'}</h1>
          <p className="sub">{isReg
            ? 'Regístrate y desbloquea el 10% de bienvenida con el cupón HOLA10.'
            : 'Inicia sesión para ver tus pedidos y acumular dulces.'}</p>
          <form className="checkout-form" onSubmit={submitAuth}>
            {isReg && <div className="field"><label>Nombre</label>
              <input required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>}
            <div className="field"><label>Email</label>
              <input type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="field"><label>Contraseña</label>
              <input type="password" required minLength={6} autoComplete={isReg ? 'new-password' : 'current-password'}
                value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <span className="hint">Mínimo 6 caracteres</span></div>
            <button className="btn btn-block" type="submit" disabled={busy}>{busy ? 'Entrando…' : isReg ? 'Crear cuenta' : 'Entrar'}</button>
          </form>
          {githubConfigured && (
            <div className="auth-oauth">
              <div className="auth-divider"><span>o continúa con</span></div>
              <a className="btn btn-block btn-github" href={auth.githubUrl(next || '/cuenta')}>🐙 Entrar con GitHub</a>
            </div>
          )}
          <p className="auth-switch">
            <span>{isReg ? '¿Ya tienes cuenta?' : '¿Aún no tienes cuenta?'}</span>
            <button type="button" onClick={() => setMode(isReg ? 'login' : 'register')}>
              {isReg ? 'Inicia sesión' : 'Regístrate aquí'}
            </button>
          </p>
          <p className="auth-switch" style={{ fontSize: '.78rem' }}>
            Demo: <b>cliente@candyshop.test</b> / <b>cliente123</b> · Admin: <b>admin@candyshop.test</b> / <b>admin123</b> · Staff: <b>staff@candyshop.test</b> / <b>staff123</b>
          </p>
        </section>
      </main>
    )
  }

  return (
    <main className="container">
      <section>
        <div className="page-head" style={{ marginTop: '1rem', borderRadius: 18 }}>
          <div className="container" style={{ width: 'auto', padding: '0 2rem' }}>
            <h1>👋 Hola, {user.name.split(' ')[0]}</h1>
            <p>{user.email} · {({ admin: 'Administrador', staff: 'Personal (staff)' }[user.role] || 'Cliente')}</p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '.8rem', margin: '1.4rem 0', flexWrap: 'wrap' }}>
          <Link className="btn" to="/tienda">🛍️ Seguir comprando</Link>
          {user.role === 'admin' && <Link className="btn btn-ghost" to="/admin">🛠️ Panel admin</Link>}
          <button className="btn btn-dark" onClick={logout}>Cerrar sesión</button>
        </div>

        <div className="panel">
          <h2>📦 Mis pedidos</h2>
          {loadingOrders ? <p style={{ color: 'var(--muted)' }}>Cargando pedidos…</p>
            : orders.length ? (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Código</th><th>Fecha</th><th>Artículos</th><th>Total</th><th>Estado</th></tr></thead>
                <tbody>{orders.map((o) => (
                  <tr key={o.code || o.id}>
                    <td><strong>{o.code}</strong></td>
                    <td>{new Date(o.created_at || o.createdAt).toLocaleDateString('es-ES')}</td>
                    <td>—</td>
                    <td><strong>{money(o.total)}</strong></td>
                    <td><span className={`status-pill status-${o.status}`}>{statusLabel(o.status)}</span></td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : (
              <div className="empty-state" style={{ padding: '2rem 0' }}>
                <span className="big">🧺</span>
                <p>Todavía no tienes pedidos.<br />¡Anímate a llevarte tus golosinas favoritas!</p>
                <Link className="btn" to="/tienda">Ver golosinas</Link>
              </div>
            )}
        </div>

        <div className="panel">
          <h2>🔒 Cambiar contraseña</h2>
          <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
            Vale para cualquier rol (cliente, staff o admin). Al cambiarla se cierran
            las sesiones abiertas en otros dispositivos.
          </p>
          <form className="checkout-form" style={{ maxWidth: 440 }} onSubmit={changePassword}>
            <div className="field"><label>Contraseña actual</label>
              <input type="password" required autoComplete="current-password" value={password.currentPassword}
                onChange={(e) => setPassword({ ...password, currentPassword: e.target.value })} /></div>
            <div className="field"><label>Nueva contraseña</label>
              <input type="password" required minLength={6} autoComplete="new-password" value={password.newPassword}
                onChange={(e) => setPassword({ ...password, newPassword: e.target.value })} />
              <span className="hint">Mínimo 6 caracteres y distinta a la actual.</span></div>
            <div className="field"><label>Repite la nueva contraseña</label>
              <input type="password" required minLength={6} autoComplete="new-password" value={password.confirm}
                onChange={(e) => setPassword({ ...password, confirm: e.target.value })} /></div>
            <button className="btn" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Cambiar contraseña'}</button>
          </form>
        </div>
      </section>
    </main>
  )
}
