package com.example.gmaetrackermobile.fragments

import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.gmaetrackermobile.ApiClient
import com.example.gmaetrackermobile.ContinueAdapter
import com.example.gmaetrackermobile.Game
import com.example.gmaetrackermobile.GameExtras
import com.example.gmaetrackermobile.MainActivity
import com.example.gmaetrackermobile.R
import com.example.gmaetrackermobile.UpNextAdapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Calendar

class HomeFragment : Fragment(), GameDetailsFragment.GameDetailsCallback {

    private lateinit var continueAdapter: ContinueAdapter
    private lateinit var upNextAdapter: UpNextAdapter

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_home, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        setupHeader(view)
        setupLists(view)
        setupShortcuts(view)
        loadLibrary()
    }

    override fun onResume() {
        super.onResume()
        loadLibrary()
    }

    override fun onGameStatusUpdated() = loadLibrary()

    private fun setupHeader(view: View) {
        val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
        val username = prefs.getString("username", "Player") ?: "Player"
        val displayName = prefs.getString("display_name", null)?.takeIf { it.isNotBlank() } ?: username

        view.findViewById<TextView>(R.id.tvUserName).text = displayName
        view.findViewById<TextView>(R.id.tvAvatarInitial).text =
            displayName.trim().firstOrNull()?.uppercase() ?: "P"
        view.findViewById<TextView>(R.id.tvGreeting).text = greeting()
    }

    private fun greeting(): String = when (Calendar.getInstance().get(Calendar.HOUR_OF_DAY)) {
        in 5..11  -> "Good morning,"
        in 12..17 -> "Good afternoon,"
        else      -> "Good evening,"
    }

    private fun setupLists(view: View) {
        continueAdapter = ContinueAdapter { openGame(it) }
        view.findViewById<RecyclerView>(R.id.rvContinue).apply {
            layoutManager = LinearLayoutManager(context, RecyclerView.HORIZONTAL, false)
            adapter = continueAdapter
        }

        upNextAdapter = UpNextAdapter { openGame(it) }
        view.findViewById<RecyclerView>(R.id.rvUpNext).apply {
            layoutManager = LinearLayoutManager(context)
            adapter = upNextAdapter
        }
    }

    private fun setupShortcuts(view: View) {
        view.findViewById<TextView>(R.id.tvSeeLibrary).setOnClickListener {
            (activity as? MainActivity)?.selectTab(R.id.navigation_library)
        }
        view.findViewById<TextView>(R.id.tvAvatarInitial).setOnClickListener {
            (activity as? MainActivity)?.selectTab(R.id.navigation_profile)
        }
    }

    private fun openGame(game: Game) {
        requireActivity().supportFragmentManager.beginTransaction()
            .setCustomAnimations(
                R.anim.slide_in_right, R.anim.slide_out_left,
                R.anim.slide_in_left, R.anim.slide_out_right
            )
            .replace(R.id.fragment_container, GameDetailsFragment.newInstance(game))
            .addToBackStack(null)
            .commit()
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
                android.util.Log.e("HomeFragment", "Load error: ${e.message}", e)
            }
        }
    }

    private fun bind(games: List<Game>) {
        val v = view ?: return

        val playing = games.filter { it.status?.lowercase() == "playing" }
        val backlog = games.filter { it.status?.lowercase() == "backlog" }
            .sortedBy { it.backlog_order ?: Int.MAX_VALUE }
        val done = games.filter { it.status?.lowercase() == "done" }
        val hours = games.sumOf { GameExtras.hours(it) }

        setStat(v, R.id.cardPlaying, playing.size.toString(), "Now playing", R.color.gt_status_playing)
        setStat(v, R.id.cardBacklog, backlog.size.toString(), "In backlog", R.color.gt_status_backlog)
        setStat(v, R.id.cardDone, done.size.toString(), "Completed", R.color.gt_status_done)
        setStat(v, R.id.cardHours, hours.toString(), "Hours tracked", R.color.gt_text_primary)

        continueAdapter.submit(playing)
        v.findViewById<View>(R.id.tvNoContinue).visibility =
            if (playing.isEmpty()) View.VISIBLE else View.GONE
        v.findViewById<View>(R.id.rvContinue).visibility =
            if (playing.isEmpty()) View.GONE else View.VISIBLE

        upNextAdapter.submit(backlog)
        v.findViewById<View>(R.id.tvNoUpNext).visibility =
            if (backlog.isEmpty()) View.VISIBLE else View.GONE
    }

    private fun setStat(root: View, cardId: Int, value: String, label: String, colorRes: Int) {
        val card = root.findViewById<View>(cardId)
        card.findViewById<TextView>(R.id.tvStatNumber).apply {
            text = value
            setTextColor(ContextCompat.getColor(requireContext(), colorRes))
        }
        card.findViewById<TextView>(R.id.tvStatLabel).text = label
    }
}
