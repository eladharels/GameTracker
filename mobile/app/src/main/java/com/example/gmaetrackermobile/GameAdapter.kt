package com.example.gmaetrackermobile

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

        fun bind(game: Game) {
            tvName.text = game.displayName
            tvReleaseDate.text = formatReleaseLabel(game.release)

            // Status badge + left border color
            val status = game.status ?: ""
            val statusColor = when (status.lowercase()) {
                "playing" -> ContextCompat.getColor(itemView.context, R.color.gt_status_playing)
                "done" -> ContextCompat.getColor(itemView.context, R.color.gt_status_done)
                "backlog" -> ContextCompat.getColor(itemView.context, R.color.gt_status_backlog)
                "unreleased" -> ContextCompat.getColor(itemView.context, R.color.gt_status_unreleased)
                else -> ContextCompat.getColor(itemView.context, R.color.gt_status_wishlist)
            }
            viewStatusBorder.setBackgroundColor(statusColor)

            if (status.isNotBlank()) {
                tvStatus.text = status.replaceFirstChar { it.uppercase() }
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
            if (!game.cover.isNullOrBlank()) {
                Glide.with(itemView)
                    .load(game.cover)
                    .transition(DrawableTransitionOptions.withCrossFade(200))
                    .placeholder(R.drawable.rounded_image_bg)
                    .into(ivCover)
            } else {
                ivCover.setImageResource(android.R.drawable.ic_menu_report_image)
            }

            // Backlog controls
            if (showBacklogControls && game.backlog_order != null) {
                tvBacklogPosition.text = "#${game.backlog_order}"
                tvBacklogPosition.visibility = View.VISIBLE
                ivDragHandle.visibility = View.VISIBLE
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

            // Add / Delete
            if (hideAddButton) {
                btnAdd.visibility = View.GONE
                btnDelete.visibility = View.VISIBLE
                btnDelete.setOnClickListener { onDelete?.invoke(game) }
            } else {
                btnAdd.visibility = View.VISIBLE
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
