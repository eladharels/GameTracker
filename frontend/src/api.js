// The ONE HTTP client for this app's own API (ROADMAP FE-16).
//
// API_BASE was defined five times, and every page leaned on App.jsx having modified the
// GLOBAL axios instance on import: a page imported without App.jsx (a component test, a
// future lazy route) sent requests with no token, and anything else in the bundle using
// axios got this app's auth behaviour whether it wanted it or not. A dedicated instance
// makes both interceptors a property of THIS client, not of import order.
//
// MODULE SCOPE touches `window` (the origin) — so, unlike session.js, this file must
// never be imported by test/helpers.test.js, which runs without a DOM.
import axios from 'axios'
import { endSession, getSession, setServerLogout } from './session'

// Always the current origin's /api: nginx (and Vite's dev proxy) forward it.
export const API_BASE = `${window.location.origin}/api`

export const api = axios.create()

// SEC-14: the session is an HttpOnly COOKIE the browser attaches by itself (same origin).
// This interceptor no longer builds an Authorization header at all -- the page cannot read
// the credential, which is the point. What it adds is the CSRF header the server requires
// on every cookie-authenticated request (sign-off condition 13), on OUR API only: never
// sent to another host, and the trailing slash keeps the SPA's own /api-docs route out.
// test/runtime.test.js pins that nothing else sets it.
const isOwnApi = (url) => url.startsWith(`${API_BASE}/`) || url.startsWith('/api/')
api.interceptors.request.use((config) => {
  try {
    if (isOwnApi(config.url || '')) {
      config.headers = config.headers || {}
      config.headers['X-Requested-With'] = 'GameTracker'
    }
  } catch { /* never let header wiring break a request */ }
  return config
})

// A 401 means the server no longer accepts our session (expired, revoked, secret rotated).
// It is THIS interceptor's alone (P0-6): end the session through endSession and go to the
// login page. The server answers 401 ONLY for a missing or invalid credential (UP-18) and a
// missing CSRF header is a 403, so this never signs someone out for anything else.
//
// Only while a session EXISTS in memory: the boot probe and the post-login probe expect a
// 401 as an answer ("nobody is signed in", "the browser refused the cookie") and pass
// `skipSessionEnd`, as does the logout call itself -- or a 401 from logout would call
// endSession, which calls logout (condition 13).
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401 && !err?.config?.skipSessionEnd && getSession()) {
      const onLogin = window.location.pathname.startsWith('/login')
      // Tells the login page why it is showing (the reload wipes React state).
      endSession({ explain: !onLogin, fromPath: window.location.pathname })
      if (!onLogin) {
        window.location.assign('/login')
      }
    }
    return Promise.reject(err)
  },
)

// What the server says about the current session: GET /api/auth/session. Resolves to the
// view, or rejects with the axios error (401 = nobody signed in; anything else = the
// server could not answer, which the caller must NOT treat as signed out).
export const probeSession = () =>
  api.get(`${API_BASE}/auth/session`, { skipSessionEnd: true }).then((res) => res.data.session)

// Clears the HttpOnly cookie, which only the server can. Registered with session.js so
// endSession() -- the one way a session ends -- does it every time, best-effort.
export const serverLogout = () =>
  api.post(`${API_BASE}/auth/logout`, null, { skipSessionEnd: true }).catch(() => {})
setServerLogout(serverLogout)
