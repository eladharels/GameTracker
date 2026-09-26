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

// Milliseconds until the session expires (0 when it already has), for scheduling the
// logout while the app is open. null when there is no valid session.
export function msUntilExpiry(token, nowMs = Date.now()) {
  const payload = readSession(token, nowMs)
  return payload ? Math.max(0, payload.exp * 1000 - nowMs) : null
}
