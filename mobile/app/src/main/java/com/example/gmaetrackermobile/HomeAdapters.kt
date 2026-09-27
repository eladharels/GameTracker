package com.example.gmaetrackermobile

import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

/** Horizontal "Continue playing" cards on the Home tab. */
class ContinueAdapter(
    private val onClick: (Game) -> Unit
) : RecyclerView.Adapter<ContinueAdapter.VH>() {

    private var items: List<Game> = emptyList()

    fun submit(list: List<Game>) { items = list; notifyDataSetChanged() }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_continue, parent, false)
        return VH(v)
    }

    override fun getItemCount() = items.size
    override fun onBindViewHolder(holder: VH, position: Int) = holder.bind(items[position])

    inner class VH(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val cover: ImageView = itemView.findViewById(R.id.ivCover)
        private val letter: TextView = itemView.findViewById(R.id.tvCoverLetter)
        private val title: TextView = itemView.findViewById(R.id.tvTitle)
        private val progress: ProgressBar = itemView.findViewById(R.id.progressBar)
        private val hours: TextView = itemView.findViewById(R.id.tvHours)

        fun bind(game: Game) {
            title.text = game.displayName
            CoverBinder.bind(cover, letter, game)
            // No progress bar and no hours: the server records neither, and inventing them
            // was MOB-11. The card says what is true: the game is being played.
            progress.visibility = View.GONE
            hours.text = GameExtras.year(game)?.let { "Released $it" } ?: ""
            itemView.setOnClickListener { onClick(game) }
        }
    }
}

/** Vertical "Up next" rows on the Home tab. */
class UpNextAdapter(
    private val onClick: (Game) -> Unit
) : RecyclerView.Adapter<UpNextAdapter.VH>() {

    private var items: List<Game> = emptyList()

    fun submit(list: List<Game>) { items = list; notifyDataSetChanged() }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_up_next, parent, false)
        return VH(v)
    }

    override fun getItemCount() = items.size
    override fun onBindViewHolder(holder: VH, position: Int) = holder.bind(items[position], position)

    inner class VH(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val cover: ImageView = itemView.findViewById(R.id.ivCover)
        private val letter: TextView = itemView.findViewById(R.id.tvCoverLetter)
        private val title: TextView = itemView.findViewById(R.id.tvTitle)
        private val sub: TextView = itemView.findViewById(R.id.tvSub)
        private val queue: TextView = itemView.findViewById(R.id.tvQueue)

        fun bind(game: Game, position: Int) {
            title.text = game.displayName
            sub.text = GameExtras.subtitle(game)
            queue.text = "#${position + 1}"
            CoverBinder.bind(cover, letter, game)
            itemView.setOnClickListener { onClick(game) }
        }
    }
}
