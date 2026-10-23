package com.example.gmaetrackermobile

import android.widget.ImageView
import android.widget.TextView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.resource.drawable.DrawableTransitionOptions

/**
 * Binds a game cover into an ImageView layered over a gradient + mono-letter fallback
 * (matching the prototype's cover treatment). When the cover URL is blank, the gradient
 * letter shows through; otherwise Glide cross-fades the artwork on top.
 */
object CoverBinder {
    fun bind(cover: ImageView, letter: TextView?, game: Game) {
        letter?.text = game.displayName.trim().firstOrNull()?.uppercase() ?: "?"
        val url = SafeUrl.https(game.cover)   // https only (MOB-8)
        if (url != null) {
            cover.visibility = ImageView.VISIBLE
            Glide.with(cover)
                .load(url)
                .transition(DrawableTransitionOptions.withCrossFade(200))
                .into(cover)
        } else {
            cover.setImageDrawable(null)
            cover.visibility = ImageView.INVISIBLE
        }
    }
}
