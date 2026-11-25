import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import Modal from '../components/Modal'
import { api, auth } from '../lib/api'
import { money, roleLabel, statusLabel } from '../lib/format'

const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled']
const EMPTY_PRODUCT = {
  id: '', name: '', price: '', comparePrice: '', stock: 10, categoryId: '', emoji: '🍬',
  color: '#ff2d95', unit: 'bolsa', weight: '', badge: '', featured: '0', description: '',
}
const EMPTY_COUPON = { code: '', type: 'percent', value: '', minTotal: '0' }

export default function Admin() {
  const { user, authReady, signIn, signOut, notify } = useApp()
  const [login, setLogin] = useState({ email: 'admin@candyshop.test', password: 'admin123' })
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState('stats')
  const [stats, setStats] = useState(null)
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [orders, setOrders] = useState([])
  const [users, setUsers] = useState([])
  const [coupons, setCoupons] = useState([])
  const [modal, setModal] = useState(null)
  const [productForm, setProductForm] = useState(EMPTY_PRODUCT)
  const [couponForm, setCouponForm] = useState(EMPTY_COUPON)
  const [pwUserId, setPwUserId] = useState(null)
  const [pwEmail, setPwEmail] = useState('')
  const [pwValue, setPwValue] = useState('')
  const [githubConfigured, setGithubConfigured] = useState(false)

  const isAdmin = user?.role === 'admin'
  const allowed = user && ['admin', 'staff'].includes(user.role)
  const tabs = [
    ...(isAdmin ? [['stats', '📊 Resumen']] : []),
    ['products', '🍬 Productos'],
    ['orders', '📦 Pedidos'],
    ...(isAdmin ? [['users', '👥 Usuarios'], ['coupons', '🏷️ Cupones']] : []),
  ]

  useEffect(() => {
    auth.githubStatus().then((s) => setGithubConfigured(!!s.configured))
  }, [])

  useEffect(() => {
    if (authReady && allowed) setTab(isAdmin ? 'stats' : 'products')
  }, [authReady, allowed, isAdmin])

  useEffect(() => {
    if (!allowed) return
    if (tab === 'stats' && isAdmin) api.get('/admin/stats').then(setStats).catch((e) => notify(e.message, 'error'))
    if (tab === 'products') {
      Promise.all([api.get('/categories'), api.get('/products?limit=50&sort=name')])
        .then(([cats, res]) => { setCategories(cats.data || []); setProducts(res.data || []) })
        .catch((e) => notify(e.message, 'error'))
    }
    if (tab === 'orders') api.get('/admin/orders').then((r) => setOrders(r.data || [])).catch((e) => notify(e.message, 'error'))
    if (tab === 'users' && isAdmin) api.get('/admin/users').then((r) => setUsers(r.data?.data || [])).catch((e) => notify(e.message, 'error'))
    if (tab === 'coupons' && isAdmin) api.get('/admin/coupons').then((r) => setCoupons(r.data || [])).catch((e) => notify(e.message, 'error'))
  }, [tab, allowed, isAdmin, notify])

  async function submitLogin(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await signIn(login, 'login')
      if (!['admin', 'staff'].includes(res.user.role)) {
        await signOut()
        notify('Esta cuenta no tiene acceso al panel (requiere admin o staff)', 'error')
      } else {
        setTab(res.user.role === 'admin' ? 'stats' : 'products')
      }
    } catch (err) { notify(err.message, 'error') }
    finally { setBusy(false) }
  }

  async function logout() {
    await signOut()
    notify('Sesión cerrada')
  }

  function openProduct(p) {
    setProductForm(p ? {
      id: p.id, name: p.name, price: p.price, comparePrice: p.comparePrice ?? '', stock: p.stock,
      categoryId: p.category?.id ?? '', emoji: p.emoji, color: p.color, unit: p.unit, weight: p.weight,
      badge: p.badge || '', featured: p.featured ? '1' : '0', description: p.description || '',
    } : EMPTY_PRODUCT)
    setModal('product')
  }

  async function editProduct(id) {
    try { openProduct(await api.get('/products/' + id)) }
    catch (err) { notify(err.message, 'error') }
  }

  async function saveProduct(e) {
    e.preventDefault()
    const p = productForm
    const payload = {
      name: p.name,
      price: parseFloat(p.price),
      comparePrice: p.comparePrice === '' ? null : parseFloat(p.comparePrice),
      stock: parseInt(p.stock),
      categoryId: p.categoryId || null,
      emoji: p.emoji || '🍬',
      color: p.color,
      unit: p.unit,
      weight: p.weight,
      badge: p.badge,
      featured: p.featured === '1',
      description: p.description,
    }
    try {
      if (p.id) await api.put('/admin/products/' + p.id, payload)
      else await api.post('/admin/products', payload)
      notify('Producto guardado ✓')
      setModal(null)
      const res = await api.get('/products?limit=50&sort=name')
      setProducts(res.data || [])
    } catch (err) { notify(err.message, 'error') }
  }

  async function deleteProduct(id) {
    if (!confirm('¿Eliminar este producto? Esta acción no se puede deshacer.')) return
    try {
      await api.del('/admin/products/' + id)
      notify('Producto eliminado')
      setProducts((list) => list.filter((p) => p.id !== id))
    } catch (err) { notify(err.message, 'error') }
  }

  async function changeStatus(id, status) {
    try {
      await api.patch(`/admin/orders/${id}`, { status })
      notify('Estado actualizado ✓')
    } catch (err) {
      notify(err.message, 'error')
    } finally {
      const res = await api.get('/admin/orders').catch(() => null)
      if (res) setOrders(res.data || [])
    }
  }

  async function saveCoupon(e) {
    e.preventDefault()
    try {
      await api.post('/admin/coupons', {
        code: couponForm.code.toUpperCase(),
        type: couponForm.type,
        value: parseFloat(couponForm.value),
        minTotal: parseFloat(couponForm.minTotal) || 0,
      })
      notify('Cupón creado ✓')
      setModal(null)
      setCouponForm(EMPTY_COUPON)
      const res = await api.get('/admin/coupons')
      setCoupons(res.data || [])
    } catch (err) { notify(err.message, 'error') }
  }

  async function deleteCoupon(id) {
    if (!confirm('¿Eliminar este cupón?')) return
    try {
      await api.del('/admin/coupons/' + id)
      notify('Cupón eliminado')
      setCoupons((list) => list.filter((c) => c.id !== id))
    } catch (err) { notify(err.message, 'error') }
  }

  async function resetPassword(e) {
    e.preventDefault()
    try {
      await api.post(`/admin/users/${pwUserId}/password`, { password: pwValue })
      notify('Contraseña actualizada ✓ Se han cerrado sus sesiones')
      setModal(null)
      setPwValue('')
    } catch (err) { notify(err.message, 'error') }
  }

  if (!authReady) return <main className="container"><p style={{ padding: '3rem 0' }}>Cargando…</p></main>

  if (!allowed) {
    return (
      <main className="container">
        <div className="page-head">
          <div className="container">
            <div className="breadcrumb"><Link to="/">Inicio</Link> / <span>Administración</span></div>
            <h1>🛠️ Panel de administración</h1><p>Gestiona productos, pedidos y cupones de la tienda.</p>
          </div>
        </div>
        <section className="auth-card">
          <h1>🔒 Acceso restringido</h1>
          <p className="sub">Inicia sesión con una cuenta de administrador o del personal (staff).</p>
          <form className="checkout-form" onSubmit={submitLogin}>
            <div className="field"><label>Email</label>
              <input type="email" required value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} /></div>
            <div className="field"><label>Contraseña</label>
              <input type="password" required value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} /></div>
            <button className="btn btn-block" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
          </form>
          {githubConfigured && (
            <div className="auth-oauth">
              <div className="auth-divider"><span>o continúa con</span></div>
              <a className="btn btn-block btn-github" href={auth.githubUrl('/admin')}>🐙 Entrar con GitHub</a>
            </div>
          )}
        </section>
      </main>
    )
  }

  return (
    <>
      <div className="page-head">
        <div className="container">
          <div className="breadcrumb"><Link to="/">Inicio</Link> / <span>Administración</span></div>
          <h1>🛠️ Panel de administración</h1>
          <p>{isAdmin ? 'Gestiona productos, pedidos, usuarios y cupones de la tienda.' : 'Gestiona productos y pedidos de la tienda.'}</p>
        </div>
      </div>

      <main className="container">
        <div className="admin-layout">
          <nav className="admin-nav">
            {tabs.map(([key, label]) => (
              <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
            ))}
            <button onClick={logout}>🚪 Salir</button>
          </nav>

          <div>
            {tab === 'stats' && isAdmin && stats && (
              <section>
                <div className="stat-grid">
                  {[
                    ['Facturación', money(stats.revenue)], ['Pedidos', stats.orders],
                    ['Pendientes', stats.pendingOrders], ['Productos', stats.products],
                    ['Clientes', stats.customers], ['Suscriptores', stats.newsletter],
                    ['Stock bajo (<25)', stats.lowStock],
                  ].map(([label, value]) => (
                    <div className="stat-card" key={label}><div className="label">{label}</div><div className="value">{value}</div></div>
                  ))}
                </div>
                <div className="promo-grid">
                  <div className="panel"><h2>🏆 Top productos vendidos</h2>
                    <div className="table-wrap">{stats.topProducts.length ? <table className="table"><tbody>
                      {stats.topProducts.map((p, i) => <tr key={i}><td>{p.emoji}</td><td>{p.name}</td><td><strong>{p.units} uds</strong></td></tr>)}
                    </tbody></table> : <p style={{ color: 'var(--muted)' }}>Aún no hay ventas registradas.</p>}</div>
                  </div>
                  <div className="panel"><h2>🕒 Últimos pedidos</h2>
                    <div className="table-wrap">{stats.recentOrders.length ? <table className="table"><tbody>
                      {stats.recentOrders.map((o, i) => <tr key={i}>
                        <td><strong>{o.code}</strong><br /><small>{o.name}</small></td>
                        <td>{money(o.total)}</td>
                        <td><span className={`status-pill status-${o.status}`}>{statusLabel(o.status)}</span></td>
                      </tr>)}
                    </tbody></table> : <p style={{ color: 'var(--muted)' }}>Sin pedidos todavía.</p>}</div>
                  </div>
                </div>
              </section>
            )}

            {tab === 'products' && (
              <section className="panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                  <h2 style={{ margin: 0 }}>🍬 Productos <span style={{ color: 'var(--muted)', fontSize: '.9rem' }}>({products.length})</span></h2>
                  <button className="btn btn-sm" onClick={() => openProduct(null)}>＋ Nuevo producto</button>
                </div>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th></th><th>Producto</th><th>Categoría</th><th>Precio</th><th>Stock</th><th>Insignia</th><th>Acciones</th></tr></thead>
                  <tbody>{products.map((p) => <tr key={p.id}>
                    <td style={{ fontSize: '1.5rem' }}>{p.emoji}</td>
                    <td><strong>{p.name}</strong><br /><small style={{ color: 'var(--muted)' }}>/{p.slug}</small></td>
                    <td>{p.category ? `${p.category.emoji} ${p.category.name}` : '—'}</td>
                    <td><strong>{money(p.price)}</strong></td>
                    <td><span className={`status-pill ${p.stock < 25 ? 'status-cancelled' : 'status-delivered'}`}>{p.stock}</span></td>
                    <td>{p.badge ? { nuevo: '✨ Nuevo', top: '🏆 Top', hot: '🔥 Hot' }[p.badge] || p.badge : '—'}</td>
                    <td className="row-actions">
                      <button className="icon-action" onClick={() => editProduct(p.id)} title="Editar">✏️</button>
                      <button className="icon-action" onClick={() => deleteProduct(p.id)} title="Eliminar">🗑️</button>
                    </td>
                  </tr>)}</tbody>
                </table></div>
              </section>
            )}

            {tab === 'orders' && (
              <section className="panel"><h2>📦 Pedidos</h2>
                <div className="table-wrap">{orders.length ? <table className="table">
                  <thead><tr><th>Código</th><th>Cliente</th><th>Envío</th><th>Total</th><th>Estado</th><th>Acción</th></tr></thead>
                  <tbody>{orders.map((o) => <tr key={o.id}>
                    <td><strong>{o.code}</strong><br /><small>{new Date(o.created_at).toLocaleString('es-ES')}</small></td>
                    <td>{o.name}<br /><small style={{ color: 'var(--muted)' }}>{o.email}</small></td>
                    <td><small>{o.address}, {o.postal} {o.city}</small></td>
                    <td><strong>{money(o.total)}</strong>{o.discount ? <br /> : null}{o.discount ? <small style={{ color: 'var(--green)' }}>- {money(o.discount)} cupón</small> : null}</td>
                    <td><span className={`status-pill status-${o.status}`}>{statusLabel(o.status)}</span></td>
                    <td><select value={o.status} onChange={(e) => changeStatus(o.id, e.target.value)}
                      style={{ border: '2px solid var(--line)', borderRadius: 8, padding: '.35rem' }}>
                      {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                    </select></td>
                  </tr>)}</tbody>
                </table> : <p style={{ color: 'var(--muted)' }}>No hay pedidos todavía. ¡Haz una compra de prueba!</p>}</div>
              </section>
            )}

            {tab === 'users' && isAdmin && (
              <section className="panel"><h2>👥 Usuarios</h2>
                <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
                  Restablece la contraseña de cualquier usuario (cliente, staff o admin). Al hacerlo se cierran sus sesiones abiertas.
                </p>
                <div className="table-wrap"><table>
                  <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Registro</th><th></th></tr></thead>
                  <tbody>{users.map((u) => <tr key={u.id}>
                    <td><strong>{u.name}</strong></td><td>{u.email}</td><td>{roleLabel(u.role)}</td>
                    <td>{new Date(u.createdAt).toLocaleDateString('es-ES')}</td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => {
                      setPwUserId(u.id); setPwEmail(u.email); setPwValue(''); setModal('password')
                    }}>🔑 Contraseña</button></td>
                  </tr>)}</tbody>
                </table></div>
              </section>
            )}

            {tab === 'coupons' && isAdmin && (
              <section className="panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                  <h2 style={{ margin: 0 }}>🏷️ Cupones</h2>
                  <button className="btn btn-sm" onClick={() => { setCouponForm(EMPTY_COUPON); setModal('coupon') }}>＋ Nuevo cupón</button>
                </div>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Código</th><th>Descuento</th><th>Mínimo</th><th>Usos</th><th>Estado</th><th></th></tr></thead>
                  <tbody>{coupons.map((c) => <tr key={c.id}>
                    <td><strong>{c.code}</strong></td>
                    <td>{c.type === 'percent' ? `${c.value} %` : money(c.value)}</td>
                    <td>{c.min_total > 0 ? money(c.min_total) : '—'}</td>
                    <td>{c.used_count}</td>
                    <td><span className={`status-pill ${c.active ? 'status-delivered' : 'status-cancelled'}`}>{c.active ? 'Activo' : 'Inactivo'}</span></td>
                    <td><button className="icon-action" onClick={() => deleteCoupon(c.id)}>🗑️</button></td>
                  </tr>)}</tbody>
                </table></div>
              </section>
            )}
          </div>
        </div>
      </main>

      <Modal open={modal === 'product'} onClose={() => setModal(null)}>
        <h3>{productForm.id ? 'Editar producto' : 'Nuevo producto'}</h3>
        <form className="checkout-form" onSubmit={saveProduct}>
          <div className="field"><label>Nombre *</label>
            <input required maxLength={120} value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} /></div>
          <div className="field-row">
            <div className="field"><label>Precio (€) *</label><input type="number" step="0.01" min="0" required value={productForm.price}
              onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} /></div>
            <div className="field"><label>Precio anterior (€)</label><input type="number" step="0.01" min="0" value={productForm.comparePrice}
              onChange={(e) => setProductForm({ ...productForm, comparePrice: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label>Stock *</label><input type="number" min="0" required value={productForm.stock}
              onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} /></div>
            <div className="field"><label>Categoría</label><select value={productForm.categoryId}
              onChange={(e) => setProductForm({ ...productForm, categoryId: e.target.value })}>
              <option value="">Sin categoría</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
            </select></div>
          </div>
          <div className="field-row">
            <div className="field"><label>Emoji</label><input maxLength={4} value={productForm.emoji}
              onChange={(e) => setProductForm({ ...productForm, emoji: e.target.value })} /></div>
            <div className="field"><label>Color</label><input type="color" value={productForm.color}
              style={{ height: 44, padding: '.2rem' }} onChange={(e) => setProductForm({ ...productForm, color: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label>Formato</label><input placeholder="bolsa / tarro / pack" value={productForm.unit}
              onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })} /></div>
            <div className="field"><label>Peso/cantidad</label><input placeholder="1 kg / 200 uds" value={productForm.weight}
              onChange={(e) => setProductForm({ ...productForm, weight: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label>Insignia</label><select value={productForm.badge}
              onChange={(e) => setProductForm({ ...productForm, badge: e.target.value })}>
              <option value="">Sin insignia</option><option value="nuevo">Novedad</option>
              <option value="top">Top ventas</option><option value="hot">En redes</option>
            </select></div>
            <div className="field"><label>Destacado</label><select value={productForm.featured}
              onChange={(e) => setProductForm({ ...productForm, featured: e.target.value })}>
              <option value="0">No</option><option value="1">Sí</option>
            </select></div>
          </div>
          <div className="field"><label>Descripción</label><textarea rows={3} value={productForm.description}
            onChange={(e) => setProductForm({ ...productForm, description: e.target.value })} /></div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal(null)}>Cancelar</button>
            <button type="submit" className="btn btn-sm">Guardar</button>
          </div>
        </form>
      </Modal>

      <Modal open={modal === 'coupon'} onClose={() => setModal(null)}>
        <h3>Nuevo cupón</h3>
        <form className="checkout-form" onSubmit={saveCoupon}>
          <div className="field"><label>Código *</label><input required maxLength={20} placeholder="PRIMAVERA15"
            style={{ textTransform: 'uppercase' }} value={couponForm.code}
            onChange={(e) => setCouponForm({ ...couponForm, code: e.target.value.toUpperCase() })} /></div>
          <div className="field-row">
            <div className="field"><label>Tipo *</label><select value={couponForm.type}
              onChange={(e) => setCouponForm({ ...couponForm, type: e.target.value })}>
              <option value="percent">% Descuento</option><option value="fixed">€ Fijo</option>
            </select></div>
            <div className="field"><label>Valor *</label><input type="number" step="0.01" min="0.01" required value={couponForm.value}
              onChange={(e) => setCouponForm({ ...couponForm, value: e.target.value })} /></div>
          </div>
          <div className="field"><label>Pedido mínimo (€)</label><input type="number" step="0.01" min="0" value={couponForm.minTotal}
            onChange={(e) => setCouponForm({ ...couponForm, minTotal: e.target.value })} /></div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal(null)}>Cancelar</button>
            <button type="submit" className="btn btn-sm">Crear cupón</button>
          </div>
        </form>
      </Modal>

      <Modal open={modal === 'password'} onClose={() => setModal(null)}>
        <h3>🔑 Nueva contraseña</h3>
        <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>Para <strong>{pwEmail}</strong>. Se cerrarán sus sesiones abiertas.</p>
        <form onSubmit={resetPassword}>
          <div className="field"><label>Contraseña *</label>
            <input type="password" required minLength={6} autoComplete="new-password" value={pwValue}
              onChange={(e) => setPwValue(e.target.value)} />
            <span className="hint">Mínimo 6 caracteres.</span></div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal(null)}>Cancelar</button>
            <button type="submit" className="btn btn-sm">Guardar</button>
          </div>
        </form>
      </Modal>
    </>
  )
}
