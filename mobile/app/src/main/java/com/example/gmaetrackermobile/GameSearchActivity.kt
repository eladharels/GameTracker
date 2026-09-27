package com.example.gmaetrackermobile

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.example.gmaetrackermobile.GameUpdateRequest
import com.google.android.material.snackbar.Snackbar
import androidx.core.content.ContextCompat

class GameSearchActivity : AppCompatActivity() {
    private lateinit var adapter: GameAdapter
    private lateinit var progressBar: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_game_search)

        val etSearch = findViewById<EditText>(R.id.etSearch)
        val btnSearch = findViewById<Button>(R.id.btnSearch)
        val rvResults = findViewById<RecyclerView>(R.id.rvResults)
        progressBar = findViewById(R.id.progressBar)

        adapter = GameAdapter(
            onAddToLibrary = { game -> addToLibrary(game) },
            hideAddButton = false,
            onItemClick = { game ->
                val intent = Intent(this, GameDetailsActivity::class.java)
                intent.putExtra("title", game.displayName)
                intent.putExtra("coverUrl", game.cover)
                intent.putExtra("releaseDate", game.release)
                startActivity(intent)
            }
        )
        rvResults.layoutManager = LinearLayoutManager(this)
        rvResults.adapter = adapter

        btnSearch.setOnClickListener {
            val query = etSearch.text.toString()
            if (query.isNotBlank()) {
                searchGames(query)
            }
        }
        etSearch.setOnEditorActionListener { v, actionId, event ->
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH ||
                (event != null && event.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.action == android.view.KeyEvent.ACTION_DOWN)) {
                val query = etSearch.text.toString()
                if (query.isNotBlank()) {
                    searchGames(query)
                }
                true
            } else {
                false
            }
        }
    }

    private fun searchGames(query: String) {
        Snackbar.make(findViewById(android.R.id.content), "Searching for $query", Snackbar.LENGTH_SHORT)
            .setBackgroundTint(ContextCompat.getColor(this, R.color.gt_card_bg))
            .setTextColor(ContextCompat.getColor(this, R.color.white))
            .show()
        progressBar.visibility = View.VISIBLE
        val token = getSharedPreferences("auth", Context.MODE_PRIVATE).getString("token", null)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val response = if (token != null) {
                    ApiClient.api.searchGames(query, "Bearer $token")
                } else {
                    ApiClient.api.searchGames(query)
                }
                withContext(Dispatchers.Main) {
                    progressBar.visibility = View.GONE
                    if (response.isSuccessful && response.body() != null) {
                        adapter.submitList(response.body())
                    } else {
                        val errorBody = response.errorBody()?.string() ?: response.message()
                        Toast.makeText(this@GameSearchActivity, "Search failed: $errorBody", Toast.LENGTH_LONG).show()
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    progressBar.visibility = View.GONE
                    Toast.makeText(this@GameSearchActivity, "Error: ${e.localizedMessage}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun addToLibrary(game: Game) {
        val prefs = getSharedPreferences("auth", Context.MODE_PRIVATE)
        val token = prefs.getString("token", null)
        val username = prefs.getString("username", null)
        if (token == null || username == null) {
            Toast.makeText(this, "Not logged in", Toast.LENGTH_SHORT).show()
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                // Fetch user's library first
                val libraryResponse = ApiClient.api.getLibrary("Bearer $token", username)
                if (libraryResponse.isSuccessful && libraryResponse.body() != null) {
                    val userGames = libraryResponse.body()!!
                    val alreadyInLibrary = userGames.any { userGame ->
                        val gId = userGame.game_id ?: userGame.id ?: ""
                        val gName = (userGame.game_name ?: userGame.name ?: "").trim().lowercase()
                        val gameId = game.game_id ?: game.id ?: ""
                        val gameName = (game.game_name ?: game.name ?: "").trim().lowercase()
                        gId == gameId || gName == gameName
                    }
                    if (alreadyInLibrary) {
                        withContext(Dispatchers.Main) {
                            Snackbar.make(findViewById(android.R.id.content), "You already have this game in your library!", Snackbar.LENGTH_SHORT)
                                .setBackgroundTint(ContextCompat.getColor(this@GameSearchActivity, R.color.gt_card_bg))
                                .setTextColor(ContextCompat.getColor(this@GameSearchActivity, R.color.white))
                                .show()
                        }
                        return@launch
                    }
                }
                // Not in library, proceed to add
                val payload = GameUpdateRequest(
                    gameId = game.id ?: "",
                    gameName = game.name ?: "",
                    coverUrl = game.cover,
                    releaseDate = game.releaseDate,
                    status = "wishlist",
                    steamAppId = game.steamAppId
                )
                val response = ApiClient.api.addOrUpdateGame("Bearer $token", username, payload)
                withContext(Dispatchers.Main) {
                    if (response.isSuccessful) {
                        Snackbar.make(findViewById(android.R.id.content), "Added to library!", Snackbar.LENGTH_SHORT)
                            .setBackgroundTint(ContextCompat.getColor(this@GameSearchActivity, R.color.gt_card_bg))
                            .setTextColor(ContextCompat.getColor(this@GameSearchActivity, R.color.white))
                            .show()
                    } else {
                        Snackbar.make(findViewById(android.R.id.content), "Failed to add", Snackbar.LENGTH_SHORT)
                            .setBackgroundTint(ContextCompat.getColor(this@GameSearchActivity, R.color.gt_card_bg))
                            .setTextColor(ContextCompat.getColor(this@GameSearchActivity, R.color.white))
                            .show()
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Snackbar.make(findViewById(android.R.id.content), "Error: ${e.localizedMessage}", Snackbar.LENGTH_SHORT)
                        .setBackgroundTint(ContextCompat.getColor(this@GameSearchActivity, R.color.gt_card_bg))
                        .setTextColor(ContextCompat.getColor(this@GameSearchActivity, R.color.white))
                        .show()
                }
            }
        }
    }
} 