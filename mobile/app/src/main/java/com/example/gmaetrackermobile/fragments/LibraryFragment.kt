package com.example.gmaetrackermobile.fragments

import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import android.widget.EditText
import android.text.Editable
import android.text.TextWatcher
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.example.gmaetrackermobile.ApiClient
import com.example.gmaetrackermobile.BacklogOrderRequest
import com.example.gmaetrackermobile.CalendarHelper
import com.example.gmaetrackermobile.GameAdapter
import com.example.gmaetrackermobile.GameUpdateRequest
import com.example.gmaetrackermobile.R
import com.example.gmaetrackermobile.Game
import com.example.gmaetrackermobile.SnackbarHelper
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.chip.ChipGroup
import com.google.android.material.chip.Chip
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.widget.ImageView
import java.text.SimpleDateFormat
import java.util.Locale

class LibraryFragment : Fragment(), GameDetailsFragment.GameDetailsCallback {
    private lateinit var recyclerView: RecyclerView
    private lateinit var swipeRefreshLayout: SwipeRefreshLayout
    private lateinit var chipGroup: ChipGroup
    private lateinit var gameAdapter: GameAdapter
    private lateinit var emptyStateLayout: View
    private lateinit var librarySearchEditText: EditText
    private lateinit var btnClearSearch: ImageView

    private var currentFilter = "all"
    private var allGames = mutableListOf<Game>()
    private var searchQuery = ""
    private var itemTouchHelper: ItemTouchHelper? = null

    /** Persisted sort preference — key "library_sort" in "app_prefs". */
    private var currentSort = "default"

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_library, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        // Load persisted sort preference
        currentSort = requireContext()
            .getSharedPreferences("app_prefs", Context.MODE_PRIVATE)
            .getString("library_sort", "default") ?: "default"

        try {
            initializeViews(view)
            setupRecyclerView()
            setupDragToReorder()
            setupChipGroup()
            setupSwipeRefresh()
            setupLibrarySearch()
            setupSortButton(view)
            loadLibrary()
        } catch (e: Exception) {
            android.util.Log.e("LibraryFragment", "Init error: ${e.message}", e)
            showSnackbar("Error loading library", SnackbarHelper.Type.ERROR)
        }
    }

    override fun onResume() {
        super.onResume()
        loadLibrary()
    }

    // ── View init ────────────────────────────────────────────────────────────

    private fun initializeViews(view: View) {
        recyclerView = view.findViewById(R.id.recyclerView)
        swipeRefreshLayout = view.findViewById(R.id.swipeRefreshLayout)
        chipGroup = view.findViewById(R.id.chipGroup)
        emptyStateLayout = view.findViewById(R.id.tvEmptyState)
        librarySearchEditText = view.findViewById(R.id.etLibrarySearch)
        btnClearSearch = view.findViewById(R.id.btnClearSearch)
    }

    private fun setupRecyclerView() {
        if (context == null) return
        gameAdapter = GameAdapter(
            onAddToLibrary = {},
            hideAddButton = true,
            onItemClick = { game ->
                requireActivity().supportFragmentManager.beginTransaction()
                    .setCustomAnimations(
                        R.anim.slide_in_right, R.anim.slide_out_left,
                        R.anim.slide_in_left, R.anim.slide_out_right
                    )
                    .replace(R.id.fragment_container, GameDetailsFragment.newInstance(game))
                    .addToBackStack(null)
                    .commit()
            },
            onDelete = { game -> deleteGameFromLibrary(game) },
            onLongPress = { game -> showStatusBottomSheet(game) }
        )
        recyclerView.apply {
            layoutManager = LinearLayoutManager(context)
            adapter = gameAdapter
        }
    }

    // ── Sort button ───────────────────────────────────────────────────────────

    private val sortLabels = mapOf(
        "default" to "Default", "name_az" to "A–Z", "name_za" to "Z–A",
        "release_newest" to "Newest", "release_oldest" to "Oldest", "by_status" to "Status"
    )

    private fun setupSortButton(view: View) {
        view.findViewById<View>(R.id.btnSort)?.setOnClickListener { showSortBottomSheet() }
        updateSortLabel()
    }

    private fun updateSortLabel() {
        view?.findViewById<TextView>(R.id.tvSortLabel)?.text = sortLabels[currentSort] ?: "Sort"
    }

    private fun showSortBottomSheet() {
        val dialog = BottomSheetDialog(requireContext())
        val sheetView = layoutInflater.inflate(R.layout.bottom_sheet_sort, null)
        dialog.setContentView(sheetView)

        // Map sort key → check-mark ImageView id
        val sortRows = mapOf(
            "default"       to Pair(R.id.sortDefault,    R.id.ivCheckDefault),
            "name_az"       to Pair(R.id.sortNameAz,     R.id.ivCheckNameAz),
            "name_za"       to Pair(R.id.sortNameZa,     R.id.ivCheckNameZa),
            "release_newest" to Pair(R.id.sortRelNewest,  R.id.ivCheckRelNewest),
            "release_oldest" to Pair(R.id.sortRelOldest,  R.id.ivCheckRelOldest),
            "by_status"     to Pair(R.id.sortByStatus,   R.id.ivCheckByStatus)
        )

        // Show checkmark next to active sort
        sortRows[currentSort]?.second?.let { sheetView.findViewById<ImageView>(it)?.visibility = View.VISIBLE }

        sortRows.forEach { (sortKey, ids) ->
            sheetView.findViewById<View>(ids.first)?.setOnClickListener {
                currentSort = sortKey
                requireContext().getSharedPreferences("app_prefs", Context.MODE_PRIVATE)
                    .edit().putString("library_sort", sortKey).apply()
                updateSortLabel()
                dialog.dismiss()
                filterGames()
            }
        }

        dialog.show()
    }

    // ── Sort logic ────────────────────────────────────────────────────────────

    private fun parseDateOrNull(dateStr: String?): Long? {
        if (dateStr.isNullOrBlank()) return null
        return try {
            SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(dateStr)?.time
        } catch (e: Exception) {
            null
        }
    }

    private fun applySortToList(list: List<Game>): List<Game> = when (currentSort) {
        "name_az"        -> list.sortedBy { it.displayName.lowercase() }
        "name_za"        -> list.sortedByDescending { it.displayName.lowercase() }
        "release_newest" -> list.sortedWith(compareByDescending { parseDateOrNull(it.release_date ?: it.releaseDate) ?: Long.MIN_VALUE })
        "release_oldest" -> list.sortedWith(compareBy { parseDateOrNull(it.release_date ?: it.releaseDate) ?: Long.MAX_VALUE })
        "by_status" -> {
            val order = listOf("playing", "done", "backlog", "wishlist", "unreleased")
            list.sortedBy { order.indexOf(it.status?.lowercase() ?: "").let { i -> if (i < 0) 99 else i } }
        }
        else -> list // "default" = API order preserved
    }

    // ── Drag-to-reorder ───────────────────────────────────────────────────────

    private fun setupDragToReorder() {
        var draggedGameId: String? = null
        var dragFromPos = -1

        val callback = object : ItemTouchHelper.SimpleCallback(
            ItemTouchHelper.UP or ItemTouchHelper.DOWN, 0
        ) {
            override fun getMovementFlags(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int {
                return if (currentFilter == "backlog")
                    makeMovementFlags(ItemTouchHelper.UP or ItemTouchHelper.DOWN, 0)
                else 0
            }

            override fun onSelectedChanged(vh: RecyclerView.ViewHolder?, actionState: Int) {
                super.onSelectedChanged(vh, actionState)
                if (actionState == ItemTouchHelper.ACTION_STATE_DRAG && vh != null) {
                    dragFromPos = vh.adapterPosition
                    val g = gameAdapter.getGames().getOrNull(dragFromPos)
                    draggedGameId = g?.game_id ?: g?.id
                    vh.itemView.alpha = 0.8f
                    vh.itemView.scaleX = 1.03f
                    vh.itemView.scaleY = 1.03f
                }
            }

            override fun clearView(rv: RecyclerView, vh: RecyclerView.ViewHolder) {
                super.clearView(rv, vh)
                vh.itemView.alpha = 1f
                vh.itemView.scaleX = 1f
                vh.itemView.scaleY = 1f
                val toPos = vh.adapterPosition
                val id = draggedGameId
                if (dragFromPos >= 0 && dragFromPos != toPos && id != null) {
                    persistBacklogMove(id, dragFromPos, toPos)
                }
                dragFromPos = -1
                draggedGameId = null
            }

            override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder): Boolean {
                gameAdapter.moveItem(vh.adapterPosition, target.adapterPosition)
                return true
            }

            override fun onSwiped(vh: RecyclerView.ViewHolder, direction: Int) {}
            override fun isLongPressDragEnabled() = false
        }

        val helper = ItemTouchHelper(callback)
        helper.attachToRecyclerView(recyclerView)
        itemTouchHelper = helper
        gameAdapter.setItemTouchHelper(helper)
    }

    private fun persistBacklogMove(gameId: String, fromPos: Int, toPos: Int) {
        val delta = toPos - fromPos
        val direction = if (delta < 0) "up" else "down"
        val steps = kotlin.math.abs(delta)

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
                val token = prefs.getString("token", null) ?: return@launch
                val username = prefs.getString("username", null) ?: return@launch
                withContext(Dispatchers.IO) {
                    repeat(steps) {
                        ApiClient.api.updateBacklogOrder(
                            "Bearer $token", username, gameId, BacklogOrderRequest(direction)
                        )
                    }
                }
                loadLibrary()
            } catch (e: Exception) {
                showSnackbar("Failed to save backlog order", SnackbarHelper.Type.ERROR)
                loadLibrary()
            }
        }
    }

    // ── Status bottom sheet with adaptive CTA ─────────────────────────────────

    private fun showStatusBottomSheet(game: Game) {
        val dialog = BottomSheetDialog(requireContext())
        val sheetView = layoutInflater.inflate(R.layout.bottom_sheet_status, null)
        dialog.setContentView(sheetView)

        sheetView.findViewById<TextView>(R.id.tvSheetGameName).text = game.displayName

        // Adaptive CTA
        when (game.status?.lowercase()) {
            "playing" -> {
                sheetView.findViewById<View>(R.id.ctaMarkDone)?.visibility = View.VISIBLE
                sheetView.findViewById<View>(R.id.btnCtaMarkDone)?.setOnClickListener {
                    dialog.dismiss()
                    updateGameStatus(game, "Done")
                    showSnackbar("🎉 Congrats on finishing ${game.displayName}!", SnackbarHelper.Type.SUCCESS)
                }
            }
            "unreleased" -> {
                sheetView.findViewById<View>(R.id.ctaReleaseReminder)?.visibility = View.VISIBLE
                sheetView.findViewById<View>(R.id.btnCtaReleaseReminder)?.setOnClickListener {
                    dialog.dismiss()
                    addReleaseReminder(game)
                }
            }
        }

        val statuses = listOf("Wishlist", "Playing", "Done", "Backlog", "Unreleased")
        val ids = listOf(R.id.itemWishlist, R.id.itemPlaying, R.id.itemDone, R.id.itemBacklog, R.id.itemUnreleased)

        statuses.zip(ids).forEach { (status, id) ->
            sheetView.findViewById<View>(id).setOnClickListener {
                dialog.dismiss()
                updateGameStatus(game, status)
            }
        }
        dialog.show()
    }

    private fun addReleaseReminder(game: Game) {
        val ctx = context ?: return
        if (!CalendarHelper.isSyncEnabled(ctx)) {
            showSnackbar("Enable Calendar Sync in Profile to get release reminders")
            return
        }
        val releaseDate = game.release
        if (releaseDate.isBlank()) {
            showSnackbar("No release date known yet for ${game.displayName}")
            return
        }
        val activity = requireActivity() as? com.example.gmaetrackermobile.MainActivity ?: return
        activity.requestCalendarPermissions { granted ->
            if (!granted) {
                showSnackbar("Calendar permission required", SnackbarHelper.Type.ERROR)
                return@requestCalendarPermissions
            }
            val gameId = game.game_id ?: game.id ?: return@requestCalendarPermissions
            viewLifecycleOwner.lifecycleScope.launch {
                val result = withContext(Dispatchers.IO) {
                    CalendarHelper.addGameEvent(ctx, gameId, game.displayName, releaseDate)
                }
                if (result != null) {
                    showSnackbar("Release reminder added for ${game.displayName}", SnackbarHelper.Type.SUCCESS)
                } else {
                    showSnackbar("Couldn't add reminder — check calendar settings", SnackbarHelper.Type.ERROR)
                }
            }
        }
    }

    // ── Status update ─────────────────────────────────────────────────────────

    private fun updateGameStatus(game: Game, newStatus: String) {
        val gameId = game.game_id ?: game.id
        val index = if (gameId != null) allGames.indexOfFirst { it.game_id == gameId || it.id == gameId } else -1
        val previousGame = if (index >= 0) allGames[index] else null
        if (index >= 0) {
            allGames[index] = allGames[index].copy(status = newStatus)
            filterGames()
        }
        showSnackbar("${game.displayName} → $newStatus", SnackbarHelper.Type.SUCCESS)

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
                val token = prefs.getString("token", null) ?: return@launch
                val username = prefs.getString("username", null) ?: return@launch
                val id = game.game_id ?: game.id ?: return@launch

                val request = GameUpdateRequest(
                    gameId = id,
                    gameName = game.displayName,
                    coverUrl = game.cover,
                    releaseDate = game.release,
                    status = newStatus,
                    steamAppId = game.steam_app_id ?: game.steamAppId
                )
                val response = withContext(Dispatchers.IO) {
                    ApiClient.api.addOrUpdateGame("Bearer $token", username, request)
                }
                if (!response.isSuccessful) {
                    if (index >= 0 && previousGame != null) allGames[index] = previousGame
                    filterGames()
                    showSnackbar("Failed to update status", SnackbarHelper.Type.ERROR)
                }
            } catch (e: Exception) {
                if (index >= 0 && previousGame != null) allGames[index] = previousGame
                filterGames()
                showSnackbar("Error: ${e.message}", SnackbarHelper.Type.ERROR)
            }
        }
    }

    // ── Filter chips ──────────────────────────────────────────────────────────

    private val filterLabels = listOf("All", "Wishlist", "Playing", "Done", "Backlog", "Unreleased")
    private val filterChips = mutableMapOf<String, Chip>()

    private fun setupChipGroup() {
        if (context == null) return
        filterChips.clear()
        filterLabels.forEach { label ->
            val key = label.lowercase()
            val chip = Chip(requireContext()).apply {
                text = label
                isCheckable = true
                isChecked = label == "All"
                setOnCheckedChangeListener { _, isChecked ->
                    if (isChecked) {
                        currentFilter = key
                        gameAdapter.showBacklogControls = (currentFilter == "backlog")
                        filterGames()
                    }
                }
            }
            filterChips[key] = chip
            chipGroup.addView(chip)
        }
    }

    /** Appends live counts to each filter chip, e.g. "Playing 3". */
    private fun updateChipCounts() {
        fun n(key: String) = when (key) {
            "all" -> allGames.size
            "unreleased" -> allGames.count {
                it.status?.lowercase() == "unreleased" || it.release_date.isNullOrBlank()
            }
            else -> allGames.count { it.status?.lowercase() == key }
        }
        filterChips.forEach { (key, chip) ->
            val label = filterLabels.first { it.lowercase() == key }
            chip.text = "$label  ${n(key)}"
        }
    }

    private fun setupSwipeRefresh() {
        swipeRefreshLayout.setOnRefreshListener { loadLibrary() }
    }

    private fun setupLibrarySearch() {
        librarySearchEditText.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                searchQuery = s.toString()
                btnClearSearch.visibility = if (searchQuery.isBlank()) View.GONE else View.VISIBLE
                filterGames()
            }
            override fun afterTextChanged(s: Editable?) {}
        })
        btnClearSearch.setOnClickListener {
            librarySearchEditText.setText("")
        }
    }

    // ── Load + filter + sort ─────────────────────────────────────────────────

    private fun loadLibrary() {
        swipeRefreshLayout.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
                val token = prefs.getString("token", null) ?: run {
                    swipeRefreshLayout.isRefreshing = false; return@launch
                }
                val username = prefs.getString("username", null) ?: run {
                    swipeRefreshLayout.isRefreshing = false; return@launch
                }
                val response = withContext(Dispatchers.IO) {
                    ApiClient.api.getLibrary("Bearer $token", username)
                }
                if (response.isSuccessful) {
                    allGames.clear()
                    allGames.addAll(response.body() ?: emptyList())
                    filterGames()
                }
            } catch (e: Exception) {
                android.util.Log.e("LibraryFragment", "Load error: ${e.message}", e)
            } finally {
                swipeRefreshLayout.isRefreshing = false
            }
        }
    }

    private fun filterGames() {
        val filtered = when (currentFilter) {
            "wishlist"   -> allGames.filter { it.status?.lowercase() == "wishlist" }
            "playing"    -> allGames.filter { it.status?.lowercase() == "playing" }
            "done"       -> allGames.filter { it.status?.lowercase() == "done" }
            "backlog"    -> allGames.filter { it.status?.lowercase() == "backlog" }
                               .sortedBy { it.backlog_order ?: Int.MAX_VALUE }
            "unreleased" -> allGames.filter {
                it.status?.lowercase() == "unreleased" || it.release_date.isNullOrBlank()
            }
            else -> allGames.toList()
        }

        val searched = if (searchQuery.isBlank()) filtered
        else filtered.filter { it.displayName.lowercase().contains(searchQuery.lowercase()) }

        // Apply sort (skip when backlog — order is fixed there)
        val sorted = if (currentFilter == "backlog") searched else applySortToList(searched)

        gameAdapter.submitList(sorted)
        emptyStateLayout.visibility = if (sorted.isEmpty()) View.VISIBLE else View.GONE
        recyclerView.visibility = if (sorted.isEmpty()) View.GONE else View.VISIBLE
        updateStats()
    }

    // ── Delete with undo ──────────────────────────────────────────────────────

    private fun deleteGameFromLibrary(game: Game) {
        val gameId = game.game_id ?: game.id ?: return

        allGames.removeAll { it.game_id == gameId || it.id == gameId }
        filterGames()

        val snackbar = Snackbar.make(requireView(), "\"${game.displayName}\" removed", 5000)
        snackbar.setAction("UNDO") {
            allGames.add(game)
            filterGames()
        }
        activity?.findViewById<android.view.View>(R.id.bottom_navigation)
            ?.let { snackbar.anchorView = it }
        SnackbarHelper.applyStyle(snackbar, SnackbarHelper.Type.DEFAULT)
        snackbar.addCallback(object : Snackbar.Callback() {
            override fun onDismissed(transientBottomBar: Snackbar, event: Int) {
                if (event == DISMISS_EVENT_ACTION) return
                viewLifecycleOwner.lifecycleScope.launch {
                    try {
                        val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
                        val token = prefs.getString("token", null) ?: return@launch
                        val username = prefs.getString("username", null) ?: return@launch
                        val response = withContext(Dispatchers.IO) {
                            ApiClient.api.deleteGame("Bearer $token", username, gameId)
                        }
                        if (response.isSuccessful) {
                            withContext(Dispatchers.IO) {
                                CalendarHelper.deleteGameEvent(requireContext(), gameId)
                            }
                        } else {
                            allGames.add(game)
                            filterGames()
                            showSnackbar("Failed to remove ${game.displayName}", SnackbarHelper.Type.ERROR)
                        }
                    } catch (e: Exception) {
                        allGames.add(game)
                        filterGames()
                        showSnackbar("Error: ${e.message}", SnackbarHelper.Type.ERROR)
                    }
                }
            }
        })
        snackbar.show()
    }

    // ── Stats ─────────────────────────────────────────────────────────────────

    private fun updateStats() {
        val v = view ?: return
        val hours = allGames.sumOf { com.example.gmaetrackermobile.GameExtras.hours(it) }
        v.findViewById<TextView>(R.id.tvTotalGames)?.text =
            "${allGames.size} games · ${hours}h tracked"
        updateChipCounts()
    }

    private fun showSnackbar(message: String, type: SnackbarHelper.Type = SnackbarHelper.Type.DEFAULT) {
        SnackbarHelper.show(this, message, type)
    }

    override fun onGameStatusUpdated() = loadLibrary()
}
