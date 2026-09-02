package com.kirti.mailflow.data.model

import com.kirti.mailflow.rules.Category

/** The app-facing shape of a message, flattened out of the Gmail wire format. */
data class EmailMessage(
    val id: String,
    val threadId: String,
    val fromName: String,
    val fromEmail: String,
    val toRaw: String,
    val subject: String,
    val snippet: String,
    val timestamp: Long,
    val isUnread: Boolean,
    val category: Category,
    /** RFC 2822 Message-ID of this mail, needed to thread a reply correctly. */
    val messageIdHeader: String?,
    val referencesHeader: String?,
    /** Only populated once the full message is fetched for the detail screen. */
    val body: String? = null,
) {
    val displaySender: String get() = fromName.ifBlank { fromEmail }
    val initial: String get() = displaySender.trim().firstOrNull()?.uppercase() ?: "?"
}
