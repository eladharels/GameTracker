package ink.etech.gametracker

import android.app.Activity
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

/**
 * Edge-to-edge (MOB-31). With targetSdk 35+ Android 15 draws every app under the status and
 * navigation bars, and Android 16 removes the opt-out, so the app does it deliberately and pads
 * what must stay clear. Both activities call [enable] right after setContentView.
 *
 * WindowCompat rather than androidx.activity's enableEdgeToEdge(): the activity library comes
 * in only through Compose today, which MOB-21 removes.
 */
object EdgeToEdge {
    private val BARS = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()

    fun enable(activity: Activity) {
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        // Dark UI: light (white) bar icons.
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
    }

    /** Keeps [view]'s own padding and adds the bars' insets on the sides asked for. */
    fun pad(view: View, top: Boolean = false, bottom: Boolean = false) {
        val baseTop = view.paddingTop
        val baseBottom = view.paddingBottom
        val baseLeft = view.paddingLeft
        val baseRight = view.paddingRight
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val bars = insets.getInsets(BARS)
            v.updatePadding(
                left = baseLeft + bars.left,
                right = baseRight + bars.right,
                top = baseTop + if (top) bars.top else 0,
                bottom = baseBottom + if (bottom) bars.bottom else 0,
            )
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }
}
