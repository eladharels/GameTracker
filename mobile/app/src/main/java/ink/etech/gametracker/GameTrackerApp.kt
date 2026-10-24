package ink.etech.gametracker

import android.app.Application

class GameTrackerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ApiClient.init(this)
    }
}
