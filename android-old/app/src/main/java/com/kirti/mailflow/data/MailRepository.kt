package com.kirti.mailflow.data

import android.util.Base64
import com.kirti.mailflow.data.model.EmailMessage
import com.kirti.mailflow.data.model.GmailMessage
import com.kirti.mailflow.data.model.MessagePart
import com.kirti.mailflow.data.model.ModifyRequest
import com.kirti.mailflow.data.model.SendMessageRequest
import com.kirti.mailflow.data.remote.GmailApi
import com.kirti.mailflow.data.remote.GmailClient
import com.kirti.mailflow.rules.CategoryRules
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext

class MailRepository(private val api: GmailApi = GmailClient.api) {

    suspend fun myEmailAddress(): String = withContext(Dispatchers.IO) {
        api.getProfile().emailAddress
    }

    /**
     * Loads the inbox. Gmail's list endpoint only returns ids, so each message is
     * fetched in parallel with `format=metadata` — enough for the list row, and far
     * cheaper than pulling full bodies for messages the user may never open.
     */
    suspend fun fetchInbox(maxResults: Int = 30): List<EmailMessage> = coroutineScope {
        val refs = withContext(Dispatchers.IO) {
            api.listMessages(query = "in:inbox", maxResults = maxResults, pageToken = null)
        }.messages.orEmpty()

        refs.map { ref ->
            async(Dispatchers.IO) {
                runCatching {
                    api.getMessage(ref.id, format = "metadata", metadataHeaders = METADATA_HEADERS)
                }.getOrNull()
            }
        }.mapNotNull { it.await() }
            .map { it.toEmailMessage() }
            .sortedByDescending { it.timestamp }
    }

    /** Full fetch, including the readable body, for the detail screen. */
    suspend fun fetchFullMessage(id: String): EmailMessage = withContext(Dispatchers.IO) {
        val raw = api.getMessage(id, format = "full", metadataHeaders = null)
        raw.toEmailMessage().copy(body = raw.payload?.let { extractBody(it) })
    }

    suspend fun markAsRead(id: String) {
        withContext(Dispatchers.IO) {
            api.modifyMessage(id, ModifyRequest(removeLabelIds = listOf("UNREAD")))
        }
    }

    suspend fun archive(id: String) {
        withContext(Dispatchers.IO) {
            api.modifyMessage(id, ModifyRequest(removeLabelIds = listOf("INBOX")))
        }
    }

    suspend fun sendNew(to: String, subject: String, body: String) {
        withContext(Dispatchers.IO) {
            val raw = MimeBuilder.build(to = to, subject = subject, bodyText = body)
            api.sendMessage(SendMessageRequest(raw = raw))
        }
    }

    /** Replies in-thread, carrying the headers Gmail needs to keep the conversation together. */
    suspend fun sendReply(original: EmailMessage, body: String) {
        withContext(Dispatchers.IO) {
            val subject =
                if (original.subject.startsWith("Re:", ignoreCase = true)) original.subject
                else "Re: " + original.subject

            val references = listOfNotNull(original.referencesHeader, original.messageIdHeader)
                .joinToString(" ")
                .ifBlank { null }

            val raw = MimeBuilder.build(
                to = original.fromEmail,
                subject = subject,
                bodyText = body,
                inReplyTo = original.messageIdHeader,
                references = references,
            )
            api.sendMessage(SendMessageRequest(raw = raw, threadId = original.threadId))
        }
    }

    // ---- mapping helpers ----

    private fun GmailMessage.toEmailMessage(): EmailMessage {
        val headers = payload?.headers.orEmpty().associate { it.name.lowercase() to it.value }
        val from = headers["from"].orEmpty()
        val labels = labelIds.orEmpty()
        val subject = headers["subject"].orEmpty().ifBlank { "(no subject)" }
        val email = parseEmailAddress(from)

        return EmailMessage(
            id = id,
            threadId = threadId,
            fromName = parseDisplayName(from),
            fromEmail = email,
            toRaw = headers["to"].orEmpty(),
            subject = subject,
            snippet = unescapeHtml(snippet.orEmpty()),
            timestamp = internalDate?.toLongOrNull() ?: 0L,
            isUnread = labels.contains("UNREAD"),
            category = CategoryRules.classify(email, subject, labels),
            messageIdHeader = headers["message-id"],
            referencesHeader = headers["references"],
        )
    }

    /** "Jane Doe <jane@x.com>" -> "Jane Doe"; a bare address yields the part before the @. */
    private fun parseDisplayName(from: String): String {
        val angle = from.indexOf('<')
        if (angle > 0) return from.substring(0, angle).trim().trim('"')
        return from.substringBefore('@').trim()
    }

    private fun parseEmailAddress(from: String): String {
        val open = from.indexOf('<')
        val close = from.indexOf('>')
        if (open >= 0 && close > open) return from.substring(open + 1, close).trim().lowercase()
        return from.trim().lowercase()
    }

    /**
     * Walks the MIME tree for something readable, preferring text/plain over
     * a tag-stripped text/html fallback.
     */
    private fun extractBody(part: MessagePart): String {
        findPart(part, "text/plain")?.let { return decode(it) }
        findPart(part, "text/html")?.let { return stripHtml(decode(it)) }
        return part.body?.data?.let { decodeData(it) }.orEmpty()
    }

    private fun findPart(part: MessagePart, mimeType: String): MessagePart? {
        if (part.mimeType == mimeType && part.body?.data != null) return part
        part.parts?.forEach { child ->
            val found = findPart(child, mimeType)
            if (found != null) return found
        }
        return null
    }

    private fun decode(part: MessagePart): String = part.body?.data?.let { decodeData(it) }.orEmpty()

    private fun decodeData(data: String): String = runCatching {
        String(Base64.decode(data, Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8)
    }.getOrDefault("")

    private fun stripHtml(html: String): String {
        val withoutScripts = SCRIPT_OR_STYLE.replace(html, " ")
        val withBreaks = BR_TAG.replace(withoutScripts, "\n")
        val withParagraphs = CLOSING_P.replace(withBreaks, "\n\n")
        val textOnly = ANY_TAG.replace(withParagraphs, " ")
        return unescapeHtml(textOnly)
            .let { RUNS_OF_SPACES.replace(it, " ") }
            .let { RUNS_OF_NEWLINES.replace(it, "\n\n") }
            .trim()
    }

    private fun unescapeHtml(text: String): String = text
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")

    private companion object {
        val METADATA_HEADERS = listOf("From", "To", "Subject", "Date", "Message-ID", "References")

        val SCRIPT_OR_STYLE = Regex("<(script|style)[^>]*>.*?</\\1>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
        val BR_TAG = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE)
        val CLOSING_P = Regex("</p>", RegexOption.IGNORE_CASE)
        val ANY_TAG = Regex("<[^>]+>")
        val RUNS_OF_SPACES = Regex("[ \\t]{2,}")
        val RUNS_OF_NEWLINES = Regex("\\n{3,}")
    }
}
