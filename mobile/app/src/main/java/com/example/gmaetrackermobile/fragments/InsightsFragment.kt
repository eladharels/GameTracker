package com.example.gmaetrackermobile.fragments

import android.content.Context
import android.graphics.Color
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
import com.example.gmaetrackermobile.ApiClient
import com.example.gmaetrackermobile.DonutView
import com.example.gmaetrackermobile.Game
import com.example.gmaetrackermobile.GameExtras
import com.example.gmaetrackermobile.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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

    override fun onResume() {
        super.onResume()
        loadLibrary()
    }

    private fun loadLibrary() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
                val token = prefs.getString("token", null) ?: return@launch
                val username = prefs.getString("username", null) ?: return@launch
                val response = withContext(Dispatchers.IO) {
                    ApiClient.api.getLibrary("Bearer $token", username)
                }
                if (response.isSuccessful && isAdded) bind(response.body() ?: emptyList())
            } catch (e: Exception) {
                android.util.Log.e("InsightsFragment", "Load error: ${e.message}", e)
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
        addBar(statusContainer, "Playing", playing, total, Color.parseColor("#22B8F6"))
        addBar(statusContainer, "Backlog", backlog, total, Color.parseColor("#F97316"))
        addBar(statusContainer, "Completed", done, total, Color.parseColor("#22C55E"))
        addBar(statusContainer, "Wishlist", wishlist, total, Color.parseColor("#8890A8"))

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
            setTextColor(Color.parseColor("#C3C8D8"))
            textSize = 12.5f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(dp(70f), ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        val track = LinearLayout(requireContext()).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(5f).toFloat()
                setColor(Color.parseColor("#10FFFFFF"))
            }
            layoutParams = LinearLayout.LayoutParams(0, dp(9f), 1f)
                .apply { marginStart = dp(12f); marginEnd = dp(12f) }
        }
        val fraction = if (max > 0) (value.toFloat() / max).coerceIn(0.02f, 1f) else 0.02f
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
            setTextColor(Color.parseColor("#F0F1F8"))
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
