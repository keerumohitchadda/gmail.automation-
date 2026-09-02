import crypto from 'node:crypto';
import express from 'express';

import { isAuthorized } from './auth.js';
import * as forward from './forward.js';
import * as store from './store.js';
import * as watch from './watch.js';
import * as wa from './whatsapp.js';

export const router = express.Router();

/**
 * Gmail notifications arrive faster than a full fetch-and-send cycle takes, and two
 * overlapping runs would read the same history cursor and forward the same mail twice.
 * Everything therefore queues onto one promise chain.
 */
let chain = Promise.resolve();
function serialize(task) {
  chain = chain.then(task).catch((err) => console.error('[webhook]', err.message));
  return chain;
}

/** Exposed so the manual "Sync now" button shares the same single-file queue. */
export function runSerialized(task) {
  return serialize(task);
}

// ---------------------------------------------------------------------------
// Meta webhook verification handshake (GET) — Meta calls this once when you save
// the callback URL, and expects hub.challenge echoed back as plain text.
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
// Inbound WhatsApp messages. The point of listening at all is the 24-hour window:
// any message you send the bot re-opens free-form replies for a day, which is what
// lets the forwarder send whole email bodies instead of a bare template.
// ---------------------------------------------------------------------------

router.post('/webhook/whatsapp', (req, res) => {
  const check = wa.verifySignature(req.rawBody || Buffer.alloc(0), req.get('x-hub-signature-256'));
  if (!check.ok) {
    console.warn(`[webhook] rejected WhatsApp callback: ${check.reason}`);
    return res.sendStatus(403);
  }

  // Answer immediately. Meta retries anything slower than a few seconds.
  res.sendStatus(200);

  const messages =
    req.body?.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.messages || []) || []) || [];

  for (const message of messages) {
    const from = wa.normalizeNumber(message.from);
    if (from !== wa.normalizeNumber(store.get().toNumber)) continue;

    store.update({ lastInboundAt: Date.now() });

    const text = message.text?.body?.trim().toLowerCase();
    if (text === 'stop' || text === 'pause') {
      store.update({ enabled: false });
      serialize(() => wa.sendText(from, '🔕 Forwarding paused. Send *start* to turn it back on.'));
    } else if (text === 'start' || text === 'resume') {
      store.update({ enabled: true });
      serialize(() => wa.sendText(from, '🔔 Forwarding is on. New inbox mail will land here.'));
    } else if (text === 'status') {
      const s = store.publicSettings();
      serialize(() =>
        wa.sendText(
          from,
          [
            `*MailFlow status*`,
            `Forwarding: ${s.enabled ? 'on' : 'off'}`,
            `Gmail watch: ${s.watching ? 'active' : 'inactive'}`,
            `Categories: ${s.categories.join(', ') || 'none'}`,
            `Held by quiet hours: ${s.queuedCount}`,
          ].join('\n'),
        ),
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Gmail push, delivered by Pub/Sub. The endpoint is public, so it is gated on a
// shared secret carried in the query string — the pattern Google documents for
// push subscriptions that are not using OIDC tokens.
// ---------------------------------------------------------------------------

router.post('/webhook/gmail', (req, res) => {
  if (!secretMatches(req.query.token, process.env.PUBSUB_VERIFICATION_TOKEN)) {
    console.warn('[webhook] rejected Gmail push: bad verification token');
    return res.sendStatus(403);
  }

  // Acknowledge before doing any work; an unacknowledged push is redelivered, which
  // would put the same mail through the pipeline again.
  res.sendStatus(204);

  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.body?.message?.data || '', 'base64').toString('utf8'));
  } catch {
    console.warn('[webhook] Gmail push had an undecodable payload');
    return;
  }

  const { emailAddress, historyId } = payload;
  if (!historyId) return;

  serialize(async () => {
    if (!isAuthorized()) {
      console.warn('[webhook] Gmail push arrived but no Google session is connected');
      return;
    }
    if (!store.get().enabled) return;

    const ids = await watch.newMessageIds(historyId);
    if (!ids.length) return;

    console.log(`[webhook] ${ids.length} new message(s) for ${emailAddress}`);
    await forward.processMessageIds(ids);
  });
});

// ---------------------------------------------------------------------------
// Operations endpoints. Neither is needed locally; both matter once the app is
// hosted, where nobody is watching a terminal.
// ---------------------------------------------------------------------------

/** Liveness probe for the host's monitor. Deliberately reveals nothing sensitive. */
router.get('/healthz', (req, res) => {
  const s = store.get();
  res.json({
    ok: true,
    connected: isAuthorized(),
    forwarding: s.enabled,
    watchExpiresAt: s.watchExpiration ? new Date(s.watchExpiration).toISOString() : null,
    queued: s.queued.length,
  });
});

/**
 * Renews the Gmail watch on demand, for an external scheduler to call daily.
 *
 * This exists because of a deadlock that only appears on hosting that idles idle
 * apps: the watch expires after seven days, the in-process renewal timer cannot
 * fire while the app is asleep, and nothing wakes it because waking it requires a
 * notification the expired watch will never send. An outside nudge breaks the cycle.
 *
 * GET is accepted alongside POST because many cron services only issue GETs.
 */
router.all('/cron/renew', (req, res) => {
  if (!secretMatches(req.query.token, process.env.CRON_TOKEN)) {
    console.warn('[cron] rejected renew: bad token');
    return res.sendStatus(403);
  }
  if (!isAuthorized()) return res.status(409).json({ error: 'No Google session on this server.' });
  if (!store.get().enabled) return res.json({ skipped: 'forwarding is off' });

  serialize(async () => {
    await watch.startWatch();
    watch.scheduleRenewal();
    // A cold start may also have missed a quiet-hours flush, so do that here too.
    await forward.flushQueue();
  });

  res.json({ ok: true, renewing: true });
});

function secretMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
