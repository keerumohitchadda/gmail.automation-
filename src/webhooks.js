import crypto from 'node:crypto';
import express from 'express';

import { isAuthorized, listAccounts, getAccount } from './auth.js';
import * as forward from './forward.js';
import * as store from './store.js';
import * as watch from './watch.js';
import * as wa from './whatsapp.js';
import * as tg from './telegram.js';

export const router = express.Router();

/**
 * How long a handler may spend forwarding before it wraps up.
 *
 * Vercel's Hobby plan kills a function at 10 seconds. Being killed mid-flight is the
 * one outcome to avoid, so handlers stop early and leave the rest queued. Locally
 * there is no such limit, so the budget is generous.
 */
const BUDGET_MS = process.env.VERCEL ? 6500 : 60_000;

// ---------------------------------------------------------------------------
// Meta webhook verification handshake. Meta calls this once when you save the
// callback URL and expects hub.challenge echoed back as plain text.
// ---------------------------------------------------------------------------

router.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === process.env.WA_VERIFY_TOKEN) {
    console.log('[webhook] Meta verification succeeded');
    return res.status(200).type('text/plain').send(String(challenge));
  }

  console.warn('[webhook] Meta verification rejected — WA_VERIFY_TOKEN did not match');
  res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// Inbound WhatsApp messages. The point of listening is the 24-hour window: any
// message you send the bot re-opens free-form replies for a day, which is what lets
// the forwarder send whole email bodies instead of a bare template.
// ---------------------------------------------------------------------------

router.post('/webhook/whatsapp', async (req, res) => {
  const check = wa.verifySignature(req.rawBody || Buffer.alloc(0), req.get('x-hub-signature-256'));
  if (!check.ok) {
    console.warn(`[webhook] rejected WhatsApp callback: ${check.reason}`);
    return res.sendStatus(403);
  }

  const messages =
    req.body?.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.messages || []) || []) || [];

  // All work happens before responding. On serverless the function is frozen the
  // instant the response is sent, so anything deferred past this point never runs.
  try {
    for (const message of messages) {
      const from = wa.normalizeNumber(message.from);
      if (from !== wa.normalizeNumber(store.get().toNumber)) continue;

      store.update({ lastInboundAt: Date.now() });

      const text = message.text?.body?.trim().toLowerCase();
      if (text === 'stop' || text === 'pause') {
        store.update({ enabled: false });
        await wa.sendText(from, '🔕 Forwarding paused. Send *start* to turn it back on.');
      } else if (text === 'start' || text === 'resume') {
        store.update({ enabled: true });
        await wa.sendText(from, '🔔 Forwarding is on. New inbox mail will land here.');
      } else if (text === 'status') {
        const s = store.publicSettings();
        await wa.sendText(
          from,
          [
            '*MailFlow status*',
            `Forwarding: ${s.enabled ? 'on' : 'off'}`,
            `Gmail watch: ${s.watching ? 'active' : 'inactive'}`,
            `Categories: ${s.categories.join(', ') || 'none'}`,
            `Waiting to send: ${s.queuedCount}`,
          ].join('\n'),
        );
      }
    }
    await store.flushed();
  } catch (err) {
    console.error('[webhook] whatsapp handler:', err.message);
  }

  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// Inbound Telegram updates.
//
// This is how the destination is configured: the first message you send the bot
// records its chat id, so there is nothing to look up or paste in. It also carries
// the same stop/start/status commands as the WhatsApp side.
// ---------------------------------------------------------------------------

router.post('/webhook/telegram', async (req, res) => {
  const check = tg.verifySecret(req.get('x-telegram-bot-api-secret-token'));
  if (!check.ok) {
    console.warn(`[webhook] rejected Telegram update: ${check.reason}`);
    return res.sendStatus(403);
  }

  const message = req.body?.message;
  const chatId = message?.chat?.id;
  if (!chatId) return res.sendStatus(200);

  try {
    const known = store.get().telegramChatId;

    if (!known) {
      const name = [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ');
      store.update({ telegramChatId: String(chatId), telegramChatName: name || message.chat.username || null });
      await store.flushed();
      await tg.sendMessage(
        chatId,
        '✅ <b>Linked.</b> Your Gmail alerts will arrive here.\n\nCommands: <code>stop</code>, <code>start</code>, <code>status</code>',
      );
      return res.sendStatus(200);
    }

    // Only the linked chat may drive the bot; anyone else who finds it is ignored.
    if (String(chatId) !== String(known)) return res.sendStatus(200);

    const text = message.text?.trim().toLowerCase();
    if (text === 'stop' || text === 'pause' || text === '/stop') {
      store.update({ enabled: false });
      await tg.sendMessage(chatId, '🔕 Forwarding paused. Send <b>start</b> to turn it back on.');
    } else if (text === 'start' || text === 'resume' || text === '/start') {
      store.update({ enabled: true });
      await tg.sendMessage(chatId, '🔔 Forwarding is on. New inbox mail will land here.');
    } else if (text === 'status' || text === '/status') {
      const s = store.publicSettings();
      await tg.sendMessage(
        chatId,
        [
          '<b>MailFlow status</b>',
          `Forwarding: ${s.enabled ? 'on' : 'off'}`,
          `Gmail watch: ${s.watching ? 'active' : 'inactive'}`,
          `Categories: ${tg.escapeHtml(s.categories.join(', ') || 'none')}`,
          `Waiting to send: ${s.queuedCount}`,
        ].join('\n'),
      );
    }
    await store.flushed();
  } catch (err) {
    console.error('[webhook] telegram handler:', err.message);
  }

  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// Gmail push, delivered by Pub/Sub. Public, so it is gated on a shared secret in
// the query string — the pattern Google documents for push subscriptions that are
// not using OIDC tokens.
// ---------------------------------------------------------------------------

router.post('/webhook/gmail', async (req, res) => {
  if (!secretMatches(req.query.token, process.env.PUBSUB_VERIFICATION_TOKEN)) {
    console.warn('[webhook] rejected Gmail push: bad verification token');
    return res.sendStatus(403);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.body?.message?.data || '', 'base64').toString('utf8'));
  } catch {
    console.warn('[webhook] Gmail push had an undecodable payload');
    return res.sendStatus(204); // Malformed: acking stops a pointless retry loop.
  }

  const { emailAddress, historyId } = payload;
  if (!historyId) return res.sendStatus(204);

  // Several mailboxes publish to the same topic, so the notification's address is
  // what decides whose history to read. Anything for an account we do not hold is
  // acked rather than retried — retrying will not make it appear.
  const account = String(emailAddress || '').toLowerCase();
  if (!account || !isAuthorized(account)) {
    console.warn(`[webhook] Gmail push for an unknown account: ${emailAddress}`);
    return res.sendStatus(204);
  }
  if (!store.get().enabled) return res.sendStatus(204);

  try {
    const ids = await watch.newMessageIds(account, historyId);
    if (ids.length) {
      console.log(`[webhook] ${ids.length} new message(s) for ${account}`);
      await forward.processMessageIds(account, ids, { budgetMs: BUDGET_MS });
    }
    await store.flushed();
    res.sendStatus(204);
  } catch (err) {
    console.error('[webhook] gmail handler:', err.message);
    await store.flushed().catch(() => {});
    // Not acked, so Pub/Sub redelivers. Safe to retry: every message is claimed
    // atomically, so a redelivery cannot forward anything twice.
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// Operations endpoints.
// ---------------------------------------------------------------------------

/** Liveness probe. Deliberately reveals nothing sensitive. */
router.get('/healthz', (req, res) => {
  const s = store.get();
  const settings = store.publicSettings();

  // Reported per mailbox: one account's watch can lapse while another is fine, and a
  // single expiry field would hide exactly the failure this probe exists to catch.
  const mailboxes = listAccounts().map((email) => {
    const expires = getAccount(email)?.watchExpiration || null;
    return {
      email,
      watchExpiresAt: expires ? new Date(expires).toISOString() : null,
      watchActive: Boolean(expires && expires > Date.now()),
    };
  });

  res.json({
    ok: true,
    connected: mailboxes.length > 0,
    forwarding: s.enabled,
    mailboxes,
    queued: settings.queuedCount,
    storage: settings.storage,
  });
});

/**
 * Renews the Gmail watch and drains the queue. Meant to be called daily by a scheduler.
 *
 * This is not optional on serverless. A Gmail watch expires after seven days and there
 * is no long-lived process to renew it — without an outside nudge, forwarding stops
 * after a week while everything still looks healthy.
 *
 * GET is accepted alongside POST because most schedulers, Vercel Cron included, issue
 * GETs. Vercel signs its own cron requests, so that header is accepted as well.
 */
router.all('/cron/renew', async (req, res) => {
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const authorised =
    secretMatches(req.query.token, process.env.CRON_TOKEN) ||
    secretMatches(bearer, process.env.CRON_SECRET);

  if (!authorised) {
    console.warn('[cron] rejected renew: bad token');
    return res.sendStatus(403);
  }
  if (!isAuthorized()) return res.status(409).json({ error: 'No Google session stored.' });
  if (!store.get().enabled) return res.json({ skipped: 'forwarding is off' });

  try {
    // Every connected mailbox needs its own watch re-armed, not just the first.
    const watches = await watch.startAllWatches();
    watch.scheduleRenewal();
    const drained = await forward.flushQueue({ budgetMs: BUDGET_MS });
    await store.flushed();
    res.json({ ok: true, watches, drained: drained.length });
  } catch (err) {
    console.error('[cron] renew failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function secretMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
