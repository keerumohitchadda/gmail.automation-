import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authUrl, exchangeCode, isAuthorized, logout, restoreSession } from './src/auth.js';
import * as gmail from './src/gmail.js';
import { CATEGORIES } from './src/categorize.js';
import * as store from './src/store.js';
import * as watch from './src/watch.js';
import * as forward from './src/forward.js';
import * as wa from './src/whatsapp.js';
import { router as webhooks, runSerialized } from './src/webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();

// In production the app sits behind Nginx or the host's own proxy, which terminates
// TLS. Without this Express reports every request as plain http and sees the proxy's
// address instead of the caller's.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// The raw body is kept alongside the parsed one so the WhatsApp webhook can verify
// Meta's HMAC signature, which is computed over the exact bytes that were sent.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.static(path.join(__dirname, 'public')));

/** Turns a thrown Google API error into something the UI can actually explain. */
function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      const status = err?.response?.status || err?.code;
      const detail = err?.response?.data?.error?.message || err.message;
      console.error(`${req.method} ${req.path} failed:`, detail);

      if (status === 401) {
        return res.status(401).json({ error: 'Session expired. Reconnect your account.' });
      }
      if (status === 403) {
        return res.status(403).json({
          error:
            'Gmail refused the request. Check that the Gmail API is enabled and your address is listed as a test user.',
        });
      }
      if (status === 429) {
        return res.status(429).json({ error: 'Too many requests to Gmail. Try again in a minute.' });
      }
      res.status(500).json({ error: detail || 'Something went wrong.' });
    }
  };
}

/** Guards the /api/* routes that need a live Google session. */
function requireAuth(req, res, next) {
  if (!isAuthorized()) return res.status(401).json({ error: 'Not connected.' });
  next();
}

// Webhooks are mounted ahead of the guarded routes: Meta and Pub/Sub call in from
// outside and authenticate with their own secrets, not with the Google session.
app.use(webhooks);

// ---- auth routes ----

app.get('/auth/google', (req, res) => {
  try {
    res.redirect(authUrl());
  } catch (err) {
    res.status(500).send(`<pre>${err.message}</pre>`);
  }
});

app.get('/oauth2callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (!code) return res.redirect('/?error=missing_code');

  try {
    await exchangeCode(String(code));
    res.redirect('/?connected=1');
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/api/logout', wrap(async (req, res) => {
  await logout();
  res.json({ ok: true });
}));

app.get('/api/status', wrap(async (req, res) => {
  if (!isAuthorized()) return res.json({ connected: false });
  const me = await gmail.profile();
  res.json({ connected: true, email: me.email });
}));

// ---- mail routes ----

app.get('/api/messages', requireAuth, wrap(async (req, res) => {
  const max = Math.min(Number(req.query.max) || 30, 100);
  const search = String(req.query.q || '').trim();
  const query = search ? `in:inbox ${search}` : 'in:inbox';
  res.json({ messages: await gmail.listInbox({ maxResults: max, query }) });
}));

app.get('/api/messages/:id', requireAuth, wrap(async (req, res) => {
  res.json(await gmail.getMessage(req.params.id));
}));

app.post('/api/messages/:id/read', requireAuth, wrap(async (req, res) => {
  await gmail.markRead(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/messages/:id/archive', requireAuth, wrap(async (req, res) => {
  await gmail.archive(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/reply', requireAuth, wrap(async (req, res) => {
  const { messageId, body } = req.body || {};
  if (!messageId || !body?.trim()) {
    return res.status(400).json({ error: 'messageId and body are required.' });
  }
  // Re-fetch the original server-side so the reply headers come from Gmail,
  // not from whatever the browser claims they were.
  const original = await gmail.getMessage(messageId);
  await gmail.sendReply({ original, body });
  res.json({ ok: true });
}));

app.post('/api/send', requireAuth, wrap(async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'A recipient and a message body are required.' });
  }
  await gmail.sendNew({ to: to.trim(), subject: subject || '(no subject)', body });
  res.json({ ok: true });
}));

// ---- WhatsApp forwarding routes ----

app.get('/api/forwarding', wrap(async (req, res) => {
  res.json({
    ...store.publicSettings(),
    categoriesAvailable: CATEGORIES,
    whatsappConfigured: wa.isConfigured(),
    pubsubConfigured: Boolean(process.env.PUBSUB_TOPIC && process.env.PUBSUB_VERIFICATION_TOKEN),
    inQuietHours: forward.inQuietHours(),
  });
}));

app.put('/api/forwarding', wrap(async (req, res) => {
  const body = req.body || {};
  const patch = {};

  if ('enabled' in body) patch.enabled = Boolean(body.enabled);
  if ('toNumber' in body) patch.toNumber = wa.normalizeNumber(body.toNumber);
  if ('keywords' in body) patch.keywords = String(body.keywords || '');
  if ('bodyChars' in body) patch.bodyChars = Math.max(0, Math.min(Number(body.bodyChars) || 0, 3000));
  if (Array.isArray(body.categories)) {
    patch.categories = body.categories.filter((c) => CATEGORIES.includes(c));
  }
  if ('senderAllowlist' in body) patch.senderAllowlist = toList(body.senderAllowlist);
  if ('senderBlocklist' in body) patch.senderBlocklist = toList(body.senderBlocklist);
  if (body.quietHours) {
    patch.quietHours = {
      enabled: Boolean(body.quietHours.enabled),
      start: String(body.quietHours.start || '23:00'),
      end: String(body.quietHours.end || '07:00'),
    };
  }

  if (patch.enabled && !(patch.toNumber ?? store.get().toNumber)) {
    return res.status(400).json({ error: 'Set the destination WhatsApp number first.' });
  }

  store.update(patch);
  await store.flushed();

  // Turning forwarding on is what registers the Gmail watch, so the two stay in step
  // without the user having to remember a second button.
  if (patch.enabled === true && isAuthorized()) {
    try {
      await watch.startWatch();
      watch.scheduleRenewal();
    } catch (err) {
      // The settings themselves saved fine, so this is a warning rather than a failure —
      // otherwise a half-finished Pub/Sub setup would block "Send test" as well.
      return res.json({
        ...store.publicSettings(),
        warning: `Settings saved, but the Gmail watch could not start: ${err.message}`,
      });
    }
  } else if (patch.enabled === false && store.get().watchExpiration) {
    await watch.stopWatch().catch((err) => console.error('[watch]', err.message));
  }

  res.json(store.publicSettings());
}));

app.post('/api/forwarding/test', wrap(async (req, res) => {
  if (!store.get().toNumber) {
    return res.status(400).json({ error: 'Set the destination WhatsApp number first.' });
  }

  const sample = {
    id: 'test',
    fromName: 'MailFlow',
    fromEmail: 'mailflow@localhost',
    subject: 'Test alert - your WhatsApp forwarding works',
    snippet: 'If this reached your phone, Gmail to WhatsApp is wired up correctly.',
    body: 'If this reached your phone, Gmail to WhatsApp is wired up correctly.\n\nReply "status" any time for a summary, "stop" to pause, "start" to resume.',
    category: 'Personal',
    timestamp: Date.now(),
  };

  const { via } = await forward.deliver(sample);
  res.json({ ok: true, via });
}));

/** Manual catch-up, for when the app was down while mail arrived. */
app.post('/api/forwarding/sync', requireAuth, wrap(async (req, res) => {
  const results = await runSerialized(async () => {
    const recent = await gmail.listInbox({ maxResults: 15, query: 'in:inbox is:unread' });
    return forward.processMessageIds(recent.map((m) => m.id));
  });
  res.json({ results: results || [] });
}));

app.post('/api/forwarding/watch', requireAuth, wrap(async (req, res) => {
  await watch.startWatch();
  watch.scheduleRenewal();
  res.json(store.publicSettings());
}));

function toList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
}

// ---- startup ----

await store.load();
const restored = await restoreSession();

if (restored && store.get().enabled) {
  // A watch lasts only seven days and does not survive a long downtime, so re-register
  // on every boot rather than trusting the stored expiry.
  watch.startWatch().catch((err) => console.error('[watch] could not start:', err.message));
  watch.scheduleRenewal();
}
forward.startQuietHoursSweeper();

const server = app.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`\n  MailFlow running at http://localhost:${PORT}`);
  console.log(
    restored
      ? '  Restored your saved Google session.'
      : '  Not connected yet — open the page and click "Connect Gmail".',
  );
  console.log(
    `  WhatsApp forwarding: ${store.get().enabled ? 'on' : 'off'}` +
      `${wa.isConfigured() ? '' : ' (credentials missing — see WHATSAPP-SETUP.md)'}\n`,
  );
});

// PM2 and systemd restart by signalling. Stop taking new requests, then let the
// store finish its last write so settings are never left half-saved.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n  ${signal} received — shutting down.`);
    server.close(async () => {
      await store.flushed();
      process.exit(0);
    });
    // Don't hang forever on a slow client holding a connection open.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
