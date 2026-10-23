package com.example.gmaetrackermobile

import android.content.Intent
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Sign-out, from the toolbar menu and from Profile. The ONE implementation, so the two
 * cannot drift.
 *
 * It ALWAYS ends the session (MOB-3). The account's notes, ratings and search history stay on
 * the phone, under that account (MOB-7, owner's decision): notes exist nowhere else. The
 * calendar is different: the events are visible to anyone holding the phone, so when this
 * account added some, the user is asked whether to remove them (owner's decision).
 */
object SignOut {
    /** A double tap must not open two dialogs. Main thread only. */
    private var inFlight = false

    fun start(activity: FragmentActivity) {
        if (inFlight) return
        inFlight = true
        // invokeOnCompletion, not finally: a scope already cancelled never runs the body, and
        // a flag left set would disable sign-out until the process restarts (Architect review).
        activity.lifecycleScope.launch { ask(activity) }.invokeOnCompletion { inFlight = false }
    }

    private suspend fun ask(activity: FragmentActivity) {
        val events = withContext(Dispatchers.IO) { CalendarHelper.eventCount(activity) }
        if (events == 0) {
            finish(activity)
            return
        }
        MaterialAlertDialogBuilder(activity)
            .setTitle("Remove release dates from your calendar?")
            .setMessage(
                "GameTracker added $events release ${if (events == 1) "date" else "dates"} to your phone's calendar. " +
                    "Anyone using this phone can see them.\n\nYour notes and ratings stay on this phone for when you sign in again."
            )
            .setPositiveButton("Remove and sign out") { _, _ ->
                activity.lifecycleScope.launch {
                    val left = withContext(Dispatchers.IO) { CalendarHelper.disableSync(activity) }
                    if (left == 0) finish(activity) else couldNotRemove(activity, left)
                }
            }
            .setNegativeButton("Keep and sign out") { _, _ -> finish(activity) }
            .setNeutralButton("Cancel", null)
            .show()
    }

    /** Never "removed" when they are still there: that is what the question was about. */
    private fun couldNotRemove(activity: FragmentActivity, left: Int) {
        MaterialAlertDialogBuilder(activity)
            .setTitle("Some release dates are still in your calendar")
            .setMessage(
                "GameTracker couldn't remove $left ${if (left == 1) "release date" else "release dates"}. " +
                    "Allow calendar access for GameTracker in the phone's settings and try again. " +
                    "If you sign out now, you can remove them the next time you sign in."
            )
            .setPositiveButton("Sign out anyway") { _, _ -> finish(activity) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun finish(activity: FragmentActivity) {
        if (activity.isFinishing) return
        Session.get(activity).endSession()
        val intent = Intent(activity, LoginActivity::class.java)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        activity.startActivity(intent)
        activity.finish()
    }
}
