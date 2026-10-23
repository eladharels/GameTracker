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

    fun start(activity: FragmentActivity) {
        activity.lifecycleScope.launch {
            val events = withContext(Dispatchers.IO) { CalendarHelper.eventCount(activity) }
            if (events == 0) {
                finish(activity)
                return@launch
            }
            MaterialAlertDialogBuilder(activity)
                .setTitle("Remove release dates from your calendar?")
                .setMessage(
                    "GameTracker added $events release ${if (events == 1) "date" else "dates"} to your phone's calendar. " +
                        "Anyone using this phone can see them."
                )
                .setPositiveButton("Remove and sign out") { _, _ ->
                    activity.lifecycleScope.launch {
                        withContext(Dispatchers.IO) { CalendarHelper.disableSync(activity) }
                        finish(activity)
                    }
                }
                .setNegativeButton("Keep and sign out") { _, _ -> finish(activity) }
                .setNeutralButton("Cancel", null)
                .show()
        }
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
