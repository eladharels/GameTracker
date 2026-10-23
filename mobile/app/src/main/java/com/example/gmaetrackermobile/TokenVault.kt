package com.example.gmaetrackermobile

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The Keystore key that seals the session token for fingerprint unlock (MOB-6).
 *
 * Before this the token sat in SharedPreferences in the clear and the fingerprint prompt
 * decided nothing: its only effect was a startActivity call. Now:
 *  - The key is AES-256-GCM, generated inside the Android Keystore (StrongBox where the phone
 *    has one) and never leaves it.
 *  - It requires a STRONG biometric for EVERY use (timeout 0), so a Cipher from it works only
 *    inside BiometricPrompt.authenticate(info, CryptoObject(cipher)). A successful prompt is
 *    what produces the token. Nothing else in the app can decrypt it.
 *  - Enrolling a new fingerprint invalidates the key (KeyPermanentlyInvalidatedException):
 *    the sealed token is dropped and the user signs in with the password once.
 *
 * Deliberately NOT EncryptedSharedPreferences / security-crypto: deprecated, and its key is
 * not bound to the biometric, which is the whole point here.
 */
object TokenVault {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "gametracker_session_v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128

    sealed class CipherResult {
        class Ready(val cipher: Cipher) : CipherResult()
        /** The key was invalidated (fingerprints changed) or is gone: the sealed copy is useless. */
        object Invalidated : CipherResult()
        /** The Keystore refused for another reason (no biometric enrolled, hardware fault). */
        class Unavailable(val error: Exception) : CipherResult()
    }

    /** A Cipher to seal a token with, for the prompt to authorise. Replaces an invalidated key. */
    fun encryptCipher(): CipherResult = try {
        CipherResult.Ready(initEncrypt())
    } catch (e: KeyPermanentlyInvalidatedException) {
        deleteKey()
        try { CipherResult.Ready(initEncrypt()) } catch (e2: Exception) { CipherResult.Unavailable(e2) }
    } catch (e: Exception) {
        CipherResult.Unavailable(e)
    }

    /** A Cipher to open [sealed] with, for the prompt to authorise. */
    fun decryptCipher(sealed: SealedToken): CipherResult {
        val key = try { existingKey() } catch (e: Exception) { return CipherResult.Unavailable(e) }
            ?: return CipherResult.Invalidated
        return try {
            val iv = Base64.decode(sealed.iv, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            CipherResult.Ready(cipher)
        } catch (e: KeyPermanentlyInvalidatedException) {
            deleteKey()
            CipherResult.Invalidated
        } catch (e: IllegalArgumentException) {
            CipherResult.Invalidated   // the stored IV is not base64: treat the copy as unusable
        } catch (e: Exception) {
            CipherResult.Unavailable(e)
        }
    }

    /** Seals [token] with a cipher the prompt has just authorised. */
    fun seal(authorised: Cipher, token: String): SealedToken {
        val ciphertext = authorised.doFinal(token.toByteArray(Charsets.UTF_8))
        return SealedToken(
            ciphertext = Base64.encodeToString(ciphertext, Base64.NO_WRAP),
            iv = Base64.encodeToString(authorised.iv, Base64.NO_WRAP),
        )
    }

    /** Opens [sealed] with a cipher the prompt has just authorised. Throws if it was tampered with. */
    fun open(authorised: Cipher, sealed: SealedToken): String =
        String(authorised.doFinal(Base64.decode(sealed.ciphertext, Base64.NO_WRAP)), Charsets.UTF_8)

    fun deleteKey() {
        try { keyStore().deleteEntry(ALIAS) } catch (e: Exception) { /* nothing to delete */ }
    }

    private fun initEncrypt(): Cipher {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: generateKey(strongBox = Build.VERSION.SDK_INT >= 28))
        return cipher
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(ALIAS, null) as? SecretKey

    private fun generateKey(strongBox: Boolean): SecretKey {
        val builder = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= 30) {
            // Every use needs a STRONG biometric; the device PIN alone does not open it.
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            // -1: authentication is required for every use, through a CryptoObject.
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }
        if (strongBox && Build.VERSION.SDK_INT >= 28) builder.setIsStrongBoxBacked(true)
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        return try {
            generator.init(builder.build())
            generator.generateKey()
        } catch (e: ProviderException) {
            // StrongBoxUnavailableException is a ProviderException (named only from API 28).
            if (strongBox) generateKey(strongBox = false) else throw e
        }
    }
}
