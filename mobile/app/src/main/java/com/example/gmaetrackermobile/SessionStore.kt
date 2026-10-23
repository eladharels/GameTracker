package com.example.gmaetrackermobile

import android.content.Context
import kotlinx.coroutines.flow.MutableSharedFlow

/**
 * The few preference operations the session needs. An interface so the JVM unit tests can
 * back it with a map instead of Android's SharedPreferences.
 */
interface KeyValueStore {
    fun getString(key: String): String?
    /** All of [values] in one write, so no reader sees some of them without the rest. */
    fun putStrings(values: Map<String, String>)
    fun remove(key: String)
}

class SharedPrefsStore(context: Context) : KeyValueStore {
    private val prefs = context.getSharedPreferences(SessionStore.PREFS, Context.MODE_PRIVATE)
    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun putStrings(values: Map<String, String>) {
        prefs.edit().apply { values.forEach { (k, v) -> putString(k, v) } }.apply()
    }
    override fun remove(key: String) { prefs.edit().remove(key).apply() }
}

/** A token encrypted by [TokenVault]: base64 ciphertext and IV. Neither is a secret. */
data class SealedToken(val ciphertext: String, val iv: String)

/**
 * The signed-in session: the backend's 12-hour JWT and whose it is.
 *
 * Rules (mobile/ROADMAP.md MOB-3, MOB-5, MOB-6):
 *  - The token is never written to disk in the clear. It lives in this process's memory.
 *    With fingerprint unlock on, a copy is kept SEALED: encrypted by a Keystore key that
 *    only a successful BiometricPrompt can use (TokenVault). Without it, nothing survives
 *    the process: a cold start asks for the password.
 *  - Ending a session removes the token and its sealed copy. The username stays, so the
 *    login form can be prefilled and a different user signing in still turns biometrics off
 *    for the old one.
 *  - A token is "live" only while its own `exp` is in the future (with clock skew). The
 *    fingerprint unlocks a live session; it never resurrects an expired one.
 *  - A 401 ends the session only when it answered the token held NOW. A late 401 from a
 *    request sent with an older token must not sign out a fresh login, and the login request
 *    itself carries no Authorization header at all.
 */
class SessionStore(
    private val kv: KeyValueStore,
    private val nowSeconds: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    @Volatile private var memToken: String? = null

    val token: String? get() = memToken
    val username: String? get() = kv.getString(KEY_USERNAME)

    fun bearer(): String? = token?.let { "Bearer $it" }

    /**
     * Before MOB-6 the token was stored in the clear under [KEY_LEGACY_TOKEN]. It is deleted
     * from disk here, once, and kept in memory, so an update does not sign anyone out of the
     * running session. Returns whether there was one.
     */
    @Synchronized
    fun migrateLegacyToken(): Boolean {
        val legacy = kv.getString(KEY_LEGACY_TOKEN) ?: return false
        kv.remove(KEY_LEGACY_TOKEN)
        if (memToken == null) memToken = legacy
        return true
    }

    /**
     * A fresh sign-in. Synchronized with [clearIfCurrent]: otherwise its check and its removal
     * could straddle a save, and a 401 answering the OLD token would remove the NEW one. Any
     * sealed copy belongs to the previous token, so it goes.
     */
    @Synchronized
    fun save(token: String, username: String) {
        memToken = token
        kv.putStrings(mapOf(KEY_USERNAME to username))
        dropSealed()
    }

    /**
     * Stores [sealed] as the persistent copy of [forToken], only if that is still the token
     * held now (a sign-in could have replaced it while the prompt was up). Its `exp` is kept
     * beside it in the clear, so the login screen can decide whether to offer the fingerprint
     * without decrypting anything.
     */
    @Synchronized
    fun storeSealed(sealed: SealedToken, forToken: String): Boolean {
        if (forToken != memToken) return false
        val exp = jwtExpiry(forToken) ?: return false
        kv.putStrings(mapOf(KEY_SEALED to sealed.ciphertext, KEY_SEALED_IV to sealed.iv, KEY_SEALED_EXP to exp.toString()))
        return true
    }

    fun sealed(): SealedToken? {
        val ct = kv.getString(KEY_SEALED) ?: return null
        val iv = kv.getString(KEY_SEALED_IV) ?: return null
        return SealedToken(ct, iv)
    }

    /** A sealed copy exists and the token inside it is still live: worth a fingerprint. */
    fun hasSealedLiveSession(skewSeconds: Long = CLOCK_SKEW_SECONDS): Boolean {
        if (sealed() == null) return false
        val exp = kv.getString(KEY_SEALED_EXP)?.toLongOrNull() ?: return false
        return exp > nowSeconds() + skewSeconds
    }

    /**
     * The token a successful fingerprint decrypted. Refused unless it is the token the sealed
     * copy was stored for (its `exp` matches) and still live, so a corrupted or swapped blob
     * cannot become the session.
     */
    @Synchronized
    fun unseal(token: String): Boolean {
        val exp = jwtExpiry(token) ?: return false
        if (kv.getString(KEY_SEALED_EXP) != exp.toString()) return false
        if (exp <= nowSeconds()) return false
        memToken = token
        return true
    }

    /** Fingerprint unlock turned off, or its key is gone: no persistent copy any more. */
    @Synchronized
    fun dropSealed() {
        kv.remove(KEY_SEALED)
        kv.remove(KEY_SEALED_IV)
        kv.remove(KEY_SEALED_EXP)
    }

    /** Sign out: the token and its sealed copy go; the username and the biometric preference stay. */
    @Synchronized
    fun endSession() {
        memToken = null
        dropSealed()
        kv.remove(KEY_LEGACY_TOKEN)
    }

    /**
     * Whether the token held IN MEMORY is live. [skewSeconds] defaults to a minute so a token
     * about to die is not used to start anything; MainActivity.onResume passes 0, where the
     * question is only "has it ALREADY expired", and the server's 401 settles anything closer.
     */
    fun hasLiveToken(skewSeconds: Long = CLOCK_SKEW_SECONDS): Boolean {
        val exp = token?.let { jwtExpiry(it) } ?: return false
        return exp > nowSeconds() + skewSeconds
    }

    /**
     * Ends the session if [authorization] is exactly the current bearer, and says whether it
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
        /** Where the token was kept IN THE CLEAR before MOB-6. Only ever read to delete it. */
        const val KEY_LEGACY_TOKEN = "token"
        const val KEY_USERNAME = "username"
        const val KEY_SEALED = "token_sealed_v1"
        const val KEY_SEALED_IV = "token_sealed_iv_v1"
        const val KEY_SEALED_EXP = "token_sealed_exp_v1"
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
            store ?: SessionStore(SharedPrefsStore(context.applicationContext))
                .also { it.migrateLegacyToken(); store = it }
        }

    /**
     * Emitted when a request found the session expired. The VISIBLE activity handles it:
     * starting an activity from OkHttp's thread is dropped by Android 10+'s background
     * activity-start rules, and ApiClient holds no Activity.
     *
     * No replay: an emit with nobody collecting is DROPPED, while [redirecting] stays true and
     * mutes error snackbars. Today MainActivity collects it while STARTED and re-checks the
     * session in onResume (showing the expiry notice when [redirecting] is set), and the only
     * other activity, Settings, makes no API calls. A new activity that calls the API must
     * collect this flow or re-check the session on resume.
     */
    val ended = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** True between a session ending and the login screen showing; mutes error snackbars. */
    @Volatile var redirecting = false
}
