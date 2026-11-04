/* ═══ Cliente de la API + OAuth 2.0 (Authorization Code + PKCE) ═══
   Sin cookies ni sesiones de servidor:
   · El login pasa por /oauth/authorize → code (PKCE) → /oauth/token
   · El access token (JWT, 15 min) y el refresh token (rotativo) se
     guardan en localStorage y viajan siempre en Authorization: Bearer.
   · Si un access token caduca, se renueva solo con el refresh token. */
(function () {
  const CLIENT_ID = 'candyshop-web';
  const SCOPES = 'profile email orders staff admin';
  const ACCESS_KEY = 'cs_access_token';
  const REFRESH_KEY = 'cs_refresh_token';
  const USER_KEY = 'cs_user';
  const CART_KEY = 'cs_cart_token';
  const PKCE_KEY = 'cs_pkce_verifier';
  const STATE_KEY = 'cs_oauth_state';
  const LEGACY_KEY = 'cs_token'; // tokens JWT antiguos (pre-OAuth)

  localStorage.removeItem(LEGACY_KEY);

  /* ── utilidades PKCE (RFC 7636) ── */
  const b64url = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function pkcePair() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(digest) };
  }

  const randomState = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = () => location.origin + location.pathname;

  function cartToken() {
    let t = localStorage.getItem(CART_KEY);
    if (!t) {
      t = 'cart-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(CART_KEY, t);
    }
    return t;
  }

  /* ── refresh token (rotación en el servidor) ── */
  let refreshing = null;
  async function refreshTokens() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const refresh = localStorage.getItem(REFRESH_KEY);
      if (!refresh) return false;
      try {
        const res = await fetch('/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            refresh_token: refresh,
          }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        localStorage.setItem(ACCESS_KEY, data.access_token);
        localStorage.setItem(REFRESH_KEY, data.refresh_token || refresh);
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /* ── peticiones con renovación automática del token ── */
  async function request(method, path, body, skipRetry) {
    await ready; // completa el ?code= del redirect OAuth si lo hay
    const headers = { 'Content-Type': 'application/json', 'X-Cart-Token': cartToken() };
    const token = localStorage.getItem(ACCESS_KEY);
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch('/api' + path, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try { data = await res.json(); } catch { /* sin cuerpo */ }

    if (!res.ok) {
      if (res.status === 401 && token && !skipRetry && (await refreshTokens())) {
        return request(method, path, body, true); // reintenta con el token nuevo
      }
      if (res.status === 401 && token) {
        localStorage.removeItem(ACCESS_KEY);
        localStorage.removeItem(REFRESH_KEY);
        localStorage.removeItem(USER_KEY);
      }
      const err = new Error((data && data.error) || `Error ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ── flujo OAuth 2.0 ── */

  /** Login completo: /oauth/authorize (code + PKCE) → /oauth/token → /auth/me */
  async function oauthLogin(email, password) {
    const { verifier, challenge } = await pkcePair();
    const state = randomState();
    const uri = redirectUri();
    localStorage.setItem(PKCE_KEY, verifier);
    localStorage.setItem(STATE_KEY, state);

    // 1) authorize: valida credenciales y devuelve un code de un solo uso
    const authRes = await fetch('/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: uri,
        scope: SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        email,
        password,
      }),
    });
    const authData = await authRes.json().catch(() => ({}));
    if (!authRes.ok) {
      throw new Error(authData.error_description || authData.error || 'No se pudo iniciar sesión');
    }

    // 2) token: canjea el code + verifier por los tokens
    return exchangeCode(authData.code, verifier, uri);
  }

  async function exchangeCode(code, verifier, uri) {
    const res = await fetch('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: uri,
        code_verifier: verifier,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      localStorage.removeItem(PKCE_KEY);
      localStorage.removeItem(STATE_KEY);
      throw new Error(data.error_description || data.error || 'No se pudieron obtener los tokens');
    }
    localStorage.setItem(ACCESS_KEY, data.access_token);
    if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
    localStorage.removeItem(PKCE_KEY);
    localStorage.removeItem(STATE_KEY);

    // 3) usuario asociado al token
    const me = await request('GET', '/auth/me');
    localStorage.setItem(USER_KEY, JSON.stringify(me.user));
    return { access_token: data.access_token, refresh_token: data.refresh_token, user: me.user };
  }

  /** Revoca el refresh token en el servidor (llamado al cerrar sesión). */
  async function revokeRefresh() {
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (!refresh) return;
    try {
      await fetch('/oauth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: refresh,
          token_type_hint: 'refresh_token',
          client_id: CLIENT_ID,
        }),
      });
    } catch { /* mejor esfuerzo */ }
  }

  function clearAuth() {
    const pending = revokeRefresh();
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    return pending;
  }

  /* ── GitHub OAuth: el backend devuelve los tokens en el #fragment ──
     Se ejecuta al cargar la página (antes que nada): guarda los tokens,
     recupera el usuario y limpia la URL. Sin cookie, todo en localStorage. */
  async function completeGithubRedirect() {
    const url = new URL(location.href);
    if (!url.hash) return;
    const frag = new URLSearchParams(url.hash.slice(1));
    if (!frag.has('access_token') && !frag.has('error')) return;
    url.hash = '';
    history.replaceState({}, '', url.toString());

    if (frag.has('error')) {
      window.__csAuthError = frag.get('error') || 'No se pudo iniciar sesión con GitHub';
      return;
    }
    const access = frag.get('access_token');
    const refresh = frag.get('refresh_token');
    if (!access) return;
    localStorage.setItem(ACCESS_KEY, access);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
    try {
      const me = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + access } }).then((r) => r.json());
      if (me && me.user) {
        localStorage.setItem(USER_KEY, JSON.stringify(me.user));
        window.__csGithubLogin = me.user;
      }
    } catch { /* la página decidirá qué hacer sin usuario */ }
  }

  /* Si llegamos con ?code= (flujo clásico con redirect del navegador),
     canjeamos el code usando el verifier de PKCE guardado antes del POST. */
  async function completeOAuthRedirect() {
    // 1) Vuelta de GitHub (tokens en el fragment)
    await completeGithubRedirect();

    // 2) Flujo clásico PKCE (?code= en la query)
    const url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return;

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const verifier = localStorage.getItem(PKCE_KEY);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    url.searchParams.delete('error_description');
    history.replaceState({}, '', url.toString());

    if (error || !code || !verifier) return;
    try {
      await exchangeCode(code, verifier, location.origin + location.pathname);
    } catch (e) {
      console.warn('[oauth] No se pudo completar el login:', e.message);
    }
  }
  const ready = completeOAuthRedirect();

  const api = {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: (p) => request('DELETE', p),
    cartToken,
    request,

    auth: {
      clientId: CLIENT_ID,
      token: () => localStorage.getItem(ACCESS_KEY),
      user: () => JSON.parse(localStorage.getItem(USER_KEY) || 'null'),
      /** URL de "Entrar con GitHub" (el backend redirige a GitHub). */
      githubUrl(next) {
        const target = next || location.pathname + location.search;
        return '/auth/github/login?redirect=' + encodeURIComponent(target);
      },
      set(access, user, refresh) {
        localStorage.setItem(ACCESS_KEY, access);
        if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
        localStorage.setItem(USER_KEY, JSON.stringify(user));
      },
      /** Login OAuth 2.0 (Authorization Code + PKCE). */
      login: oauthLogin,
      /** Registro + login automático por OAuth. */
      async register({ name, email, password }) {
        const res = await request('POST', '/auth/register', { name, email, password });
        return oauthLogin(email, password).then((r) => ({ ...r, created: res.user }));
      },
      clear: clearAuth,
      refresh: refreshTokens,
      /** true si quedó un code OAuth pendiente por canjear en la URL. */
      ready,
    },

    money(n) {
      return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number(n) || 0);
    },
  };

  window.api = api;
})();
