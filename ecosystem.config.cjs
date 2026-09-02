/**
 * PM2 process definition, used on a VPS.
 *
 * .cjs rather than .js because package.json sets "type": "module" and PM2 reads
 * this file with require().
 *
 * Secrets stay in .env — dotenv loads them at boot, so nothing sensitive is in a
 * file that gets committed.
 */
module.exports = {
  apps: [
    {
      name: 'mailflow',
      script: 'server.js',
      cwd: __dirname,

      // A single instance, deliberately. The Gmail history cursor, the de-dup list
      // and the quiet-hours queue all live in one JSON file with no locking between
      // processes — a second worker would double-send and corrupt the cursor.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',

      // The app is small; anything past this means a leak worth restarting on.
      max_memory_restart: '400M',

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '127.0.0.1', // Nginx is the only thing that should reach it directly.
        TRUST_PROXY: 1,
      },

      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
