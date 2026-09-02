/**
 * Vercel entry point.
 *
 * Every request is rewritten here by vercel.json, and @vercel/node hands an Express
 * app straight to the runtime. There is no listen() and no startup work: the app has
 * to be usable from a cold start on the very first request, which is why state loads
 * per request in src/app.js rather than at boot.
 *
 * Environment variables come from the Vercel dashboard, so dotenv is not imported —
 * a .env file is never deployed.
 */

let app;
let bootError = null;

try {
  const { createApp } = await import('../src/app.js');
  app = createApp();
} catch (err) {
  // A throw during module load surfaces as a bare FUNCTION_INVOCATION_FAILED with the
  // real cause buried in the platform log. Capturing it here means the deployment can
  // explain itself in the browser instead.
  bootError = err;
  console.error('[boot] failed to create the app:', err?.stack || err);
}

export default function handler(req, res) {
  if (bootError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify(
        {
          error: 'MailFlow failed to start.',
          message: bootError?.message || String(bootError),
          // Useful for telling a missing dependency apart from a bad import path.
          stack: (bootError?.stack || '').split('\n').slice(0, 6),
        },
        null,
        2,
      ),
    );
  }
  return app(req, res);
}
