# MailFlow — Setup

Three steps: install Node, create a Google OAuth client, run it. Steps 1 and 2 are
one-time; after that `npm start` is all you need.

---

## 1. Install Node.js

Your machine has no Node runtime yet. Get the **LTS** build (v20 or v22):

- https://nodejs.org/en/download

Accept the defaults in the installer. Then **open a new terminal** (the installer edits
your PATH, and an already-open window won't see it) and check:

```bash
node -v
```

You should see `v20.x` or `v22.x`. Anything below v18 will not run this app.

## 2. Create your Google OAuth client

Go to https://console.cloud.google.com/ and sign in as **kirtichadda461@gmail.com**.

**a. Create a project** — top bar project picker → **New Project** → name it `MailFlow`.

**b. Enable the Gmail API** — *APIs & Services → Library* → search "Gmail API" → **Enable**.

**c. Configure the OAuth consent screen** — *APIs & Services → OAuth consent screen*:

- User type: **External**
- App name `MailFlow`; support email and developer email: your own address
- **Scopes** → *Add or remove scopes* → add
  `https://www.googleapis.com/auth/gmail.modify`
- **Test users** → *Add users* → add `kirtichadda461@gmail.com`
- Leave the app in **Testing**. Do not click "Publish app".

**d. Create the credentials** — *APIs & Services → Credentials → Create Credentials →
OAuth client ID*:

- Application type: **Web application**
- Name: `MailFlow Local`
- Under **Authorized redirect URIs** click *Add URI* and enter exactly:
  ```
  http://localhost:3000/oauth2callback
  ```
- **Create**

Google shows you a **Client ID** and **Client secret**. Keep that dialog open for the next step.

## 3. Configure and run

In this folder:

```bash
npm install
```

Copy `.env.example` to `.env`:

```bash
copy .env.example .env
```

Open `.env` in a text editor and paste in your two values:

```
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret-here
```

Then start it:

```bash
npm start
```

Open **http://localhost:3000** and click **Connect Gmail account**.

Google will warn that the app is unverified — click **Advanced → Go to MailFlow
(unsafe)**. That warning exists because *you* are the unverified developer; it is your own
app talking to your own mailbox.

---

## Where your credentials live

| File | Contains | Committed? |
|---|---|---|
| `.env` | Your client ID and secret | No — gitignored |
| `.tokens.json` | Google refresh/access token, written after you connect | No — gitignored |

Both stay on your machine. Nothing is sent anywhere except to Google's API. Deleting
`.tokens.json` (or clicking **Disconnect** in the UI) fully signs the app out.

## About the `gmail.modify` scope

`gmail.modify` is one of Google's **restricted** scopes — it covers reading, labelling and
sending, but not permanent deletion. In *Testing* mode it works normally for the test
users you listed. Publishing to real users would require Google's verification review
including a security assessment; that is not needed for your own inbox.

Test-mode refresh tokens expire after **7 days**. If the app suddenly asks you to
reconnect, that's why — just click Connect again.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` | The URI in Google Cloud must match `OAUTH_REDIRECT_URI` character for character, including `http://` and the port. |
| `Missing GOOGLE_CLIENT_ID` on start | No `.env` file, or it's named `.env.txt`. Windows hides extensions — check in the terminal with `dir`. |
| 403 banner in the app | Gmail API not enabled, or your address isn't in the test-users list. |
| `access_denied` at consent | Your address isn't a test user on the consent screen. |
| Asked to reconnect after a week | Normal for Testing mode — see above. |
| `EADDRINUSE` | Something else holds port 3000. Change `PORT` in `.env`, and update the redirect URI in both `.env` and Google Cloud to match. |
| No desktop alerts | Click **🔔 Alerts: off** to turn them on and allow the browser prompt. The tab must stay open. |
