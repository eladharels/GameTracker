package ink.etech.gametracker.fragments

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
import ink.etech.gametracker.CalendarHelper
import ink.etech.gametracker.GameAdapter
import ink.etech.gametracker.MainActivity
import ink.etech.gametracker.R
import ink.etech.gametracker.Game
import ink.etech.gametracker.LibraryMatch
import ink.etech.gametracker.SnackbarHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.content.Context.MODE_PRIVATE
import android.widget.HorizontalScrollView
import android.widget.TextView
import com.google.android.material.chip.Chip
import org.json.JSONArray
import ink.etech.gametracker.Session
import ink.etech.gametracker.LibraryRepository
import ink.etech.gametracker.UserData
import ink.etech.gametracker.GameStatus
import ink.etech.gametracker.SearchResult
import ink.etech.gametracker.SearchResults
import ink.etech.gametracker.LibraryAdd

class SearchFragment : Fragment() {
    private lateinit var searchEditText: EditText
    private lateinit var searchButton: Button
    private lateinit var recyclerView: RecyclerView
    private lateinit var errorState: View
    private lateinit var tvStateTitle: TextView
    private lateinit var tvStateBody: TextView
    private lateinit var btnRetry: Button
    private lateinit var searchResultsHeader: TextView
    private lateinit var welcomeMessage: View
    private lateinit var gameAdapter: GameAdapter
    private lateinit var searchHistoryScroll: HorizontalScrollView
    private lateinit var searchHistoryChipContainer: LinearLayout

    private var currentQuery = ""
    // The search in flight. A new one cancels it, and an answer for any query but the current
    // one is dropped: a slow earlier search used to land after a later one and win (MOB-15).
    private var searchJob: kotlinx.coroutines.Job? = null

    // The library as last fetched, for the "In library" badges (MOB-10). Only for DISPLAY:
    // an add re-checks against a fresh copy, because this one can be stale.
    private var library: List<ink.etech.gametracker.Game> = emptyList()
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
                showError("Couldn't open search. Try again.")
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (::searchHistoryScroll.isInitialized) {
            renderHistoryChips()
        }
    }

    /** Shown again (MOB-19): the results stay, but their "In library" badges are re-read. */
    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) {
            // A keyboard left open over another tab (UI/UX review, PR #15).
            if (::searchEditText.isInitialized) {
                searchEditText.clearFocus()
                androidx.core.content.ContextCompat.getSystemService(requireContext(), android.view.inputmethod.InputMethodManager::class.java)
                    ?.hideSoftInputFromWindow(searchEditText.windowToken, 0)
            }
            return
        }
        if (view == null) return
        if (::searchHistoryScroll.isInitialized && currentQuery.isEmpty()) renderHistoryChips()
        viewLifecycleOwner.lifecycleScope.launch {
            fetchLibrary()?.let { library = it; if (view != null) gameAdapter.notifyDataSetChanged() }
        }
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
        tvStateTitle = view.findViewById(R.id.tvSearchStateTitle)
        tvStateBody = view.findViewById(R.id.tvSearchStateBody)
        btnRetry = view.findViewById(R.id.btnSearchRetry)
        btnRetry.setOnClickListener { performSearch() }
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
                // Your own row when the game is already in your library, so Details shows
                    // its real status and library actions (MOB-16, MOB-39); otherwise only Add.
                (activity as? MainActivity)?.openDetails(
                    LibraryMatch.owned(library, game) ?.let { GameDetailsFragment.newInstance(it, inLibrary = true) } ?: GameDetailsFragment.newInstance(game, inLibrary = false)
                )
            }
        )
        gameAdapter.ownedStatusOf = { game -> LibraryMatch.owned(library, game)?.status }
        recyclerView.apply {
            layoutManager = LinearLayoutManager(context)
            adapter = gameAdapter
        }
    }

    override fun onDestroyView() {
        // MOB-17: a pending debounce would otherwise call performSearch() against a view
        // that no longer exists (the fragment survives on the back stack, its view does not).
        searchHandler.removeCallbacks(searchRunnable)
        super.onDestroyView()
    }

    // ── Search history ────────────────────────────────────────────────────────

    private fun loadHistory(): List<String> {
        // Per account (MOB-7): the next person on this phone does not see these searches.
        val json = UserData.current(requireContext())?.searchHistoryJson() ?: "[]"
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
        UserData.current(requireContext())?.setSearchHistoryJson(json)
    }

    private fun removeHistoryEntry(query: String) {
        val existing = loadHistory().toMutableList()
        existing.removeAll { it.equals(query, ignoreCase = true) }
        val json = JSONArray(existing).toString()
        UserData.current(requireContext())?.setSearchHistoryJson(json)
        renderHistoryChips()
    }

    private fun clearAllHistory() {
        UserData.current(requireContext())?.setSearchHistoryJson("[]")
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
        searchJob?.cancel()
        currentQuery = ""
        searchResultsHeader.visibility = View.GONE
        errorState.visibility = View.GONE
        recyclerView.visibility = View.GONE
        welcomeMessage.visibility = View.VISIBLE
        gameAdapter.submitList(emptyList())
        renderHistoryChips()
    }

    private fun performSearch() {
        if (!isAdded || view == null) return   // viewLifecycleOwner below needs the view (MOB-17)
        val query = searchEditText.text.toString().trim()
        if (query.isEmpty()) return

        currentQuery = query
        welcomeMessage.visibility = View.GONE
        searchHistoryScroll.visibility = View.GONE
        view?.findViewById<View>(R.id.tvRecentLabel)?.visibility = View.GONE

        // A retry must visibly do something, even when it fails the same way (UI/UX review):
        // the state says "Searching…" and the button waits until the answer is shown.
        if (errorState.visibility == View.VISIBLE) {
            tvStateTitle.text = "Searching…"
            tvStateBody.text = ""
            btnRetry.isEnabled = false
        }
        searchJob?.cancel()
        searchJob = viewLifecycleOwner.lifecycleScope.launch {
            val result = searchAllGames(query)
            // Refresh the badges' copy of the library; on failure keep the last one.
            if (result is SearchResult.Found) fetchLibrary()?.let { library = it }
            if (!isAdded || view == null || query != currentQuery) return@launch   // superseded
            showResult(result, query)
        }
    }

    /** Found, empty, or WHY it failed: never a failure dressed as "no games" (MOB-15). */
    private fun showResult(result: SearchResult, query: String) {
        val games = (result as? SearchResult.Found)?.games ?: emptyList()
        gameAdapter.submitList(games)
        gameAdapter.notifyDataSetChanged()
        searchResultsHeader.visibility = View.VISIBLE
        searchResultsHeader.text = SearchResults.header(result, query) +
            (SearchResults.degradedNote(result)?.let { "\n$it" } ?: "")
        val state = SearchResults.state(result)
        if (state == null) {
            errorState.visibility = View.GONE
            recyclerView.visibility = View.VISIBLE
            saveHistory(query)
            return
        }
        tvStateTitle.text = state.first
        tvStateBody.text = state.second
        btnRetry.isEnabled = true
        btnRetry.visibility = if (SearchResults.canRetry(result)) View.VISIBLE else View.GONE
        errorState.visibility = View.VISIBLE
        recyclerView.visibility = View.GONE
    }

    private suspend fun searchAllGames(query: String): SearchResult {
        val token = Session.get(requireContext()).token ?: return SearchResult.Failed(SearchResult.Reason.SIGNED_OUT)
        return try {
            val response = withContext(Dispatchers.IO) {
                ink.etech.gametracker.ApiClient.api.searchGames(query, "Bearer $token")
            }
            SearchResults.of(response.code(), response.body(), response.headers()[SearchResults.DEGRADED_HEADER])
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e   // superseded by a newer search: not a failure
        } catch (e: Exception) {
            android.util.Log.e("SearchFragment", "Search failed: ${e.javaClass.simpleName}")
            SearchResults.of(e)
        }
    }

    // ── Add to library ────────────────────────────────────────────────────────

    /** The library, or null when it could not be read. */
    private suspend fun fetchLibrary(): List<Game>? {
        if (!isAdded) return null
        // Shared copy (MOB-19); the add itself re-reads it fresh (LibraryAdd, MOB-10).
        return LibraryRepository.load(requireContext())
    }

    private fun addGameToLibrary(game: Game) {
        if (!isAdded) return
        viewLifecycleOwner.lifecycleScope.launch {
            // A fresh library check, then the add: MOB-10, in LibraryAdd (shared with Details).
            val outcome = LibraryAdd.add(requireContext(), game)
            when (outcome) {
                is LibraryAdd.Outcome.Added -> outcome.library?.let { library = it }
                is LibraryAdd.Outcome.AlreadyOwned -> library = outcome.library
                else -> Unit
            }
            if (!isAdded || view == null) return@launch
            gameAdapter.notifyDataSetChanged()
            val type = when (outcome) {
                is LibraryAdd.Outcome.Added -> SnackbarHelper.Type.SUCCESS
                is LibraryAdd.Outcome.AlreadyOwned -> SnackbarHelper.Type.DEFAULT
                else -> SnackbarHelper.Type.ERROR
            }
            showSnackbar(LibraryAdd.message(game, outcome), type)
            if (outcome is LibraryAdd.Outcome.Added) maybeCreateCalendarEvent(game)
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
                    // outlives the view: the calendar write must finish even if the user leaves (MOB-17)
                    lifecycleScope.launch(Dispatchers.IO) {
                        CalendarHelper.addGameEvent(ctx, gameId, game.displayName, releaseDate)
                    }
                }
            } else {
                // outlives the view: the calendar write must finish even if the user leaves (MOB-17)
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
