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
        val biometricManager = BiometricManager.from(this)
        val canAuthenticate = biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        val fingerprintEnabled = prefs.getBoolean("fingerprint_enabled", false)

        // Setup BiometricPrompt
        val executor = ContextCompat.getMainExecutor(this)
        biometricPrompt = BiometricPrompt(this, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    // If token exists, log user in
                    val token = prefs.getString("token", null)
                    val username = prefs.getString("username", null)
                    if (token != null && username != null) {
                        // Navigate to main screen
                        startActivity(Intent(this@LoginActivity, MainActivity::class.java))
                        finish()
                    } else {
                        tvLoginStatus.text = "No saved login found. Please login with username and password first."
                    }
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    // Show login form if authentication is cancelled or fails
                    tvLoginStatus.text = "Authentication error: $errString"
                }
                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                    tvLoginStatus.text = "Authentication failed. Try again or login with password."
                }
            })

        promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Login with Fingerprint")
            .setSubtitle("Use your fingerprint to login")
            .setNegativeButtonText("Cancel")
            .build()

        // If biometrics are enabled and available, prompt immediately
        if (fingerprintEnabled && canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS) {
            biometricPrompt.authenticate(promptInfo)
        }

        btnLogin.setOnClickListener {
            val username = etUsername.text.toString()
            val password = etPassword.text.toString()
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
                            // Save token and username in SharedPreferences
                            prefs.edit()
                                .putString("token", token)
                                .putString("username", normalizedUsername)
                                .apply()
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
} 