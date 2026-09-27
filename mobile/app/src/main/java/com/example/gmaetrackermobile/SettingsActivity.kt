package com.example.gmaetrackermobile

import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

class SettingsActivity : AppCompatActivity() {
    private lateinit var btnBiometric: Button
    private lateinit var biometricPrompt: BiometricPrompt
    private lateinit var promptInfo: BiometricPrompt.PromptInfo

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        theme.applyStyle(ThemeManager.getThemeResId(this), true)
        setContentView(R.layout.activity_settings)

        findViewById<View>(R.id.btnSettingsBack).setOnClickListener { finish() }
        setupInfoRows()

        btnBiometric = findViewById(R.id.btnBiometric)
        val prefs = getSharedPreferences("auth", Context.MODE_PRIVATE)
        val biometricManager = BiometricManager.from(this)
        val canAuthenticate = biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)

        fun updateButton() {
            val enabled = prefs.getBoolean("fingerprint_enabled", false)
            btnBiometric.text = if (enabled) "Turn off fingerprint unlock" else "Unlock with fingerprint while signed in"
            btnBiometric.isEnabled = canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS || enabled
        }

        updateButton()

        val executor = ContextCompat.getMainExecutor(this)
        biometricPrompt = BiometricPrompt(this, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    prefs.edit().putBoolean("fingerprint_enabled", true).apply()
                    runOnUiThread {
                        Toast.makeText(this@SettingsActivity, "Fingerprint unlock on (while signed in)", Toast.LENGTH_SHORT).show()
                        updateButton()
                    }
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    runOnUiThread {
                        Toast.makeText(this@SettingsActivity, "Authentication error: $errString", Toast.LENGTH_SHORT).show()
                    }
                }
                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                    runOnUiThread {
                        Toast.makeText(this@SettingsActivity, "Authentication failed. Try again.", Toast.LENGTH_SHORT).show()
                    }
                }
            })

        promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock with fingerprint")
            .setSubtitle("Unlock the app with your fingerprint while you are signed in")
            .setNegativeButtonText("Cancel")
            .build()

        btnBiometric.setOnClickListener {
            val enabled = prefs.getBoolean("fingerprint_enabled", false)
            if (enabled) {
                // Cancel biometrics
                prefs.edit().putBoolean("fingerprint_enabled", false).apply()
                Toast.makeText(this, "Fingerprint unlock off.", Toast.LENGTH_SHORT).show()
                updateButton()
            } else {
                // Enable biometrics
                biometricPrompt.authenticate(promptInfo)
            }
        }
    }

    /** Populates the informational App-section rows. */
    private fun setupInfoRows() {
        fun row(id: Int, label: String, sub: String, value: String) {
            val root = findViewById<View>(id)
            root.findViewById<TextView>(R.id.tvRowLabel).text = label
            root.findViewById<TextView>(R.id.tvRowSub).text = sub
            root.findViewById<TextView>(R.id.tvRowValue).text = value
        }
        row(R.id.rowAppearance, "Appearance", "Theme & accent", "Dark")
        row(R.id.rowNotifications, "Notifications", "Release reminders", "On")
        row(R.id.rowConnected, "Connected sources", "Steam, IGDB, RAWG", "3")
    }
} 