# MailFlow

A local web app that pulls your Gmail into your own inbox page, sorts it into categories,
alerts you when new mail lands, and lets you reply — with a confirmation step before
anything is sent.

Runs entirely on your machine. No build step, no framework, no bundler.

**Start with [SETUP.md](SETUP.md).** The app cannot talk to Gmail until you create a Google
OAuth client.

```bash
npm install
npm start
```

Then open http://localhost:3000

## What it does

| Feature | Where it lives |
|---|---|
| Show the inbox | [`src/gmail.js`](src/gmail.js) → `listInbox()` |
| Auto-refresh every 30s + desktop alerts | [`public/app.js`](public/app.js) → `refresh()`, `notifyNewMail()` |
| Category filtering | [`src/categorize.js`](src/categorize.js) |
| Search | the search box maps onto Gmail's own query syntax |
| Reply / compose | [`src/mime.js`](src/mime.js) + the confirm dialog in `public/app.js` |
| **Forward new mail to WhatsApp** | [`src/forward.js`](src/forward.js), [`src/whatsapp.js`](src/whatsapp.js), [`src/watch.js`](src/watch.js) |

## Gmail → WhatsApp

New inbox mail can be pushed to your phone over WhatsApp. Gmail publishes a Pub/Sub
notification the moment mail arrives, the app pulls the message, applies your filters,
and sends it through Meta's WhatsApp Cloud API.

```
Gmail ──push──▶ Pub/Sub ──HTTPS──▶ /webhook/gmail ──▶ filters ──▶ WhatsApp Cloud API ──▶ phone
```

Set it up with **[WHATSAPP-SETUP.md](WHATSAPP-SETUP.md)**, then configure it from the
**💬 WhatsApp** button in the toolbar: destination number, which categories to forward,
sender allow/blocklists, keyword filters, how much body text to include, and quiet hours
(held and delivered later, not dropped).

Two things worth knowing before you start:

- **Meta blocks free-form messages outside a 24-hour window.** Message the bot from your
  phone and the next 24 hours arrive as full email text; outside that window alerts fall
  back to an approved template carrying sender, subject and a short preview. The app
  switches between the two automatically.
- **Push only works while the app is running.** On your own PC that means mail arriving
  overnight waits for the next start — use **Sync unread now** to catch up, or deploy it
  somewhere always-on.

You can text the bot `stop`, `start` or `status`.

## Deploying

Forwarding only works while the app is reachable at a public HTTPS address, so a host
is required rather than optional.

- **[VERCEL-SETUP.md](VERCEL-SETUP.md)** — free, no card, no server to administer.
  Requires the Upstash Redis integration, because serverless has no persistent disk.
- **[DEPLOY-HOSTINGER.md](DEPLOY-HOSTINGER.md)** — a VPS with PM2, Nginx and
  Let's Encrypt. More setup, fewer constraints.
- **[ORACLE-SETUP.md](ORACLE-SETUP.md)** — the same VPS path on Oracle's free tier.

The app runs unchanged in both shapes. `src/kv.js` keeps state in Redis when
`KV_REST_API_URL` is set and in a local file otherwise, and the background timers that
only a long-lived process can run are skipped on Vercel in favour of the cron endpoint.

Two endpoints exist for hosted operation: `/healthz` for uptime monitoring, and
`/cron/renew?token=…` for a daily scheduler to keep the Gmail watch alive on hosting
that idles inactive apps.

## How it's put together

```
browser (public/)                    server (Node + Express)
  app.js  ──── fetch /api/* ────►  server.js
                                      ├── src/auth.js       OAuth + token persistence
                                      ├── src/gmail.js      Gmail API calls + parsing
                                      ├── src/categorize.js sorting rules
                                      └── src/mime.js       RFC 2822 message building
                                             │
                                             ▼
                                     Google Gmail API
```

Your Google client secret and tokens never reach the browser — the front end only ever
talks to your own server, which holds the credentials. That is the reason for the server
half at all; a pure browser app would have to expose the secret or run a token proxy anyway.

`googleapis` refreshes the access token on its own; `src/auth.js` listens for the `tokens`
event and writes the new pair to `.tokens.json`, so restarting the server doesn't send you
back through the consent screen.

## Editing the categories

[`src/categorize.js`](src/categorize.js) is plain data. Gmail's own tab labels win first,
then each rule matches against the sender address and subject:

```js
{
  category: 'Finance',
  senders: ['bank', 'hdfc', 'razorpay', ...],
  subjects: ['invoice', 'receipt', ...],
}
```

Add a domain to `senders` and it takes effect on the next refresh. For a new bucket, add
an object to `RULES` — the sidebar builds itself from whatever categories actually have
mail in them.

## On sending

Two gates stand between a click and an outgoing email: the composer's **Send…** button
opens a confirmation dialog showing the exact recipient, subject and body, and only
**Yes, send it** calls the API. The quick-reply chips just fill the text box; they never
send on their own.

Replies are assembled server-side. `/api/reply` takes only a message id and body, then
re-fetches the original from Gmail to build the `In-Reply-To` and `References` headers —
so the browser can't be tricked into redirecting a reply to a different recipient.

If you later add genuine auto-replies, keep a human confirmation or an explicit allow-list
of senders. Two auto-responders discovering each other is a genuinely bad afternoon.

## Not built yet

- Pagination past the first 30 messages
- Attachments
- HTML mail rendering (bodies are converted to plain text)
- Multiple accounts

## `android-old/`

The first draft of this was an Android app. Those files are archived in `android-old/` and
are not part of the web app — delete the folder whenever you like.
