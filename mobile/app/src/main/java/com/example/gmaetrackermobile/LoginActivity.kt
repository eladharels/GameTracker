package com.example.gmaetrackermobile

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.content.Intent
import com.example.gmaetrackermobile.MainActivity
import com.example.gmaetrackermobile.ThemeManager
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope

class LoginActivity : AppCompatActivity() {
    // Created in onCreate: a BiometricPrompt must exist before the activity is resumed.
    private lateinit var cryptoPrompt: CryptoPrompt
    private lateinit var btnFingerprint: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Apply the user's chosen accent theme overlay BEFORE view inflation (after super so
        // AppCompat is initialised, but before setContentView so views pick up the colours)
        theme.applyStyle(ThemeManager.getThemeResId(this), true)
        setContentView(R.layout.activity_login)

        val etUsername = findViewById<EditText>(R.id.etUsername)
        val etPassword = findViewById<EditText>(R.id.etPassword)
        val btnLogin = findViewById<Button>(R.id.btnLogin)
        val tvLoginStatus = findViewById<TextView>(R.id.tvLoginStatus)
        // After a dismissed prompt: a way back to the fingerprint without restarting the app.
        btnFingerprint = findViewById(R.id.btnBiometric)
        btnFingerprint.text = "Unlock with fingerprint"
        btnFingerprint.setOnClickListener { unlockWithFingerprint(tvLoginStatus) }

        val session = Session.get(this)
        cryptoPrompt = CryptoPrompt.forActivity(this)
        Session.redirecting = false
        errorColor = tvLoginStatus.currentTextColor

        // Signing out keeps the username (MOB-3): prefill it.
        session.username?.let { if (etUsername.text.isNullOrEmpty()) etUsername.setText(it) }

        // Arrived here because the session expired (a boolean extra, never text: this activity
        // is exported, and any app could otherwise put its own words on the login screen).
        val sessionEnded = intent.getBooleanExtra(EXTRA_SESSION_ENDED, false)
        if (sessionEnded) notice(tvLoginStatus, SESSION_EXPIRED_TEXT)

        // MOB-6: the fingerprint DECRYPTS the session (TokenVault); it is no longer a UI gate.
        // Offered only for a LIVE sealed session: it cannot bring back an expired or
        // signed-out one, and prompting anyway would end in "no saved login" after the user
        // had already touched the sensor.
        if (!sessionEnded && FingerprintUnlock.isOn(this) && FingerprintUnlock.canUse(this)) {
            if (session.hasSealedLiveSession()) {
                unlockWithFingerprint(tvLoginStatus)
            } else if (session.hasLiveToken()) {
                // Updated from a version that kept the token in the clear: it was moved into
                // memory (SessionStore.migrateLegacyToken). Seal it now, once. This prompt is
                // the way in, so cancelling it must not let the old token through.
                FingerprintUnlock.enable(this, cryptoPrompt, FingerprintUnlock.KEEP_ON_PROMPT) { result ->
                    if (result == FingerprintUnlock.Result.Done) {
                        verifyAndEnter(tvLoginStatus)
                    } else {
                        session.endSession()
                        notice(tvLoginStatus, "Sign in with your password to continue.")
                    }
                }
            }
        }

        btnLogin.setOnClickListener {
            val username = etUsername.text.toString()
            val password = etPassword.text.toString()
            tvLoginStatus.setTextColor(errorColor)
            tvLoginStatus.text = ""

            // Client-side validation to prevent empty credentials
            if (username.trim().isEmpty() || password.trim().isEmpty()) {
                tvLoginStatus.text = "Username and password are required"
                return@setOnClickListener
            }

            // Disable button and show loading state
            btnLogin.isEnabled = false
            btnLogin.text = "Logging in..."
            tvLoginStatus.text = ""

            // Normalize username to lowercase to prevent case sensitivity issues
            val normalizedUsername = username.lowercase()

            // Tied to this screen: a result arriving after it is gone is dropped, not acted on.
            lifecycleScope.launch(Dispatchers.IO) {
                try {
                    val response = ApiClient.api.login(LoginRequest(normalizedUsername, password))
                    withContext(Dispatchers.Main) {
                        // Re-enable button
                        btnLogin.isEnabled = true
                        btnLogin.text = "Login"
                        
                        if (response.isSuccessful && response.body() != null) {
                            val token = response.body()!!.token
                            // If username or password changed, disable biometrics
                            val oldUsername = session.username
                            if (oldUsername != null && oldUsername != normalizedUsername) {
                                FingerprintUnlock.disable(this@LoginActivity)
                            }
                            session.save(token, normalizedUsername)
                            tvLoginStatus.text = "Login successful!"
                            // A new token: with fingerprint unlock on, seal it (one prompt)
                            // so the next start can unlock it. Then go in either way.
                            if (FingerprintUnlock.isOn(this@LoginActivity)) {
                                sealThen { enterApp(offline = false) }
                            } else {
                                enterApp(offline = false)
                            }
                        } else {
                            val errorBody = response.errorBody()?.string() ?: response.message()
                            tvLoginStatus.text = "Login failed: $errorBody"
                        }
                    }
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) {
                        // Re-enable button
                        btnLogin.isEnabled = true
                        btnLogin.text = "Login"
                        tvLoginStatus.text = "Error: ${e.localizedMessage}"
                    }
                }
            }
        }
    }

    private var errorColor: Int = 0

    private fun unlockWithFingerprint(status: TextView) {
        btnFingerprint.visibility = View.GONE
        FingerprintUnlock.unlock(this, cryptoPrompt) { result -> afterUnlock(result, status) }
    }

    private fun afterUnlock(result: FingerprintUnlock.Result, status: TextView) {
        when (result) {
            FingerprintUnlock.Result.Done -> verifyAndEnter(status)
            FingerprintUnlock.Result.KeyInvalidated -> notice(status, FingerprintUnlock.KEY_CHANGED_TEXT)
            is FingerprintUnlock.Result.Cancelled -> {
                // A lockout or sensor fault is the system's to explain; only a dismissal is ours.
                notice(status, if (result.byUser) "Sign in with your password, or use your fingerprint." else result.message.toString())
                if (Session.get(this).hasSealedLiveSession()) btnFingerprint.visibility = View.VISIBLE
            }
            is FingerprintUnlock.Result.Unavailable -> notice(status, result.message)
        }
    }

    /**
     * Seals the session just made behind the fingerprint. If that does not happen (cancelled,
     * or not possible), fingerprint unlock is OFF and the user is told where to turn it on:
     * a flag that says "on" with nothing sealed would quietly ask for the password next time.
     */
    private fun sealThen(next: () -> Unit) {
        FingerprintUnlock.enable(this, cryptoPrompt, FingerprintUnlock.KEEP_ON_PROMPT) { result ->
            if (result != FingerprintUnlock.Result.Done) {
                Toast.makeText(this, "Fingerprint unlock is off. Turn it on again in Profile.", Toast.LENGTH_LONG).show()
            }
            next()
        }
    }

    private fun notice(status: TextView, text: String) {
        status.setTextColor(ContextCompat.getColor(this, R.color.gt_text_secondary))
        status.text = text
    }

    /**
     * After the fingerprint: ask the server whether the stored session still works, then go in.
     * A 401 means it has ended (the interceptor has already cleared it). A network failure is
     * NOT a sign-out: the user goes in and is told they are offline.
     */
    private fun verifyAndEnter(status: TextView) {
        val session = Session.get(this)
        val bearer = session.bearer()
        if (bearer == null || !session.hasLiveToken()) {
            session.endSession()
            notice(status, SESSION_EXPIRED_TEXT)
            return
        }
        notice(status, "Checking session…")
        lifecycleScope.launch {
            val code: Int? = try {
                withContext(Dispatchers.IO) { ApiClient.api.getMe(bearer).code() }
            } catch (e: java.io.IOException) {
                null
            }
            when (code) {
                null -> enterApp(offline = true)
                401 -> {
                    // Only if it is still the token that was checked: the user may have signed
                    // in with the password while the check was in flight.
                    session.clearIfCurrent(bearer)
                    Session.redirecting = false
                    notice(status, SESSION_EXPIRED_TEXT)
                }
                else -> enterApp(offline = false)
            }
        }
    }

    private fun enterApp(offline: Boolean) {
        Session.redirecting = false
        startActivity(Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OFFLINE, offline))
        finish()
    }

    companion object {
        const val EXTRA_SESSION_ENDED = "session_ended"
        const val SESSION_EXPIRED_TEXT = "Your session expired. Please sign in again."
    }
}
