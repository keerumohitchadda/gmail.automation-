package com.kirti.mailflow.data.prefs

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "mailflow_settings")

/**
 * Small persisted state: which account is connected, whether background sync is on,
 * and the timestamp of the newest message we have already notified about.
 */
class SettingsStore(context: Context) {

    private val store = context.applicationContext.dataStore

    val accountEmail: Flow<String> = store.data.map { it[KEY_ACCOUNT].orEmpty() }
    val notificationsEnabled: Flow<Boolean> = store.data.map { it[KEY_NOTIFY] ?: true }

    suspend fun setAccountEmail(email: String) {
        store.edit { it[KEY_ACCOUNT] = email }
    }

    suspend fun setNotificationsEnabled(enabled: Boolean) {
        store.edit { it[KEY_NOTIFY] = enabled }
    }

    suspend fun lastNotifiedTimestamp(): Long = store.data.first()[KEY_LAST_SEEN] ?: 0L

    suspend fun setLastNotifiedTimestamp(value: Long) {
        store.edit { it[KEY_LAST_SEEN] = value }
    }

    private companion object {
        val KEY_ACCOUNT = stringPreferencesKey("account_email")
        val KEY_NOTIFY = booleanPreferencesKey("notifications_enabled")
        val KEY_LAST_SEEN = longPreferencesKey("last_notified_timestamp")
    }
}
