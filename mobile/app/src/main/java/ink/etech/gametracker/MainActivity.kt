package ink.etech.gametracker

import android.Manifest
import android.content.Context
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentManager
import ink.etech.gametracker.fragments.HomeFragment
import ink.etech.gametracker.fragments.InsightsFragment
import ink.etech.gametracker.fragments.LibraryFragment
import ink.etech.gametracker.fragments.ProfileFragment
import ink.etech.gametracker.fragments.SearchFragment
import com.google.android.material.bottomnavigation.BottomNavigationView
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
        layoutEdgeToEdge()

        // Determine which tab to show: restore from savedInstanceState (e.g. after recreate()
        // triggered by theme change) or default to Home on first launch.
        val savedTab = savedInstanceState?.getInt(KEY_SELECTED_TAB) ?: R.id.navigation_home

        // Set the visual indicator BEFORE attaching the listener (avoids double-loading)
        val bottomNav = findViewById<BottomNavigationView>(R.id.bottom_navigation)
        if (savedTab != R.id.navigation_home) {
            bottomNav.selectedItemId = savedTab
        }

        // A restored activity already has its tabs (and any open details) back from the
        // FragmentManager; only a fresh one creates the first tab.
        if (savedInstanceState == null) loadFragmentForTab(savedTab)

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
            // A snackbar over the nav, like every other notice in the app (MOB-36; was a Toast).
            val nav = findViewById<View>(R.id.bottom_navigation)
            com.google.android.material.snackbar.Snackbar.make(nav, "You're offline. Some screens may not load until you reconnect.",
                com.google.android.material.snackbar.Snackbar.LENGTH_LONG)
                .setAnchorView(nav)
                .also { SnackbarHelper.applyStyle(it) }
                .show()
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
        LibraryRepository.clear()
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


    private fun setupBottomNavigation() {
        val bottomNav = findViewById<BottomNavigationView>(R.id.bottom_navigation)
        bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.navigation_home, R.id.navigation_search, R.id.navigation_library,
                R.id.navigation_insights, R.id.navigation_profile -> { loadFragmentForTab(item.itemId); true }
                else -> false
            }
        }
    }

    /** Programmatically switch tabs (used by Home shortcuts). */
    fun selectTab(tabId: Int) {
        findViewById<BottomNavigationView>(R.id.bottom_navigation).selectedItemId = tabId
    }

    /**
     * MOB-31: the screens start below the status bar; the bottom nav grows by the navigation
     * bar's height (Material pads its own content by it), and the screens end above the nav as
     * it is actually measured: the old fixed 72dp nav and 80dp padding clipped under a
     * gesture or 3-button bar.
     */
    private var imeBottom = 0

    private fun layoutEdgeToEdge() {
        EdgeToEdge.enable(this)
        val container = findViewById<View>(R.id.fragment_container)
        val nav = findViewById<BottomNavigationView>(R.id.bottom_navigation)
        val navContent = nav.layoutParams.height
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val bars = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars() or
                    androidx.core.view.WindowInsetsCompat.Type.displayCutout()
            )
            imeBottom = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom
            v.setPadding(bars.left, bars.top, bars.right, maxOf(nav.height, imeBottom))
            nav.layoutParams = nav.layoutParams.apply { height = navContent + bars.bottom }
            insets
        }
        // Above the nav as measured, or above the keyboard while it is open: the focused field
        // in Details, Search or Library can then scroll into view (UI/UX review, PR #15).
        nav.addOnLayoutChangeListener { _, _, top, _, bottom, _, _, _, _ ->
            val h = maxOf(bottom - top, imeBottom)
            if (container.paddingBottom != h) container.setPadding(container.paddingLeft, container.paddingTop, container.paddingRight, h)
        }
    }

    /**
     * The five tabs are created once and then SHOWN and HIDDEN, never replaced (MOB-19): a new
     * instance on every tap lost the scroll position, the filter and the search text, and
     * re-downloaded the library. A restored activity (theme change) finds them by tag.
     * A tab learns it is visible again from onHiddenChanged, not onResume.
     */
    private fun loadFragmentForTab(tabId: Int) {
        val fm = supportFragmentManager
        // A details screen belongs to the tab it was opened from: leaving the tab closes it.
        if (fm.backStackEntryCount > 0) fm.popBackStackImmediate(null, FragmentManager.POP_BACK_STACK_INCLUSIVE)
        val tag = TAB_PREFIX + tabId
        try {
            val tx = fm.beginTransaction().setReorderingAllowed(true)
            val target = fm.findFragmentByTag(tag)
            fm.fragments.filter { it.tag?.startsWith(TAB_PREFIX) == true && it !== target && !it.isHidden }
                .forEach { tx.hide(it) }
            if (target == null) tx.add(R.id.fragment_container, newTab(tabId), tag) else tx.show(target)
            tx.commit()
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Error showing tab: ${e.message}", e)
            loadFragment(newTab(tabId))
        }
    }

    private fun newTab(tabId: Int): Fragment = when (tabId) {
        R.id.navigation_search   -> SearchFragment()
        R.id.navigation_library  -> LibraryFragment()
        R.id.navigation_insights -> InsightsFragment()
        R.id.navigation_profile  -> ProfileFragment()
        else                     -> HomeFragment()
    }

    /**
     * Game Details over the current tab: the tab is hidden, not destroyed, so Back returns to
     * it exactly as it was (and onHiddenChanged tells it to re-read the library).
     */
    fun openDetails(details: Fragment) {
        val fm = supportFragmentManager
        val tx = fm.beginTransaction()
            .setReorderingAllowed(true)
            .setCustomAnimations(
                R.anim.slide_in_right, R.anim.slide_out_left,
                R.anim.slide_in_left, R.anim.slide_out_right
            )
        fm.fragments.filter { it.isAdded && !it.isHidden && it.id == R.id.fragment_container }.forEach { tx.hide(it) }
        tx.add(R.id.fragment_container, details).addToBackStack(null).commit()
    }

    /** The last-resort path: one fragment, replacing everything. */
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
                        text = "Something went wrong loading this screen.\nPlease restart the app."
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
                android.widget.Toast.makeText(this, "Something went wrong. Please restart the app.", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }



    companion object {
        private const val KEY_SELECTED_TAB = "selected_tab"
        private const val TAB_PREFIX = "tab:"
        const val EXTRA_OFFLINE = "offline"
    }
}
