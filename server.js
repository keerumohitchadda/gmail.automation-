import 'dotenv/config';

import { createApp } from './src/app.js';
import { listAccounts, loadAccounts } from './src/auth.js';
import * as store from './src/store.js';
import * as watch from './src/watch.js';
import * as forward from './src/forward.js';
import * as wa from './src/whatsapp.js';
import * as notify from './src/notify.js';
import * as kv from './src/kv.js';

/**
 * Local / VPS entry point: a long-lived process.
 *
 * Routing lives in src/app.js, shared with the Vercel function. What is unique here
 * is everything needing a process that outlives a request — watch renewal, the
 * quiet-hours sweeper, and graceful shutdown.
 */

const PORT = Number(process.env.PORT) || 3000;
const app = createApp();

await store.load();
await loadAccounts();
const accounts = listAccounts();

if (accounts.length && store.get().enabled) {
  // A watch lasts seven days and does not survive a long downtime, so re-arm every
  // mailbox on boot rather than trusting the stored expiry.
  watch.startAllWatches().catch((err) => console.error('[watch] could not start:', err.message));
  watch.scheduleRenewal();
}
forward.startQuietHoursSweeper();

const server = app.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`\n  MailFlow running at http://localhost:${PORT}`);
  console.log(`  Storage: ${kv.describe()}`);
  console.log(
    accounts.length
      ? `  Mailboxes: ${accounts.join(', ')}`
      : '  No mailbox connected yet — open the page and click "Connect Gmail".',
  );
  console.log(
    `  Forwarding: ${store.get().enabled ? 'on' : 'off'} via ${notify.describeChannel()}` +
      `${wa.isConfigured() || notify.activeChannel() ? '' : ' (no channel configured)'}\n`,
  );
});

// PM2 and systemd restart by signalling. Stop taking new requests, then let the store
// finish its last write so settings are never left half-saved.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n  ${signal} received — shutting down.`);
    server.close(async () => {
      await store.flushed();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
