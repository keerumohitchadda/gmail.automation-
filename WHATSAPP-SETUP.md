# Gmail → WhatsApp setup

This wires three services together:

```
Gmail  ──push──▶  Google Cloud Pub/Sub  ──HTTPS──▶  MailFlow  ──▶  WhatsApp Cloud API  ──▶  your phone
```

Budget about **90 minutes**, plus a wait of up to a day for Meta to approve the message
template. Do the parts in order — each one needs a value from the one before it.

---

## Part 0 — Install Node.js (required, not yet on this machine)

Node is not installed here, so nothing will run until it is. Download the **LTS**
installer from <https://nodejs.org> and run it, then reopen your terminal and check:

```bash
node -v
```

Then install the app's dependencies:

```bash
npm install
```

---

## Part 1 — Gmail OAuth

Follow the existing [SETUP.md](SETUP.md). You need `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in `.env`, and your own address added as a **test user** on the
OAuth consent screen. Confirm it works by starting the app and connecting your account
before going any further.

---

## Part 2 — A public HTTPS address

Meta and Pub/Sub both call *into* your app, so `localhost` is not reachable. While
developing, use a tunnel:

```bash
npx ngrok http 3000
```

That prints a URL like `https://a1b2c3d4.ngrok-free.app`. Everywhere below says
`YOUR_URL`, use that. Keep the tunnel running — a free ngrok URL changes each restart,
and both webhooks have to be re-pointed when it does.

> For something permanent, deploy to Railway or Render and use the hostname they give
> you. The rest of the setup is identical.

---

## Part 3 — WhatsApp Cloud API

1. Go to <https://developers.facebook.com/apps> → **Create app** → type **Business**.
2. In the app dashboard, find **WhatsApp** and click **Set up**. Accept the business
   account it offers to create.
3. Open **WhatsApp → API Setup**. You get a free test number to send *from*.
   - Copy the **Phone number ID** → `WA_PHONE_NUMBER_ID`
   - Copy the **temporary access token** → `WA_ACCESS_TOKEN`
   - Under **To**, click **Manage phone number list** and add your own number. Meta
     sends a code; enter it. **A test number can only message verified recipients**, so
     skipping this means every send fails.
4. **App Settings → Basic** → reveal **App Secret** → `WA_APP_SECRET`.
5. Invent any long random string for `WA_VERIFY_TOKEN`. It is yours; you just have to
   type the same one into Meta in the next step.

### The temporary token expires in 24 hours

Fine for testing, useless after that. For a permanent one:

**Business Settings → Users → System Users → Add** → name it, role **Admin** →
**Generate new token** → pick your app → tick `whatsapp_business_messaging` and
`whatsapp_business_management` → set expiry to **Never**. Put that in `WA_ACCESS_TOKEN`.

### Point the webhook at your app

**WhatsApp → Configuration → Webhook → Edit**:

- Callback URL: `YOUR_URL/webhook/whatsapp`
- Verify token: the same `WA_VERIFY_TOKEN` you put in `.env`

Save. Meta immediately calls your app to verify — it must be **running** with the value
already in `.env`, or verification fails. Then click **Manage** and subscribe to the
**messages** field.

This webhook is not decoration. Every message *you* send the bot reopens Meta's
24-hour window, and inside that window MailFlow sends the **full email text** instead of
the stripped-down template. It also enables the `stop`, `start` and `status` commands.

---

## Part 4 — The message template

Outside that 24-hour window Meta only accepts pre-approved templates. This is a hard
platform rule, not something the app can work around.

**WhatsApp Manager → Message templates → Create template**:

- Name: `new_email_alert`
- Category: **Utility**
- Language: **English**
- Body:

  ```
  New email from {{1}}

  Subject: {{2}}

  {{3}}
  ```

- Samples (required before it will submit): `Ravi Sharma`, `Invoice for August`,
  `Your monthly invoice is attached.`

Submit. Utility templates are usually approved within minutes to a day. The three
variables must stay in that order — the app passes sender, subject, preview.

---

## Part 5 — Gmail push via Pub/Sub

1. In the [Google Cloud console](https://console.cloud.google.com), select the same
   project as your OAuth client. Enable the **Cloud Pub/Sub API**.
2. **Pub/Sub → Topics → Create topic**, id `gmail-push`. Its full name is
   `projects/YOUR_PROJECT_ID/topics/gmail-push` → `PUBSUB_TOPIC`.
3. **Grant Gmail permission to publish to it.** Open the topic → **Permissions** →
   **Add principal**:
   - Principal: `gmail-api-push@system.gserviceaccount.com`
   - Role: **Pub/Sub Publisher**

   Miss this and `users.watch` fails with a permission error — it is the single most
   common thing to get wrong here.
4. Invent a long random string for `PUBSUB_VERIFICATION_TOKEN`.
5. **Create subscription** on that topic:
   - Id: `gmail-push-sub`
   - Delivery type: **Push**
   - Endpoint URL: `YOUR_URL/webhook/gmail?token=YOUR_PUBSUB_VERIFICATION_TOKEN`
   - Acknowledgement deadline: 60 seconds

   The `?token=` part is what stops anyone who guesses your URL from injecting fake
   notifications. Requests without the exact value are rejected with a 403.

---

## Part 6 — Turn it on

```bash
npm start
```

Open <http://localhost:3000>, connect Gmail if you have not, then click **💬 WhatsApp**
in the toolbar:

1. Enter your number in full international form, digits only — `919876543210`.
2. Tick the categories you want. Personal, Work and Finance are on by default;
   Newsletters and Social are off, which is usually what you want.
3. Flip **Forwarding** on and **Save**. Saving with it on is what registers the Gmail
   watch — the pill should switch to *Gmail watch active*.
4. Click **Send test**. Check your phone.
5. Send yourself an email and watch it arrive.

### Filters, briefly

- **Categories** — the buckets from `src/categorize.js`. Edit that file to retune them.
- **Only these senders** — when non-empty this *replaces* the category filter. Use it
  for "only ever ping me about my bank and my manager".
- **Never these senders** — checked first, beats everything else.
- **Keywords** — subject or preview must contain one of them.
- **Body preview** — how much email text to include. Set it to 0 for sender + subject
  only. Only applies inside the 24-hour window; the template preview is fixed at 300
  characters.
- **Quiet hours** — mail is **held and sent later**, not dropped. The queue flushes
  within five minutes of the window closing.

### Commands you can text the bot

| Send | Effect |
| --- | --- |
| `stop` / `pause` | Turns forwarding off |
| `start` / `resume` | Turns it back on |
| `status` | Replies with current settings and queue depth |

---

## Running it 24/7

Gmail push only helps while something is listening. On your PC the app must be running;
close it and mail queues up until the next start (use **Sync unread now** to catch up).

For genuine always-on, deploy to Railway or Render:

1. Push the repo (`.env`, `.tokens.json` and `.forwarding.json` are gitignored — keep it
   that way).
2. Set every `.env` value as environment variables in the host's dashboard.
3. Add the host's HTTPS URL to your Google OAuth client as an authorized redirect URI,
   and set `OAUTH_REDIRECT_URI` to match.
4. Re-point both webhooks (Meta and the Pub/Sub subscription) at the new hostname.
5. Open the deployed URL once and connect Gmail there, so tokens exist server-side.

---

## When it does not work

**Nothing arrives, no errors.** Check the server log for `[webhook]` lines. Silence
means Pub/Sub is not reaching you: confirm the tunnel is up and the subscription's
endpoint URL still matches, including the `?token=`.

**`403 rejected Gmail push: bad verification token`.** The `?token=` in the subscription
URL does not match `PUBSUB_VERIFICATION_TOKEN` in `.env`.

**`users.watch` fails with a permission error.** Part 5 step 3 — Gmail's service account
is not a Publisher on the topic.

**`(#131030) Recipient phone number not in allowed list`.** Test numbers can only message
recipients you verified in Part 3 step 3.

**`(#131047) Re-engagement message`.** The 24-hour window is closed and the template
either is not approved yet or its name does not match `WA_TEMPLATE_NAME`.

**Everything worked yesterday, now `Invalid OAuth access token`.** The temporary Meta
token expired. Generate a permanent System User token (Part 3).

**Alerts arrive as bare template messages, never full text.** Expected until you message
the bot. Send it anything from your phone; the next 24 hours come through in full.

**Mail stops after a week.** The Gmail watch expires after 7 days. The app renews it
daily while running — if it was down through the expiry, restart it or press **Save**
in the panel.
