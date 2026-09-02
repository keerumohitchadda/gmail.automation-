package com.kirti.mailflow.ui

import android.app.Application
import android.content.Intent
import android.content.IntentSender
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kirti.mailflow.auth.AuthState
import com.kirti.mailflow.auth.GoogleAuthManager
import com.kirti.mailflow.data.MailRepository
import com.kirti.mailflow.data.model.EmailMessage
import com.kirti.mailflow.data.prefs.SettingsStore
import com.kirti.mailflow.rules.Category
import com.kirti.mailflow.work.MailSyncWorker
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class InboxUiState(
    val isSignedIn: Boolean = false,
    val accountEmail: String = "",
    val isLoading: Boolean = false,
    val isSending: Boolean = false,
    val messages: List<EmailMessage> = emptyList(),
    val selectedCategory: Category = Category.ALL,
    val selectedMessage: EmailMessage? = null,
    val notificationsEnabled: Boolean = true,
    val error: String? = null,
    val status: String? = null,
    /** Set when Google needs to show an account picker or consent screen. */
    val consentRequest: IntentSender? = null,
) {
    val visibleMessages: List<EmailMessage>
        get() = if (selectedCategory == Category.ALL) messages
        else messages.filter { it.category == selectedCategory }

    val unreadCount: Int get() = messages.count { it.isUnread }

    /** Only show tabs that actually have mail behind them. */
    val availableCategories: List<Category>
        get() = listOf(Category.ALL) +
            Category.entries.filter { c -> c != Category.ALL && messages.any { it.category == c } }
}

class InboxViewModel(app: Application) : AndroidViewModel(app) {

    private val auth = GoogleAuthManager(app)
    private val repo = MailRepository()
    private val settings = SettingsStore(app)

    private val _state = MutableStateFlow(InboxUiState())
    val state: StateFlow<InboxUiState> = _state.asStateFlow()

    private var pollJob: Job? = null

    init {
        viewModelScope.launch {
            _state.update {
                it.copy(
                    accountEmail = settings.accountEmail.first(),
                    notificationsEnabled = settings.notificationsEnabled.first(),
                )
            }
        }
    }

    /** Kicks off (or silently renews) Gmail authorization. */
    fun connect() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            when (val result = auth.authorize()) {
                is AuthState.Authorized -> onAuthorized()
                is AuthState.NeedsConsent ->
                    _state.update { it.copy(isLoading = false, consentRequest = result.intentSender) }
                is AuthState.Failed ->
                    _state.update { it.copy(isLoading = false, error = result.message) }
                else -> _state.update { it.copy(isLoading = false) }
            }
        }
    }

    fun onConsentResult(data: Intent?) {
        _state.update { it.copy(consentRequest = null) }
        when (val result = auth.handleConsentResult(data)) {
            is AuthState.Authorized -> viewModelScope.launch { onAuthorized() }
            is AuthState.Failed -> _state.update { it.copy(error = result.message) }
            else -> Unit
        }
    }

    fun consentLaunched() {
        _state.update { it.copy(consentRequest = null) }
    }

    private suspend fun onAuthorized() {
        _state.update { it.copy(isSignedIn = true, error = null) }
        runCatching { repo.myEmailAddress() }.onSuccess { email ->
            settings.setAccountEmail(email)
            _state.update { it.copy(accountEmail = email) }
        }
        refresh()
        startPolling()
    }

    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, error = null) }
            runCatching { repo.fetchInbox() }
                .onSuccess { messages ->
                    _state.update { it.copy(isLoading = false, messages = messages) }
                    messages.maxOfOrNull { it.timestamp }
                        ?.let { settings.setLastNotifiedTimestamp(it) }
                }
                .onFailure { e ->
                    _state.update { it.copy(isLoading = false, error = friendlyError(e)) }
                }
        }
    }

    /** While the app is in the foreground, check far more often than WorkManager allows. */
    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (true) {
                delay(POLL_INTERVAL_MS)
                // Renew the access token first — it expires roughly hourly.
                if (auth.authorize() is AuthState.Authorized) {
                    runCatching { repo.fetchInbox() }.onSuccess { messages ->
                        _state.update { it.copy(messages = messages) }
                    }
                }
            }
        }
    }

    fun selectCategory(category: Category) {
        _state.update { it.copy(selectedCategory = category) }
    }

    fun openMessage(message: EmailMessage) {
        _state.update { it.copy(selectedMessage = message) }
        viewModelScope.launch {
            runCatching { repo.fetchFullMessage(message.id) }
                .onSuccess { full ->
                    _state.update { s ->
                        if (s.selectedMessage?.id == full.id) s.copy(selectedMessage = full) else s
                    }
                }
                .onFailure { e -> _state.update { it.copy(error = friendlyError(e)) } }

            if (message.isUnread) {
                runCatching { repo.markAsRead(message.id) }.onSuccess {
                    _state.update { s ->
                        s.copy(messages = s.messages.map {
                            if (it.id == message.id) it.copy(isUnread = false) else it
                        })
                    }
                }
            }
        }
    }

    fun closeMessage() {
        _state.update { it.copy(selectedMessage = null) }
    }

    fun archive(message: EmailMessage) {
        viewModelScope.launch {
            runCatching { repo.archive(message.id) }
                .onSuccess {
                    _state.update { s ->
                        s.copy(
                            messages = s.messages.filterNot { it.id == message.id },
                            selectedMessage = null,
                            status = "Archived",
                        )
                    }
                }
                .onFailure { e -> _state.update { it.copy(error = friendlyError(e)) } }
        }
    }

    /**
     * Sends a reply. The UI only calls this after the user confirms in a dialog —
     * nothing leaves the device on a single tap.
     */
    fun sendReply(original: EmailMessage, body: String, onDone: () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(isSending = true, error = null) }
            runCatching { repo.sendReply(original, body) }
                .onSuccess {
                    _state.update { it.copy(isSending = false, status = "Reply sent") }
                    onDone()
                }
                .onFailure { e ->
                    _state.update { it.copy(isSending = false, error = friendlyError(e)) }
                }
        }
    }

    fun sendNew(to: String, subject: String, body: String, onDone: () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(isSending = true, error = null) }
            runCatching { repo.sendNew(to, subject, body) }
                .onSuccess {
                    _state.update { it.copy(isSending = false, status = "Message sent") }
                    onDone()
                }
                .onFailure { e ->
                    _state.update { it.copy(isSending = false, error = friendlyError(e)) }
                }
        }
    }

    fun setNotificationsEnabled(enabled: Boolean) {
        viewModelScope.launch {
            settings.setNotificationsEnabled(enabled)
            _state.update { it.copy(notificationsEnabled = enabled) }
            val app = getApplication<Application>()
            if (enabled) MailSyncWorker.schedule(app) else MailSyncWorker.cancel(app)
        }
    }

    fun clearBanner() {
        _state.update { it.copy(error = null, status = null) }
    }

    private fun friendlyError(e: Throwable): String {
        val message = e.message.orEmpty()
        return when {
            message.contains("401") -> "Session expired. Tap Reconnect to sign in again."
            message.contains("403") -> "Gmail refused the request. Check that the Gmail API is enabled and your address is a test user."
            message.contains("429") -> "Too many requests to Gmail. Try again in a minute."
            message.contains("Unable to resolve host") -> "No internet connection."
            else -> message.ifBlank { "Something went wrong." }
        }
    }

    private companion object {
        const val POLL_INTERVAL_MS = 60_000L
    }
}
