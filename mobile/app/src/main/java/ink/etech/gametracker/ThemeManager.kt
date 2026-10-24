package ink.etech.gametracker

import android.content.Context

/**
 * Manages the app's accent colour theme using proper Android theme overlays.
 *
 * ## How it works
 * Each of the 6 presets maps to a `ThemeOverlay.GameTracker.*` style defined in themes.xml.
 * The overlay is applied in every Activity's `onCreate()` after `super.onCreate()` but
 * before `setContentView()` — AppCompat is initialised first, then the overlay is
 * overlaid on top before any views are inflated:
 *
 *   super.onCreate(savedInstanceState)
 *   theme.applyStyle(ThemeManager.getThemeResId(this), true)
 *   setContentView(R.layout.activity_...)
 *
 * All layout views that need accent tinting reference `?attr/colorPrimary` — the overlay
 * overrides `colorPrimary` at the theme level, so no runtime view-tree traversal is needed.
 *
 * ## Changing the accent
 * Call `setAccent(context, colorInt)` then `activity.recreate()`.  The new overlay is picked
 * up automatically when the activity re-inflates its views.
 *
 * ## Colour ints (used directly by ProfileFragment for the swatch dots and SnackbarHelper)
 * `getAccent(context)` returns the stored colour int.
 */
object ThemeManager {

    /**
     * The web's six presets, in its order and with its names (MOB-33, frontend/src/App.jsx
     * ACCENT_PRESETS). Violet is the default. A colour stored by the old five-preset picker
     * matches none of these and falls back to Violet.
     */
    val PRESETS = intArrayOf(
        0xFF8B5CF6.toInt(),   // 0  Violet (default)
        0xFF3B82F6.toInt(),   // 1  Blue
        0xFF10B981.toInt(),   // 2  Emerald
        0xFFF59E0B.toInt(),   // 3  Amber
        0xFFF43F5E.toInt(),   // 4  Rose
        0xFF06B6D4.toInt(),   // 5  Cyan
    )

    /** Shown to TalkBack on each colour dot (MOB-30). */
    val PRESET_NAMES = arrayOf("Violet", "Blue", "Emerald", "Amber", "Rose", "Cyan")

    private const val PREFS     = "app_prefs"
    private const val KEY_ACCENT = "accent_color"

    // ── Colour access ────────────────────────────────────────────────────────

    /**
     * Returns the stored accent colour as an ARGB int.
     * Used by: ProfileFragment (swatch dot drawing), SnackbarHelper (action text).
     */
    fun getAccent(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt(KEY_ACCENT, PRESETS[0])

    /**
     * Persists a new accent colour.  After calling this, invoke `activity.recreate()`
     * so the new theme overlay is applied to the re-inflated view hierarchy.
     */
    fun setAccent(context: Context, color: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putInt(KEY_ACCENT, color).apply()
    }

    // ── Theme overlay ────────────────────────────────────────────────────────

    /**
     * Returns the theme overlay resource ID that matches the stored accent colour.
     *
     * Call in Activity.onCreate() AFTER super.onCreate() but BEFORE setContentView():
     *   super.onCreate(savedInstanceState)
     *   theme.applyStyle(ThemeManager.getThemeResId(this), true)  // ← here
     *   setContentView(R.layout.activity_...)
     */
    fun getThemeResId(context: Context): Int = when (getAccent(context)) {
        PRESETS[1] -> R.style.ThemeOverlay_GameTracker_Blue
        PRESETS[2] -> R.style.ThemeOverlay_GameTracker_Emerald
        PRESETS[3] -> R.style.ThemeOverlay_GameTracker_Amber
        PRESETS[4] -> R.style.ThemeOverlay_GameTracker_Rose
        PRESETS[5] -> R.style.ThemeOverlay_GameTracker_Cyan
        else       -> R.style.ThemeOverlay_GameTracker_Violet   // PRESETS[0] + any unknown value
    }
}
