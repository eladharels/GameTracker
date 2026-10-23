package com.example.gmaetrackermobile

import android.content.Intent
import android.widget.Toast
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

    /**
     * [committed]: the user has ALREADY agreed to be signed out (turning fingerprint unlock
     * off, MOB-9), so no later dialog may offer a way to stay signed in: the calendar question
     * has no Cancel, and neither does "still in your calendar" (UI/UX review, PR #14).
     */
    fun start(activity: FragmentActivity, committed: Boolean = false) {
        // A committed sign-out never returns silently: fingerprint unlock is already off, and
        // the 30-day token must not stay live in memory, unsealed (CISO review, PR #14).
        if (inFlight && !committed) return
        inFlight = true
        // invokeOnCompletion, not finally: a scope already cancelled never runs the body, and
        // a flag left set would disable sign-out until the process restarts (Architect review).
        activity.lifecycleScope.launch { ask(activity, committed) }.invokeOnCompletion { inFlight = false }
    }

    private suspend fun ask(activity: FragmentActivity, committed: Boolean) {
        val events = withContext(Dispatchers.IO) { CalendarHelper.eventCount(activity) }
        if (events == 0) {
            finish(activity)
            return
        }
        val dialog = MaterialAlertDialogBuilder(activity)
            .setTitle("Remove release dates from your calendar?")
            .setMessage(
                "GameTracker added $events release ${if (events == 1) "date" else "dates"} to your phone's calendar. " +
                    "Anyone using this phone can see them.\n\nYour notes and ratings stay on this phone for when you sign in again."
            )
            .setPositiveButton("Remove and sign out") { _, _ ->
                activity.lifecycleScope.launch {
                    val left = withContext(Dispatchers.IO) { CalendarHelper.disableSync(activity) }
                    if (left == 0) finish(activity) else couldNotRemove(activity, left, committed)
                }
            }
            .setNegativeButton("Keep and sign out") { _, _ -> finish(activity) }
        if (committed) dialog.setCancelable(false) else dialog.setNeutralButton("Cancel", null)
        dialog.show()
    }

    /** Never "removed" when they are still there: that is what the question was about. */
    private fun couldNotRemove(activity: FragmentActivity, left: Int, committed: Boolean) {
        val dialog = MaterialAlertDialogBuilder(activity)
            .setTitle("Some release dates are still in your calendar")
            .setMessage(
                "GameTracker couldn't remove $left ${if (left == 1) "release date" else "release dates"}. " +
                    "Allow calendar access for GameTracker in the phone's settings and try again. " +
                    "If you sign out now, you can remove them the next time you sign in."
            )
            .setPositiveButton(if (committed) "Sign out" else "Sign out anyway") { _, _ -> finish(activity) }
        if (committed) dialog.setCancelable(false) else dialog.setNegativeButton("Cancel", null)
        dialog.show()
    }

    /**
     * Turning fingerprint unlock off while this phone holds its 30-day token (MOB-9). Kept in
     * memory, the token would outlive the process with no copy anywhere: so it is revoked, and
     * the user is signed out, after saying so (CISO design review). Returns false when there
     * is nothing to confirm (a 12-hour session): the caller then just turns it off.
     */
    fun confirmFingerprintOff(activity: FragmentActivity, onCancel: () -> Unit): Boolean {
        if (!Session.get(activity).isPat) return false
        MaterialAlertDialogBuilder(activity)
            .setTitle("Turn off fingerprint unlock?")
            .setMessage(
                "Fingerprint unlock is what keeps this phone signed in for up to 30 days. " +
                    "Turning it off signs you out, and you'll sign in with your password next time."
            )
            .setPositiveButton("Turn off and sign out") { _, _ ->
                FingerprintUnlock.disable(activity)
                start(activity, committed = true)
            }
            .setNegativeButton("Cancel") { _, _ -> onCancel() }
            .setOnCancelListener { onCancel() }
            .show()
        return true
    }

    /**
     * MOB-9: a 30-day token is revoked on the server before the session ends, presenting only
     * itself and only its own id (CISO condition 5). If that fails the session still ends, the
     * id stays recorded so the next password sign-in revokes it, and the user is told where
     * to remove it by hand.
     */
    private fun finish(activity: FragmentActivity) {
        if (activity.isFinishing) return
        val session = Session.get(activity)
        val id = session.patId
        val bearer = session.bearer()
        if (id == null || bearer == null) {
            leave(activity)
            return
        }
        activity.lifecycleScope.launch {
            val gone = withContext(Dispatchers.IO) { MobileTokenApi.revoke(bearer, id) }
            if (gone) {
                session.forgetPatId(id)
            } else {
                Toast.makeText(
                    activity.applicationContext,
                    "Couldn't sign this phone out on the server. Remove its \"Android app\" sign-in in My Account on the web.",
                    Toast.LENGTH_LONG,
                ).show()
            }
            leave(activity)
        }
    }

    private fun leave(activity: FragmentActivity) {
        if (activity.isFinishing) return
        Session.get(activity).endSession()
        val intent = Intent(activity, LoginActivity::class.java)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        activity.startActivity(intent)
        activity.finish()
    }
}
