package com.example.gmaetrackermobile.fragments

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.bumptech.glide.Glide
import com.bumptech.glide.load.resource.drawable.DrawableTransitionOptions
import com.example.gmaetrackermobile.ApiClient
import com.example.gmaetrackermobile.CalendarHelper
import com.example.gmaetrackermobile.Game
import com.example.gmaetrackermobile.GameExtras
import com.example.gmaetrackermobile.GameUpdateRequest
import com.example.gmaetrackermobile.R
import com.example.gmaetrackermobile.SnackbarHelper
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class GameDetailsFragment : Fragment() {

    private lateinit var ivGameCover: ImageView
    private lateinit var tvGameTitle: TextView
    private lateinit var tvMeta: TextView
    private lateinit var tvPrice: TextView
    private lateinit var chipGroupStatus: ChipGroup
    private lateinit var starContainer: LinearLayout
    private lateinit var tvHoursPlayed: TextView
    private lateinit var btnRefreshMetadata: Button
    private lateinit var btnRemoveFromLibrary: Button
    private lateinit var btnBack: View
    private lateinit var etGameNotes: EditText
    private lateinit var btnSaveNote: Button

    private var currentGame: Game? = null
    private var currentStatus: String = ""

    companion object {
        private const val ARG_GAME = "game"
        private val STATUS_OPTIONS = listOf("Wishlist", "Backlog", "Playing", "Done")
        private val STATUS_COLORS = mapOf(
            "wishlist" to "#8890A8", "backlog" to "#F97316",
            "playing" to "#22B8F6", "done" to "#22C55E"
        )

        fun newInstance(game: Game): GameDetailsFragment =
            GameDetailsFragment().apply {
                arguments = Bundle().apply { putParcelable(ARG_GAME, game) }
            }
    }

    interface GameDetailsCallback {
        fun onGameStatusUpdated()
    }

    private var callback: GameDetailsCallback? = null

    override fun onAttach(context: Context) {
        super.onAttach(context)
        callback = parentFragment as? GameDetailsCallback
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_game_details, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        currentGame = arguments?.getParcelable(ARG_GAME)
        if (currentGame == null) {
            showSnackbar("Game information not found")
            requireActivity().supportFragmentManager.popBackStack()
            return
        }
        initializeViews(view)
        populateGameDetails()
        setupStatusChips()
        setupRating()
        setupClickListeners()
        loadNoteForCurrentGame()
    }

    private fun initializeViews(view: View) {
        ivGameCover = view.findViewById(R.id.ivGameCover)
        tvGameTitle = view.findViewById(R.id.tvGameTitle)
        tvMeta = view.findViewById(R.id.tvReleaseDate)
        tvPrice = view.findViewById(R.id.tvPrice)
        chipGroupStatus = view.findViewById(R.id.chipGroupStatus)
        starContainer = view.findViewById(R.id.starContainer)
        tvHoursPlayed = view.findViewById(R.id.tvHoursPlayed)
        btnRefreshMetadata = view.findViewById(R.id.btnRefreshMetadata)
        btnRemoveFromLibrary = view.findViewById(R.id.btnRemoveFromLibrary)
        btnBack = view.findViewById(R.id.btnBack)
        etGameNotes = view.findViewById(R.id.etGameNotes)
        btnSaveNote = view.findViewById(R.id.btnSaveNote)
    }

    private fun populateGameDetails() {
        val game = currentGame ?: return
        tvGameTitle.text = game.displayName

        // The year only: the genre that used to follow it was invented (MOB-11).
        tvMeta.text = GameExtras.subtitle(game)

        val price = game.last_price
        tvPrice.text = if (!price.isNullOrBlank()) price else "TBA"

        if (!game.cover.isNullOrBlank()) {
            Glide.with(this)
                .load(game.cover)
                .transition(DrawableTransitionOptions.withCrossFade(250))
                .into(ivGameCover)
        }

        // Where "Nh played" was (invented, MOB-11): the rating beside it is stored on this
        // device only, and the card says so.
        tvHoursPlayed.text = "Not synced"
    }

    // ── Status chips ─────────────────────────────────────────────────────────

    private fun setupStatusChips() {
        val game = currentGame ?: return
        currentStatus = game.status ?: "Wishlist"
        chipGroupStatus.removeAllViews()

        STATUS_OPTIONS.forEach { status ->
            val key = status.lowercase()
            val color = Color.parseColor(STATUS_COLORS[key] ?: "#8890A8")
            val chip = Chip(requireContext()).apply {
                text = status
                isCheckable = true
                isChecked = currentStatus.equals(status, ignoreCase = true)
                chipStrokeWidth = resources.displayMetrics.density * 1.5f
                chipBackgroundColor = ColorStateList(
                    arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
                    intArrayOf(color, Color.parseColor("#0F1118"))
                )
                chipStrokeColor = ColorStateList(
                    arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
                    intArrayOf(color, Color.parseColor("#1AFFFFFF"))
                )
                setTextColor(ColorStateList(
                    arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
                    intArrayOf(Color.WHITE, Color.parseColor("#8890A8"))
                ))
                isCheckedIconVisible = false
                setOnClickListener {
                    isChecked = true
                    updateGameStatus(status)
                }
            }
            chipGroupStatus.addView(chip)
        }
    }

    // ── Star rating (local) ──────────────────────────────────────────────────

    private fun setupRating() { drawStars(GameExtras.rating(requireContext(), currentGame ?: return)) }

    private fun drawStars(rating: Int) {
        val game = currentGame ?: return
        starContainer.removeAllViews()
        val density = resources.displayMetrics.density
        val size = (30 * density).toInt()
        val gold = Color.parseColor("#FBBF24")
        val empty = Color.parseColor("#4A5068")
        for (i in 1..5) {
            val star = ImageView(requireContext()).apply {
                setImageResource(R.drawable.ic_star)
                imageTintList = ColorStateList.valueOf(if (i <= rating) gold else empty)
                layoutParams = LinearLayout.LayoutParams(size, size).apply {
                    marginEnd = (8 * density).toInt()
                }
                contentDescription = "Rate $i star"
                setOnClickListener {
                    val newRating = if (rating == i) 0 else i
                    GameExtras.setRating(requireContext(), game, newRating)
                    drawStars(newRating)
                }
            }
            starContainer.addView(star)
        }
    }

    private fun setupClickListeners() {
        btnRefreshMetadata.setOnClickListener { refreshMetadata() }
        btnRemoveFromLibrary.setOnClickListener { removeGameFromLibrary() }
        btnBack.setOnClickListener {
            callback?.onGameStatusUpdated()
            requireActivity().supportFragmentManager.popBackStack()
        }
        btnSaveNote.setOnClickListener { saveNoteForCurrentGame() }
    }

    // ── Personal Notes ───────────────────────────────────────────────────────

    private fun noteKey(gameId: String): String {
        val safe = gameId.replace(Regex("[^a-zA-Z0-9_\\-]"), "_")
        return "note_$safe"
    }

    private fun loadNoteForCurrentGame() {
        val gameId = currentGame?.game_id ?: currentGame?.id ?: return
        val prefs = requireContext().getSharedPreferences("app_prefs", Context.MODE_PRIVATE)
        etGameNotes.setText(prefs.getString(noteKey(gameId), ""))
    }

    private fun saveNoteForCurrentGame() {
        val gameId = currentGame?.game_id ?: currentGame?.id ?: return
        val note = etGameNotes.text.toString()
        val prefs = requireContext().getSharedPreferences("app_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString(noteKey(gameId), note).apply()
        showSnackbar("Note saved", SnackbarHelper.Type.SUCCESS)
    }

    // ── Status update ────────────────────────────────────────────────────────

    private fun updateGameStatus(newStatus: String) {
        if (newStatus == currentStatus) return
        val game = currentGame ?: return
        lifecycleScope.launch {
            try {
                val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
                val token = prefs.getString("token", null) ?: run {
                    showSnackbar("Authentication error", SnackbarHelper.Type.ERROR); return@launch
                }
                val username = prefs.getString("username", null) ?: run {
                    showSnackbar("Authentication error", SnackbarHelper.Type.ERROR); return@launch
                }
                val gameRequest = GameUpdateRequest(
                    gameId = game.game_id ?: game.id ?: "",
                    gameName = game.displayName,
                    coverUrl = game.cover,
                    releaseDate = game.release,
                    status = newStatus,
                    steamAppId = game.steam_app_id ?: game.steamAppId
                )
                val response = withContext(Dispatchers.IO) {
                    ApiClient.api.addOrUpdateGame("Bearer $token", username, gameRequest)
                }
                withContext(Dispatchers.Main) {
                    if (response.isSuccessful) {
                        currentStatus = newStatus
                        currentGame = game.copy(status = newStatus)
                        showSnackbar("Status: $newStatus", SnackbarHelper.Type.SUCCESS)
                        callback?.onGameStatusUpdated()
                    } else {
                        showSnackbar("Failed to update status", SnackbarHelper.Type.ERROR)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { showSnackbar("Error: ${e.message}", SnackbarHelper.Type.ERROR) }
            }
        }
    }

    private fun refreshMetadata() {
        val game = currentGame ?: return
        btnRefreshMetadata.isEnabled = false
        btnRefreshMetadata.text = "…"
        lifecycleScope.launch {
            try {
                val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
                val token = prefs.getString("token", null) ?: run { restoreRefreshButton(); return@launch }
                val username = prefs.getString("username", null) ?: run { restoreRefreshButton(); return@launch }
                val gameId = game.game_id ?: game.id ?: run { restoreRefreshButton(); return@launch }
                val response = withContext(Dispatchers.IO) {
                    ApiClient.api.refreshGameMetadata("Bearer $token", username, gameId)
                }
                withContext(Dispatchers.Main) {
                    restoreRefreshButton()
                    if (response.isSuccessful) {
                        showSnackbar("Game data refreshed", SnackbarHelper.Type.SUCCESS)
                        callback?.onGameStatusUpdated()
                    } else {
                        showSnackbar("Failed to refresh game data", SnackbarHelper.Type.ERROR)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    restoreRefreshButton()
                    showSnackbar("Error: ${e.message}", SnackbarHelper.Type.ERROR)
                }
            }
        }
    }

    private fun restoreRefreshButton() {
        btnRefreshMetadata.isEnabled = true
        btnRefreshMetadata.text = "Refresh"
    }

    private fun removeGameFromLibrary() {
        val game = currentGame ?: return
        lifecycleScope.launch {
            try {
                val prefs = requireContext().getSharedPreferences("auth", Context.MODE_PRIVATE)
                val token = prefs.getString("token", null) ?: run {
                    showSnackbar("Authentication error", SnackbarHelper.Type.ERROR); return@launch
                }
                val username = prefs.getString("username", null) ?: run {
                    showSnackbar("Authentication error", SnackbarHelper.Type.ERROR); return@launch
                }
                val gameId = game.game_id ?: game.id ?: ""
                val response = withContext(Dispatchers.IO) {
                    ApiClient.api.deleteGame("Bearer $token", username, gameId)
                }
                if (response.isSuccessful) {
                    withContext(Dispatchers.IO) { CalendarHelper.deleteGameEvent(requireContext(), gameId) }
                }
                withContext(Dispatchers.Main) {
                    if (response.isSuccessful) {
                        showSnackbar("${game.displayName} removed")
                        callback?.onGameStatusUpdated()
                        requireActivity().supportFragmentManager.popBackStack()
                    } else {
                        showSnackbar("Failed to remove game", SnackbarHelper.Type.ERROR)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { showSnackbar("Error: ${e.message}", SnackbarHelper.Type.ERROR) }
            }
        }
    }

    private fun showSnackbar(message: String, type: SnackbarHelper.Type = SnackbarHelper.Type.DEFAULT) {
        SnackbarHelper.show(this, message, type)
    }
}
