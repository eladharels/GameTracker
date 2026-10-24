package ink.etech.gametracker

/**
 * What the sign-in form sends (MOB-34). The username is trimmed and lowercased: an autocorrect
 * trailing space sent "alice " and the sign-in failed. The password is sent exactly as typed and
 * only has to be non-empty: a password of spaces is the server's to accept or refuse.
 */
object LoginInput {
    fun username(raw: String): String = raw.trim().lowercase()

    /** The message to show, or null when the form may be sent. */
    fun problem(rawUsername: String, password: String): String? = when {
        username(rawUsername).isEmpty() && password.isEmpty() -> "Enter your username and password."
        username(rawUsername).isEmpty() -> "Enter your username."
        password.isEmpty() -> "Enter your password."
        else -> null
    }
}
