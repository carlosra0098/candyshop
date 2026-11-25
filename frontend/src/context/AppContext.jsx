import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, auth, cartToken, login as oauthLogin, ready, redirectNotice } from '../lib/api'

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [user, setUser] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [cart, setCart] = useState(null)
  const [cartOpen, setCartOpen] = useState(false)
  const [toasts, setToasts] = useState([])
  const navigate = useNavigate()
  const location = useLocation()

  const notify = useCallback((message, type = 'success') => {
    const id = Date.now() + Math.random()
    setToasts((list) => [...list, { id, message, type }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3400)
  }, [])

  const refreshCart = useCallback(async () => {
    if (!auth.token()) { setCart(null); return null }
    try {
      const data = await api.get('/cart')
      setCart(data)
      return data
    } catch (err) {
      if (err.status === 401) {
        await auth.logout()
        setUser(null)
        setCart(null)
      }
      return null
    }
  }, [])

  // Esperamos a que api.js canjee un posible ?code= o #access_token de vuelta de login
  useEffect(() => {
    let alive = true
    ready.then(() => {
      if (!alive) return
      setUser(auth.user())
      setAuthReady(true)
      if (redirectNotice.error) {
        notify(redirectNotice.error, 'error')
        redirectNotice.error = null
      }
      if (redirectNotice.githubUser) {
        notify(`¡Bienvenido, ${redirectNotice.githubUser.name.split(' ')[0]}! 👋 (GitHub)`)
        redirectNotice.githubUser = null
      }
    })
    return () => { alive = false }
  }, [notify])

  useEffect(() => {
    if (user) refreshCart()
    else setCart(null)
  }, [user, refreshCart])

  const loginUrl = useCallback(() => {
    const next = location.pathname + location.search
    return next === '/cuenta' ? '/cuenta' : `/cuenta?next=${encodeURIComponent(next)}`
  }, [location.pathname, location.search])

  const signIn = useCallback(async (values, mode) => {
    const res = mode === 'register' ? await auth.register(values) : await oauthLogin(values.email, values.password)
    auth.set(res.access_token, res.user, res.refresh_token)
    setUser(res.user)
    try { await api.post('/cart/merge', { token: cartToken() }) } catch { /* carrito vacío */ }
    await refreshCart()
    return res
  }, [refreshCart])

  const signOut = useCallback(async () => {
    await auth.logout()
    setUser(null)
    setCart(null)
    setCartOpen(false)
  }, [])

  const addToCart = useCallback(async (productId, quantity = 1) => {
    if (!auth.token()) {
      notify('Inicia sesión para comprar 🍬', 'error')
      setTimeout(() => navigate(loginUrl()), 700)
      return false
    }
    try {
      await api.post('/cart/items', { productId, quantity })
      await refreshCart()
      setCartOpen(true)
      return true
    } catch (err) {
      if (err.status === 401) {
        notify('Inicia sesión para comprar 🍬', 'error')
        navigate(loginUrl())
      } else notify(err.message, 'error')
      return false
    }
  }, [navigate, loginUrl, notify, refreshCart])

  const value = {
    user, setUser, authReady, cart, refreshCart, cartOpen, setCartOpen,
    toasts, notify, signIn, signOut, addToCart, loginUrl,
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp debe usarse dentro de AppProvider')
  return ctx
}
