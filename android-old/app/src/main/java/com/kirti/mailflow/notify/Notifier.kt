package com.kirti.mailflow.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.kirti.mailflow.MainActivity
import com.kirti.mailflow.R
import com.kirti.mailflow.data.model.EmailMessage

object Notifier {

    private const val CHANNEL_ID = "new_mail"
    private const val GROUP_KEY = "com.kirti.mailflow.NEW_MAIL"
    private const val SUMMARY_ID = 1

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "New mail",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Alerts when new messages arrive in your inbox"
        }
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }

    fun notifyNewMail(context: Context, messages: List<EmailMessage>) {
        if (messages.isEmpty() || !canPost(context)) return

        val manager = NotificationManagerCompat.from(context)
        val contentIntent = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        messages.take(5).forEach { message ->
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(message.displaySender)
                .setContentText(message.subject)
                .setStyle(NotificationCompat.BigTextStyle().bigText(message.snippet))
                .setSubText(message.category.label)
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setGroup(GROUP_KEY)
                .build()

            // Gmail ids are hex strings; hashCode gives a stable per-message notification id.
            manager.notify(message.id.hashCode(), notification)
        }

        val summary = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("New mail")
            .setContentText("${messages.size} new message(s)")
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setGroup(GROUP_KEY)
            .setGroupSummary(true)
            .build()

        manager.notify(SUMMARY_ID, summary)
    }

    /** POST_NOTIFICATIONS only became a runtime permission in Android 13. */
    private fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }
}
