package com.example.gmaetrackermobile

/**
 * The ONE gate between a server-supplied URL and the network (MOB-8), the app's twin of the
 * web app's `frontend/src/safeUrl.js`. Cover URLs come from three third-party catalogues
 * via the server. On API 24-27 Android permits cleartext by default, so an `http://` cover
 * went out in the clear, and nothing checked the scheme at all.
 *
 * Only `https://` with a host passes. A protocol-relative `//host/...` (how IGDB writes its
 * own image URLs) is read as https. Everything else is refused, and the screen shows its
 * no-cover fallback: `http`, `file`, `content`, `javascript`, `data`, a blank or a bare path.
 * The network security config refuses cleartext as well; this check is what stops the
 * app from even trying.
 */
object SafeUrl {
    private val HTTPS = Regex("^https://[^/?#\\s]+", RegexOption.IGNORE_CASE)

    fun https(url: String?): String? {
        val u = url?.trim().orEmpty()
        if (u.isEmpty() || u.any { it.isWhitespace() || it.code < 0x20 }) return null
        val candidate = if (u.startsWith("//")) "https:$u" else u
        return if (HTTPS.containsMatchIn(candidate)) candidate else null
    }
}
