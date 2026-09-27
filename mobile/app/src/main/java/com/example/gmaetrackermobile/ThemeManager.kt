package com.example.gmaetrackermobile

import android.content.Context

/**
 * Manages the app's accent colour theme using proper Android theme overlays.
 *
 * ## How it works
 * Each of the 5 presets maps to a `ThemeOverlay.GameTracker.*` style defined in themes.xml.
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

    /** 5 accent presets — matches the new design prototype's swatch row. */
    val PRESETS = intArrayOf(
        0xFF5B8DEF.toInt(),   // 0  Blue  (default)
        0xFF8B5CF6.toInt(),   // 1  Purple
        0xFF22C55E.toInt(),   // 2  Green
        0xFFF97316.toInt(),   // 3  Orange
        0xFFEC4899.toInt()    // 4  Pink
    )

    /** Human-readable names shown in the Profile colour picker. */
    val PRESET_NAMES = arrayOf("Blue", "Purple", "Green", "Orange", "Pink")

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
        PRESETS[1] -> R.style.ThemeOverlay_GameTracker_Purple
        PRESETS[2] -> R.style.ThemeOverlay_GameTracker_Green
        PRESETS[3] -> R.style.ThemeOverlay_GameTracker_Orange
        PRESETS[4] -> R.style.ThemeOverlay_GameTracker_Pink
        else       -> R.style.ThemeOverlay_GameTracker_Sky   // PRESETS[0] + any unknown value
    }
}
