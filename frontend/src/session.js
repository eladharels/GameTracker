// Reading the session JWT on the client (ROADMAP SEC-7 short-term fix, FE-12).
//
// The token is only ever DECODED here, never verified — the server verifies it on every
// request and re-reads privilege from the database. What the client must not do is keep
// rendering the app on a token the server will refuse: `exp` was never checked, so an
// expired session showed the whole UI until the first request came back 401.
//
// JWT segments are base64URL. The old inline `atob(token.split('.')[1])` decoded them as
// plain base64, which throws on `-` or `_` — a payload that happened to encode to one
// of those read as "logged out" on every page load.

function decodeSegment(segment) {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

// The payload of a still-valid token, or null for a missing, malformed or expired one.
// A token with no numeric `exp` is treated as expired: every token this server issues
// carries one, so its absence means the value is not ours.
export function readSession(token, nowMs = Date.now()) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  let payload
  try {
    payload = decodeSegment(parts[1])
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return null
  return payload
}

// WHO a token names, ignoring `exp` — or null. ONLY for deciding whose return path a
// finished session left behind (ROADMAP FE-14): an EXPIRED token still says whose it was,
// and readSession() deliberately returns nothing for one. Never use this to decide what
// to render or whether someone is signed in; that is readSession()'s job.
export function sessionOwner(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const name = decodeSegment(parts[1])?.username
    return typeof name === 'string' && name ? name.toLowerCase() : null
  } catch {
    return null
  }
}

// Milliseconds until the session expires (0 when it already has), for scheduling the
// logout while the app is open. null when there is no valid session.
export function msUntilExpiry(token, nowMs = Date.now()) {
  const payload = readSession(token, nowMs)
  return payload ? Math.max(0, payload.exp * 1000 - nowMs) : null
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

// Where to go after signing in with `newToken`, or null for the default page.
//
// The stored path belongs to whoever's session ENDED. On a shared machine the next
// person to sign in is often someone else, and was sent to the previous user's page —
// /user/alice/… for bob is at best an error screen (ROADMAP FE-14). So the path is
// honoured only when the new session is the SAME user; a record with no owner (written
// before this change, or from a token that named nobody) is never honoured.
export function returnPathFor(sessionEnd, newToken) {
  if (!sessionEnd || !sessionEnd.from || !sessionEnd.owner) return null
  return sessionOwner(newToken) === sessionEnd.owner ? sessionEnd.from : null
}

// Clear, so the notice shows once.
export function clearSessionEnd() {
  try { sessionStorage.removeItem(END_KEY) } catch { /* nothing to clear */ }
}

// ── Ending a session: ONE function (ROADMAP FE-17) ─────────────────────────────────
// Three places removed the token by hand — the 401 interceptor, the expiry check at boot
// and the logout button — and a fourth, in a page, is how P0-6 happened. They all call
// this now; test/runtime.test.js pins that nothing else touches the token.
//
// `explain`: record WHY for the login page (expiry, a refused credential). A manual
// sign-out passes false: nothing went wrong, so the login page must say nothing.
// Storage is touched only inside the function — helpers.test.js imports this module.
export function endSession({ explain, fromPath } = {}) {
  // WHO, read before the token goes: the return path is recorded as theirs (FE-14).
  let owner = null
  try { owner = sessionOwner(localStorage.getItem('token')) } catch { /* no storage */ }
  try { localStorage.removeItem('token') } catch { /* storage unavailable: nothing to clear */ }
  if (explain) markSessionEnded(fromPath, owner)
}
