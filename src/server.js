// Production entry point, and the only file that knows every part of the system.
//
//   DATABASE_URL        PostgreSQL connection string (migrations applied: npm run migrate -- up)
//   AUTH_SECRET         at least 16 random characters; signs login tokens
//   PORT                default 3000 (0 = pick a free port)
//   HOST                default 0.0.0.0
//   ALLOW_SIGNUP        "true" lets POST /api/v1/users create accounts (off by default; development only)
//
//   Email-link sign-in is on when MAIL_TRANSPORT is set (or SMTP_URL is, which implies "smtp"):
//   MAIL_TRANSPORT      "smtp" (real delivery) or "console" (prints links in the log: development only)
//   APP_URL             public address of this site, e.g. https://game.example.com. Links in emails are built
//                       from this, never from request headers. Must be https:// in production.
//   SMTP_URL            smtps://user:pass@host:465 or smtp://user:pass@host:587 (STARTTLS)
//   MAIL_FROM           sender, e.g. "Nuclear Destruction <game@example.com>"
//   MAX_OPEN_GAMES_PER_USER  unfinished games (lobby or running) one person may have created at once, 0 to 100
//                       (default 3; 0 = no limit). Creators can cancel a game that is still in its lobby.
//   LOGIN_LINK_MINUTES  how long a link works, 1 to 60 (default 15)
//   Turn emails are opt-in per player and available whenever email is configured (see above):
//   NOTIFY_REMINDER_HOURS  how long before a deadline the reminder goes out, 0 to 72 (default 4; 0 = no reminders)
//   NOTIFY_DAILY_LIMIT  turn emails in any rolling 24 hours, 0 to 100000 (default 150; 0 = no cap). Keep it under your
//                       mail plan's daily allowance minus the sign-in links you expect (Mailjet free: 200 a day in total).
//   TRUST_PROXY         "true" only behind a reverse proxy you control: client addresses (for rate limits)
//                       are then read from X-Forwarded-For
//   CLIENT_IP_HEADER    name of a header in which the proxy puts the visitor's address, e.g. cf-connecting-ip on Render
//                       (which sits behind Cloudflare, so the last X-Forwarded-For entry is not the visitor). Wins over
//                       TRUST_PROXY. Only set it when every request really comes through that proxy.
//   NODE_ENV            "production" refuses the console transport and a non-https APP_URL
//   CORS_ORIGIN         one allowed browser origin, e.g. https://game.example.com
//   WORKER_INTERVAL_MS  how often overdue turns are resolved (default 60000)
//   SHUTDOWN_GRACE_MS   how long open connections get to finish on shutdown (default 5000)
//   STORE=memory        a throwaway in-memory server: every game is lost when it stops. Development only.
//
// Exit codes: 0 clean shutdown, 1 failed to start (for example the database is unreachable),
// 2 bad configuration (nothing was started).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './http/app.js';
import { createTokenAuth } from './http/auth.js';
import { createEmailLogin } from './http/login.js';
import { createNotifications } from './app/notifications.js';
import { createConsoleMailer, createSmtpMailer } from './mail/mailer.js';
import { parseSmtpUrl, parseMailbox } from './mail/smtp.js';
import { startWorker } from './worker.js';

export class ConfigError extends Error {}

/** Reads and checks the environment. Reports every problem at once, and never echoes a secret. */
export function readConfig(env = process.env) {
  const errors = [];
  const store = env.STORE || 'postgres';
  if (!['postgres', 'memory'].includes(store)) errors.push('STORE must be "postgres" or "memory"');
  const whole = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) { errors.push(`${name} must be a whole number from ${min} to ${max}`); return fallback; }
    return n;
  };
  const port = whole('PORT', 3000, 0, 65535);
  const workerIntervalMs = whole('WORKER_INTERVAL_MS', 60_000, 10, 3_600_000);
  const shutdownGraceMs = whole('SHUTDOWN_GRACE_MS', 5000, 0, 600_000);
  if (store === 'postgres' && !env.DATABASE_URL) errors.push('DATABASE_URL is required (or set STORE=memory for a throwaway in-memory server)');
  if ((env.AUTH_SECRET ?? '').length < 16) errors.push('AUTH_SECRET must be at least 16 characters');
  const loginLinkMinutes = whole('LOGIN_LINK_MINUTES', 15, 1, 60);
  const maxOpenGamesPerUser = whole('MAX_OPEN_GAMES_PER_USER', 3, 0, 100);
  const notifyReminderHours = whole('NOTIFY_REMINDER_HOURS', 4, 0, 72);
  const notifyDailyLimit = whole('NOTIFY_DAILY_LIMIT', 150, 0, 100_000);
  const clientIpHeader = env.CLIENT_IP_HEADER ? env.CLIENT_IP_HEADER.trim().toLowerCase() : null;
  if (clientIpHeader && !/^[a-z0-9-]{1,64}$/.test(clientIpHeader)) errors.push('CLIENT_IP_HEADER must be a header name such as cf-connecting-ip');
  const production = env.NODE_ENV === 'production';
  const transport = env.MAIL_TRANSPORT || (env.SMTP_URL ? 'smtp' : null);
  let appUrl = null;
  if (transport !== null && !['smtp', 'console'].includes(transport)) errors.push('MAIL_TRANSPORT must be "smtp" or "console"');
  if (transport) {
    try {
      const u = new URL(env.APP_URL ?? '');
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('scheme');
      if (production && u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) errors.push('APP_URL must start with https:// in production');
      appUrl = u.origin + u.pathname.replace(/\/$/, '');
    } catch { errors.push('APP_URL is required for email sign-in and must be a full address such as https://game.example.com'); }
    if (transport === 'console' && production) errors.push('MAIL_TRANSPORT=console prints sign-in links to the log, so it is not allowed when NODE_ENV=production');
    if (transport === 'smtp') {
      if (!env.SMTP_URL) errors.push('SMTP_URL is required for MAIL_TRANSPORT=smtp, for example smtps://user:pass@smtp.example.com:465');
      else { try { parseSmtpUrl(env.SMTP_URL); } catch (e) { errors.push(e.message); } }   // never echoes the password
      try { parseMailbox(env.MAIL_FROM ?? ''); } catch (e) { errors.push(e.message); }
    }
  }
  if (errors.length) throw new ConfigError(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  return {
    store, databaseUrl: env.DATABASE_URL, authSecret: env.AUTH_SECRET, port, host: env.HOST || '0.0.0.0',
    allowSignup: env.ALLOW_SIGNUP === 'true', corsOrigin: env.CORS_ORIGIN || null, workerIntervalMs, shutdownGraceMs,
    trustProxy: env.TRUST_PROXY === 'true', clientIpHeader, loginLinkMinutes, maxOpenGamesPerUser, notifyReminderHours, notifyDailyLimit,
    mail: transport ? { transport, appUrl, smtpUrl: env.SMTP_URL, from: env.MAIL_FROM } : null,
  };
}

/** Fails fast, with a useful message, if the database cannot be reached or has not been migrated. */
export async function assertDatabaseReady(pool) {
  let rows;
  try {
    ({ rows } = await pool.query(`SELECT to_regclass('public.games') AS games`));
  } catch (err) {
    throw new Error(`cannot reach the database: ${err.message || err.code || String(err)}`);
  }
  if (!rows[0]?.games) throw new Error('the database has no tables yet: run "npm run migrate -- up" first');
}

/**
 * Builds everything and starts listening. Returns { server, port, app, worker, stop }.
 * `store` and `mailer` may be injected (tests do); otherwise they come from the environment.
 */
export async function startServer({ env = process.env, store = null, mailer = null, logger = console } = {}) {
  const config = readConfig(env);
  let pool = null;
  try {
    if (!store && config.store === 'memory') {
      const { createMemoryStore } = await import('./store/memory.js');
      store = createMemoryStore();
      logger.warn('STORE=memory: every game is lost when this process stops. Never use this in production.');
    } else if (!store) {
      let pg;
      try { pg = (await import('pg')).default; } catch { throw new ConfigError('The "pg" package is required: npm install pg'); }
      pool = new pg.Pool({ connectionString: config.databaseUrl });
      await assertDatabaseReady(pool);
      const { createPgStore } = await import('./store/postgres.js');
      store = createPgStore(pool);
    }

    const auth = createTokenAuth({ secret: config.authSecret, store });
    let login = null;
    let notifications = null;
    if (config.mail) {
      if (!mailer) {
        if (config.mail.transport === 'console') {
          mailer = createConsoleMailer({ logger });
          logger.warn('MAIL_TRANSPORT=console: sign-in links are printed to this log. Development only.');
        } else {
          mailer = createSmtpMailer({ smtpUrl: config.mail.smtpUrl, from: config.mail.from, ehloName: new URL(config.mail.appUrl).hostname });
        }
      }
      login = createEmailLogin({ store, mailer, auth, appUrl: config.mail.appUrl, ttlMs: config.loginLinkMinutes * 60_000, logger });
      notifications = createNotifications({ store, mailer, secret: config.authSecret, appUrl: config.mail.appUrl, reminderHours: config.notifyReminderHours, dailyLimit: config.notifyDailyLimit, logger });
    }
    if (!login && !config.allowSignup) logger.warn('No way to sign in is configured: set MAIL_TRANSPORT (email links) or, for development, ALLOW_SIGNUP=true.');
    const app = createApp({ store, auth, allowSignup: config.allowSignup, login, notifications, trustProxy: config.trustProxy, clientIpHeader: config.clientIpHeader, maxOpenGamesPerUser: config.maxOpenGamesPerUser, corsOrigin: config.corsOrigin, logger });
    const worker = startWorker({ store, notify: app.notify, notifier: notifications, intervalMs: config.workerIntervalMs, logger });
    let server;
    try { server = await app.listen(config.port, config.host); } catch (err) { await worker.stop(); throw err; }
    const port = server.address().port;
    logger.log(`Nuclear Destruction API listening on ${port}`);

    let stopping = null;
    const stop = () => (stopping ??= (async () => {
      await worker.stop();                                   // waits for a tick that is already running
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections?.();
      const force = setTimeout(() => server.closeAllConnections?.(), config.shutdownGraceMs); // e.g. open SSE streams
      force.unref?.();
      await closed;
      clearTimeout(force);
      if (pool) await pool.end();
    })());
    return { server, port, app, worker, stop };
  } catch (err) {
    if (pool) await pool.end().catch(() => {});
    throw err;
  }
}

/** Starts the server, sets the exit code on failure, and shuts down cleanly on SIGINT / SIGTERM. */
export async function main(env = process.env, logger = console) {
  let running;
  try {
    running = await startServer({ env, logger });
  } catch (err) {
    logger.error(err.message);
    process.exitCode = err instanceof ConfigError ? 2 : 1;
    return null;
  }
  let shuttingDown = false;
  const shutdown = async (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${why}: shutting down`);
    try { await running.stop(); process.exit(0); } catch (err) { logger.error(err.message); process.exit(1); }
  };
  // Ctrl+C (SIGINT) works everywhere; SIGTERM is what Linux and macOS supervisors send; SIGBREAK is Ctrl+Break on
  // Windows. Each is handled once, so a second Ctrl+C while shutting down stops the process immediately.
  const signals = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
  for (const signal of signals) process.once(signal, () => shutdown(signal));
  // Windows cannot send SIGTERM to another process (it just kills it), so a parent that started us with an IPC
  // channel (child_process with stdio 'ipc') can ask for a clean stop by sending the message "shutdown".
  // Without such a channel `process.send` does not exist and this does nothing.
  if (typeof process.send === 'function') process.on('message', (m) => { if (m === 'shutdown') shutdown('shutdown message'); });
  return running;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
