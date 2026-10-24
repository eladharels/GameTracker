package ink.etech.gametracker

import android.annotation.SuppressLint
import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.resource.drawable.DrawableTransitionOptions

class GameAdapter(
    private val onAddToLibrary: (Game) -> Unit,
    private val hideAddButton: Boolean = false,
    private val onItemClick: ((Game) -> Unit)? = null,
    private val onDelete: ((Game) -> Unit)? = null,
    private val onLongPress: ((Game) -> Unit)? = null
) : RecyclerView.Adapter<GameAdapter.GameViewHolder>() {

    private var games: MutableList<Game> = mutableListOf()
    var showBacklogControls: Boolean = false
    /** Each backlog game's position in the WHOLE backlog (BacklogOrder.positions, MOB-14). */
    var backlogPositions: Map<String, Int> = emptyMap()
    /** Off while a search narrows the backlog: no handle that does nothing (MOB-14). */
    var dragEnabled: Boolean = true

    /**
     * Search only (MOB-10): the status of the library game this result IS, or null when it is
     * not in the library. An owned result gets an "In library · Done" badge instead of the
     * Add button, because v1's add overwrites the stored status: Add on a finished game
     * demoted it to wishlist.
     */
    var ownedStatusOf: ((Game) -> String?)? = null

    /**
     * MOB-30: reordering by accessibility action ("Move up" / "Move down"), because a drag
     * handle is unreachable with TalkBack (the web's FE-23). Called after the move, to persist.
     */
    var onReordered: (() -> Unit)? = null
    private var itemTouchHelper: ItemTouchHelper? = null

    fun setItemTouchHelper(helper: ItemTouchHelper) {
        itemTouchHelper = helper
    }

    fun submitList(list: List<Game>?) {
        val newList = (list ?: emptyList())
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
            override fun getOldListSize() = games.size
            override fun getNewListSize() = newList.size
            override fun areItemsTheSame(oldPos: Int, newPos: Int): Boolean {
                val old = games[oldPos]
                val new = newList[newPos]
                return (old.game_id != null && old.game_id == new.game_id) ||
                        (old.id != null && old.id == new.id)
            }
            override fun areContentsTheSame(oldPos: Int, newPos: Int) = games[oldPos] == newList[newPos]
        })
        games = newList.toMutableList()
        diff.dispatchUpdatesTo(this)
    }

    fun moveItem(from: Int, to: Int) {
        val item = games.removeAt(from)
        games.add(to, item)
        notifyItemMoved(from, to)
    }

    fun getGames(): List<Game> = games

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): GameViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_game, parent, false)
        return GameViewHolder(view)
    }

    override fun onBindViewHolder(holder: GameViewHolder, position: Int) {
        holder.bind(games[position])
    }

    override fun getItemCount(): Int = games.size

    @SuppressLint("ClickableViewAccessibility")
    inner class GameViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val tvName: TextView = itemView.findViewById(R.id.tvName)
        private val ivCover: ImageView = itemView.findViewById(R.id.ivCover)
        private val btnAdd: Button = itemView.findViewById(R.id.btnAdd)
        private val btnDelete: ImageButton = itemView.findViewById(R.id.btnDelete)
        private val tvReleaseDate: TextView = itemView.findViewById(R.id.tvReleaseDate)
        private val tvStatus: TextView = itemView.findViewById(R.id.tvStatus)
        private val tvPrice: TextView = itemView.findViewById(R.id.tvPrice)
        private val tvBacklogPosition: TextView = itemView.findViewById(R.id.tvBacklogPosition)
        private val viewStatusBorder: View = itemView.findViewById(R.id.viewStatusBorder)
        private val ivDragHandle: ImageView = itemView.findViewById(R.id.ivDragHandle)

        /** Accessibility actions added by the last bind, removed before the next (rows are reused). */
        private val actionIds = mutableListOf<Int>()

        private fun action(label: String, run: () -> Unit) {
            actionIds += ViewCompat.addAccessibilityAction(itemView, label) { _, _ -> run(); true }
        }

        private fun bindAccessibilityActions(game: Game, position: Int?) {
            actionIds.forEach { ViewCompat.removeAccessibilityAction(itemView, it) }
            actionIds.clear()
            if (onLongPress != null) action("Change status") { onLongPress?.invoke(game) }
            if (!showBacklogControls || !dragEnabled || position == null) return
            val at = bindingAdapterPosition
            if (at > 0) action("Move up") { moveBy(-1) }
            if (at != RecyclerView.NO_POSITION && at < games.size - 1) action("Move down") { moveBy(1) }
        }

        private fun moveBy(delta: Int) {
            val from = bindingAdapterPosition
            val to = from + delta
            if (from == RecyclerView.NO_POSITION || to !in games.indices) return
            moveItem(from, to)
            onReordered?.invoke()
            itemView.announceForAccessibility("Moved to position ${to + 1}")
        }

        fun bind(game: Game) {
            tvName.text = game.displayName
            tvReleaseDate.text = formatReleaseLabel(game.release)

            // Status badge + left border color. A search result carries no status of its
            // own; when it is already in the library, the badge shows the library's.
            val ownedStatus = if (game.status == null) ownedStatusOf?.invoke(game) else null
            val status = game.status ?: ownedStatus ?: ""
            val statusColor = when (status.lowercase()) {
                "playing" -> ContextCompat.getColor(itemView.context, R.color.gt_status_playing)
                "done" -> ContextCompat.getColor(itemView.context, R.color.gt_status_done)
                "backlog" -> ContextCompat.getColor(itemView.context, R.color.gt_status_backlog)
                "unreleased" -> ContextCompat.getColor(itemView.context, R.color.gt_status_unreleased)
                else -> ContextCompat.getColor(itemView.context, R.color.gt_status_wishlist)
            }
            viewStatusBorder.setBackgroundColor(statusColor)

            if (status.isNotBlank()) {
                val label = status.replaceFirstChar { it.uppercase() }
                tvStatus.text = if (ownedStatus != null) "In library · $label" else label
                tvStatus.visibility = View.VISIBLE
                tvStatus.backgroundTintList = ColorStateList.valueOf(statusColor)
            } else {
                tvStatus.visibility = View.GONE
            }

            // Steam price
            val price = game.last_price
            if (!price.isNullOrBlank()) {
                tvPrice.text = price
                tvPrice.visibility = View.VISIBLE
            } else {
                tvPrice.visibility = View.GONE
            }

            // Cover with fade-in
            val coverUrl = SafeUrl.https(game.cover)   // https only (MOB-8)
            if (coverUrl != null) {
                Glide.with(itemView)
                    .load(coverUrl)
                    .transition(DrawableTransitionOptions.withCrossFade(200))
                    .placeholder(R.drawable.rounded_image_bg)
                    .into(ivCover)
            } else {
                ivCover.setImageResource(android.R.drawable.ic_menu_report_image)
            }

            // Backlog controls
            val position = backlogPositions[game.game_id ?: game.id ?: ""]
            if (showBacklogControls && position != null) {
                // The position in the list, as Home shows it: never the stored number, which
                // can have gaps (MOB-14, the web's FE-24).
                tvBacklogPosition.text = "#$position"
                tvBacklogPosition.visibility = View.VISIBLE
                ivDragHandle.visibility = if (dragEnabled) View.VISIBLE else View.GONE
                ivDragHandle.setOnTouchListener { _, event ->
                    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                        itemTouchHelper?.startDrag(this)
                    }
                    false
                }
            } else {
                tvBacklogPosition.visibility = View.GONE
                ivDragHandle.visibility = View.GONE
                ivDragHandle.setOnTouchListener(null)
            }

            bindAccessibilityActions(game, position)

            // Add / Delete
            if (hideAddButton) {
                btnAdd.visibility = View.GONE
                btnDelete.visibility = View.VISIBLE
                btnDelete.setOnClickListener { onDelete?.invoke(game) }
            } else {
                // No Add for a game the user already owns (MOB-10); the badge above says so.
                btnAdd.visibility = if (ownedStatus != null) View.GONE else View.VISIBLE
                btnAdd.contentDescription = "Add ${game.displayName} to library"
                btnAdd.setOnClickListener { onAddToLibrary(game) }
                btnDelete.visibility = View.GONE
            }

            itemView.setOnClickListener { onItemClick?.invoke(game) }
            itemView.setOnLongClickListener {
                onLongPress?.invoke(game)
                true
            }

            // Press scale animation for tactile feedback
            itemView.setOnTouchListener { v, event ->
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> v.animate().scaleX(0.97f).scaleY(0.97f).setDuration(80).start()
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                        v.animate().scaleX(1f).scaleY(1f).setDuration(100).start()
                }
                false
            }
        }
    }
}
