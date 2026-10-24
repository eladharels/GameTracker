package ink.etech.gametracker

import java.io.IOException

/**
 * What the user reads when something fails (MOB-27). FIXED sentences only: never a server body,
 * never an exception message. Those showed `Login failed: {"error":"Invalid credentials"}` and
 * `Error: Unable to resolve host "gametracker.etech.ink"`, and put host and stack details into
 * screenshots. The server's `{error}` text is for logs at most.
 *
 * Sign-in follows the web's loginErrors.js (FE-4): a lockout (429) or an outage (503, UP-21) must
 * never read as a wrong password, or the user retries a password that may be right.
 */
object ErrorText {
    const val UNREACHABLE = "Can't reach the server. Check your connection and try again."

    /** [code] null: no answer at all (offline, DNS, TLS). [retryAfter]: the header, raw. */
    fun signIn(code: Int?, retryAfter: String? = null): String = when {
        code == null -> UNREACHABLE
        code == 401 -> "Wrong username or password."
        code == 429 -> minutes(retryAfter)?.let {
            "Too many sign-in attempts. Try again in $it ${if (it == 1L) "minute" else "minutes"}."
        } ?: "Too many sign-in attempts. Wait a few minutes and try again."
        // "Not in the required group": admin language the user cannot act on. Say who can.
        code == 403 -> "Your account isn't allowed to sign in to GameTracker. Ask an administrator for access."
        code == 400 -> "Enter your username and password."
        // A few minutes, not "a moment": quick retries during an outage end in a lockout.
        code >= 500 -> "Sign-in is unavailable right now. Try again in a few minutes."
        else -> "Sign-in failed. Try again."
    }

    /** Whole minutes, rounded up, from a Retry-After in seconds; null when absent or a date. */
    fun minutes(retryAfter: String?): Long? {
        val seconds = retryAfter?.trim()?.toLongOrNull()?.takeIf { it > 0 } ?: return null
        return (seconds + 59) / 60
    }

    /** A failed action: [whatFailed] ("Couldn't save the status.") unless the server was unreachable. */
    fun action(e: Throwable, whatFailed: String): String =
        if (e is IOException) UNREACHABLE else "$whatFailed Try again."
}
