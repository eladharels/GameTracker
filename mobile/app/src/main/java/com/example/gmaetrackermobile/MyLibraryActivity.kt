package com.example.gmaetrackermobile

import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.ProgressBar
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.content.Intent
import android.text.Editable
import android.text.TextWatcher
import android.widget.EditText
import com.google.android.material.snackbar.Snackbar

class MyLibraryActivity : AppCompatActivity() {
    private lateinit var adapter: GameAdapter
    private lateinit var progressBar: ProgressBar
    private lateinit var etSearchLibrary: EditText
    private var allGames: List<Game> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_my_library)

        val rvLibrary = findViewById<RecyclerView>(R.id.rvLibrary)
        progressBar = findViewById(R.id.progressBar)
        etSearchLibrary = findViewById(R.id.etSearchLibrary)

        adapter = GameAdapter(
            onAddToLibrary = { /* No add in library, so do nothing */ },
            hideAddButton = true,
            onItemClick = { game ->
                val intent = Intent(this, GameDetailsActivity::class.java)
                intent.putExtra("title", game.displayName)
                intent.putExtra("coverUrl", game.cover)
                intent.putExtra("releaseDate", game.release)
                intent.putExtra("status", game.status)
                intent.putExtra("gameId", game.game_id)
                startActivity(intent)
            },
            onDelete = { game ->
                val prefs = getSharedPreferences("auth", Context.MODE_PRIVATE)
                val token = prefs.getString("token", null)
                val username = prefs.getString("username", null)
                if (token == null || username == null) return@GameAdapter
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        val gameId = game.game_id ?: game.id ?: ""
                        val response = ApiClient.api.deleteGame("Bearer $token", username, gameId)
                        withContext(Dispatchers.Main) {
                            if (response.isSuccessful) {
                                // Remove from list and update UI
                                val newList = adapter.getGames().filter { it != game }
                                adapter.submitList(newList)
                                Snackbar.make(findViewById(android.R.id.content), "Game deleted", Snackbar.LENGTH_SHORT)
                                    .setBackgroundTint(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.gt_card_bg))
                                    .setTextColor(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.white))
                                    .show()
                            } else {
                                Snackbar.make(findViewById(android.R.id.content), "Failed to delete", Snackbar.LENGTH_SHORT)
                                    .setBackgroundTint(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.gt_card_bg))
                                    .setTextColor(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.white))
                                    .show()
                            }
                        }
                    } catch (e: Exception) {
                        withContext(Dispatchers.Main) {
                            Snackbar.make(findViewById(android.R.id.content), "Error: ${e.localizedMessage}", Snackbar.LENGTH_SHORT)
                                .setBackgroundTint(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.gt_card_bg))
                                .setTextColor(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.white))
                                .show()
                        }
                    }
                }
            }
        )
        rvLibrary.layoutManager = LinearLayoutManager(this)
        rvLibrary.adapter = adapter

        etSearchLibrary.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                filterGames(s?.toString() ?: "")
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        etSearchLibrary.setOnEditorActionListener { v, actionId, event ->
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH ||
                (event != null && event.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.action == android.view.KeyEvent.ACTION_DOWN)) {
                val query = etSearchLibrary.text.toString()
                filterGames(query)
                true
            } else {
                false
            }
        }

        loadLibrary()
    }

    override fun onResume() {
        super.onResume()
        loadLibrary()
    }

    private fun filterGames(query: String) {
        val filtered = if (query.isBlank()) {
            allGames
        } else {
            allGames.filter { it.displayName.contains(query, ignoreCase = true) }
        }
        adapter.submitList(filtered)
    }

    private fun loadLibrary() {
        progressBar.visibility = View.VISIBLE
        val token = getSharedPreferences("auth", Context.MODE_PRIVATE).getString("token", null)
        val username = getSharedPreferences("auth", Context.MODE_PRIVATE).getString("username", null)
        if (token == null || username == null) {
            Snackbar.make(findViewById(android.R.id.content), "Not logged in", Snackbar.LENGTH_SHORT)
                .setBackgroundTint(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.gt_card_bg))
                .setTextColor(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.white))
                .show()
            progressBar.visibility = View.GONE
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val response = ApiClient.api.getLibrary("Bearer $token", username)
                withContext(Dispatchers.Main) {
                    progressBar.visibility = View.GONE
                }
                if (response.isSuccessful && response.body() != null) {
                    val games = response.body() ?: emptyList()
                    withContext(Dispatchers.Main) {
                        allGames = games
                        filterGames(etSearchLibrary.text.toString())
                    }
                } else {
                    val errorBody = response.errorBody()?.string() ?: response.message()
                    Snackbar.make(findViewById(android.R.id.content), "Failed to load library: $errorBody", Snackbar.LENGTH_LONG)
                        .setBackgroundTint(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.gt_card_bg))
                        .setTextColor(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.white))
                        .show()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    progressBar.visibility = View.GONE
                    Snackbar.make(findViewById(android.R.id.content), "Error: ${e.localizedMessage}", Snackbar.LENGTH_SHORT)
                        .setBackgroundTint(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.gt_card_bg))
                        .setTextColor(androidx.core.content.ContextCompat.getColor(this@MyLibraryActivity, R.color.white))
                        .show()
                }
            }
        }
    }
} 