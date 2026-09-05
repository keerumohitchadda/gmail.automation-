import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authUrl,
  disconnect,
  disconnectAll,
  exchangeCode,
  isAuthorized,
  listAccounts,
  loadAccounts,
} from './auth.js';
import * as gmail from './gmail.js';
import { CATEGORIES } from './categorize.js';
import * as store from './store.js';
import * as watch from './watch.js';
import * as forward from './forward.js';
import * as wa from './whatsapp.js';
import * as tg from './telegram.js';
import * as notify from './notify.js';
import { router as webhooks } from './webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the Express app.
 *
 * Shared by the local server and the Vercel function so there is one copy of the
 * routing. Environment differences are confined to how state is loaded (below) and
 * to what starts the background timers (server.js only).
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

  app.get(['/', '/api'], (req, res, next) => {
    res.sendFile(INDEX_HTML, (err) => (err ? next(err) : undefined));
  });

  app.use(express.static(PUBLIC_DIR));

  /**
   * Loads settings and every Google session before any route that needs them.
   *
   * Deliberately reloaded on each such request rather than cached in module scope.
   * Serverless keeps warm instances around, so a cached snapshot would go stale the
   * moment another invocation — or the cron job — changed something.
   */
  const needsState = ['/api', '/webhook', '/cron', '/auth', '/oauth2callback', '/healthz'];
  app.use(needsState, async (req, res, next) => {
    try {
      await store.load();
      await loadAccounts();
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
          return res.status(401).json({ error: 'Session expired. Reconnect that account.' });
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

  /**
   * Resolves which mailbox a request is about.
   *
   * Per-message routes must name their account, because a Gmail message id only means
   * something within one mailbox. Falling back to the first account keeps older
   * clients working while there is only one.
   */
  function accountFor(req) {
    const asked = String(req.query.account || req.body?.account || '').toLowerCase();
    if (asked && isAuthorized(asked)) return asked;
    if (asked) throw new Error(`Not connected: ${asked}`);
    return listAccounts()[0];
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
      const email = await exchangeCode(String(code));
      await store.flushed();
      res.redirect(`/?connected=${encodeURIComponent(email)}`);
    } catch (err) {
      res.redirect(`/?error=${encodeURIComponent(err.message)}`);
    }
  });

  /** Disconnects one account, or all of them when none is named. */
  app.post('/api/logout', wrap(async (req, res) => {
    const email = String(req.body?.account || '').toLowerCase();
    if (email) {
      await watch.stopWatch(email).catch(() => {});
      await disconnect(email);
    } else {
      for (const account of listAccounts()) await watch.stopWatch(account).catch(() => {});
      await disconnectAll();
    }
    res.json({ ok: true, accounts: listAccounts() });
  }));

  app.get('/api/status', wrap(async (req, res) => {
    const emails = listAccounts();
    if (!emails.length) return res.json({ connected: false, accounts: [] });

    // Reported per account: one mailbox can have an expired session while another
    // is fine, and a single "connected" flag would hide that.
    const accounts = await Promise.all(
      emails.map(async (email) => {
        try {
          const me = await gmail.profile(email);
          return { email, ok: true, total: me.total };
        } catch (err) {
          return { email, ok: false, error: err.message };
        }
      }),
    );

    res.json({ connected: true, accounts, email: emails[0] });
  }));

  // ---- mail ----

  /** Merged inbox across every connected mailbox, newest first. */
  app.get('/api/messages', requireAuth, wrap(async (req, res) => {
    const max = Math.min(Number(req.query.max) || 30, 100);
    const search = String(req.query.q || '').trim();
    const query = search ? `in:inbox ${search}` : 'in:inbox';
    const only = String(req.query.account || '').toLowerCase();

    const emails = only ? [only] : listAccounts();

    // One slow or broken mailbox should not blank the whole inbox, so failures are
    // reported alongside whatever else came back.
    const settled = await Promise.all(
      emails.map(async (email) => {
        try {
          return { email, messages: await gmail.listInbox(email, { maxResults: max, query }) };
        } catch (err) {
          return { email, messages: [], error: err.message };
        }
      }),
    );

    const messages = settled
      .flatMap((r) => r.messages)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, max);

    res.json({
      messages,
      accounts: emails,
      errors: settled.filter((r) => r.error).map((r) => ({ account: r.email, error: r.error })),
    });
  }));

  app.get('/api/messages/:id', requireAuth, wrap(async (req, res) => {
    res.json(await gmail.getMessage(accountFor(req), req.params.id));
  }));

  app.post('/api/messages/:id/read', requireAuth, wrap(async (req, res) => {
    await gmail.markRead(accountFor(req), req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/messages/:id/archive', requireAuth, wrap(async (req, res) => {
    await gmail.archive(accountFor(req), req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/reply', requireAuth, wrap(async (req, res) => {
    const { messageId, body } = req.body || {};
    if (!messageId || !body?.trim()) {
      return res.status(400).json({ error: 'messageId and body are required.' });
    }
    const account = accountFor(req);
    // Re-fetch server-side so reply headers come from Gmail, not the browser.
    const original = await gmail.getMessage(account, messageId);
    await gmail.sendReply(account, { original, body });
    res.json({ ok: true });
  }));

  app.post('/api/send', requireAuth, wrap(async (req, res) => {
    const { to, subject, body } = req.body || {};
    if (!to?.trim() || !body?.trim()) {
      return res.status(400).json({ error: 'A recipient and a message body are required.' });
    }
    await gmail.sendNew(accountFor(req), { to: to.trim(), subject: subject || '(no subject)', body });
    res.json({ ok: true });
  }));

  // ---- forwarding ----

  app.get('/api/forwarding', wrap(async (req, res) => {
    res.json({
      ...store.publicSettings(),
      categoriesAvailable: CATEGORIES,
      accounts: listAccounts(),
      channel: notify.activeChannel(),
      channelName: notify.describeChannel(),
      linked: Boolean(notify.destination()),
      whatsappConfigured: wa.isConfigured(),
      telegramConfigured: tg.isConfigured(),
      pubsubConfigured: Boolean(process.env.PUBSUB_TOPIC && process.env.PUBSUB_VERIFICATION_TOKEN),
      inQuietHours: forward.inQuietHours(),
    });
  }));

  app.post('/api/telegram/register', wrap(async (req, res) => {
    if (!tg.isConfigured()) {
      return res.status(400).json({ error: 'Set TELEGRAM_BOT_TOKEN first.' });
    }

    const host = req.get('x-forwarded-host') || req.get('host');
    await tg.setWebhook(`https://${host}/webhook/telegram`);
    const me = await tg.getMe();
    const info = await tg.getWebhookInfo();

    res.json({
      ok: true,
      bot: `@${me.username}`,
      webhook: info.url,
      linked: Boolean(store.get().telegramChatId),
      next: store.get().telegramChatId
        ? 'Already linked to a chat.'
        : `Open https://t.me/${me.username} and send it any message to link your chat.`,
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

    if (patch.enabled && !notify.destination() && !(patch.toNumber || '')) {
      return res.status(400).json({
        error:
          notify.activeChannel() === 'telegram'
            ? 'No destination yet — send your Telegram bot any message to link it.'
            : 'Set the destination WhatsApp number first.',
      });
    }

    store.update(patch);
    await store.flushed();

    // Turning forwarding on arms a watch for every mailbox, so adding an account
    // later needs nothing more than connecting it.
    if (patch.enabled === true && isAuthorized()) {
      const watches = await watch.startAllWatches();
      watch.scheduleRenewal();
      const failed = watches.filter((w) => !w.ok);
      if (failed.length) {
        return res.json({
          ...store.publicSettings(),
          watches,
          warning: `Saved, but ${failed.length} watch(es) could not start: ${failed[0].error}`,
        });
      }
      return res.json({ ...store.publicSettings(), watches });
    }

    if (patch.enabled === false) {
      for (const email of listAccounts()) {
        await watch.stopWatch(email).catch((err) => console.error('[watch]', err.message));
      }
    }

    res.json(store.publicSettings());
  }));

  app.post('/api/forwarding/test', wrap(async (req, res) => {
    if (!notify.destination()) {
      return res.status(400).json({
        error: `No destination linked yet (channel: ${notify.describeChannel()}).`,
      });
    }

    const { via } = await forward.deliver({
      id: 'test',
      account: listAccounts()[0] || 'mailflow',
      fromName: 'MailFlow',
      fromEmail: 'mailflow@localhost',
      subject: 'Test alert - your forwarding works',
      snippet: 'If this reached your phone, Gmail forwarding is wired up correctly.',
      body: 'If this reached your phone, Gmail forwarding is wired up correctly.\n\nReply "status" any time for a summary, "stop" to pause, "start" to resume.',
      category: 'Personal',
      timestamp: Date.now(),
    });

    res.json({ ok: true, via });
  }));

  /** Manual catch-up across every mailbox, for when notifications were missed. */
  app.post('/api/forwarding/sync', requireAuth, wrap(async (req, res) => {
    const results = [];
    for (const email of listAccounts()) {
      const recent = await gmail.listInbox(email, { maxResults: 15, query: 'in:inbox is:unread' });
      results.push(
        ...(await forward.processMessageIds(email, recent.map((m) => m.id), { budgetMs: 5000 })),
      );
    }
    res.json({ results });
  }));

  app.post('/api/forwarding/watch', requireAuth, wrap(async (req, res) => {
    const watches = await watch.startAllWatches();
    watch.scheduleRenewal();
    res.json({ ...store.publicSettings(), watches });
  }));

  /**
   * Last resort for anything that escapes a route handler. Without it a throw becomes
   * a bare FUNCTION_INVOCATION_FAILED with the cause only in the platform log.
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
