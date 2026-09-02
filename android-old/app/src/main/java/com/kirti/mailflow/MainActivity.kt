package com.kirti.mailflow

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kirti.mailflow.ui.InboxScreen
import com.kirti.mailflow.ui.InboxViewModel
import com.kirti.mailflow.ui.MessageDetailScreen
import com.kirti.mailflow.ui.ReplyScreen
import com.kirti.mailflow.ui.theme.MailFlowTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MailFlowTheme {
                MailFlowRoot()
            }
        }
    }
}

@Composable
private fun MailFlowRoot(viewModel: InboxViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var isReplying by remember { mutableStateOf(false) }

    // Google's account picker / consent screen comes back through here.
    val consentLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult(),
    ) { result ->
        viewModel.onConsentResult(result.data)
    }

    // Ask for notifications first, then connect — two system dialogs racing each other
    // on first launch is how you get a consent screen that silently never appears.
    val notificationLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { viewModel.connect() }

    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            // Renews silently if the scope was already granted, so the inbox loads on launch.
            viewModel.connect()
        }
    }

    LaunchedEffect(state.consentRequest) {
        state.consentRequest?.let { sender ->
            consentLauncher.launch(IntentSenderRequest.Builder(sender).build())
            viewModel.consentLaunched()
        }
    }

    val selected = state.selectedMessage

    // System back should walk reply -> detail -> inbox rather than leaving the app.
    BackHandler(enabled = selected != null) {
        if (isReplying) isReplying = false else viewModel.closeMessage()
    }

    when {
        selected != null && isReplying -> ReplyScreen(
            original = selected,
            isSending = state.isSending,
            onBack = { isReplying = false },
            onSend = { body ->
                viewModel.sendReply(selected, body) { isReplying = false }
            },
        )

        selected != null -> MessageDetailScreen(
            message = selected,
            onBack = viewModel::closeMessage,
            onArchive = { viewModel.archive(selected) },
            onReply = { isReplying = true },
        )

        else -> InboxScreen(
            state = state,
            onConnect = viewModel::connect,
            onRefresh = viewModel::refresh,
            onSelectCategory = viewModel::selectCategory,
            onOpenMessage = viewModel::openMessage,
            onToggleNotifications = viewModel::setNotificationsEnabled,
            onDismissBanner = viewModel::clearBanner,
        )
    }
}
