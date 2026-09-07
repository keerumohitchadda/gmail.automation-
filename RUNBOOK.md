# Runbook — the live deployment

What is actually running, and what to do when it stops. No secrets are in this file;
this repository is public.

## Where things live

| | |
| --- | --- |
| App | <https://gmail-automation-lilac.vercel.app> |
| Health | <https://gmail-automation-lilac.vercel.app/healthz> |
| Host | Vercel, project `gmail-automation` (team `mk-e7e7`) |
| Storage | Upstash Redis, via the Vercel integration |
| Meta app | `2261642857990038` — WhatsApp Business account `1097746046152863` |
| Sender | Meta test number `+1 555 669-7773` |
| Google Cloud | project `mail-automation-507507`, topic `gmail-push` |
| Cron | `/cron/renew` daily at 04:00 UTC (`vercel.json`) |

## Start here when something is wrong

```bash
curl https://gmail-automation-lilac.vercel.app/healthz
```

```json
{ "ok": true, "connected": true, "forwarding": true,
  "mailboxes": [{ "email": "…", "watchExpiresAt": "…", "watchActive": true }],
  "queued": 0, "storage": "Upstash Redis" }
```

| Symptom | Meaning |
| --- | --- |
| `storage` says `local file` | Redis credentials are missing. Nothing persists — the Google session will not survive. |
| `connected: false` | No mailbox authorised. Open the app and connect one. |
| `watchActive: false` | Gmail push has lapsed. Call the cron endpoint below. |
| `queued` climbing | Sends are failing. Almost always the Meta token. |
| `forwarding: false` | Someone sent `stop` to the bot, or it was switched off in the UI. |

## The three failures that have actually happened

### 1. The Meta access token expired

The single most likely cause of silence. Temporary tokens die after 24 hours.

**Fix:** use a **system user** token with expiry **Never** —
<https://business.facebook.com/settings/system-users?business_id=1136995332240787>.
It needs `whatsapp_business_messaging` and `whatsapp_business_management`, and the
system user must have Full control over both the app and the WhatsApp account, or the
permissions list comes up empty.

Verify any token before trusting it:

```bash
curl "https://graph.facebook.com/debug_token?input_token=TOKEN&access_token=TOKEN"
```

`expires_at: 0` means it never expires. Anything else will fail on that date.

Install it without a redeploy — see **Rotating credentials** below.

### 2. Messages reported as sent but never arrived

Meta accepts a **free-form** message outside its 24-hour customer service window,
returns `200` with a message id, and then silently discards it. There is no error to
catch. A full day of alerts disappeared this way while every call looked successful.

This is why `src/notify.js` sends the approved **template** by default and only
attempts free-form when an inbound message proves the window is open. Do not "improve"
this by trying text first — that is the bug, not an optimisation.

### 3. The Gmail watch lapsed

A watch expires seven days after registration. The cron endpoint re-arms every mailbox:

```bash
curl -X POST "https://gmail-automation-lilac.vercel.app/cron/renew?token=CRON_TOKEN"
```

It also drains the retry queue, so it is the right thing to call after fixing a token.

## Rotating credentials without a redeploy

Environment variables only reach a *new* deployment, which is a poor dependency for a
credential that expires on a timer. Values stored in Redis under `mailflow:secrets`
override the environment for:

`WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_TEMPLATE_NAME`,
`WA_TEMPLATE_LANG`, `TELEGRAM_BOT_TOKEN`, `CRON_TOKEN`, `CRON_SECRET`

Write the whole object at once — a `SET` replaces it:

```bash
curl -X POST "$KV_REST_API_URL" -H "Authorization: Bearer $KV_REST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '["SET","mailflow:secrets","{\"WA_ACCESS_TOKEN\":\"…\",\"CRON_TOKEN\":\"…\"}"]'
```

Takes effect on the next request. `/api/forwarding` lists which names are overridden,
never their values.

## Adding another mailbox

Click **➕ Account** in the app and authorise. Tokens, history cursor and watch are all
per-account, and every mailbox publishes to the same Pub/Sub topic, so no Google
changes are needed. Both addresses must be **test users** on the OAuth consent screen —
<https://console.cloud.google.com/apis/credentials/consent?project=mail-automation-507507>.

Then re-arm watches:

```bash
curl -X POST "https://gmail-automation-lilac.vercel.app/api/forwarding/watch"
```

## Things that are easy to get wrong

- **Self-sent mail is skipped on purpose.** Testing by emailing yourself from the same
  account will look broken. Send from a different address.
- **The recipient number must be on Meta's allowed list.** A test number can only
  message verified recipients; anything else fails with `131030`.
- **Template language is `en_US`, not `en`.** Meta treats them as different languages
  and fails the send outright rather than falling back.
- **Categories filter forwarding.** Mail in an unticked category is dropped silently
  and counted as handled. Check the WhatsApp panel before concluding the pipeline broke.
