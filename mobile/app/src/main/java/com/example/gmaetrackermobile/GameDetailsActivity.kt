package com.example.gmaetrackermobile

import android.os.Bundle
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.bumptech.glide.Glide
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.AdapterView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.content.Context
import com.example.gmaetrackermobile.Game
import com.example.gmaetrackermobile.GameUpdateRequest
import com.google.android.material.snackbar.Snackbar
import androidx.core.content.ContextCompat

class GameDetailsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_game_details)

        val tvTitle = findViewById<TextView>(R.id.tvTitle)
        val ivCover = findViewById<ImageView>(R.id.ivCover)
        val tvReleaseDate = findViewById<TextView>(R.id.tvReleaseDate)
        val spinnerStatus = findViewById<Spinner>(R.id.spinnerStatus)

        val title = intent.getStringExtra("title") ?: "Unknown Title"
        val coverUrl = intent.getStringExtra("coverUrl")
        val releaseDate = intent.getStringExtra("releaseDate") ?: ""
        tvTitle.text = title
        tvReleaseDate.text = "Release Date: $releaseDate"
        if (coverUrl != null && coverUrl.isNotBlank()) {
            Glide.with(this).load(coverUrl).into(ivCover)
        } else {
            ivCover.setImageResource(android.R.drawable.ic_menu_report_image)
        }

        // Get status and unreleased info from intent (pass these from MyLibrary)
        val status = intent.getStringExtra("status") ?: ""
        val gameId = intent.getStringExtra("gameId")
        val username = getSharedPreferences("auth", Context.MODE_PRIVATE).getString("username", null)
        val isUnreleased = status.equals("unreleased", ignoreCase = true)

        if (!isUnreleased && gameId != null && username != null) {
            val statuses = listOf("wishlist", "playing", "done")
            val adapter = ArrayAdapter(this, R.layout.item_status_spinner, statuses)
            adapter.setDropDownViewResource(R.layout.item_status_spinner)
            spinnerStatus.adapter = adapter
            spinnerStatus.visibility = android.view.View.VISIBLE
            val currentIndex = statuses.indexOfFirst { it.equals(status, ignoreCase = true) }
            if (currentIndex >= 0) spinnerStatus.setSelection(currentIndex)

            spinnerStatus.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>, view: android.view.View?, position: Int, id: Long) {
                    val newStatus = statuses[position]
                    if (!newStatus.equals(status, ignoreCase = true)) {
                        val token = getSharedPreferences("auth", Context.MODE_PRIVATE).getString("token", null)
                        if (token != null) {
                            CoroutineScope(Dispatchers.IO).launch {
                                try {
                                    val payload = GameUpdateRequest(
                                        gameId = gameId ?: "",
                                        gameName = title,
                                        coverUrl = coverUrl,
                                        releaseDate = releaseDate,
                                        status = newStatus,
                                        steamAppId = null
                                    )
                                    val response = ApiClient.api.addOrUpdateGame(
                                        "Bearer $token", username, payload
                                    )
                                    withContext(Dispatchers.Main) {
                                        if (response.isSuccessful) {
                                            Snackbar.make(findViewById(android.R.id.content), "Status updated!", Snackbar.LENGTH_SHORT)
                                                .setBackgroundTint(ContextCompat.getColor(this@GameDetailsActivity, R.color.gt_card_bg))
                                                .setTextColor(ContextCompat.getColor(this@GameDetailsActivity, R.color.white))
                                                .show()
                                        } else {
                                            Snackbar.make(findViewById(android.R.id.content), "Failed to update status", Snackbar.LENGTH_SHORT)
                                                .setBackgroundTint(ContextCompat.getColor(this@GameDetailsActivity, R.color.gt_card_bg))
                                                .setTextColor(ContextCompat.getColor(this@GameDetailsActivity, R.color.white))
                                                .show()
                                        }
                                    }
                                } catch (e: Exception) {
                                    withContext(Dispatchers.Main) {
                                        Snackbar.make(findViewById(android.R.id.content), "Error: ${e.localizedMessage}", Snackbar.LENGTH_SHORT)
                                            .setBackgroundTint(ContextCompat.getColor(this@GameDetailsActivity, R.color.gt_card_bg))
                                            .setTextColor(ContextCompat.getColor(this@GameDetailsActivity, R.color.white))
                                            .show()
                                    }
                                }
                            }
                        }
                    }
                }
                override fun onNothingSelected(parent: AdapterView<*>) {}
            }
        } else {
            spinnerStatus.visibility = android.view.View.GONE
        }
    }
} 