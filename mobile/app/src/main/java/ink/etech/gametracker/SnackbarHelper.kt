package ink.etech.gametracker

import androidx.core.content.ContextCompat
import android.graphics.drawable.GradientDrawable
import android.widget.TextView
import androidx.fragment.app.Fragment
import com.google.android.material.snackbar.Snackbar
import ink.etech.gametracker.ThemeManager

object SnackbarHelper {

    enum class Type { DEFAULT, SUCCESS, ERROR }

    fun show(
        fragment: Fragment,
        message: String,
        type: Type = Type.DEFAULT,
        duration: Int = Snackbar.LENGTH_SHORT,
        action: String? = null,
        onAction: (() -> Unit)? = null,
    ): Snackbar? {
        // While an expired session is on its way to the login screen, the screen's own
        // "failed to load" error is noise on top of the real reason (MOB-5).
        if (type == Type.ERROR && Session.redirecting) return null
        val view = fragment.view ?: return null
        val snackbar = Snackbar.make(view, message, duration)
        // Anchor above the bottom nav bar so it's never hidden behind it
        fragment.activity?.findViewById<android.view.View>(R.id.bottom_navigation)
            ?.let { snackbar.anchorView = it }
        if (action != null && onAction != null) snackbar.setAction(action) { onAction() }
        applyStyle(snackbar, type)
        snackbar.show()
        return snackbar
    }

    /**
     * Applies the app's dark-theme styling to any Snackbar.
     * Call this on manually-constructed Snackbars (e.g. the undo snackbar in LibraryFragment)
     * before calling show().
     */
    fun applyStyle(snackbar: Snackbar, type: Type = Type.DEFAULT): Snackbar {
        val snackView = snackbar.view
        val density = snackView.context.resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        // Rounded dark card background
        snackView.background = GradientDrawable().apply {
            setColor(ContextCompat.getColor(snackView.context, R.color.gt_snackbar_bg))
            cornerRadius = dp(14).toFloat()
            setStroke(dp(1), ContextCompat.getColor(snackView.context, R.color.gt_snackbar_stroke))
        }

        // Floating: add horizontal margins so it doesn't span the full width
        (snackView.layoutParams as? android.view.ViewGroup.MarginLayoutParams)?.apply {
            setMargins(dp(16), 0, dp(16), dp(8))
            snackView.layoutParams = this
        }

        // Message text — color conveys type
        val textColor = when (type) {
            Type.SUCCESS -> ContextCompat.getColor(snackView.context, R.color.gt_success_text)   // not a status colour
            Type.ERROR   -> androidx.core.content.ContextCompat.getColor(snackView.context, R.color.gt_error_text)   // 4.6:1 here (MOB-29)
            Type.DEFAULT -> ContextCompat.getColor(snackView.context, R.color.gt_text_primary)
        }
        snackView.findViewById<TextView>(com.google.android.material.R.id.snackbar_text)?.apply {
            setTextColor(textColor)
            textSize = 14f
            maxLines = 3
        }

        // Action button (e.g. UNDO) uses the user's current accent color
        val accentColor = ThemeManager.getAccent(snackView.context)
        snackView.findViewById<TextView>(com.google.android.material.R.id.snackbar_action)?.apply {
            setTextColor(accentColor)
            textSize = 13f
        }

        return snackbar
    }
}
