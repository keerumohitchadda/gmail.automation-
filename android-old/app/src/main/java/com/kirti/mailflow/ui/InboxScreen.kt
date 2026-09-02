package com.kirti.mailflow.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kirti.mailflow.data.model.EmailMessage
import com.kirti.mailflow.rules.Category
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    state: InboxUiState,
    onConnect: () -> Unit,
    onRefresh: () -> Unit,
    onSelectCategory: (Category) -> Unit,
    onOpenMessage: (EmailMessage) -> Unit,
    onToggleNotifications: (Boolean) -> Unit,
    onDismissBanner: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Inbox", style = MaterialTheme.typography.titleLarge)
                        val subtitle = when {
                            state.accountEmail.isNotBlank() && state.unreadCount > 0 ->
                                "${state.accountEmail} · ${state.unreadCount} unread"
                            state.accountEmail.isNotBlank() -> state.accountEmail
                            else -> "Not connected"
                        }
                        Text(
                            subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { onToggleNotifications(!state.notificationsEnabled) }) {
                        Icon(
                            imageVector = if (state.notificationsEnabled) Icons.Default.Notifications
                            else Icons.Default.NotificationsOff,
                            contentDescription = "Toggle new-mail alerts",
                        )
                    }
                    IconButton(onClick = onRefresh, enabled = state.isSignedIn) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {

            if (state.isLoading) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }

            state.error?.let { Banner(it, isError = true, onDismiss = onDismissBanner) }
            state.status?.let { Banner(it, isError = false, onDismiss = onDismissBanner) }

            when {
                !state.isSignedIn && state.messages.isEmpty() ->
                    ConnectPrompt(isLoading = state.isLoading, onConnect = onConnect)

                state.visibleMessages.isEmpty() && !state.isLoading ->
                    EmptyState(state.selectedCategory)

                else -> {
                    CategoryBar(
                        categories = state.availableCategories,
                        selected = state.selectedCategory,
                        counts = state.messages.groupingBy { it.category }.eachCount(),
                        total = state.messages.size,
                        onSelect = onSelectCategory,
                    )
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(state.visibleMessages, key = { it.id }) { message ->
                            MessageRow(message = message, onClick = { onOpenMessage(message) })
                            Divider(Modifier.padding(start = 72.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectPrompt(isLoading: Boolean, onConnect: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Connect your Gmail", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(
            "MailFlow reads your inbox, sorts it into categories, and alerts you when new mail arrives.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(24.dp))
        if (isLoading) {
            CircularProgressIndicator()
        } else {
            TextButton(onClick = onConnect) { Text("Connect Gmail account") }
        }
    }
}

@Composable
private fun EmptyState(category: Category) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            if (category == Category.ALL) "Inbox is empty." else "Nothing in ${category.label}.",
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}

@Composable
private fun Banner(text: String, isError: Boolean, onDismiss: () -> Unit) {
    val background =
        if (isError) MaterialTheme.colorScheme.errorContainer
        else MaterialTheme.colorScheme.secondaryContainer
    val foreground =
        if (isError) MaterialTheme.colorScheme.onErrorContainer
        else MaterialTheme.colorScheme.onSecondaryContainer

    Row(
        Modifier.fillMaxWidth().background(background).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = foreground, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        TextButton(onClick = onDismiss) { Text("Dismiss", color = foreground) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CategoryBar(
    categories: List<Category>,
    selected: Category,
    counts: Map<Category, Int>,
    total: Int,
    onSelect: (Category) -> Unit,
) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(categories) { category ->
            val count = if (category == Category.ALL) total else counts[category] ?: 0
            FilterChip(
                selected = category == selected,
                onClick = { onSelect(category) },
                label = { Text("${category.label} ($count)") },
                colors = FilterChipDefaults.filterChipColors(),
            )
        }
    }
}

@Composable
private fun MessageRow(message: EmailMessage, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                message.initial,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }

        Spacer(Modifier.width(16.dp))

        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    message.displaySender,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = if (message.isUnread) FontWeight.Bold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    formatTimestamp(message.timestamp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                message.subject,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (message.isUnread) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                message.snippet,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

private val timeFormat = DateTimeFormatter.ofPattern("h:mm a")
private val dateFormat = DateTimeFormatter.ofPattern("d MMM")

/** Today shows a clock time, anything older shows a date — the usual mail-client convention. */
fun formatTimestamp(millis: Long): String {
    if (millis <= 0L) return ""
    val zone = ZoneId.systemDefault()
    val dateTime = Instant.ofEpochMilli(millis).atZone(zone)
    return if (dateTime.toLocalDate() == LocalDate.now(zone)) {
        dateTime.format(timeFormat)
    } else {
        dateTime.format(dateFormat)
    }
}
