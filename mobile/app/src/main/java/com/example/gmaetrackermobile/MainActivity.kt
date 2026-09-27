package com.example.gmaetrackermobile

import android.Manifest
import android.content.Context
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.example.gmaetrackermobile.fragments.HomeFragment
import com.example.gmaetrackermobile.fragments.InsightsFragment
import com.example.gmaetrackermobile.fragments.LibraryFragment
import com.example.gmaetrackermobile.fragments.ProfileFragment
import com.example.gmaetrackermobile.fragments.SearchFragment
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.appbar.MaterialToolbar
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.content.Intent
import android.widget.Toast
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private var onCalendarPermissionsResult: ((Boolean) -> Unit)? = null

    private val calendarPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val granted = permissions[Manifest.permission.READ_CALENDAR] == true &&
                      permissions[Manifest.permission.WRITE_CALENDAR] == true
        onCalendarPermissionsResult?.invoke(granted)
        onCalendarPermissionsResult = null
    }

    fun requestCalendarPermissions(onResult: (Boolean) -> Unit) {
        if (CalendarHelper.hasCalendarPermissions(this)) { onResult(true); return }
        onCalendarPermissionsResult = onResult
        calendarPermissionLauncher.launch(
            arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // No live session, no main screen (MOB-2). This also covers a process restored from
        // Recents after the session was ended elsewhere.
        if (!ensureLiveSession()) return
        // Apply the user's chosen accent theme overlay BEFORE view inflation (after super so
        // AppCompat is initialised, but before setContentView so views pick up the colours)
        theme.applyStyle(ThemeManager.getThemeResId(this), true)
        setContentView(R.layout.activity_main)

        setupToolbar()

        // Determine which tab to show: restore from savedInstanceState (e.g. after recreate()
        // triggered by theme change) or default to Home on first launch.
        val savedTab = savedInstanceState?.getInt(KEY_SELECTED_TAB) ?: R.id.navigation_home

        // Set the visual indicator BEFORE attaching the listener (avoids double-loading)
        val bottomNav = findViewById<BottomNavigationView>(R.id.bottom_navigation)
        if (savedTab != R.id.navigation_home) {
            bottomNav.selectedItemId = savedTab
        }

        // Load the correct fragment for the restored/initial tab
        loadFragmentForTab(savedTab)

        // Attach the listener for subsequent user taps
        setupBottomNavigation()

        // A request found the session expired (SessionExpiryInterceptor). Handled here, by the
        // visible activity, never from OkHttp's thread.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                Session.ended.collect { toLogin(sessionEnded = true) }
            }
        }
        if (intent.getBooleanExtra(EXTRA_OFFLINE, false)) {
            Toast.makeText(this, "You're offline. Some screens may not load until you reconnect.", Toast.LENGTH_LONG).show()
        }
    }

    override fun onResume() {
        super.onResume()
        ensureLiveSession()
    }

    /** False (and on the way to the login screen) when there is no live session. */
    private fun ensureLiveSession(): Boolean {
        val session = Session.get(this)
        // A 401 while another activity was on top clears the token and sets `redirecting`, but
        // the "ended" event is dropped (nothing collects it off-screen): still say why.
        if (session.token == null) { toLogin(sessionEnded = Session.redirecting); return false }
        if (!session.hasLiveToken(skewSeconds = 0)) {
            session.endSession()
            toLogin(sessionEnded = true)
            return false
        }
        return true
    }

    private fun toLogin(sessionEnded: Boolean) {
        if (isFinishing) return
        val intent = Intent(this, LoginActivity::class.java)
            .putExtra(LoginActivity.EXTRA_SESSION_ENDED, sessionEnded)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        startActivity(intent)
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        val bottomNav = findViewById<BottomNavigationView>(R.id.bottom_navigation)
        outState.putInt(KEY_SELECTED_TAB, bottomNav.selectedItemId)
    }

    private fun setupToolbar() {
        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)

        toolbar.setOnMenuItemClickListener { menuItem ->
            when (menuItem.itemId) {
                R.id.action_logout -> { logout(); true }
                else -> false
            }
        }
    }

    private fun setupBottomNavigation() {
        val bottomNav = findViewById<BottomNavigationView>(R.id.bottom_navigation)
        bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.navigation_home     -> { loadFragment(HomeFragment());     true }
                R.id.navigation_search   -> { loadFragment(SearchFragment());   true }
                R.id.navigation_library  -> { loadFragment(LibraryFragment());  true }
                R.id.navigation_insights -> { loadFragment(InsightsFragment()); true }
                R.id.navigation_profile  -> { loadFragment(ProfileFragment());  true }
                else -> false
            }
        }
    }

    /** Programmatically switch tabs (used by Home shortcuts). */
    fun selectTab(tabId: Int) {
        findViewById<BottomNavigationView>(R.id.bottom_navigation).selectedItemId = tabId
    }

    /** Load the fragment that corresponds to a bottom-nav item ID. */
    private fun loadFragmentForTab(tabId: Int) {
        loadFragment(
            when (tabId) {
                R.id.navigation_search   -> SearchFragment()
                R.id.navigation_library  -> LibraryFragment()
                R.id.navigation_insights -> InsightsFragment()
                R.id.navigation_profile  -> ProfileFragment()
                else                     -> HomeFragment()
            }
        )
    }

    private fun loadFragment(fragment: Fragment) {
        try {
            supportFragmentManager.beginTransaction()
                .setCustomAnimations(R.anim.slide_in_right, R.anim.slide_out_left)
                .replace(R.id.fragment_container, fragment)
                .commit()
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Error loading fragment: ${e.message}", e)
            try {
                val fallback = object : androidx.fragment.app.Fragment() {
                    override fun onCreateView(
                        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
                    ): View = android.widget.TextView(requireContext()).apply {
                        text = "Something went wrong loading this screen.\nPlease restart the app.\n\nError: ${e.message}"
                        textSize = 16f
                        gravity = android.view.Gravity.CENTER
                        setTextColor(android.graphics.Color.WHITE)
                        setBackgroundColor(android.graphics.Color.BLACK)
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    }
                }
                supportFragmentManager.beginTransaction()
                    .replace(R.id.fragment_container, fallback)
                    .commit()
            } catch (fallbackError: Exception) {
                android.util.Log.e("MainActivity", "Fallback fragment failed", fallbackError)
                android.widget.Toast.makeText(this, "Critical error: ${e.message}", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    /** Sign out: ALWAYS ends the session (MOB-3). It used to keep the token whenever
     *  fingerprint unlock was on, so "log out" left a working credential on the phone. */
    private fun logout() {
        Session.get(this).endSession()
        toLogin(sessionEnded = false)
    }

    fun refreshCurrentFragment() {
        val current = supportFragmentManager.findFragmentById(R.id.fragment_container)
        if (current is com.example.gmaetrackermobile.fragments.GameDetailsFragment.GameDetailsCallback) {
            current.onGameStatusUpdated()
        }
    }

    companion object {
        private const val KEY_SELECTED_TAB = "selected_tab"
        const val EXTRA_OFFLINE = "offline"
    }
}
