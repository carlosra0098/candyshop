/* Cliente de la API + OAuth 2.0 (Authorization Code + PKCE).
   El backend está en otro origen: VITE_API_URL (por defecto http://localhost:8000).
   Tokens en localStorage, sin cookies: Authorization: Bearer en cada petición. */

export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/+$/, '')
const CLIENT_ID = 'candyshop-web'
const SCOPES = 'profile email orders staff admin'

const ACCESS_KEY = 'cs_access_token'
const REFRESH_KEY = 'cs_refresh_token'
const USER_KEY = 'cs_user'
const CART_KEY = 'cs_cart_token'
const PKCE_KEY = 'cs_pkce_verifier'
const STATE_KEY = 'cs_oauth_state'

localStorage.removeItem('cs_token') // token JWT antiguo (pre-OAuth)

export const redirectNotice = { error: null, githubUser: null }

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: b64url(digest) }
}

const randomState = () => b64url(crypto.getRandomValues(new Uint8Array(16)))
const redirectUri = () => location.origin + location.pathname // debe coincidir con REDIRECT_URIS del backend

export function cartToken() {
  let token = localStorage.getItem(CART_KEY)
  if (!token) {
    token = 'cart-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    localStorage.setItem(CART_KEY, token)
  }
  return token
}

const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }

async function oauthForm(path, params) {
  const res = await fetch(API_URL + path, {
    method: 'POST',
    headers: formHeaders,
    body: new URLSearchParams(params),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `Error ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

let refreshing = null
function refreshTokens() {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const refresh = localStorage.getItem(REFRESH_KEY)
    if (!refresh) return false
    try {
      const data = await oauthForm('/oauth/token', {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refresh,
      })
      localStorage.setItem(ACCESS_KEY, data.access_token)
      if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token)
      return true
    } catch {
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/* rawRequest NO espera a `ready` (lo usa el propio flujo de redirect). */
async function rawRequest(method, path, body, skipRefresh = false) {
  const headers = { 'Content-Type': 'application/json', 'X-Cart-Token': cartToken() }
  const token = localStorage.getItem(ACCESS_KEY)
  if (token) headers.Authorization = 'Bearer ' + token

  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)

  if (!res.ok) {
    if (res.status === 401 && token && !skipRefresh && (await refreshTokens())) {
      return rawRequest(method, path, body, true)
    }
    if (res.status === 401 && token) clearLocalAuth()
    const err = new Error((data && data.error) || `Error ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

async function request(method, path, body) {
  await ready
  return rawRequest(method, path, body)
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
  request,
}

/* ── OAuth: authorize (code + PKCE) → token → /auth/me ── */

async function exchangeCode(code, verifier, uri) {
  const data = await oauthForm('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: uri,
    code_verifier: verifier,
  })
  localStorage.setItem(ACCESS_KEY, data.access_token)
  if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token)
  localStorage.removeItem(PKCE_KEY)
  localStorage.removeItem(STATE_KEY)

  const me = await rawRequest('GET', '/auth/me')
  localStorage.setItem(USER_KEY, JSON.stringify(me.user))
  return { access_token: data.access_token, refresh_token: data.refresh_token, user: me.user }
}

export async function login(email, password) {
  const { verifier, challenge } = await pkcePair()
  const state = randomState()
  const uri = redirectUri()
  localStorage.setItem(PKCE_KEY, verifier)
  localStorage.setItem(STATE_KEY, state)

  // /oauth/authorize valida credenciales y devuelve un code de un solo uso
  const data = await oauthForm('/oauth/authorize', {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: uri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    email,
    password,
  }).catch((err) => {
    localStorage.removeItem(PKCE_KEY)
    localStorage.removeItem(STATE_KEY)
    throw err
  })
  return exchangeCode(data.code, verifier, uri)
}

export async function register({ name, email, password }) {
  await rawRequest('POST', '/auth/register', { name, email, password })
  return login(email, password)
}

function clearLocalAuth() {
  localStorage.removeItem(ACCESS_KEY)
  localStorage.removeItem(REFRESH_KEY)
  localStorage.removeItem(USER_KEY)
}

export async function logout() {
  const refresh = localStorage.getItem(REFRESH_KEY)
  clearLocalAuth()
  if (!refresh) return
  try {
    await oauthForm('/oauth/revoke', {
      token: refresh,
      token_type_hint: 'refresh_token',
      client_id: CLIENT_ID,
    })
  } catch {
    /* mejor esfuerzo: la sesión local ya se cerró */
  }
}

export const auth = {
  clientId: CLIENT_ID,
  token: () => localStorage.getItem(ACCESS_KEY),
  user: () => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null') } catch { return null }
  },
  set(access, user, refresh) {
    localStorage.setItem(ACCESS_KEY, access)
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh)
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  },
  login,
  register,
  logout,
  refresh: refreshTokens,
  githubUrl(next) {
    const target = next || location.pathname + location.search
    return `${API_URL}/auth/github/login?redirect=${encodeURIComponent(target)}`
  },
  async githubStatus() {
    try {
      const res = await fetch(`${API_URL}/auth/github/status`)
      return await res.json()
    } catch {
      return { configured: false }
    }
  },
}

/* GitHub devuelve los tokens en el #fragment; el flujo clásico usa ?code= (PKCE). */
async function completeGithubRedirect() {
  const url = new URL(location.href)
  if (!url.hash) return
  const frag = new URLSearchParams(url.hash.slice(1))
  if (!frag.has('access_token') && !frag.has('error')) return
  url.hash = ''
  history.replaceState({}, '', url.toString())

  if (frag.has('error')) {
    redirectNotice.error = frag.get('error_description') || frag.get('error') || 'No se pudo entrar con GitHub'
    return
  }
  const access = frag.get('access_token')
  if (!access) return
  localStorage.setItem(ACCESS_KEY, access)
  if (frag.get('refresh_token')) localStorage.setItem(REFRESH_KEY, frag.get('refresh_token'))
  try {
    const me = await fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: 'Bearer ' + access } }).then((r) => r.json())
    if (me?.user) {
      localStorage.setItem(USER_KEY, JSON.stringify(me.user))
      redirectNotice.githubUser = me.user
    }
  } catch { /* la app decidirá qué hacer sin usuario */ }
}

async function completeOAuthRedirect() {
  const url = new URL(location.href)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  const errorDescription = url.searchParams.get('error_description')
  if (!code && !error) return

  const verifier = localStorage.getItem(PKCE_KEY)
  ;['code', 'state', 'error', 'error_description'].forEach((k) => url.searchParams.delete(k))
  history.replaceState({}, '', url.toString())

  if (error || !code || !verifier) {
    if (error) redirectNotice.error = errorDescription || error
    return
  }
  try {
    await exchangeCode(code, verifier, redirectUri())
  } catch (err) {
    redirectNotice.error = err.message
  }
}

export const ready = (async () => {
  await completeGithubRedirect()
  await completeOAuthRedirect()
})()
