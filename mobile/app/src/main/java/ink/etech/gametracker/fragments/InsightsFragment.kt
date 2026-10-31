package ink.etech.gametracker.fragments

import android.content.Context
import ink.etech.gametracker.GameStatus
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import ink.etech.gametracker.ApiClient
import ink.etech.gametracker.DonutView
import ink.etech.gametracker.Game
import ink.etech.gametracker.GameExtras
import ink.etech.gametracker.R
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ink.etech.gametracker.Session
import ink.etech.gametracker.LibraryRepository

class InsightsFragment : Fragment() {

    private val density get() = resources.displayMetrics.density
    private fun dp(v: Float) = (v * density + 0.5f).toInt()

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_insights, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        loadLibrary()
    }

    // A hidden tab is resumed with the activity too: only the visible one reads (MOB-19).
    override fun onResume() {
        super.onResume()
        if (!isHidden) loadLibrary()
    }

    /** Shown again, by a tab tap or by Back from Game Details (MOB-19). */
    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) loadError?.dismiss()
        if (!hidden && view != null) loadLibrary()
    }

    /**
     * The indefinite "couldn't load" snackbar. It sits on the activity, not this tab, so the
     * tab dismisses it when hidden or destroyed: it must not follow the user to another tab.
     */
    private var loadError: com.google.android.material.snackbar.Snackbar? = null

    override fun onDestroyView() {
        loadError?.dismiss()
        loadError = null
        super.onDestroyView()
    }

    /** From the shared copy (MOB-19). */
    private fun loadLibrary() {
        val ctx = context ?: return
        LibraryRepository.peek(ctx)?.let { bind(it) }
        viewLifecycleOwner.lifecycleScope.launch {
            val games = LibraryRepository.load(ctx)
            if (!isAdded) return@launch
            if (games != null) {
                loadError?.dismiss()
                loadError = null
                bind(games)
            } else {
                // It used to fail in silence: zeros everywhere, as if the library were empty.
                loadError?.dismiss()
                loadError = ink.etech.gametracker.SnackbarHelper.show(
                    this@InsightsFragment,
                    "Couldn't load your library",
                    ink.etech.gametracker.SnackbarHelper.Type.ERROR,
                    com.google.android.material.snackbar.Snackbar.LENGTH_INDEFINITE,
                    action = "Retry",
                    onAction = { loadLibrary() },
                )
            }
        }
    }

    private fun bind(games: List<Game>) {
        val v = view ?: return
        val total = games.size
        fun count(s: String) = games.count { it.status?.lowercase() == s }
        val playing = count("playing")
        val backlog = count("backlog")
        val done = count("done")
        val wishlist = count("wishlist")

        val pct = if (total > 0) done.toFloat() / total else 0f
        v.findViewById<DonutView>(R.id.donut).setProgress(pct)
        v.findViewById<TextView>(R.id.tvDoneSummary).text = "$done done"
        v.findViewById<TextView>(R.id.tvDoneSub).text = "of $total tracked games completed"
        v.findViewById<TextView>(R.id.tvCompletionBadge).text =
            "${(pct * 100).toInt()}% completion rate"

        // MOB-11: this card showed hours played, invented from a hash of each game id. It
        // now shows the number of games tracked, which the library actually holds.
        v.findViewById<TextView>(R.id.tvTotalHours).text = total.toString()

        // Only ratings the user set on this device: a game with no rating counts as unrated,
        // never as the 4-5 stars the old mock gave every finished game.
        val rated = games.map { GameExtras.rating(requireContext(), it) }.filter { it > 0 }
        v.findViewById<TextView>(R.id.tvAvgRating).text =
            if (rated.isEmpty()) "—" else String.format("%.1f", rated.average())

        // Status breakdown bars
        val statusContainer = v.findViewById<LinearLayout>(R.id.statusBars)
        statusContainer.removeAllViews()
        addBar(statusContainer, "Playing", playing, total, ContextCompat.getColor(requireContext(), R.color.gt_status_playing))
        addBar(statusContainer, "Backlog", backlog, total, ContextCompat.getColor(requireContext(), R.color.gt_status_backlog))
        addBar(statusContainer, "Completed", done, total, ContextCompat.getColor(requireContext(), R.color.gt_status_done))
        addBar(statusContainer, "Wishlist", wishlist, total, ContextCompat.getColor(requireContext(), R.color.gt_status_wishlist))
        // The fifth status was missing, so the bars did not add up to the total (MOB-18:
        // unreleased is the status, not a date guess).
        val unreleased = games.count { GameStatus.canonical(it.status) == GameStatus.UNRELEASED }
        addBar(statusContainer, "Unreleased", unreleased, total, ContextCompat.getColor(requireContext(), R.color.gt_status_unreleased))

        // Release years (was "Top genres", drawn from random labels: MOB-11). The year is
        // the one descriptive fact every library row carries; undated games are left out
        // rather than bucketed as a year they do not have. The five busiest years, newest
        // first. The view ids keep their old names so the layout is untouched.
        val yearContainer = v.findViewById<LinearLayout>(R.id.genreBars)
        yearContainer.removeAllViews()
        val yearCounts = games.mapNotNull { GameExtras.year(it) }.groupingBy { it }.eachCount()
            .entries.sortedByDescending { it.value }.take(5).sortedByDescending { it.key }
        val accent = resolveAccent()
        v.findViewById<View>(R.id.tvNoGenres).visibility =
            if (yearCounts.isEmpty()) View.VISIBLE else View.GONE
        val yMax = yearCounts.maxOfOrNull { it.value } ?: 1
        yearCounts.forEach { addBar(yearContainer, it.key, it.value, yMax, accent) }
    }

    private fun resolveAccent(): Int {
        val tv = android.util.TypedValue()
        requireContext().theme.resolveAttribute(
            com.google.android.material.R.attr.colorPrimary, tv, true
        )
        return tv.data
    }

    /** Builds one "label | track[fill] | value" bar row matching the prototype. */
    private fun addBar(parent: LinearLayout, label: String, value: Int, max: Int, color: Int) {
        val row = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(12f) }
        }

        val labelView = TextView(requireContext()).apply {
            text = label
            setTextColor(ContextCompat.getColor(context, R.color.gt_text_light))
            textSize = 12.5f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(dp(70f), ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        val track = LinearLayout(requireContext()).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(5f).toFloat()
                setColor(ContextCompat.getColor(context, R.color.gt_border))
            }
            layoutParams = LinearLayout.LayoutParams(0, dp(9f), 1f)
                .apply { marginStart = dp(12f); marginEnd = dp(12f) }
        }
        // Zero is an empty track, not a 2% sliver that reads as "a few". A non-zero count
        // keeps a visible minimum so one game out of 300 still shows.
        val fraction = when {
            value <= 0 || max <= 0 -> 0f
            else -> (value.toFloat() / max).coerceIn(0.02f, 1f)
        }
        val fill = View(requireContext()).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(5f).toFloat()
                setColor(color)
            }
            layoutParams = LinearLayout.LayoutParams(0, dp(9f), fraction)
        }
        track.addView(fill)
        // pad the remaining track space so the fill weight resolves correctly
        track.addView(View(requireContext()).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(9f), (1f - fraction).coerceAtLeast(0f))
        })

        val valueView = TextView(requireContext()).apply {
            text = value.toString()
            setTextColor(ContextCompat.getColor(context, R.color.gt_text_primary))
            textSize = 13f
            gravity = Gravity.END
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(dp(24f), ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        row.addView(labelView)
        row.addView(track)
        row.addView(valueView)
        parent.addView(row)
    }
}
