package com.example.gmaetrackermobile.fragments

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.Button
import android.widget.LinearLayout
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.gmaetrackermobile.CalendarHelper
import com.example.gmaetrackermobile.GameAdapter
import com.example.gmaetrackermobile.MainActivity
import com.example.gmaetrackermobile.R
import com.example.gmaetrackermobile.Game
import com.example.gmaetrackermobile.SnackbarHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.content.Context.MODE_PRIVATE
import android.widget.HorizontalScrollView
import android.widget.TextView
import com.google.android.material.chip.Chip
import org.json.JSONArray

class SearchFragment : Fragment(), GameDetailsFragment.GameDetailsCallback {
    private lateinit var searchEditText: EditText
    private lateinit var searchButton: Button
    private lateinit var recyclerView: RecyclerView
    private lateinit var errorState: View
    private lateinit var searchResultsHeader: TextView
    private lateinit var welcomeMessage: View
    private lateinit var gameAdapter: GameAdapter
    private lateinit var searchHistoryScroll: HorizontalScrollView
    private lateinit var searchHistoryChipContainer: LinearLayout

    private var currentQuery = ""
    private val searchHandler = Handler(Looper.getMainLooper())
    private val searchRunnable = Runnable { performSearch() }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? {
        try {
            return inflater.inflate(R.layout.fragment_search, container, false)
        } catch (e: Exception) {
            android.util.Log.e("SearchFragment", "Error inflating layout: ${e.message}", e)
            return TextView(requireContext()).apply {
                text = "Search Screen\n\nSomething went wrong loading this screen.\nPlease restart the app."
                textSize = 16f
                gravity = android.view.Gravity.CENTER
                setTextColor(android.graphics.Color.WHITE)
                setBackgroundColor(android.graphics.Color.BLACK)
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
                )
            }
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        view.post {
            try {
                initializeViews(view)
                setupRecyclerView()
                setupSearchFunctionality()
                renderHistoryChips()
            } catch (e: Exception) {
                android.util.Log.e("SearchFragment", "Error initializing views: ${e.message}", e)
                showError("Error initializing search screen: ${e.message}")
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (::searchHistoryScroll.isInitialized) {
            renderHistoryChips()
        }
    }

    override fun onGameStatusUpdated() {
        if (currentQuery.isNotEmpty()) performSearch()
    }

    // ── View init ────────────────────────────────────────────────────────────

    private fun initializeViews(view: View) {
        searchEditText = view.findViewById(R.id.etSearch)
            ?: throw IllegalStateException("Search EditText not found")
        searchButton = view.findViewById(R.id.btnSearch)
            ?: throw IllegalStateException("Search Button not found")
        recyclerView = view.findViewById(R.id.recyclerView)
            ?: throw IllegalStateException("RecyclerView not found")
        errorState = view.findViewById(R.id.errorState)
            ?: throw IllegalStateException("Error State View not found")
        searchResultsHeader = view.findViewById(R.id.tvSearchResultsHeader)
            ?: throw IllegalStateException("Search Results Header not found")
        welcomeMessage = view.findViewById(R.id.welcomeMessage)
            ?: throw IllegalStateException("Welcome Message View not found")
        searchHistoryScroll = view.findViewById(R.id.searchHistoryScroll)
            ?: throw IllegalStateException("searchHistoryScroll not found")
        searchHistoryChipContainer = view.findViewById(R.id.searchHistoryChipContainer)
            ?: throw IllegalStateException("searchHistoryChipContainer not found")
    }

    private fun setupRecyclerView() {
        if (context == null) return
        gameAdapter = GameAdapter(
            onAddToLibrary = { game -> addGameToLibrary(game) },
            hideAddButton = false,
            onItemClick = { game ->
                requireActivity().supportFragmentManager.beginTransaction()
                    .setCustomAnimations(
                        R.anim.slide_in_right, R.anim.slide_out_left,
                        R.anim.slide_in_left, R.anim.slide_out_right
                    )
                    .replace(R.id.fragment_container, GameDetailsFragment.newInstance(game))
                    .addToBackStack(null)
                    .commit()
            }
        )
        recyclerView.apply {
            layoutManager = LinearLayoutManager(context)
            adapter = gameAdapter
        }
    }

    // ── Search history ────────────────────────────────────────────────────────

    private fun loadHistory(): List<String> {
        val prefs = requireContext().getSharedPreferences("app_prefs", MODE_PRIVATE)
        val json = prefs.getString("search_history", "[]") ?: "[]"
        return try {
            val arr = JSONArray(json)
            (0 until arr.length()).map { arr.getString(it) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun saveHistory(query: String) {
        val existing = loadHistory().toMutableList()
        existing.removeAll { it.equals(query, ignoreCase = true) }
        existing.add(0, query)
        val trimmed = existing.take(5)
        val json = JSONArray(trimmed).toString()
        requireContext().getSharedPreferences("app_prefs", MODE_PRIVATE)
            .edit().putString("search_history", json).apply()
    }

    private fun removeHistoryEntry(query: String) {
        val existing = loadHistory().toMutableList()
        existing.removeAll { it.equals(query, ignoreCase = true) }
        val json = JSONArray(existing).toString()
        requireContext().getSharedPreferences("app_prefs", MODE_PRIVATE)
            .edit().putString("search_history", json).apply()
        renderHistoryChips()
    }

    private fun clearAllHistory() {
        requireContext().getSharedPreferences("app_prefs", MODE_PRIVATE)
            .edit().putString("search_history", "[]").apply()
        renderHistoryChips()
    }

    fun renderHistoryChips() {
        if (!isAdded || !::searchHistoryChipContainer.isInitialized) return
        searchHistoryChipContainer.removeAllViews()
        val history = loadHistory()

        val recentLabel = view?.findViewById<View>(R.id.tvRecentLabel)
        if (history.isEmpty() || currentQuery.isNotEmpty()) {
            searchHistoryScroll.visibility = View.GONE
            recentLabel?.visibility = View.GONE
            return
        }
        recentLabel?.visibility = View.VISIBLE

        history.forEach { query ->
            val chip = Chip(requireContext()).apply {
                text = query
                isCloseIconVisible = true
                chipBackgroundColor = android.content.res.ColorStateList.valueOf(0xFF1E2030.toInt())
                setTextColor(0xFFF0F1F8.toInt())
                closeIconTint = android.content.res.ColorStateList.valueOf(0xFF8890A8.toInt())
                setOnClickListener {
                    searchEditText.setText(query)
                    performSearch()
                }
                setOnCloseIconClickListener {
                    removeHistoryEntry(query)
                }
            }
            searchHistoryChipContainer.addView(chip)
        }

        // "Clear all" chip
        val clearChip = Chip(requireContext()).apply {
            text = "Clear all"
            chipBackgroundColor = android.content.res.ColorStateList.valueOf(0xFF1E2030.toInt())
            setTextColor(android.graphics.Color.parseColor("#FF4D4F"))
            setOnClickListener { clearAllHistory() }
        }
        searchHistoryChipContainer.addView(clearChip)

        searchHistoryScroll.visibility = View.VISIBLE
    }

    // ── Search functionality ─────────────────────────────────────────────────

    private fun setupSearchFunctionality() {
        searchButton.setOnClickListener { performSearch() }

        searchEditText.setOnEditorActionListener { _, _, _ ->
            performSearch()
            true
        }

        searchEditText.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                searchHandler.removeCallbacks(searchRunnable)
                if (s.isNullOrBlank()) {
                    clearSearch()
                } else {
                    searchHandler.postDelayed(searchRunnable, 400)
                }
            }
            override fun afterTextChanged(s: android.text.Editable?) {}
        })
    }

    private fun clearSearch() {
        currentQuery = ""
        searchResultsHeader.visibility = View.GONE
        errorState.visibility = View.GONE
        recyclerView.visibility = View.GONE
        welcomeMessage.visibility = View.VISIBLE
        gameAdapter.submitList(emptyList())
        renderHistoryChips()
    }

    private fun performSearch() {
        if (!isAdded) return
        val query = searchEditText.text.toString().trim()
        if (query.isEmpty()) return

        currentQuery = query
        welcomeMessage.visibility = View.GONE
        searchHistoryScroll.visibility = View.GONE
        view?.findViewById<View>(R.id.tvRecentLabel)?.visibility = View.GONE

        lifecycleScope.launch {
            try {
                val games = searchAllGames(query)
                withContext(Dispatchers.Main) {
                    if (!isAdded) return@withContext
                    gameAdapter.submitList(games)
                    if (games.isEmpty()) {
                        searchResultsHeader.visibility = View.VISIBLE
                        searchResultsHeader.text = "No games found for '$query'"
                        errorState.visibility = View.VISIBLE
                        recyclerView.visibility = View.GONE
                    } else {
                        searchResultsHeader.visibility = View.VISIBLE
                        searchResultsHeader.text = "Found ${games.size} game(s) for '$query'"
                        errorState.visibility = View.GONE
                        recyclerView.visibility = View.VISIBLE
                        // Save to history after a successful non-empty result
                        saveHistory(query)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    if (!isAdded) return@withContext
                    showError("Search error: ${e.message}")
                }
            }
        }
    }

    private suspend fun searchAllGames(query: String): List<Game> {
        if (!isAdded) return emptyList()
        return try {
            val prefs = requireContext().getSharedPreferences("auth", MODE_PRIVATE)
            val token = prefs.getString("token", null) ?: return emptyList()
            val response = com.example.gmaetrackermobile.ApiClient.api.searchGames(query, "Bearer $token")
            if (response.isSuccessful) response.body() ?: emptyList() else emptyList()
        } catch (e: Exception) {
            android.util.Log.e("SearchFragment", "Error searching: ${e.message}", e)
            emptyList()
        }
    }

    // ── Add to library ────────────────────────────────────────────────────────

    private fun addGameToLibrary(game: Game) {
        if (!isAdded) return
        lifecycleScope.launch {
            try {
                val prefs = requireContext().getSharedPreferences("auth", MODE_PRIVATE)
                val token = prefs.getString("token", null) ?: return@launch
                val username = prefs.getString("username", null) ?: return@launch

                val gameRequest = com.example.gmaetrackermobile.GameUpdateRequest(
                    gameId = game.game_id ?: game.id ?: "",
                    gameName = game.displayName,
                    coverUrl = game.cover,
                    releaseDate = game.release,
                    status = "Wishlist",
                    steamAppId = game.steam_app_id ?: game.steamAppId
                )
                val response = com.example.gmaetrackermobile.ApiClient.api
                    .addOrUpdateGame("Bearer $token", username, gameRequest)

                withContext(Dispatchers.Main) {
                    if (!isAdded) return@withContext
                    if (response.isSuccessful) {
                        showSnackbar("${game.displayName} added to library!", SnackbarHelper.Type.SUCCESS)
                        maybeCreateCalendarEvent(game)
                    } else {
                        showSnackbar("Failed to add game to library", SnackbarHelper.Type.ERROR)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    if (!isAdded) return@withContext
                    showSnackbar("Error: ${e.message}", SnackbarHelper.Type.ERROR)
                }
            }
        }
    }

    private fun maybeCreateCalendarEvent(game: Game) {
        val releaseDate = game.release
        if (releaseDate.isBlank()) return
        val ctx = context ?: return
        if (!CalendarHelper.isSyncEnabled(ctx)) return
        val activity = requireActivity() as? MainActivity ?: return
        activity.requestCalendarPermissions { granted ->
            if (!granted) return@requestCalendarPermissions
            val gameId = game.game_id ?: game.id ?: return@requestCalendarPermissions
            if (CalendarHelper.getStoredCalendarId(ctx) == null) {
                val calendars = CalendarHelper.getAvailableCalendars(ctx)
                CalendarHelper.showCalendarPickerDialog(ctx, calendars) { selected ->
                    CalendarHelper.storeCalendarId(ctx, selected.id)
                    lifecycleScope.launch(Dispatchers.IO) {
                        CalendarHelper.addGameEvent(ctx, gameId, game.displayName, releaseDate)
                    }
                }
            } else {
                lifecycleScope.launch(Dispatchers.IO) {
                    CalendarHelper.addGameEvent(ctx, gameId, game.displayName, releaseDate)
                }
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun showError(message: String) {
        if (!isAdded) return
        try {
            errorState.visibility = View.VISIBLE
            recyclerView.visibility = View.GONE
            showSnackbar(message, SnackbarHelper.Type.ERROR)
        } catch (e: Exception) {
            android.util.Log.e("SearchFragment", "Error showing error state: ${e.message}", e)
        }
    }

    private fun showSnackbar(message: String, type: SnackbarHelper.Type = SnackbarHelper.Type.DEFAULT) {
        if (!isAdded) return
        SnackbarHelper.show(this, message, type)
    }
}
