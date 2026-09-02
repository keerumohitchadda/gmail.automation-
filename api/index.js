import { createApp } from '../src/app.js';

/**
 * Vercel entry point.
 *
 * Every request to the deployment is rewritten here by vercel.json, and @vercel/node
 * hands an Express app straight to the runtime. There is no listen() and no startup
 * work: the app must be usable from a cold start on the very first request, which is
 * why state is loaded per request in src/app.js rather than at boot.
 *
 * Environment variables come from the Vercel dashboard, so dotenv is not imported —
 * a .env file is never deployed.
 */
export default createApp();
