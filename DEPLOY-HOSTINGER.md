# Deploying MailFlow to Hostinger

Running this on a host is not optional once you want WhatsApp forwarding: Google
Pub/Sub and Meta both call *into* your app over public HTTPS, and neither can reach
`localhost`.

---

## First: does your plan support Node.js?

| Hostinger plan | Node.js | Verdict for this app |
| --- | --- | --- |
| Single / Premium web hosting | ❌ | **Will not run.** PHP only. |
| **Business** web hosting | ✅ managed | Works, with the cron workaround below |
| **Cloud** (Startup and up) | ✅ managed | Same as Business |
| **VPS** | ✅ full root | **Best fit** — this is the path to prefer |

If you are on Single or Premium, no amount of configuration will help; Node is simply
not installed on those plans. Upgrade to Business, or use a VPS.

### Why VPS is the better fit here

Managed Node on shared hosting idles applications that receive no traffic. That is
normally harmless, but this app has a trap:

- Your Gmail watch expires **7 days** after registration.
- The daily renewal timer cannot fire while the app is asleep.
- Nothing wakes the app, because waking it requires a notification the expired watch
  will never send.

The result is silent failure — the app looks fine and forwards nothing. `/cron/renew`
exists to break that cycle, but on a VPS the process simply never sleeps and the
problem does not arise.

---

# Path A — VPS (recommended)

Assumes Ubuntu 22.04/24.04, which is Hostinger's default VPS image. SSH details are in
hPanel under **VPS → Server → SSH access**.

## 1. Connect and create a non-root user

```bash
ssh root@YOUR_SERVER_IP
```

```bash
adduser --disabled-password --gecos "" mailflow
```

Running a public-facing Node process as root means any bug in it is a root bug. Don't.

## 2. Install Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
```

```bash
node -v && npm -v
```

## 3. Get the code onto the server

The repo is **private**, so the server needs its own read access. Give it a deploy
key — a key scoped to this one repository, which is safer than putting a personal
token on a server.

On the server:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C "mailflow-vps" && cat ~/.ssh/github_deploy.pub
```

Copy that output into GitHub → the repo → **Settings → Deploy keys → Add deploy key**.
Leave "Allow write access" **unchecked**; the server only ever needs to read.

Then tell SSH to use it, and clone:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

```bash
git clone git@github.com:keerumohitchadda/gmail.automation-.git ~/mailflow
```

**Simpler alternative:** skip git entirely and upload the bundle, which is what
`deploy.sh` expects. It copies from whatever folder it is sitting in, so no repository
access is needed on the server at all. You lose one-command updates, but the initial
deploy is quicker.

Either way, **never upload `.env`, `.tokens.json`, `.forwarding.json`, or
`node_modules`** — the first three are secrets and the last is platform-specific.

## 4. Install dependencies and configure

```bash
cd /home/mailflow/mailflow && npm ci --omit=dev
```

```bash
cp .env.example .env && nano .env
```

Fill in every value. The deployment-specific ones:

```ini
OAUTH_REDIRECT_URI=https://mail.yourdomain.com/oauth2callback
HOST=127.0.0.1
TRUST_PROXY=1
CRON_TOKEN=some-long-random-string
```

`OAUTH_REDIRECT_URI` **must** be your public HTTPS URL now, not localhost, and must
match what you register in Google Cloud in step 8.

Lock the file down — it holds every secret you have:

```bash
chmod 600 .env
```

## 5. Run it under PM2

```bash
npm install -g pm2
```

```bash
cd /home/mailflow/mailflow && pm2 start ecosystem.config.cjs
```

```bash
pm2 save && pm2 startup systemd -u mailflow --hp /home/mailflow
```

That last command prints another command — run it. Without it PM2 will not come back
after a server reboot, and you will discover this a week later.

Check it:

```bash
pm2 logs mailflow --lines 30
```

`ecosystem.config.cjs` deliberately runs **one** instance. The Gmail history cursor and
the de-dup list live in a single JSON file with no cross-process locking, so a second
worker would double-send every email and corrupt the cursor.

## 6. Nginx reverse proxy

```bash
apt install -y nginx
```

Create `/etc/nginx/sites-available/mailflow`:

```nginx
server {
    listen 80;
    server_name mail.yourdomain.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Meta signs the webhook body byte-for-byte. Buffering is fine, but never
        # add anything here that rewrites or re-encodes the request body.
        client_max_body_size 2m;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/mailflow /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
```

## 7. HTTPS

Point an A record for `mail.yourdomain.com` at your VPS IP first, wait for it to
resolve, then:

```bash
apt install -y certbot python3-certbot-nginx && certbot --nginx -d mail.yourdomain.com
```

Certbot rewrites the Nginx config for TLS and installs a renewal timer. **Meta will
reject a self-signed certificate**, so this step is mandatory, not optional polish.

Firewall:

```bash
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

Port 3000 is deliberately not opened — the app binds to `127.0.0.1` and is only
reachable through Nginx.

## 8. Re-point everything at the new URL

Four places still think you are on localhost:

1. **Google Cloud → Credentials → your OAuth client → Authorized redirect URIs**
   Add `https://mail.yourdomain.com/oauth2callback`.
2. **Meta → WhatsApp → Configuration → Webhook**
   Callback URL `https://mail.yourdomain.com/webhook/whatsapp`, same verify token.
3. **Google Cloud → Pub/Sub → your subscription → Edit → Endpoint URL**
   `https://mail.yourdomain.com/webhook/gmail?token=YOUR_PUBSUB_VERIFICATION_TOKEN`
4. **The app itself** — open `https://mail.yourdomain.com` and click **Connect Gmail**.
   OAuth tokens live on whichever machine did the authorising; connecting locally does
   nothing for the server.

## 9. Confirm

```bash
curl https://mail.yourdomain.com/healthz
```

You want `"connected": true` and, once forwarding is on, a non-null `watchExpiresAt`.

---

# Path B — Business or Cloud plan (managed Node)

## 1. Create the app

hPanel → **Websites → Manage → Advanced → Node.js**. Set:

- **Application root**: where you uploaded the project
- **Application startup file**: `server.js`
- **Node version**: 18 or newer
- **Application URL**: your domain or subdomain

## 2. Upload and install

Upload everything except `node_modules`, `.env`, `.tokens.json`, `.forwarding.json`.
Then use the panel's **Run NPM Install** button, or from the browser terminal:

```bash
npm ci --omit=dev
```

## 3. Environment variables

Add every variable from `.env.example` through the panel's environment variable
editor rather than uploading a `.env` file — the panel injects them into the process,
and a `.env` sitting in a web-served directory is a liability.

Set `OAUTH_REDIRECT_URI` to `https://yourdomain.com/oauth2callback`. Leave `HOST`
unset; the panel decides the bind address.

## 4. The keep-alive cron — do not skip this

This is what stops the silent-failure trap described at the top.

hPanel → **Advanced → Cron Jobs**, daily:

```bash
curl -s "https://yourdomain.com/cron/renew?token=YOUR_CRON_TOKEN"
```

That endpoint re-registers the Gmail watch and flushes anything quiet hours held back.
It is a no-op when forwarding is off, and returns 403 without the right token.

If you would rather not use Hostinger's cron, <https://cron-job.org> does the same
thing for free.

## 5. Re-point everything

Identical to **Path A step 8** — all four items.

---

## Keeping it updated

On the VPS:

```bash
cd /home/mailflow/mailflow && git pull && npm ci --omit=dev && pm2 restart mailflow
```

`.env`, `.tokens.json` and `.forwarding.json` are gitignored, so a pull never disturbs
your credentials or your forwarding state.

---

## When it goes wrong

**502 Bad Gateway from Nginx.** The Node process is down. `pm2 logs mailflow --err`.

**`/healthz` says `"connected": false`.** Nobody authorised Gmail *on the server*.
Open the site and click Connect Gmail.

**Meta webhook verification fails.** The app must already be running with
`WA_VERIFY_TOKEN` set before you click Save in Meta's console, and the URL must be
HTTPS with a real certificate.

**Forwarding worked, then stopped after about a week.** The Gmail watch expired. On a
VPS check that PM2 actually survived a reboot (`pm2 list`). On Business/Cloud, check
the cron job is firing — this is exactly the failure it exists to prevent.

**Mail arrives twice.** More than one instance is running. `pm2 list` should show a
single `mailflow`; the config sets `instances: 1` for this reason.

**`EADDRINUSE` on start.** Something already holds port 3000 — usually an older PM2
process. `pm2 delete all` and start again.
