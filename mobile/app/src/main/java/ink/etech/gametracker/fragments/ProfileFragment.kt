package ink.etech.gametracker.fragments

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
import ink.etech.gametracker.Game
import com.google.android.material.button.MaterialButton
import ink.etech.gametracker.CryptoPrompt
import ink.etech.gametracker.FingerprintUnlock
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.fragment.app.Fragment
import ink.etech.gametracker.ApiClient
import ink.etech.gametracker.CalendarHelper
import ink.etech.gametracker.LoginActivity
import ink.etech.gametracker.MainActivity
import ink.etech.gametracker.R
import ink.etech.gametracker.SnackbarHelper
import ink.etech.gametracker.ThemeManager
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.switchmaterial.SwitchMaterial
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ink.etech.gametracker.Session
import ink.etech.gametracker.LibraryRepository
import ink.etech.gametracker.SignOut
import ink.etech.gametracker.UserData
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
        // A sign-out elsewhere, or a new fingerprint invalidating the key, can have turned it off.
        context?.let { showBiometric(FingerprintUnlock.isOn(it)) }
    }

    /** Shown again by a tab tap (MOB-19): the counts may have changed on another tab. */
    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden && view != null) loadLibraryStats()
    }

    // ── Profile info ──────────────────────────────────────────────────────────

    private fun setupProfileInfo(view: View) {
        val session = Session.get(requireContext())
        val username = session.username ?: "Unknown"
        val displayName = username   // display_name was never written on the phone (MOB-22)
        view.findViewById<TextView>(R.id.tvUsername).text = "@$username"
        view.findViewById<TextView>(R.id.tvDisplayName).text = displayName
        view.findViewById<TextView>(R.id.tvAvatarInitial).text =
            displayName.trim().firstOrNull()?.uppercase() ?: "?"
    }

    private fun setupSettingsRow(view: View) {
        // Settings is gone (MOB-28): its one real control is the fingerprint switch above.
        view.findViewById<TextView>(R.id.tvAppVersion)?.text = "GameTracker ${ink.etech.gametracker.BuildConfig.VERSION_NAME}"
    }

    private fun loadLibraryStats() {
        // The view's scope (MOB-17): this was an unscoped CoroutineScope that called
        // requireContext() on an IO thread after the fragment could have detached.
        val ctx = context ?: return
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                // The shared copy (MOB-19); null when it could not be read: keep the old numbers.
                val games = LibraryRepository.load(ctx)
                if (games != null && isAdded) {
                    view?.findViewById<TextView>(R.id.tvProfileTotal)?.text = games.size.toString()
                    view?.findViewById<TextView>(R.id.tvProfilePlaying)?.text =
                        games.count { it.status?.lowercase() == "playing" }.toString()
                    view?.findViewById<TextView>(R.id.tvProfileDone)?.text =
                        games.count { it.status?.lowercase() == "done" }.toString()
                    view?.findViewById<TextView>(R.id.tvProfileBacklog)?.text =
                        games.count { it.status?.lowercase() == "backlog" }.toString()
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
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
            R.id.colorPreset3, R.id.colorPreset4, R.id.colorPreset5
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

            val circle: android.graphics.drawable.Drawable = if (isSelected) {
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
            // A 40dp circle centred in the cell, which is the 48dp-tall touch target (MOB-33).
            dot.background = android.graphics.drawable.LayerDrawable(arrayOf(circle)).apply {
                setLayerSize(0, dp(40f), dp(40f))
                setLayerGravity(0, android.view.Gravity.CENTER)
            }

            // MOB-30: a focusable View with no label read as "unlabelled" to TalkBack.
            dot.contentDescription = "${ThemeManager.PRESET_NAMES[i]} accent"
            dot.isSelected = isSelected
            ViewCompat.setStateDescription(dot, if (isSelected) "Selected" else null)
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
            // Holding this phone's 30-day token (MOB-9), off means signed out: ask first.
            if (SignOut.confirmFingerprintOff(requireActivity()) { showBiometric(true) }) return
            FingerprintUnlock.disable(ctx)
            showSnackbar("Fingerprint unlock off.", SnackbarHelper.Type.DEFAULT)
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
            if (settingCalendarSwitchQuietly) return@setOnCheckedChangeListener
            if (isChecked) {
                val activity = requireActivity() as? MainActivity ?: return@setOnCheckedChangeListener
                activity.requestCalendarPermissions { granted ->
                    if (!granted) {
                        showSnackbar("Calendar permission required", SnackbarHelper.Type.ERROR)
                        // Quietly: sync was never on, so this must not ask to turn it off.
                        setCalendarSwitchQuietly(switchCalendar, false)
                        return@requestCalendarPermissions
                    }
                    CalendarHelper.setSyncEnabled(ctx, true)
                    updateCalendarUi(true, btnSync, tvStatus)
                    showSnackbar("Calendar sync on — press Sync to link your games", SnackbarHelper.Type.SUCCESS)
                }
            } else if (!CalendarHelper.isSyncEnabled(ctx)) {
                // Sync is not on, so there is nothing to remove and nothing to ask.
                updateCalendarUi(false, btnSync, tvStatus)
            } else {
                // Turning sync off deletes every event it put in the user's calendar, which
                // cannot be undone. It used to happen on the switch alone: one stray tap
                // emptied the calendar. Now it asks; Cancel puts the switch back.
                MaterialAlertDialogBuilder(ctx)
                    .setTitle("Turn off calendar sync?")
                    .setMessage("This removes every release date GameTracker added to your calendar. Your library is not affected.")
                    .setNegativeButton("Cancel") { _, _ -> setCalendarSwitchQuietly(switchCalendar, true) }
                    .setOnCancelListener { setCalendarSwitchQuietly(switchCalendar, true) }
                    .setPositiveButton("Turn off and remove") { _, _ ->
                        updateCalendarUi(false, btnSync, tvStatus)
                        viewLifecycleOwner.lifecycleScope.launch {
                            val left = withContext(Dispatchers.IO) { CalendarHelper.disableSync(ctx) }
                            if (!isAdded) return@launch
                            if (left == 0) showSnackbar("Calendar sync off — all events removed")
                            else showSnackbar(
                                "Calendar sync off, but $left ${if (left == 1) "event" else "events"} couldn't be removed. Allow calendar access, then try again.",
                                SnackbarHelper.Type.ERROR, Snackbar.LENGTH_LONG,
                            )
                        }
                    }
                    .show()
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
                    viewLifecycleOwner.lifecycleScope.launch {
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

    /** Set while the code moves the switch itself, so neither the on nor the off path runs. */
    private var settingCalendarSwitchQuietly = false

    /**
     * Move the switch without acting on it: Cancel on the "turn off?" question puts it back
     * on, and a refused permission puts it back off. Neither is the user asking for a change.
     */
    private fun setCalendarSwitchQuietly(switch: SwitchMaterial, checked: Boolean) {
        settingCalendarSwitchQuietly = true
        switch.isChecked = checked
        settingCalendarSwitchQuietly = false
    }

    private fun updateCalendarUi(enabled: Boolean, btnSync: MaterialButton, tvStatus: TextView) {
        btnSync.visibility = if (enabled) View.VISIBLE else View.GONE
        tvStatus.text = if (enabled) "On — tap Sync to link your games" else "Off — not syncing"
    }

    private suspend fun syncAllLibraryGames(ctx: Context): Int = withContext(Dispatchers.IO) {
        try {
            // Fresh: the calendar is written from it (MOB-19).
            val games: List<Game> = LibraryRepository.load(ctx, force = true) ?: return@withContext 0

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
            .setPositiveButton("Remove data") { _, _ ->
                val appCtx = ctx.applicationContext
                // outlives the view: the removal must finish even if the user leaves (MOB-17);
                // the UI updates below are guarded.
                lifecycleScope.launch {
                    val left = withContext(Dispatchers.IO) { UserData.removeFromPhone(appCtx) }
                    if (!isAdded || view == null) return@launch
                    view?.let { setupCalendarOption(it) }
                    if (left == 0) {
                        showSnackbar("Notes, ratings and search history removed from this phone", SnackbarHelper.Type.SUCCESS)
                    } else {
                        showSnackbar(
                            "Data removed, but $left calendar ${if (left == 1) "date" else "dates"} couldn't be. Allow calendar access, then try again.",
                            SnackbarHelper.Type.ERROR, Snackbar.LENGTH_LONG,
                        )
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showSnackbar(message: String, type: SnackbarHelper.Type = SnackbarHelper.Type.DEFAULT, duration: Int = Snackbar.LENGTH_SHORT) {
        SnackbarHelper.show(this, message, type, duration)
    }
}
