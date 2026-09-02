package com.kirti.mailflow.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.kirti.mailflow.auth.AuthState
import com.kirti.mailflow.auth.GoogleAuthManager
import com.kirti.mailflow.data.MailRepository
import com.kirti.mailflow.data.prefs.SettingsStore
import com.kirti.mailflow.notify.Notifier
import kotlinx.coroutines.flow.first
import java.util.concurrent.TimeUnit

/**
 * Periodic background check for new mail.
 *
 * Runs at most every 15 minutes — that is WorkManager's floor for periodic work, and
 * fighting it with alarms or a foreground service would cost far more battery than it
 * is worth. While the app is open, [com.kirti.mailflow.ui.InboxViewModel] polls faster.
 */
class MailSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val settings = SettingsStore(applicationContext)
        if (!settings.notificationsEnabled.first()) return Result.success()

        // authorize() returns a token silently once the user has granted the scope.
        val auth = GoogleAuthManager(applicationContext)
        when (val state = auth.authorize()) {
            is AuthState.Authorized -> Unit
            is AuthState.NeedsConsent -> return Result.success() // Wait for the user to open the app.
            is AuthState.Failed -> return Result.retry()
            else -> return Result.retry()
        }

        return try {
            val lastSeen = settings.lastNotifiedTimestamp()
            val inbox = MailRepository().fetchInbox(maxResults = 25)
            val fresh = inbox.filter { it.timestamp > lastSeen && it.isUnread }

            if (fresh.isNotEmpty()) {
                Notifier.notifyNewMail(applicationContext, fresh)
            }
            inbox.maxOfOrNull { it.timestamp }?.let { settings.setLastNotifiedTimestamp(it) }

            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }

    companion object {
        private const val WORK_NAME = "mailflow_periodic_sync"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<MailSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}
