package com.example.gmaetrackermobile

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class SettingsActivity : AppCompatActivity() {
    private lateinit var btnBiometric: Button
    private lateinit var cryptoPrompt: CryptoPrompt

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        theme.applyStyle(ThemeManager.getThemeResId(this), true)
        setContentView(R.layout.activity_settings)

        findViewById<View>(R.id.btnSettingsBack).setOnClickListener { finish() }
        setupInfoRows()

        btnBiometric = findViewById(R.id.btnBiometric)
        // MOB-6: created in onCreate (a BiometricPrompt must exist before resume).
        cryptoPrompt = CryptoPrompt.forActivity(this)
        updateButton()

        btnBiometric.setOnClickListener {
            if (FingerprintUnlock.isOn(this)) {
                FingerprintUnlock.disable(this)
                Toast.makeText(this, "Fingerprint unlock off.", Toast.LENGTH_SHORT).show()
                updateButton()
            } else {
                FingerprintUnlock.enable(this, cryptoPrompt) { result ->
                    val text = when (result) {
                        FingerprintUnlock.Result.Done -> FingerprintUnlock.ENABLED_TEXT
                        is FingerprintUnlock.Result.Cancelled -> "Fingerprint unlock not turned on."
                        is FingerprintUnlock.Result.Unavailable -> result.message
                        FingerprintUnlock.Result.KeyInvalidated -> FingerprintUnlock.KEY_CHANGED_TEXT
                    }
                    Toast.makeText(this, text, Toast.LENGTH_LONG).show()
                    updateButton()
                }
            }
        }
    }

    private fun updateButton() {
        val enabled = FingerprintUnlock.isOn(this)
        btnBiometric.text = if (enabled) "Turn off fingerprint unlock" else "Turn on fingerprint unlock"
        btnBiometric.isEnabled = FingerprintUnlock.canUse(this) || enabled
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