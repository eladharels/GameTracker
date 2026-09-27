package com.example.gmaetrackermobile

import android.content.Context
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.content.Intent
import com.example.gmaetrackermobile.MainActivity
import com.example.gmaetrackermobile.ThemeManager
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope

class LoginActivity : AppCompatActivity() {
    private lateinit var biometricPrompt: BiometricPrompt
    private lateinit var promptInfo: BiometricPrompt.PromptInfo

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

        val prefs = getSharedPreferences("auth", Context.MODE_PRIVATE)
        val session = Session.get(this)
        Session.redirecting = false
        errorColor = tvLoginStatus.currentTextColor

        // Signing out keeps the username (MOB-3): prefill it.
        session.username?.let { if (etUsername.text.isNullOrEmpty()) etUsername.setText(it) }

        // Arrived here because the session expired (a boolean extra, never text: this activity
        // is exported, and any app could otherwise put its own words on the login screen).
        val sessionEnded = intent.getBooleanExtra(EXTRA_SESSION_ENDED, false)
        if (sessionEnded) notice(tvLoginStatus, SESSION_EXPIRED_TEXT)

        val biometricManager = BiometricManager.from(this)
        val canAuthenticate = biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        val fingerprintEnabled = prefs.getBoolean("fingerprint_enabled", false)

        // Setup BiometricPrompt
        val executor = ContextCompat.getMainExecutor(this)
        biometricPrompt = BiometricPrompt(this, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    // The fingerprint unlocks a LIVE session; the server still has the last word.
                    verifyAndEnter(tvLoginStatus)
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    // Show login form if authentication is cancelled or fails
                    showError(tvLoginStatus, "Authentication error: $errString")
                }
                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                    showError(tvLoginStatus, "Authentication failed. Try again or login with password.")
                }
            })

        promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock GameTracker")
            .setSubtitle("Use your fingerprint to continue your session")
            .setNegativeButtonText("Cancel")
            .build()

        // Prompt only when there is a LIVE session to unlock (MOB-5). Signing out ends the
        // session, and a fingerprint cannot bring back an expired one: prompting anyway would
        // end in "no saved login" after the user had already touched the sensor.
        if (!sessionEnded && fingerprintEnabled && canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS &&
            session.hasLiveToken()) {
            biometricPrompt.authenticate(promptInfo)
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

            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val response = ApiClient.api.login(LoginRequest(normalizedUsername, password))
                    withContext(Dispatchers.Main) {
                        // Re-enable button
                        btnLogin.isEnabled = true
                        btnLogin.text = "Login"
                        
                        if (response.isSuccessful && response.body() != null) {
                            val token = response.body()!!.token
                            // If username or password changed, disable biometrics
                            val oldUsername = prefs.getString("username", null)
                            if (oldUsername != null && oldUsername != normalizedUsername) {
                                prefs.edit().putBoolean("fingerprint_enabled", false).apply()
                            }
                            session.save(token, normalizedUsername)
                            tvLoginStatus.text = "Login successful!"
                            // Navigate to main screen
                            startActivity(Intent(this@LoginActivity, MainActivity::class.java))
                            finish()
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

    private fun notice(status: TextView, text: String) {
        status.setTextColor(ContextCompat.getColor(this, R.color.gt_text_secondary))
        status.text = text
    }

    private fun showError(status: TextView, text: String) {
        status.setTextColor(errorColor)
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
