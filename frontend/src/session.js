// The browser session, client side (ROADMAP SEC-14; SEC-7, FE-12, FE-14, FE-17).
//
// The credential is an HttpOnly cookie the page CANNOT read -- that is the point of SEC-14:
// a token in localStorage was readable by any script that ever ran in the origin. So
// nothing here decodes a JWT any more. What the page knows about the session comes from
// the SERVER (GET /api/auth/session): who is signed in, their privilege as re-read from the
// database, and `expiresIn` by the server's clock, so a device whose clock is wrong no
// longer reads a fresh session as expired.
//
// ONE in-memory store. App.jsx, the login page and the pages that need the username all
// read it here; nothing keeps its own copy (sign-off condition 14).
//
// No DOM or storage at MODULE scope: test/helpers.test.js imports this file.

// App.jsx mirrors this in React state to trigger renders, and sets BOTH together (the boot
// probe, sign-in, every endSession caller); nothing else keeps a copy.
let current = null

// The session as the server described it, plus when this tab learned of it, so the
// expiry is computed from the server's `expiresIn` rather than this device's clock.
export function sessionFromView(view, nowMs = Date.now()) {
  if (!view || typeof view.username !== 'string' || !view.username) return null
  const expiresIn = Number(view.expiresIn)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null
  return {
    username: view.username,
    can_manage_users: !!view.can_manage_users,
    origin: view.origin || 'local',
    display_name: view.display_name || view.username,
    exp: view.exp,
    expiresAtMs: nowMs + expiresIn * 1000,
    // false only when the server runs with SESSION_COOKIE_INSECURE=1 (System Status warns).
    cookieSecure: view.cookieSecure !== false,
  }
}

export const getSession = () => current

export function setSession(session) {
  current = session || null
  return current
}

// Milliseconds until the session expires (0 once it has), or null with no session.
export function msUntilExpiry(session = current, nowMs = Date.now()) {
  if (!session || typeof session.expiresAtMs !== 'number') return null
  return Math.max(0, session.expiresAtMs - nowMs)
}

// ── The hint (condition 14) ─────────────────────────────────────────────────────────
// {username, exp} in localStorage, NEVER the credential. It lets the app tell, at boot,
// "a session existed and has expired" (the ended notice, FE-14's return path) from "nobody
// was signed in" -- which the cookie, being unreadable, cannot say.
const HINT_KEY = 'session_hint'

export function writeHint(session) {
  try {
    if (!session) { localStorage.removeItem(HINT_KEY); return }
    localStorage.setItem(HINT_KEY, JSON.stringify({ username: session.username, exp: session.exp }))
  } catch { /* storage unavailable: only the notices are lost */ }
}

// Re-validated on read: localStorage is writable by anything running in the origin.
export function readHint() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HINT_KEY) || 'null')
    if (!parsed || typeof parsed.username !== 'string' || !parsed.username) return null
    return { username: parsed.username.toLowerCase(), exp: typeof parsed.exp === 'number' ? parsed.exp : null }
  } catch {
    return null
  }
}

// ── The legacy token (condition 14) ────────────────────────────────────────────────
// Before SEC-14 the JWT itself lived in localStorage under `token`. It is deleted at boot,
// HERE and nowhere else (pinned), and the caller shows a one-time "sign-in has been
// updated" line. Returns whether one was there.
export function dropLegacyToken() {
  try {
    const had = localStorage.getItem('token') !== null
    localStorage.removeItem('token')
    return had
  } catch {
    return false
  }
}

// The one-time line the login page shows after dropLegacyToken removed an old session:
// a neutral "sign-in has been updated", NOT the "session ended" notice -- nothing went
// wrong, the storage changed. sessionStorage, read then cleared like the ended notice.
const UPDATED_KEY = 'signin_updated'
export function markSignInUpdated() {
  try { sessionStorage.setItem(UPDATED_KEY, '1') } catch { /* the notice is only a courtesy */ }
}
export function peekSignInUpdated() {
  try { return sessionStorage.getItem(UPDATED_KEY) === '1' } catch { return false }
}
export function clearSignInUpdated() {
  try { sessionStorage.removeItem(UPDATED_KEY) } catch { /* nothing to clear */ }
}

// ── Other tabs (condition 18) ──────────────────────────────────────────────────────
// A sign-in or sign-out in one tab is announced to the others, which re-ask the server.
// Created on first use, never at module scope.
const CHANNEL = 'gametracker-session'
let channel = null
function getChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return channel
  try { channel = new BroadcastChannel(CHANNEL) } catch { channel = null }
  return channel
}

export function announceSession(type, username = null) {
  try { getChannel()?.postMessage({ type, username }) } catch { /* no other tabs to tell */ }
}

export function onSessionAnnounced(fn) {
  const ch = getChannel()
  if (!ch) return () => {}
  const handler = (event) => {
    const d = event && event.data
    if (d && (d.type === 'login' || d.type === 'logout')) fn(d)
  }
  ch.addEventListener('message', handler)
  return () => ch.removeEventListener('message', handler)
}

// ── Why the login page is showing (UI/UX review of SEC-7) ───────────────────────────
// A session that ENDS — expired while the app was open, found expired at boot, or
// refused by the server — must not look like a random logout: an unexplained state
// change is read as data loss here (see CLAUDE.md on the "my games were deleted"
// report). The ending path records why, and where the user was; the login page reads
// it once. sessionStorage, because the 401 path reloads the page and would wipe any
// React state or toast. A MANUAL logout records nothing.

const END_KEY = 'session_end'

// An in-app path worth returning to after login, or null. Only a same-origin absolute
// path: not protocol-relative (`//host`, `/\host` — browsers treat `\` as `/`), not the
// login page itself, nothing with control characters.
export function safeReturnPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  if (path.startsWith('//') || path.includes('\\')) return null
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return null   // control characters
  }
  if (path === '/login' || path.startsWith('/login/') || path.startsWith('/login?')) return null
  return path
}

// `owner`: whose session ended. The return path is theirs; see returnPathFor.
export function markSessionEnded(fromPath, owner = null) {
  try {
    sessionStorage.setItem(END_KEY, JSON.stringify({
      from: safeReturnPath(fromPath),
      owner: typeof owner === 'string' && owner ? owner.toLowerCase() : null,
    }))
  } catch { /* storage unavailable: the redirect still happens, just unexplained */ }
}

// Read WITHOUT clearing — safe inside a render/state initializer. Returns {from, owner}
// or null. The stored value is re-validated: sessionStorage is writable by anything
// running in the origin.
//
// Reading and clearing are separate on purpose: StrictMode renders twice on mount in
// dev and keeps the SECOND render's state, so a read-and-clear in the initializer
// showed nothing under `vite dev` and made the feature look broken. The page reads in
// its initializer and clears in a mount effect.
export function peekSessionEnd() {
  try {
    const raw = sessionStorage.getItem(END_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const owner = parsed && typeof parsed.owner === 'string' && parsed.owner ? parsed.owner : null
    return { from: safeReturnPath(parsed && parsed.from), owner }
  } catch {
    return null
  }
}

// Where to go after `username` signs in, or null for the default page.
//
// The stored path belongs to whoever's session ENDED. On a shared machine the next
// person to sign in is often someone else, and was sent to the previous user's page —
// /user/alice/… for bob is at best an error screen (ROADMAP FE-14). So the path is
// honoured only when the new session is the SAME user; a record with no owner is never
// honoured. The username comes from the SERVER's session answer, not a decoded token.
export function returnPathFor(sessionEnd, username) {
  if (!sessionEnd || !sessionEnd.from || !sessionEnd.owner) return null
  return typeof username === 'string' && username.toLowerCase() === sessionEnd.owner ? sessionEnd.from : null
}

// Clear, so the notice shows once.
export function clearSessionEnd() {
  try { sessionStorage.removeItem(END_KEY) } catch { /* nothing to clear */ }
}

// ── Ending a session: ONE function (ROADMAP FE-17) ─────────────────────────────────
// Every ending -- the 401 interceptor, expiry, sign-out, another tab's sign-out -- comes
// through here, and test/runtime.test.js pins that nothing else ends one.
//
// `explain`: record WHY for the login page (expiry, a refused credential). A manual
// sign-out passes false: nothing went wrong, so the login page must say nothing.
// `announce`: tell other tabs. False when this ending was itself another tab's news.
// `logout`: clear the cookie server-side. False when there is nothing of THIS tab's to clear:
// the boot probe's 401 (no valid cookie), and another tab's sign-out (that tab already
// cleared it). A frozen background tab thawing later must not replay a stale logout and
// clear a NEWER user's cookie (CISO review).
//
// The server-side logout (clearing the HttpOnly cookie, which JS cannot touch) is
// registered by api.js, which owns HTTP. It is best-effort and never throws: a session
// ending must never depend on the network.
let serverLogout = null
export function setServerLogout(fn) { serverLogout = typeof fn === 'function' ? fn : null }

export function endSession({ explain, fromPath, announce = true, logout = true } = {}) {
  // WHO, read before the session goes: the return path is recorded as theirs (FE-14).
  const owner = current?.username?.toLowerCase() || readHint()?.username || null
  setSession(null)
  writeHint(null)
  if (explain) markSessionEnded(fromPath, owner)
  if (announce) announceSession('logout', owner)
  if (!logout) return
  try { const p = serverLogout && serverLogout(); if (p && p.catch) p.catch(() => {}) } catch { /* best effort */ }
}
