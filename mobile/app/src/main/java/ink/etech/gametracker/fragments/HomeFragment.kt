package ink.etech.gametracker.fragments

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
import ink.etech.gametracker.ApiClient
import ink.etech.gametracker.BacklogOrder
import ink.etech.gametracker.ContinueAdapter
import ink.etech.gametracker.Game
import ink.etech.gametracker.MainActivity
import ink.etech.gametracker.R
import ink.etech.gametracker.UpNextAdapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Calendar
import ink.etech.gametracker.Session
import ink.etech.gametracker.LibraryRepository

class HomeFragment : Fragment() {

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

    // A hidden tab is resumed with the activity too: only the visible one reads (MOB-19).
    override fun onResume() {
        super.onResume()
        if (!isHidden) loadLibrary()
    }

    /** Shown again, by a tab tap or by Back from Game Details (MOB-19). */
    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden && view != null) loadLibrary()
    }

    private fun setupHeader(view: View) {
        val session = Session.get(requireContext())
        val username = session.username ?: "Player"
        val displayName = username   // display_name was never written on the phone (MOB-22)

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
        (activity as? MainActivity)?.openDetails(GameDetailsFragment.newInstance(game))
    }

    /** From the shared copy (MOB-19): opening the tab no longer downloads the library twice. */
    private fun loadLibrary() {
        val ctx = context ?: return
        LibraryRepository.peek(ctx)?.let { bind(it) }
        viewLifecycleOwner.lifecycleScope.launch {
            val games = LibraryRepository.load(ctx)
            if (!isAdded) return@launch
            if (games != null) {
                bind(games)
            } else {
                // It used to fail in silence: zeros everywhere, as if the library were empty.
                ink.etech.gametracker.SnackbarHelper.show(
                    this@HomeFragment,
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

        val playing = games.filter { it.status?.lowercase() == "playing" }
        val backlog = BacklogOrder.backlog(games)   // the Library's order, from one place
        val done = games.filter { it.status?.lowercase() == "done" }
        val wishlist = games.count { it.status?.lowercase() == "wishlist" }

        setStat(v, R.id.cardPlaying, playing.size.toString(), "Now playing", R.color.gt_status_playing)
        setStat(v, R.id.cardBacklog, backlog.size.toString(), "In backlog", R.color.gt_status_backlog)
        setStat(v, R.id.cardDone, done.size.toString(), "Completed", R.color.gt_status_done)
        // Was "Hours tracked", invented from a hash of each game id (MOB-11).
        setStat(v, R.id.cardHours, wishlist.toString(), "On wishlist", R.color.gt_status_wishlist)

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
