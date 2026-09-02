package com.kirti.mailflow.rules

/** Buckets the inbox is sorted into. Order here is the order shown in the filter bar. */
enum class Category(val label: String) {
    ALL("All"),
    PERSONAL("Personal"),
    WORK("Work"),
    FINANCE("Finance"),
    SHOPPING("Shopping"),
    NEWSLETTERS("Newsletters"),
    SOCIAL("Social"),
    OTHER("Other"),
}

/**
 * Classifies a message into a [Category].
 *
 * Gmail's own tab labels win when present, because Google already did the hard part.
 * Everything else falls through to sender-domain and keyword rules, which are plain
 * data below so you can edit them without touching the logic.
 */
object CategoryRules {

    private data class Rule(
        val category: Category,
        val senderContains: List<String> = emptyList(),
        val subjectContains: List<String> = emptyList(),
    )

    private val rules = listOf(
        Rule(
            Category.FINANCE,
            senderContains = listOf(
                "bank", "hdfc", "icici", "sbi", "axis", "kotak", "paytm", "phonepe",
                "razorpay", "stripe", "paypal", "billing", "invoice", "payments",
                "zerodha", "groww", "upstox", "creditcard",
            ),
            subjectContains = listOf(
                "invoice", "receipt", "payment", "transaction", "statement", "refund",
                "credited", "debited", "due date", "emi", "salary",
            ),
        ),
        Rule(
            Category.SHOPPING,
            senderContains = listOf(
                "amazon", "flipkart", "myntra", "ajio", "swiggy", "zomato", "bigbasket",
                "nykaa", "meesho", "shopify", "order", "delivery",
            ),
            subjectContains = listOf(
                "your order", "shipped", "out for delivery", "delivered", "cart", "tracking",
            ),
        ),
        Rule(
            Category.WORK,
            senderContains = listOf(
                "jira", "atlassian", "github", "gitlab", "slack", "notion", "asana",
                "linear", "zoom", "teams", "workspace", "calendar-notification",
                "linkedin", "naukri", "indeed", "greenhouse", "lever",
            ),
            subjectContains = listOf(
                "meeting", "standup", "sprint", "deadline", "review", "interview",
                "offer letter", "pull request", "merge request", "ticket", "deploy",
            ),
        ),
        Rule(
            Category.NEWSLETTERS,
            senderContains = listOf(
                "newsletter", "substack", "medium", "digest", "noreply", "no-reply",
                "updates@", "news@", "mailer", "marketing", "campaign",
            ),
            subjectContains = listOf(
                "newsletter", "weekly digest", "this week in", "unsubscribe", "issue #",
            ),
        ),
        Rule(
            Category.SOCIAL,
            senderContains = listOf(
                "facebook", "instagram", "twitter", "x.com", "reddit", "quora",
                "discord", "pinterest", "snapchat", "youtube", "whatsapp",
            ),
            subjectContains = listOf(
                "tagged you", "commented on", "mentioned you", "new follower", "friend request",
            ),
        ),
    )

    fun classify(fromEmail: String, subject: String, labelIds: List<String>): Category {
        // 1. Trust Gmail's own tab classification first.
        when {
            labelIds.contains("CATEGORY_SOCIAL") -> return Category.SOCIAL
            labelIds.contains("CATEGORY_PROMOTIONS") -> return Category.NEWSLETTERS
            labelIds.contains("CATEGORY_FORUMS") -> return Category.NEWSLETTERS
        }

        val sender = fromEmail.lowercase()
        val subj = subject.lowercase()

        for (rule in rules) {
            if (rule.senderContains.any { sender.contains(it) }) return rule.category
            if (rule.subjectContains.any { subj.contains(it) }) return rule.category
        }

        // A human wrote to you directly and Gmail put it in Primary: treat as personal.
        if (labelIds.contains("CATEGORY_PERSONAL")) return Category.PERSONAL
        return Category.OTHER
    }
}
