package com.example.gmaetrackermobile

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import javax.crypto.Cipher

/**
 * A BiometricPrompt that always authenticates a CryptoObject (MOB-6). Created once, while the
 * activity or fragment is being set up (BiometricPrompt must exist before it is resumed);
 * each [authenticate] call says what to do with that one result.
 */
class CryptoPrompt private constructor(build: (BiometricPrompt.AuthenticationCallback) -> BiometricPrompt) {
    private var onSuccess: ((Cipher) -> Unit)? = null
    private var onFailure: ((CharSequence) -> Unit)? = null

    private val prompt: BiometricPrompt = build(object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            val ok = onSuccess
            val fail = onFailure
            clear()
            // No cipher means the prompt was not bound to the key: never treat it as unlocked.
            val cipher = result.cryptoObject?.cipher
            if (cipher != null) ok?.invoke(cipher) else fail?.invoke("Fingerprint check failed.")
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            val fail = onFailure
            clear()
            fail?.invoke(errString)
        }
        // onAuthenticationFailed (a finger not recognised): the prompt stays up and says so.
    })

    fun authenticate(info: BiometricPrompt.PromptInfo, cipher: Cipher, onSuccess: (Cipher) -> Unit, onFailure: (CharSequence) -> Unit) {
        this.onSuccess = onSuccess
        this.onFailure = onFailure
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    private fun clear() {
        onSuccess = null
        onFailure = null
    }

    companion object {
        fun forActivity(activity: FragmentActivity) =
            CryptoPrompt { BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), it) }

        fun forFragment(fragment: Fragment) =
            CryptoPrompt { BiometricPrompt(fragment, ContextCompat.getMainExecutor(fragment.requireContext()), it) }

        fun info(title: String, subtitle: String): BiometricPrompt.PromptInfo =
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setNegativeButtonText("Use password")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .build()
    }
}

/**
 * Fingerprint unlock (MOB-6): the session token sealed with a biometric-bound Keystore key.
 * The ONE place that turns it on, off, and uses it. LoginActivity, ProfileFragment and
 * SettingsActivity call these; none of them touches the key or the sealed copy directly.
 *
 * Any fingerprint enrolled on the phone opens the app: that is how Android biometrics work,
 * and the UI says so when the feature is turned on.
 */
object FingerprintUnlock {
    private const val PREF_ENABLED = "fingerprint_enabled"

    const val ENABLED_TEXT = "Fingerprint unlock on. Any fingerprint enrolled on this phone can open the app."
    const val KEY_CHANGED_TEXT = "Fingerprints on this phone changed, so fingerprint unlock was turned off. " +
        "Sign in with your password, then turn it on again in Profile."

    sealed class Result {
        object Done : Result()
        /** The user cancelled or the prompt failed; [message] is the system's reason. */
        class Cancelled(val message: CharSequence) : Result()
        /** Not possible right now (no session, no biometric, Keystore refused). */
        class Unavailable(val message: String) : Result()
        /** The key is gone (fingerprints changed): unlock was turned off. */
        object KeyInvalidated : Result()
    }

    fun isOn(context: Context): Boolean =
        context.getSharedPreferences(SessionStore.PREFS, Context.MODE_PRIVATE).getBoolean(PREF_ENABLED, false)

    private fun setOn(context: Context, on: Boolean) {
        context.getSharedPreferences(SessionStore.PREFS, Context.MODE_PRIVATE).edit().putBoolean(PREF_ENABLED, on).apply()
    }

    fun canUse(context: Context): Boolean =
        BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    /** Turns it off: the flag and the sealed copy go. The in-memory session is untouched. */
    fun disable(context: Context) {
        setOn(context, false)
        Session.get(context).dropSealed()
    }

    /**
     * Seals the CURRENT session token behind the fingerprint and turns unlock on. Needs a
     * session in memory: you can only turn it on while signed in. Anything but [Result.Done]
     * leaves it off.
     */
    fun enable(context: Context, prompt: CryptoPrompt, done: (Result) -> Unit) {
        val session = Session.get(context)
        val token = session.token
        if (token == null || !session.hasLiveToken(skewSeconds = 0)) {
            done(Result.Unavailable("Sign in again to turn on fingerprint unlock."))
            return
        }
        if (!canUse(context)) {
            done(Result.Unavailable("Add a fingerprint in the phone's settings first."))
            return
        }
        when (val c = TokenVault.encryptCipher()) {
            is TokenVault.CipherResult.Ready -> prompt.authenticate(
                CryptoPrompt.info("Turn on fingerprint unlock", "Confirm your fingerprint"),
                c.cipher,
                onSuccess = { cipher ->
                    val stored = try {
                        session.storeSealed(TokenVault.seal(cipher, token), forToken = token)
                    } catch (e: Exception) {
                        false
                    }
                    if (stored) {
                        setOn(context, true)
                        done(Result.Done)
                    } else {
                        disable(context)
                        done(Result.Unavailable("Couldn't turn on fingerprint unlock. Try again."))
                    }
                },
                onFailure = { message ->
                    disable(context)
                    done(Result.Cancelled(message))
                },
            )
            else -> {
                disable(context)
                done(Result.Unavailable("Fingerprint unlock isn't available on this phone right now."))
            }
        }
    }

    /**
     * Opens the sealed token with the fingerprint and makes it the session again. Only the
     * successful prompt can decrypt it. [Result.Done] means the session is in memory; the
     * caller still asks the server whether it works.
     */
    fun unlock(context: Context, prompt: CryptoPrompt, done: (Result) -> Unit) {
        val session = Session.get(context)
        val sealed = session.sealed()
        if (sealed == null) {
            done(Result.Unavailable("No saved session. Sign in with your password."))
            return
        }
        when (val c = TokenVault.decryptCipher(sealed)) {
            is TokenVault.CipherResult.Ready -> prompt.authenticate(
                CryptoPrompt.info("Unlock GameTracker", "Use your fingerprint to continue your session"),
                c.cipher,
                onSuccess = { cipher ->
                    val token = try { TokenVault.open(cipher, sealed) } catch (e: Exception) { null }
                    if (token != null && session.unseal(token)) {
                        done(Result.Done)
                    } else {
                        // Tampered with, or not the session it claims to be: never try it again.
                        session.dropSealed()
                        done(Result.Unavailable("Your saved session couldn't be opened. Sign in with your password."))
                    }
                },
                onFailure = { message -> done(Result.Cancelled(message)) },
            )
            TokenVault.CipherResult.Invalidated -> {
                disable(context)
                done(Result.KeyInvalidated)
            }
            is TokenVault.CipherResult.Unavailable ->
                done(Result.Unavailable("Fingerprint unlock isn't available right now. Sign in with your password."))
        }
    }
}
