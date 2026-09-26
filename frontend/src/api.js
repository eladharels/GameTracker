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
import { endSession } from './session'

// Always the current origin's /api: nginx (and Vite's dev proxy) forward it.
export const API_BASE = `${window.location.origin}/api`

export const api = axios.create()

// Attach the stored JWT to requests for OUR API only, so the call sites never build an
// Authorization header themselves (test/runtime.test.js pins that nothing else does).
// Same-origin /api/ only — never leak the token to another host, and the trailing slash
// keeps the SPA's own /api-docs route out.
api.interceptors.request.use((config) => {
  try {
    const url = config.url || ''
    const isOwnApi = url.startsWith(`${API_BASE}/`) || url.startsWith('/api/')
    if (isOwnApi) {
      const token = localStorage.getItem('token')
      if (token) {
        config.headers = config.headers || {}
        if (!config.headers.Authorization) {
          config.headers.Authorization = `Bearer ${token}`
        }
      }
    }
  } catch { /* never let header wiring break a request */ }
  return config
})

// A 401 means the server no longer accepts our credential (expired, revoked, secret
// rotated). It is THIS interceptor's alone (P0-6): drop the token through endSession and
// go to the login page, rather than leave the app half signed-in. A page must never
// handle a 401 itself, and the server answers 401 ONLY for a missing or invalid
// credential (pinned server-side, UP-18) — so this never signs someone out for a typo.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401 && localStorage.getItem('token')) {
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
