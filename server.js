import 'dotenv/config';

import { createApp } from './src/app.js';
import { isAuthorized, restoreSession } from './src/auth.js';
import * as store from './src/store.js';
import * as watch from './src/watch.js';
import * as forward from './src/forward.js';
import * as wa from './src/whatsapp.js';
import * as kv from './src/kv.js';

/**
 * Local / VPS entry point: a long-lived process.
 *
 * The routing lives in src/app.js, shared with the Vercel function. What is unique
 * here is everything that needs a process to outlive a request — the Gmail watch
 * renewal timer, the quiet-hours sweeper, and graceful shutdown.
 */

const PORT = Number(process.env.PORT) || 3000;
const app = createApp();

await store.load();
const restored = await restoreSession();

if (restored && store.get().enabled) {
  // A watch lasts seven days and does not survive a long downtime, so re-register on
  // every boot rather than trusting the stored expiry.
  watch.startWatch().catch((err) => console.error('[watch] could not start:', err.message));
  watch.scheduleRenewal();
}
forward.startQuietHoursSweeper();

const server = app.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`\n  MailFlow running at http://localhost:${PORT}`);
  console.log(`  Storage: ${kv.describe()}`);
  console.log(
    restored
      ? `  Google session restored${isAuthorized() ? '' : ' (but credentials look empty)'}.`
      : '  Not connected yet — open the page and click "Connect Gmail".',
  );
  console.log(
    `  WhatsApp forwarding: ${store.get().enabled ? 'on' : 'off'}` +
      `${wa.isConfigured() ? '' : ' (credentials missing — see WHATSAPP-SETUP.md)'}\n`,
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
