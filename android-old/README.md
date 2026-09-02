# MailFlow

An Android app that pulls your Gmail into your own inbox screen, sorts it into
categories, alerts you when new mail lands, and lets you reply — with a confirmation
step before anything is sent.

**Start with [SETUP.md](SETUP.md).** The app cannot talk to Gmail until the Google Cloud
OAuth client is configured.

## What it does

| Feature | Where it lives |
|---|---|
| Read the inbox | `data/MailRepository.kt` → `fetchInbox()` |
| Auto-refresh while open (60s) | `ui/InboxViewModel.kt` → `startPolling()` |
| Background check + notifications | `work/MailSyncWorker.kt`, `notify/Notifier.kt` |
| Category filtering | `rules/CategoryRules.kt` |
| Reply / send | `data/MimeBuilder.kt`, `ui/ReplyScreen.kt` |

## How it's put together

```
MainActivity ──► InboxViewModel ──► MailRepository ──► GmailApi (Retrofit)
     │                 │                                     ▲
     │                 └──► SettingsStore (DataStore)         │
     └──► GoogleAuthManager ───── access token ───────────────┘

MailSyncWorker (every 15 min) ──► MailRepository ──► Notifier
```

Authorization uses Play Services' `AuthorizationClient`, which hands back a short-lived
OAuth access token. `GmailClient` holds it in a volatile field that an OkHttp interceptor
reads per request, so refreshing the token never means rebuilding the HTTP stack. Calling
`authorize()` again after the user has granted the scope returns a fresh token silently —
that is how the background worker stays logged in.

The Gmail REST API is called directly over Retrofit rather than via the
`google-api-services-gmail` Java client, which is large, drags in an old HTTP stack, and
needs packaging workarounds on Android.

## Editing the categories

`rules/CategoryRules.kt` is plain data. Gmail's own tab labels win first, then each rule
is matched against the sender address and subject:

```kotlin
Rule(
    Category.FINANCE,
    senderContains = listOf("bank", "hdfc", "razorpay", ...),
    subjectContains = listOf("invoice", "receipt", ...),
)
```

Add a domain to `senderContains` and it takes effect on the next refresh. To add a whole
new bucket, add a value to the `Category` enum and a `Rule` for it — the filter bar builds
itself from whatever categories actually have mail.

## On sending

`sendReply` and `sendNew` are only ever reached after the confirmation dialog in
`ReplyScreen`, which shows the recipient, subject, and full body. The "quick replies" are
templates that fill the text box — they never send on their own. If you later add genuine
auto-replies, keep a human confirmation or an explicit allow-list of senders; an
auto-responder loop between two mailboxes is a genuinely bad afternoon.

## Not built yet

- Offline cache (messages are held in memory; a Room table is the natural next step)
- Attachments
- Pagination past the first 30 messages
- Search
