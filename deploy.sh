#!/usr/bin/env bash
#
# One-shot MailFlow deployment for a fresh Hostinger VPS (Ubuntu 22.04 / 24.04).
#
#   sudo bash deploy.sh mail.yourdomain.com
#
# Safe to run more than once: every step checks before it acts, so a re-run after a
# failure picks up where it stopped rather than duplicating anything.

set -euo pipefail

DOMAIN="${1:-}"
APP_USER="mailflow"
APP_HOME="/home/${APP_USER}"
APP_DIR="${APP_HOME}/mailflow"
NODE_MAJOR=22

die()  { printf '\n\033[31mERROR:\033[0m %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n\033[36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m  %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo bash deploy.sh your.domain.com"
[ -n "$DOMAIN" ]     || die "Pass your domain: sudo bash deploy.sh mail.yourdomain.com"

# A typo here produces a certificate for the wrong name and a confusing failure much
# later, so reject anything that is not plausibly a hostname.
[[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]] \
  || die "'$DOMAIN' does not look like a domain name."

printf '\n\033[1mMailFlow deployment\033[0m\n  domain: %s\n  app dir: %s\n' "$DOMAIN" "$APP_DIR"

# ---------------------------------------------------------------------------
step "Checking the archive is here"
# ---------------------------------------------------------------------------
# The script is shipped inside the bundle, so the source sits next to it.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "${SRC_DIR}/server.js" ] || die "server.js not found next to this script. Unpack the bundle first: tar -xzf mailflow.tar.gz"
ok "found source in ${SRC_DIR}"

# ---------------------------------------------------------------------------
step "Checking DNS points here"
# ---------------------------------------------------------------------------
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
DOMAIN_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || echo '')"

if [ -z "$DOMAIN_IP" ]; then
  warn "$DOMAIN does not resolve yet. Add an A record pointing to ${SERVER_IP:-this server} and wait a few minutes."
  warn "Continuing — but the HTTPS step at the end will fail until DNS resolves."
elif [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
  warn "$DOMAIN resolves to $DOMAIN_IP but this server is $SERVER_IP."
  warn "If you just changed DNS this is normal; if not, HTTPS will fail."
else
  ok "$DOMAIN -> $SERVER_IP"
fi

# ---------------------------------------------------------------------------
step "Installing system packages"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg nginx >/dev/null
ok "nginx and prerequisites"

if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 18 ]; then
  ok "node $(node -v) already installed"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "node $(node -v)"
fi

command -v pm2 >/dev/null 2>&1 || { npm install -g pm2 --silent >/dev/null; }
ok "pm2 $(pm2 -v)"

# ---------------------------------------------------------------------------
step "Creating the ${APP_USER} service account"
# ---------------------------------------------------------------------------
# The app faces the public internet. Running it as root would make any bug in it a
# root-level bug, so it gets its own unprivileged, non-login account.
if id "$APP_USER" >/dev/null 2>&1; then
  ok "user ${APP_USER} exists"
else
  adduser --system --group --shell /usr/sbin/nologin --home "$APP_HOME" "$APP_USER"
  ok "created ${APP_USER}"
fi
mkdir -p "$APP_DIR" "${APP_DIR}/logs"

# ---------------------------------------------------------------------------
step "Copying application files"
# ---------------------------------------------------------------------------
# --update keeps anything newer that is already on the server, so an existing .env,
# .tokens.json or .forwarding.json is never clobbered by a redeploy.
cp -r --update "${SRC_DIR}/." "$APP_DIR/"
rm -rf "${APP_DIR}/node_modules"
chown -R "${APP_USER}:${APP_USER}" "$APP_HOME"
ok "copied to ${APP_DIR}"

# ---------------------------------------------------------------------------
step "Installing dependencies"
# ---------------------------------------------------------------------------
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --silent 2>/dev/null \
  || sudo -u "$APP_USER" npm install --omit=dev --silent
ok "$(sudo -u "$APP_USER" npm ls --depth=0 --omit=dev 2>/dev/null | grep -c '──' || echo '?') top-level packages"

# ---------------------------------------------------------------------------
step "Preparing .env"
# ---------------------------------------------------------------------------
NEEDS_ENV=0
if [ -f "${APP_DIR}/.env" ]; then
  ok ".env already present — leaving it alone"
else
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  # Generate the three secrets that are just "any long random string", so there is
  # one less thing to invent by hand and no chance of a weak value.
  CRON_TOKEN="$(openssl rand -hex 24)"
  PUBSUB_TOKEN="$(openssl rand -hex 24)"
  VERIFY_TOKEN="$(openssl rand -hex 24)"
  sed -i "s|^# CRON_TOKEN=.*|CRON_TOKEN=${CRON_TOKEN}|"                 "${APP_DIR}/.env"
  sed -i "s|^PUBSUB_VERIFICATION_TOKEN=.*|PUBSUB_VERIFICATION_TOKEN=${PUBSUB_TOKEN}|" "${APP_DIR}/.env"
  sed -i "s|^WA_VERIFY_TOKEN=.*|WA_VERIFY_TOKEN=${VERIFY_TOKEN}|"       "${APP_DIR}/.env"
  sed -i "s|^OAUTH_REDIRECT_URI=.*|OAUTH_REDIRECT_URI=https://${DOMAIN}/oauth2callback|" "${APP_DIR}/.env"
  sed -i "s|^# HOST=.*|HOST=127.0.0.1|"                                 "${APP_DIR}/.env"
  sed -i "s|^# TRUST_PROXY=.*|TRUST_PROXY=1|"                           "${APP_DIR}/.env"
  NEEDS_ENV=1
  ok "created .env with generated secrets"
fi
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"

# ---------------------------------------------------------------------------
step "Starting the app under PM2"
# ---------------------------------------------------------------------------
sudo -u "$APP_USER" HOME="$APP_HOME" pm2 delete mailflow >/dev/null 2>&1 || true
sudo -u "$APP_USER" HOME="$APP_HOME" pm2 start ecosystem.config.cjs >/dev/null
sudo -u "$APP_USER" HOME="$APP_HOME" pm2 save >/dev/null
# Without this the app does not come back after a reboot, which you would find out
# about days later and blame on something else.
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
systemctl enable "pm2-${APP_USER}" >/dev/null 2>&1 || true
ok "pm2 running and enabled at boot"

# ---------------------------------------------------------------------------
step "Configuring nginx"
# ---------------------------------------------------------------------------
cat > /etc/nginx/sites-available/mailflow <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;

        # Meta signs the webhook body byte for byte. Nothing here may rewrite or
        # re-encode the request body or signature checks start failing.
        client_max_body_size 2m;
    }
}
NGINX

ln -sfn /etc/nginx/sites-available/mailflow /etc/nginx/sites-enabled/mailflow
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "nginx config test failed — run 'nginx -t' to see why"
systemctl reload nginx
ok "proxying ${DOMAIN} -> 127.0.0.1:3000"

# ---------------------------------------------------------------------------
step "Firewall"
# ---------------------------------------------------------------------------
# Port 3000 is never opened anywhere below: the app binds to loopback and is only
# reachable through nginx.

# Oracle Cloud's Ubuntu images ship an iptables chain that REJECTs everything except
# SSH, *underneath* whatever ufw thinks it is doing. Opening the cloud Security List
# is not enough and neither is ufw — the packets die on the host. This is the single
# most common reason an Oracle instance looks dead on port 80.
if iptables -C INPUT -j REJECT --reject-with icmp-host-prohibited >/dev/null 2>&1 \
   || iptables -L INPUT -n 2>/dev/null | grep -q 'REJECT.*icmp-host-prohibited'; then
  step_note="oracle-style iptables detected"
  for port in 80 443; do
    if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; then
      # Insert at the top so it lands before the catch-all REJECT.
      iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
    fi
  done
  apt-get install -y -qq iptables-persistent netfilter-persistent >/dev/null 2>&1 || true
  netfilter-persistent save >/dev/null 2>&1 || iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
  ok "${step_note}; opened 80 and 443 and persisted the rules"
  warn "Also open 80 and 443 in the Oracle console: Networking > VCN > Security Lists > Ingress"
elif command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  ok "ufw: ports 22, 80, 443 open; 3000 stays private"
else
  warn "no recognised firewall — skipping"
fi

# ---------------------------------------------------------------------------
step "HTTPS certificate"
# ---------------------------------------------------------------------------
apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
if certbot certificates 2>/dev/null | grep -q "$DOMAIN"; then
  ok "certificate already present"
elif certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
  ok "certificate issued and auto-renewal installed"
else
  warn "certbot failed — almost always DNS not yet pointing at this server."
  warn "Once ${DOMAIN} resolves here, run:  certbot --nginx -d ${DOMAIN}"
fi

# ---------------------------------------------------------------------------
step "Daily Gmail watch renewal"
# ---------------------------------------------------------------------------
TOKEN="$(grep -E '^CRON_TOKEN=' "${APP_DIR}/.env" | cut -d= -f2- || echo '')"
if [ -n "$TOKEN" ]; then
  echo "0 4 * * * root curl -fsS 'https://${DOMAIN}/cron/renew?token=${TOKEN}' >/dev/null 2>&1" \
    > /etc/cron.d/mailflow-renew
  chmod 644 /etc/cron.d/mailflow-renew
  ok "cron installed — renews the watch daily at 04:00"
else
  warn "no CRON_TOKEN in .env — skipping the renewal cron"
fi

# ---------------------------------------------------------------------------
step "Health check"
# ---------------------------------------------------------------------------
sleep 3
if curl -fsS --max-time 10 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
  ok "app responding: $(curl -fsS http://127.0.0.1:3000/healthz)"
else
  warn "app not responding yet — check: sudo -u ${APP_USER} pm2 logs mailflow"
fi

# ---------------------------------------------------------------------------
printf '\n\033[32m%s\033[0m\n' "Server setup complete."
# ---------------------------------------------------------------------------

cat <<SUMMARY

  Site:     https://${DOMAIN}
  Logs:     sudo -u ${APP_USER} pm2 logs mailflow
  Restart:  sudo -u ${APP_USER} pm2 restart mailflow
  Health:   curl https://${DOMAIN}/healthz

SUMMARY

if [ "$NEEDS_ENV" -eq 1 ]; then
  cat <<TODO
  STILL TO DO — the app runs, but cannot reach Gmail or WhatsApp until you add
  credentials that only you can create:

    nano ${APP_DIR}/.env

  Fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  (see SETUP.md)
          WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_APP_SECRET, PUBSUB_TOPIC
                                                 (see WHATSAPP-SETUP.md)

  The random secrets below were generated for you — copy them into the Meta and
  Google consoles where those guides ask for them:

TODO
  grep -E '^(WA_VERIFY_TOKEN|PUBSUB_VERIFICATION_TOKEN|CRON_TOKEN)=' "${APP_DIR}/.env" | sed 's/^/    /'
  printf '\n  Then:  sudo -u %s pm2 restart mailflow\n\n' "$APP_USER"
fi
