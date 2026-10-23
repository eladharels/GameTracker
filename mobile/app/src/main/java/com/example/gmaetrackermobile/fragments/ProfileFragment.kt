package com.example.gmaetrackermobile.fragments

import android.content.Context
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.lifecycle.lifecycleScope
import com.example.gmaetrackermobile.Game
import com.google.android.material.button.MaterialButton
import com.example.gmaetrackermobile.CryptoPrompt
import com.example.gmaetrackermobile.FingerprintUnlock
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.example.gmaetrackermobile.ApiClient
import com.example.gmaetrackermobile.CalendarHelper
import com.example.gmaetrackermobile.LoginActivity
import com.example.gmaetrackermobile.MainActivity
import com.example.gmaetrackermobile.R
import com.example.gmaetrackermobile.SnackbarHelper
import com.example.gmaetrackermobile.ThemeManager
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.switchmaterial.SwitchMaterial
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.example.gmaetrackermobile.Session
import com.example.gmaetrackermobile.SignOut
import com.example.gmaetrackermobile.UserData
import com.google.android.material.dialog.MaterialAlertDialogBuilder

class ProfileFragment : Fragment() {

    private lateinit var switchBiometric: SwitchMaterial
    private lateinit var cryptoPrompt: CryptoPrompt

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_profile, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        setupProfileInfo(view)
        setupBiometricToggle(view)
        setupCalendarOption(view)
        setupLogout(view)
        setupColorPicker(view)
        setupSettingsRow(view)
        loadLibraryStats()
    }

    override fun onResume() {
        super.onResume()
        // Redraw dots so the correct one shows the selection ring
        view?.let { setupColorPickerDots(it) }
        // It may have been changed in Settings while this screen was in the back stack.
        context?.let { showBiometric(FingerprintUnlock.isOn(it)) }
    }

    // ── Profile info ──────────────────────────────────────────────────────────

    private fun setupProfileInfo(view: View) {
        val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
        val username = prefs.getString("username", "Unknown") ?: "Unknown"
        val displayName = prefs.getString("display_name", username)?.takeIf { it.isNotBlank() } ?: username
        view.findViewById<TextView>(R.id.tvUsername).text = "@$username"
        view.findViewById<TextView>(R.id.tvDisplayName).text = displayName
        view.findViewById<TextView>(R.id.tvAvatarInitial).text =
            displayName.trim().firstOrNull()?.uppercase() ?: "?"
    }

    private fun setupSettingsRow(view: View) {
        view.findViewById<View>(R.id.rowSettings)?.setOnClickListener {
            startActivity(Intent(requireContext(), com.example.gmaetrackermobile.SettingsActivity::class.java))
        }
    }

    private fun loadLibraryStats() {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
                val token = Session.get(requireContext()).token ?: return@launch
                val username = prefs.getString("username", null) ?: return@launch
                val response = ApiClient.api.getLibrary("Bearer $token", username)
                withContext(Dispatchers.Main) {
                    if (response.isSuccessful && isAdded) {
                        val games = response.body() ?: emptyList()
                        view?.findViewById<TextView>(R.id.tvProfileTotal)?.text = games.size.toString()
                        view?.findViewById<TextView>(R.id.tvProfilePlaying)?.text =
                            games.count { it.status?.lowercase() == "playing" }.toString()
                        view?.findViewById<TextView>(R.id.tvProfileDone)?.text =
                            games.count { it.status?.lowercase() == "done" }.toString()
                        view?.findViewById<TextView>(R.id.tvProfileBacklog)?.text =
                            games.count { it.status?.lowercase() == "backlog" }.toString()
                    }
                }
            } catch (e: Exception) {
                // Stats are optional — fail silently
            }
        }
    }

    // ── Color picker ──────────────────────────────────────────────────────────

    private fun setupColorPicker(view: View) {
        setupColorPickerDots(view)
    }

    private fun setupColorPickerDots(view: View) {
        val presetIds = listOf(
            R.id.colorPreset0, R.id.colorPreset1, R.id.colorPreset2,
            R.id.colorPreset3, R.id.colorPreset4
        )
        val currentAccent = ThemeManager.getAccent(requireContext())
        val density = resources.displayMetrics.density
        fun dp(v: Float) = (v * density + 0.5f).toInt()

        // Card background colour used as the "gap" layer in the selection ring
        val gapColor = 0xFF1F2130.toInt()

        presetIds.forEachIndexed { i, viewId ->
            val dot = view.findViewById<View>(viewId) ?: return@forEachIndexed
            val presetColor = ThemeManager.PRESETS[i]
            val isSelected = presetColor == currentAccent

            dot.background = if (isSelected) {
                // Professional "gap ring" style (used by Instagram, Google Photos, iOS):
                //   Layer 0 — white outer ring (full dot size)
                //   Layer 1 — dark gap ring matching the card background (2 dp inset)
                //   Layer 2 — coloured inner circle (4 dp inset)
                // This creates a clean white ring ▸ visible gap ▸ colour — no border artefacts.
                val outerWhite = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(0xFFFFFFFF.toInt())
                }
                val gapRing = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(gapColor)
                }
                val innerColour = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(presetColor)
                }
                android.graphics.drawable.LayerDrawable(
                    arrayOf(outerWhite, gapRing, innerColour)
                ).also { ld ->
                    ld.setLayerInset(1, dp(2f), dp(2f), dp(2f), dp(2f))
                    ld.setLayerInset(2, dp(4f), dp(4f), dp(4f), dp(4f))
                }
            } else {
                GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(presetColor)
                }
            }

            dot.setOnClickListener {
                if (presetColor == currentAccent) return@setOnClickListener
                ThemeManager.setAccent(requireContext(), presetColor)
                requireActivity().recreate()
            }
        }
    }

    // ── Biometric toggle ──────────────────────────────────────────────────────

    private fun setupBiometricToggle(view: View) {
        switchBiometric = view.findViewById(R.id.switchBiometric)
        val ctx = requireContext()
        // MOB-6: turning it on SEALS the session token with a fingerprint-bound Keystore key
        // (FingerprintUnlock), so the prompt here is the real thing, not a confirmation.
        cryptoPrompt = CryptoPrompt.forFragment(this)

        fun show(on: Boolean) {
            // Without the listener: setting isChecked from code must not count as a tap.
            switchBiometric.setOnCheckedChangeListener(null)
            switchBiometric.isChecked = on
            switchBiometric.setOnCheckedChangeListener { _, isChecked -> onToggled(isChecked) }
        }
        showBiometric = ::show

        show(FingerprintUnlock.isOn(ctx))
        switchBiometric.isEnabled = FingerprintUnlock.canUse(ctx) || FingerprintUnlock.isOn(ctx)
    }

    private var showBiometric: (Boolean) -> Unit = {}

    private fun onToggled(isChecked: Boolean) {
        val ctx = context ?: return
        if (!isChecked) {
            FingerprintUnlock.disable(ctx)
            showSnackbar("Fingerprint unlock off", SnackbarHelper.Type.DEFAULT)
            return
        }
        FingerprintUnlock.enable(ctx, cryptoPrompt) { result ->
            if (!isAdded) return@enable
            when (result) {
                FingerprintUnlock.Result.Done -> {
                    showBiometric(true)   // onResume may have redrawn it off while the prompt was up
                    showSnackbar(FingerprintUnlock.ENABLED_TEXT, SnackbarHelper.Type.SUCCESS)
                }
                is FingerprintUnlock.Result.Cancelled -> {
                    showBiometric(false)
                    if (result.byUser) showSnackbar("Fingerprint unlock not turned on.", SnackbarHelper.Type.DEFAULT)
                    else showSnackbar(result.message.toString(), SnackbarHelper.Type.ERROR)
                }
                is FingerprintUnlock.Result.Unavailable -> {
                    showBiometric(false)
                    showSnackbar(result.message, SnackbarHelper.Type.ERROR)
                }
                FingerprintUnlock.Result.KeyInvalidated -> {
                    showBiometric(false)
                    showSnackbar(FingerprintUnlock.KEY_CHANGED_TEXT, SnackbarHelper.Type.ERROR)
                }
            }
        }
    }

    // ── Calendar sync ─────────────────────────────────────────────────────────

    private fun setupCalendarOption(view: View) {
        val switchCalendar = view.findViewById<SwitchMaterial>(R.id.switchCalendarSync) ?: return
        val btnSync = view.findViewById<MaterialButton>(R.id.btnSyncCalendar) ?: return
        val tvStatus = view.findViewById<TextView>(R.id.tvCalendarStatus) ?: return
        val ctx = requireContext()

        switchCalendar.setOnCheckedChangeListener(null)
        switchCalendar.isChecked = CalendarHelper.isSyncEnabled(ctx)
        updateCalendarUi(switchCalendar.isChecked, btnSync, tvStatus)

        switchCalendar.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) {
                val activity = requireActivity() as? MainActivity ?: return@setOnCheckedChangeListener
                activity.requestCalendarPermissions { granted ->
                    if (!granted) {
                        showSnackbar("Calendar permission required", SnackbarHelper.Type.ERROR)
                        switchCalendar.isChecked = false
                        return@requestCalendarPermissions
                    }
                    CalendarHelper.setSyncEnabled(ctx, true)
                    updateCalendarUi(true, btnSync, tvStatus)
                    showSnackbar("Calendar sync on — press Sync to link your games", SnackbarHelper.Type.SUCCESS)
                }
            } else {
                lifecycleScope.launch(Dispatchers.IO) { CalendarHelper.disableSync(ctx) }
                updateCalendarUi(false, btnSync, tvStatus)
                showSnackbar("Calendar sync off — all events removed")
            }
        }

        btnSync.setOnClickListener {
            val activity = requireActivity() as? MainActivity ?: return@setOnClickListener
            activity.requestCalendarPermissions { granted ->
                if (!granted) { showSnackbar("Calendar permission required", SnackbarHelper.Type.ERROR); return@requestCalendarPermissions }
                val calendars = CalendarHelper.getAvailableCalendars(ctx)
                CalendarHelper.showCalendarPickerDialog(ctx, calendars) { selected ->
                    CalendarHelper.storeCalendarId(ctx, selected.id)
                    tvStatus.text = "Syncing to: ${selected.displayName}"
                    btnSync.isEnabled = false
                    btnSync.text = "Syncing…"
                    lifecycleScope.launch {
                        val synced = syncAllLibraryGames(ctx)
                        btnSync.isEnabled = true
                        btnSync.text = "Sync Games to Calendar"
                        tvStatus.text = "Syncing to: ${selected.displayName}"
                        showSnackbar("Synced $synced game(s) to ${selected.displayName}", SnackbarHelper.Type.SUCCESS)
                    }
                }
            }
        }
    }

    private fun updateCalendarUi(enabled: Boolean, btnSync: MaterialButton, tvStatus: TextView) {
        btnSync.visibility = if (enabled) View.VISIBLE else View.GONE
        tvStatus.text = if (enabled) "On — tap Sync to link your games" else "Off — not syncing"
    }

    private suspend fun syncAllLibraryGames(ctx: Context): Int = withContext(Dispatchers.IO) {
        try {
            val prefs = ctx.getSharedPreferences("auth", Context.MODE_PRIVATE)
            val token = Session.get(ctx).token ?: return@withContext 0
            val username = prefs.getString("username", null) ?: return@withContext 0
            val response = ApiClient.api.getLibrary("Bearer $token", username)
            if (!response.isSuccessful) return@withContext 0
            val games: List<Game> = response.body() ?: emptyList()

            CalendarHelper.deleteAllEvents(ctx)

            var count = 0
            games.forEach { game ->
                val releaseDate = game.release
                val gameId = game.game_id ?: game.id ?: return@forEach
                if (releaseDate.isBlank()) return@forEach
                if (CalendarHelper.addGameEvent(ctx, gameId, game.displayName, releaseDate) != null) count++
            }
            count
        } catch (e: Exception) {
            android.util.Log.e("ProfileFragment", "Calendar sync failed", e)
            0
        }
    }

    // ── Logout ────────────────────────────────────────────────────────────────

    private fun setupLogout(view: View) {
        view.findViewById<Button>(R.id.btnLogout).setOnClickListener { SignOut.start(requireActivity()) }
        view.findViewById<Button>(R.id.btnRemoveLocalData).setOnClickListener { confirmRemoveLocalData() }
    }

    /**
     * MOB-7: notes, ratings and search history are kept per account and survive sign-out
     * (they exist nowhere else). This is the way to take them off a phone.
     */
    private fun confirmRemoveLocalData() {
        val ctx = requireContext()
        MaterialAlertDialogBuilder(ctx)
            .setTitle("Remove your data from this phone?")
            .setMessage(
                "Your notes, star ratings and search history are stored only on this phone, so they " +
                    "will be gone for good. Release dates GameTracker added to your calendar are removed too. " +
                    "Your library on the server is not affected."
            )
            .setPositiveButton("Remove") { _, _ ->
                val appCtx = ctx.applicationContext
                lifecycleScope.launch {
                    withContext(Dispatchers.IO) { UserData.removeFromPhone(appCtx) }
                    if (!isAdded) return@launch
                    view?.let { setupCalendarOption(it) }
                    showSnackbar("Removed from this phone", SnackbarHelper.Type.SUCCESS)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showSnackbar(message: String, type: SnackbarHelper.Type = SnackbarHelper.Type.DEFAULT) {
        SnackbarHelper.show(this, message, type)
    }
}
