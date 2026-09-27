package com.example.gmaetrackermobile

import android.content.Context
import kotlinx.coroutines.flow.MutableSharedFlow

/**
 * The few preference operations the session needs. An interface so the JVM unit tests can
 * back it with a map instead of Android's SharedPreferences.
 */
interface KeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
    fun remove(key: String)
}

class SharedPrefsStore(context: Context) : KeyValueStore {
    private val prefs = context.getSharedPreferences(SessionStore.PREFS, Context.MODE_PRIVATE)
    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun putString(key: String, value: String) { prefs.edit().putString(key, value).apply() }
    override fun remove(key: String) { prefs.edit().remove(key).apply() }
}

/**
 * The signed-in session: the backend's 12-hour JWT and whose it is.
 *
 * Rules (mobile/ROADMAP.md MOB-3, MOB-5):
 *  - Ending a session removes the TOKEN only. The username stays, so the login form can be
 *    prefilled and a different user signing in still turns biometrics off for the old one.
 *  - A token is "live" only while its own `exp` is in the future (with clock skew). The
 *    fingerprint unlocks a live session; it never resurrects an expired one.
 *  - A 401 ends the session only when it answered the token that is stored NOW. A late 401
 *    from a request sent with an older token must not sign out a fresh login, and the login
 *    request itself carries no Authorization header at all.
 *
 * NOT a security boundary: the token is plaintext in SharedPreferences and the fingerprint
 * is a UI gate (MOB-6 records the Keystore-bound fix).
 */
class SessionStore(
    private val kv: KeyValueStore,
    private val nowSeconds: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    val token: String? get() = kv.getString(KEY_TOKEN)
    val username: String? get() = kv.getString(KEY_USERNAME)

    fun bearer(): String? = token?.let { "Bearer $it" }

    fun save(token: String, username: String) {
        kv.putString(KEY_TOKEN, token)
        kv.putString(KEY_USERNAME, username)
    }

    /** Sign out: the token goes, the username and the biometric preference stay. */
    fun endSession() = kv.remove(KEY_TOKEN)

    fun hasLiveToken(skewSeconds: Long = CLOCK_SKEW_SECONDS): Boolean {
        val exp = token?.let { jwtExpiry(it) } ?: return false
        return exp > nowSeconds() + skewSeconds
    }

    /**
     * Ends the session if [authorization] is exactly the stored bearer, and says whether it
     * did. Synchronized, and the first caller removes the token, so a burst of 401s from one
     * expired session ends it exactly once.
     */
    @Synchronized
    fun clearIfCurrent(authorization: String?): Boolean {
        val current = bearer() ?: return false
        if (authorization == null || authorization != current) return false
        endSession()
        return true
    }

    companion object {
        const val PREFS = "auth"
        const val KEY_TOKEN = "token"
        const val KEY_USERNAME = "username"
        const val CLOCK_SKEW_SECONDS = 60L

        private const val B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

        /** The `exp` claim of a JWT, or null. DECODES only: the server verifies. */
        fun jwtExpiry(token: String): Long? {
            val parts = token.split('.')
            if (parts.size != 3) return null
            val payload = base64UrlDecode(parts[1]) ?: return null
            return Regex("\"exp\"\\s*:\\s*(\\d+)").find(payload)?.groupValues?.get(1)?.toLongOrNull()
        }

        // Hand-rolled: java.util.Base64 needs API 26 and minSdk is 24, and android.util.Base64
        // is not available to JVM unit tests.
        internal fun base64UrlDecode(input: String): String? {
            val out = java.io.ByteArrayOutputStream()
            var buffer = 0
            var bits = 0
            for (c in input.trimEnd('=')) {
                val v = B64URL.indexOf(c)
                if (v < 0) return null
                buffer = (buffer shl 6) or v
                bits += 6
                if (bits >= 8) {
                    bits -= 8
                    out.write((buffer shr bits) and 0xFF)
                    buffer = buffer and ((1 shl bits) - 1)
                }
            }
            return String(out.toByteArray(), Charsets.UTF_8)
        }
    }
}

/** The one SessionStore per process, and the "session ended" signal. */
object Session {
    @Volatile private var store: SessionStore? = null

    fun get(context: Context): SessionStore =
        store ?: synchronized(this) {
            store ?: SessionStore(SharedPrefsStore(context.applicationContext)).also { store = it }
        }

    /**
     * Emitted when a request found the session expired. The VISIBLE activity handles it:
     * starting an activity from OkHttp's thread is dropped by Android 10+'s background
     * activity-start rules, and ApiClient holds no Activity.
     */
    val ended = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** True between a session ending and the login screen showing; mutes error snackbars. */
    @Volatile var redirecting = false
}
