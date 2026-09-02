import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authUrl, exchangeCode, isAuthorized, logout, restoreSession } from './auth.js';
import * as gmail from './gmail.js';
import { CATEGORIES } from './categorize.js';
import * as store from './store.js';
import * as watch from './watch.js';
import * as forward from './forward.js';
import * as wa from './whatsapp.js';
import { router as webhooks } from './webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the Express app.
 *
 * Shared by the local server and the Vercel function so there is exactly one copy of
 * the routing. The differences between the two environments are confined to how state
 * is loaded (below) and to what starts the background timers (server.js only).
 */
export function createApp() {
  const app = express();

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

  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

  /**
   * Serve the app shell explicitly rather than leaning on express.static's
   * directory-index behaviour.
   *
   * Behind Vercel's catch-all rewrite the path the function sees for a bare "/" is not
   * reliably "/", so static's implicit index lookup does not fire and the request
   * falls through. Naming the file removes the guesswork. "/api" is matched too
   * because that is the rewrite destination and nothing else answers on it.
   */
  app.get(['/', '/api'], (req, res, next) => {
    res.sendFile(INDEX_HTML, (err) => (err ? next(err) : undefined));
  });

  app.use(express.static(PUBLIC_DIR));

  /**
   * Loads settings and the Google session before any route that needs them.
   *
   * Deliberately reloaded on every such request rather than cached in module scope.
   * Serverless keeps warm instances around, so a cached snapshot would go stale the
   * moment another invocation — or the cron job — changed something.
   *
   * Static files skip this, which is most of the traffic.
   */
  const needsState = ['/api', '/webhook', '/cron', '/auth', '/oauth2callback', '/healthz'];
  app.use(needsState, async (req, res, next) => {
    try {
      await store.load();
      await restoreSession();
      next();
    } catch (err) {
      console.error('[app] could not load state:', err.message);
      res.status(503).json({ error: `Storage unavailable: ${err.message}` });
    }
  });

  /** Turns a thrown Google API error into something the UI can actually explain. */
  function wrap(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
        await store.flushed();
      } catch (err) {
        const status = err?.response?.status || err?.code;
        const detail = err?.response?.data?.error?.message || err.message;
        console.error(`${req.method} ${req.path} failed:`, detail);

        if (res.headersSent) return;
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

  function requireAuth(req, res, next) {
    if (!isAuthorized()) return res.status(401).json({ error: 'Not connected.' });
    next();
  }

  // Webhooks authenticate with their own secrets, not the Google session.
  app.use(webhooks);

  // ---- auth ----

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
      await store.flushed();
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

  // ---- mail ----

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
    // Re-fetch server-side so reply headers come from Gmail, not the browser.
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

  // ---- WhatsApp forwarding ----

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

    // Turning forwarding on is what registers the Gmail watch, so the two stay in step.
    if (patch.enabled === true && isAuthorized()) {
      try {
        await watch.startWatch();
        watch.scheduleRenewal();
      } catch (err) {
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

    const { via } = await forward.deliver({
      id: 'test',
      fromName: 'MailFlow',
      fromEmail: 'mailflow@localhost',
      subject: 'Test alert - your WhatsApp forwarding works',
      snippet: 'If this reached your phone, Gmail to WhatsApp is wired up correctly.',
      body: 'If this reached your phone, Gmail to WhatsApp is wired up correctly.\n\nReply "status" any time for a summary, "stop" to pause, "start" to resume.',
      category: 'Personal',
      timestamp: Date.now(),
    });

    res.json({ ok: true, via });
  }));

  /** Manual catch-up, for when notifications were missed. */
  app.post('/api/forwarding/sync', requireAuth, wrap(async (req, res) => {
    const recent = await gmail.listInbox({ maxResults: 15, query: 'in:inbox is:unread' });
    const results = await forward.processMessageIds(recent.map((m) => m.id), { budgetMs: 6000 });
    res.json({ results });
  }));

  app.post('/api/forwarding/watch', requireAuth, wrap(async (req, res) => {
    await watch.startWatch();
    watch.scheduleRenewal();
    res.json(store.publicSettings());
  }));

  /**
   * Last resort for anything that escapes a route handler.
   *
   * Without it a throw becomes a bare FUNCTION_INVOCATION_FAILED on Vercel, with the
   * cause visible only in the platform log — which is a slow way to learn that a file
   * was missing from the bundle. This says so in the response instead.
   */
  app.use((err, req, res, next) => {
    console.error(`[app] unhandled on ${req.method} ${req.originalUrl}:`, err?.stack || err);
    if (res.headersSent) return next(err);
    res.status(500).json({
      error: err?.message || 'Unhandled error',
      path: req.originalUrl,
      code: err?.code,
    });
  });

  return app;
}

function toList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
}
