# Deploying MailFlow to Vercel

No server to administer, no SSH, no certificates, no card. Vercel gives you HTTPS on a
`*.vercel.app` hostname, which is a real certificate that Meta and Google both accept.

The app was reworked to run here — see [What changed, and why](#what-changed-and-why)
at the bottom if you want to know what serverless cost us.

---

## 1. Create the Vercel account

<https://vercel.com/signup> — sign up **with GitHub**. That authorises Vercel to see
your repositories, which is what makes the next step one click. The Hobby plan is free
and needs no payment method.

## 2. Import the project

**Add New → Project → Import** `gmail.automation-`.

Vercel detects the config from `vercel.json`; leave the framework preset as **Other**
and do not change the build settings. **Do not deploy yet** — the storage and
environment variables below have to exist first, or the first deployment will fail
health checks and you will be debugging a red X for no reason.

## 3. Add the database — this is not optional

Serverless functions have no persistent disk. Without a database the app cannot
remember your Gmail authorisation, which mail it has already forwarded, or where it had
reached in your mailbox history.

Project → **Storage → Create Database → Upstash for Redis** → *Connect*.

Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. You do not copy
anything by hand. The free tier is far more than this app uses.

## 4. Environment variables

Project → **Settings → Environment Variables**. Add each for **all three**
environments (Production, Preview, Development):

| Variable | Where it comes from |
| --- | --- |
| `GOOGLE_CLIENT_ID` | [SETUP.md](SETUP.md) |
| `GOOGLE_CLIENT_SECRET` | [SETUP.md](SETUP.md) |
| `OAUTH_REDIRECT_URI` | `https://YOUR-PROJECT.vercel.app/oauth2callback` |
| `WA_PHONE_NUMBER_ID` | [WHATSAPP-SETUP.md](WHATSAPP-SETUP.md) |
| `WA_ACCESS_TOKEN` | same |
| `WA_APP_SECRET` | same |
| `WA_VERIFY_TOKEN` | any long random string you invent |
| `WA_TEMPLATE_NAME` | `new_email_alert` |
| `PUBSUB_TOPIC` | `projects/YOUR-PROJECT/topics/gmail-push` |
| `PUBSUB_VERIFICATION_TOKEN` | another long random string |
| `CRON_SECRET` | a third random string — Vercel sends this to authorise its own cron |

`CRON_SECRET` is Vercel's own convention: it puts the value in an
`Authorization: Bearer` header on scheduled requests, and `/cron/renew` accepts it.

Now hit **Deploy**.

## 5. Point everything at the deployment

Your URL is `https://YOUR-PROJECT.vercel.app`. Four places need it:

1. **Google Cloud → Credentials → OAuth client → Authorized redirect URIs**
   Add `https://YOUR-PROJECT.vercel.app/oauth2callback`
2. **Meta → WhatsApp → Configuration → Webhook**
   Callback `https://YOUR-PROJECT.vercel.app/webhook/whatsapp`, verify token =
   `WA_VERIFY_TOKEN`. Subscribe to the **messages** field.
3. **Google Cloud → Pub/Sub → subscription → Endpoint URL**
   `https://YOUR-PROJECT.vercel.app/webhook/gmail?token=YOUR_PUBSUB_VERIFICATION_TOKEN`
4. **The app** — open your Vercel URL and click **Connect Gmail**. Authorising on your
   laptop does nothing for the deployment; the tokens have to be created there.

## 6. Check it

```
https://YOUR-PROJECT.vercel.app/healthz
```

Expect `"connected": true` and `"storage": "Upstash Redis"`. If storage says
`local file`, the database is not connected and nothing will persist — go back to
step 3.

---

## What changed, and why

Serverless is a poor natural fit for this app, and three things had to be reworked. The
constraints are real, so it is worth knowing what they cost.

**State moved off the filesystem.** `.tokens.json` and `.forwarding.json` are gone.
Everything lives in Redis via `src/kv.js`. A local run with no database configured
falls back to a `.kv.json` file, so nothing about developing on your laptop changed.

**Webhooks finish their work before responding.** Previously they acknowledged
immediately and forwarded in the background — the right design for a long-lived server,
since an unacknowledged Pub/Sub push gets redelivered. On serverless the function is
frozen the moment it responds, so that background work would silently never run. Now
the handler forwards first and acknowledges after.

**Duplicate protection had to become atomic.** With one server, "have I sent this?"
followed by "mark it sent" was safe. Vercel runs invocations concurrently, and two of
them could both pass the check before either marked it — sending you the same email
twice. There is now a single atomic `store.claim()` backed by a Redis set: exactly one
invocation is ever told to proceed.

### Limits you are living with

- **Function timeout.** Handlers stop forwarding after ~6.5 seconds and queue the rest,
  rather than being killed mid-send. A large burst of mail arrives across a few
  notifications instead of all at once.
- **Cron runs once a day** on Hobby, UTC only. That is enough — its job is renewing the
  Gmail watch, which expires weekly — but a delivery that fails waits up to 24 hours for
  its retry.
- **Quiet-hours mail is released by the daily cron**, not within five minutes as it is
  on a long-lived server. Mail held overnight goes out at the next cron run.

### Failure modes worth recognising

**`/healthz` says `"storage": "local file"`.** The Upstash integration is not connected.
Nothing persists; fix before doing anything else.

**Logged out of Gmail after every deploy.** Same cause. Tokens are going to a filesystem
that gets thrown away.

**Forwarding stopped after about a week.** The Gmail watch expired and cron did not
renew it. Check Project → Settings → Cron Jobs, and that `CRON_SECRET` is set.

**Same email twice.** Should not happen — the claim is atomic. If it does, check whether
two Pub/Sub subscriptions are pointed at the deployment.
