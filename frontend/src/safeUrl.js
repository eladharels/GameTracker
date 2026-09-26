// The only way a URL that came from a server response may reach an `href`
// (ROADMAP SEC-8). React escapes text, but an `href` is a navigation sink: a
// `javascript:` value there runs in this origin when clicked, and `script-src 'self'`
// does not stop a javascript: URL a user clicks.
//
// Returns the URL when it is absolute http(s), else null — render no link at all
// rather than a link to something else.
export function safeExternalUrl(value) {
  if (typeof value !== 'string' || !value) return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null   // relative or unparseable: nothing a server response should hand us
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
}
