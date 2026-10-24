package ink.etech.gametracker.fragments

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
import ink.etech.gametracker.ApiClient
import ink.etech.gametracker.CalendarHelper
import ink.etech.gametracker.Game
import ink.etech.gametracker.SafeUrl
import ink.etech.gametracker.GameExtras
import ink.etech.gametracker.GameStatus
import ink.etech.gametracker.R
import ink.etech.gametracker.SnackbarHelper
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ink.etech.gametracker.Session
import ink.etech.gametracker.ErrorText
import ink.etech.gametracker.LibraryAdd
import ink.etech.gametracker.LibraryMatch

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
    private lateinit var btnAddToLibrary: Button
    private lateinit var cardStatus: View
    private lateinit var cardRating: View
    private lateinit var cardNotes: View

    /** False for a search result not in the library: only "Add to library" is offered (MOB-16). */
    private var inLibrary = true

    private var currentGame: Game? = null
    private var currentStatus: String = ""

    companion object {
        private const val ARG_GAME = "game"
        private const val ARG_IN_LIBRARY = "in_library"
        // Never Unreleased: the server decides that from the date (MOB-13).
        private val STATUS_OPTIONS = GameStatus.PICKABLE
        private val STATUS_COLORS = mapOf(
            "wishlist" to "#8890A8", "backlog" to "#F97316",
            "playing" to "#22B8F6", "done" to "#22C55E"
        )

        /**
         * [inLibrary]: whether [game] is the user's own library row. A search result that is
         * not shows only "Add to library": Remove, Refresh, the status chips (which silently
         * ADDED the game), rating and notes all belong to a library entry (MOB-16).
         */
        fun newInstance(game: Game, inLibrary: Boolean = true): GameDetailsFragment =
            GameDetailsFragment().apply {
                arguments = Bundle().apply {
                    putParcelable(ARG_GAME, game)
                    putBoolean(ARG_IN_LIBRARY, inLibrary)
                }
            }
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.fragment_game_details, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        currentGame = arguments?.getParcelable(ARG_GAME)
        inLibrary = arguments?.getBoolean(ARG_IN_LIBRARY, true) ?: true
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
        showLibraryActions()
    }

    /** Library actions for a library entry; only "Add to library" for anything else (MOB-16). */
    private fun showLibraryActions() {
        val library = if (inLibrary) View.VISIBLE else View.GONE
        cardStatus.visibility = library
        cardRating.visibility = library
        cardNotes.visibility = library
        btnRefreshMetadata.visibility = library
        btnRemoveFromLibrary.visibility = library
        btnAddToLibrary.visibility = if (inLibrary) View.GONE else View.VISIBLE
    }

    private fun addToLibrary() {
        val game = currentGame ?: return
        btnAddToLibrary.isEnabled = false
        viewLifecycleOwner.lifecycleScope.launch {
            // The same fresh-library check as Search (MOB-10), in one place.
            val outcome = LibraryAdd.add(requireContext(), game)
            btnAddToLibrary.isEnabled = true
            val row = when (outcome) {
                is LibraryAdd.Outcome.Added -> outcome.library?.let { LibraryMatch.owned(it, game) }
                    ?: game.copy(status = outcome.saved)
                is LibraryAdd.Outcome.AlreadyOwned -> outcome.owned
                else -> null
            }
            showSnackbar(LibraryAdd.message(game, outcome), when (outcome) {
                is LibraryAdd.Outcome.Added -> SnackbarHelper.Type.SUCCESS
                is LibraryAdd.Outcome.AlreadyOwned -> SnackbarHelper.Type.DEFAULT
                else -> SnackbarHelper.Type.ERROR
            })
            if (row != null) {
                // Now a library entry: its real status, and the library actions.
                currentGame = row
                inLibrary = true
                setupStatusChips()
                setupRating()
                loadNoteForCurrentGame()
                showLibraryActions()
            }
        }
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
        btnAddToLibrary = view.findViewById(R.id.btnAddToLibrary)
        cardStatus = view.findViewById(R.id.cardStatus)
        cardRating = view.findViewById(R.id.cardRating)
        cardNotes = view.findViewById(R.id.cardNotes)
    }

    private fun populateGameDetails() {
        val game = currentGame ?: return
        tvGameTitle.text = game.displayName

        // The year only: the genre that used to follow it was invented (MOB-11).
        tvMeta.text = GameExtras.subtitle(game)

        val price = game.last_price
        tvPrice.text = if (!price.isNullOrBlank()) price else "TBA"

        val coverUrl = SafeUrl.https(game.cover)   // https only (MOB-8)
        if (coverUrl != null) {
            Glide.with(this)
                .load(coverUrl)
                .transition(DrawableTransitionOptions.withCrossFade(250))
                .into(ivGameCover)
        }

        // Where "Nh played" was (invented, MOB-11): the rating beside it is stored on this
        // device only, and the card says so.
        tvHoursPlayed.visibility = View.GONE
    }

    // ── Status chips ─────────────────────────────────────────────────────────

    private fun setupStatusChips() {
        val game = currentGame ?: return
        currentStatus = GameStatus.canonical(game.status) ?: GameStatus.WISHLIST
        chipGroupStatus.removeAllViews()

        // Unreleased is the server's conclusion, never a choice (MOB-13), but the card must still
        // SAY it: a checked chip that cannot be tapped, ahead of the four choices.
        val shown = if (currentStatus == GameStatus.UNRELEASED) listOf(GameStatus.UNRELEASED) + STATUS_OPTIONS else STATUS_OPTIONS
        shown.forEach { status ->
            val color = Color.parseColor(STATUS_COLORS[status] ?: "#8890A8")
            val chip = Chip(requireContext()).apply {
                text = GameStatus.label(status)
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
                    intArrayOf(Color.parseColor("#0C0D11"), Color.parseColor("#8890A8"))   // gt_on_status when checked (MOB-29)
                ))
                isCheckedIconVisible = false
                if (status == GameStatus.UNRELEASED) {
                    isClickable = false
                    isFocusable = false
                    contentDescription = if (game.release.isBlank()) "Status: Unreleased. No release date yet."
                        else "Status: Unreleased until ${game.release}."
                } else {
                    setOnClickListener {
                        isChecked = true
                        updateGameStatus(status)
                    }
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
        val empty = Color.parseColor("#858CA4")   // gt_text_muted: 3:1+ for a control (MOB-29)
        for (i in 1..5) {
            val star = ImageView(requireContext()).apply {
                setImageResource(R.drawable.ic_star)
                imageTintList = ColorStateList.valueOf(if (i <= rating) gold else empty)
                layoutParams = LinearLayout.LayoutParams(size, size).apply {
                    marginEnd = (8 * density).toInt()
                }
                // MOB-30: say the current value, not only "Rate 3 star".
                contentDescription = if (i == rating) "Rated $i of 5. Tap to clear the rating."
                    else "Rate $i of 5" + if (i == 1 && rating == 0) ". Not rated yet." else ""
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
        btnRemoveFromLibrary.setOnClickListener { confirmRemove() }
        btnAddToLibrary.setOnClickListener { addToLibrary() }
        btnBack.setOnClickListener {
            requireActivity().supportFragmentManager.popBackStack()
        }
        btnSaveNote.setOnClickListener { saveNoteForCurrentGame() }
    }

    // ── Personal Notes ───────────────────────────────────────────────────────

    // One store, per account (MOB-7): this used to write app_prefs while GameExtras read
    // game_extras, so the two never agreed.
    private fun loadNoteForCurrentGame() {
        val game = currentGame ?: return
        etGameNotes.setText(GameExtras.note(requireContext(), game))
    }

    private fun saveNoteForCurrentGame() {
        val game = currentGame ?: return
        GameExtras.setNote(requireContext(), game, etGameNotes.text.toString())
        showSnackbar("Note saved", SnackbarHelper.Type.SUCCESS)
    }

    // ── Status update ────────────────────────────────────────────────────────

    private fun updateGameStatus(newStatus: String) {
        if (newStatus == currentStatus) return
        val game = currentGame ?: return
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val session = Session.get(requireContext())
                val token = session.token ?: run {
                    showSnackbar("You're signed out. Sign in again.", SnackbarHelper.Type.ERROR); return@launch
                }
                val username = session.username ?: run {
                    showSnackbar("You're signed out. Sign in again.", SnackbarHelper.Type.ERROR); return@launch
                }
                val gameRequest = GameStatus.request(game, newStatus)
                val response = withContext(Dispatchers.IO) {
                    ApiClient.api.addOrUpdateGame("Bearer $token", username, gameRequest)
                }
                withContext(Dispatchers.Main) {
                    if (response.isSuccessful) {
                        // What the server stored, which the date can make different (MOB-13).
                        val answer = response.body()
                        val saved = GameStatus.stored(newStatus, answer)
                        currentStatus = saved
                        currentGame = game.copy(status = saved)
                        setupStatusChips()
                        val coerced = answer?.coerced == true
                        showSnackbar(GameStatus.outcome(game, newStatus, answer),
                            if (coerced) SnackbarHelper.Type.DEFAULT else SnackbarHelper.Type.SUCCESS,
                            if (coerced) Snackbar.LENGTH_LONG else Snackbar.LENGTH_SHORT)
                    } else {
                        setupStatusChips()
                        showSnackbar("Couldn't save the status. Try again.", SnackbarHelper.Type.ERROR)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    setupStatusChips()   // undo the tapped chip's optimistic check
                    showSnackbar(ErrorText.action(e, "Couldn't save the status."), SnackbarHelper.Type.ERROR)
                }
            }
        }
    }

    private fun refreshMetadata() {
        val game = currentGame ?: return
        btnRefreshMetadata.isEnabled = false
        btnRefreshMetadata.text = "…"
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val session = Session.get(requireContext())
                val token = session.token ?: run { restoreRefreshButton(); return@launch }
                val username = session.username ?: run { restoreRefreshButton(); return@launch }
                val gameId = game.game_id ?: game.id ?: run { restoreRefreshButton(); return@launch }
                val response = withContext(Dispatchers.IO) {
                    ApiClient.api.refreshGameMetadata("Bearer $token", username, gameId)
                }
                withContext(Dispatchers.Main) {
                    restoreRefreshButton()
                    if (response.isSuccessful) {
                        showSnackbar("Game data refreshed", SnackbarHelper.Type.SUCCESS)
                    } else {
                        showSnackbar("Couldn't refresh the game data. Try again.", SnackbarHelper.Type.ERROR)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    restoreRefreshButton()
                    showSnackbar(ErrorText.action(e, "Couldn't refresh the game data."), SnackbarHelper.Type.ERROR)
                }
            }
        }
    }

    private fun restoreRefreshButton() {
        btnRefreshMetadata.isEnabled = true
        btnRefreshMetadata.text = "Refresh"
    }

    /** No undo on this screen, so it asks first (MOB-16); the library list has its 5-second undo. */
    private fun confirmRemove() {
        val game = currentGame ?: return
        com.google.android.material.dialog.MaterialAlertDialogBuilder(requireContext())
            .setTitle("Remove ${game.displayName}?")
            .setMessage("It's removed from your library on the server. Notes and ratings stored on this phone are kept.")
            .setPositiveButton("Remove") { _, _ -> removeGameFromLibrary() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun removeGameFromLibrary() {
        val game = currentGame ?: return
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val session = Session.get(requireContext())
                val token = session.token ?: run {
                    showSnackbar("You're signed out. Sign in again.", SnackbarHelper.Type.ERROR); return@launch
                }
                val username = session.username ?: run {
                    showSnackbar("You're signed out. Sign in again.", SnackbarHelper.Type.ERROR); return@launch
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
                        requireActivity().supportFragmentManager.popBackStack()
                    } else {
                        showSnackbar("Couldn't remove the game. Try again.", SnackbarHelper.Type.ERROR)
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { showSnackbar(ErrorText.action(e, "Couldn't remove the game."), SnackbarHelper.Type.ERROR) }
            }
        }
    }

    private fun showSnackbar(
        message: String,
        type: SnackbarHelper.Type = SnackbarHelper.Type.DEFAULT,
        duration: Int = Snackbar.LENGTH_SHORT,
    ) {
        SnackbarHelper.show(this, message, type, duration)
    }
}
