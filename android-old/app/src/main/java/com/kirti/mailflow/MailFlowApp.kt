package com.kirti.mailflow

import android.app.Application
import com.kirti.mailflow.notify.Notifier
import com.kirti.mailflow.work.MailSyncWorker

class MailFlowApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannel(this)
        MailSyncWorker.schedule(this)
    }
}
