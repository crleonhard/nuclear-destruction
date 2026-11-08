import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, readConfig, assertDatabaseReady, ConfigError } from '../src/server.js';
import { createMemoryStore } from '../src/store/memory.js';
import { startGame } from '../src/app/pipeline.js';

const SECRET = 'a-long-enough-secret-123';
const quiet = () => ({ log() {}, warn() {}, error() {} });
const env = (extra = {}) => ({ AUTH_SECRET: SECRET, STORE: 'memory', PORT: '0', HOST: '127.0.0.1', ...extra });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ───────────────────────── Configuration ─────────────────────────

test('config: defaults and parsing', () => {
  const c = readConfig({ DATABASE_URL: 'postgres://x/y', AUTH_SECRET: SECRET });
  assert.deepEqual([c.store, c.port, c.host, c.allowSignup, c.corsOrigin, c.workerIntervalMs, c.shutdownGraceMs],
    ['postgres', 3000, '0.0.0.0', false, null, 60_000, 5000]);
  const d = readConfig(env({ ALLOW_SIGNUP: 'true', CORS_ORIGIN: 'https://g.example', PORT: '8080', WORKER_INTERVAL_MS: '250' }));
  assert.deepEqual([d.store, d.port, d.allowSignup, d.corsOrigin, d.workerIntervalMs], ['memory', 8080, true, 'https://g.example', 250]);
  assert.equal(readConfig(env({ ALLOW_SIGNUP: 'yes' })).allowSignup, false); // only the exact word "true" opens sign-up
});

test('config: every problem is reported at once, and a secret is never echoed', () => {
  assert.throws(() => readConfig({ PORT: '99999', AUTH_SECRET: 'hunter2-short', WORKER_INTERVAL_MS: 'soon', STORE: 'sqlite' }), (e) => {
    assert.ok(e instanceof ConfigError);
    for (const word of ['PORT', 'AUTH_SECRET', 'WORKER_INTERVAL_MS', 'STORE must be']) assert.ok(e.message.includes(word), word);
    assert.ok(!e.message.includes('hunter2'));
    return true;
  });
  assert.throws(() => readConfig({ AUTH_SECRET: SECRET }), /DATABASE_URL is required/);
  assert.doesNotThrow(() => readConfig({ AUTH_SECRET: SECRET, STORE: 'memory' }));      // no database needed for memory mode
});

// ───────────────────────── Database readiness ─────────────────────────

test('database check: unreachable, unmigrated, and ready', async () => {
  const pool = (query) => ({ query });
  await assert.rejects(assertDatabaseReady(pool(async () => { throw Object.assign(new Error(''), { code: 'ECONNREFUSED' }); })),
    /cannot reach the database: ECONNREFUSED/);                                           // some driver errors have an empty message
  await assert.rejects(assertDatabaseReady(pool(async () => ({ rows: [{ games: null }] }))), /npm run migrate -- up/);
  await assert.doesNotReject(assertDatabaseReady(pool(async () => ({ rows: [{ games: 'games' }] }))));
});

// ───────────────────────── Starting and stopping ─────────────────────────

test('startup: serves requests on the chosen port, sign-up is off unless enabled, memory mode warns loudly', async () => {
  const warnings = [];
  const closed = await startServer({ env: env({ AUTH_SECRET: 'a-different-secret-entirely' }), logger: { ...quiet(), warn: (m) => warnings.push(m) } });
  const open = await startServer({ env: env({ ALLOW_SIGNUP: 'true', CORS_ORIGIN: 'https://g.example' }), logger: quiet() });
  try {
    assert.ok(closed.port > 0);
    assert.match(warnings[0], /lost when this process stops/);
    assert.deepEqual(await json(await fetch(`http://127.0.0.1:${closed.port}/healthz`)), { status: 200, body: { status: 'up' } });
    assert.equal((await fetch(`http://127.0.0.1:${closed.port}/api/v1/me`)).status, 401);
    const noSignup = await fetch(`http://127.0.0.1:${closed.port}/api/v1/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"displayName":"x"}' });
    assert.equal(noSignup.status, 404);

    const res = await fetch(`http://127.0.0.1:${open.port}/api/v1/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"displayName":"Ann"}' });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://g.example');
    const { token } = await res.json();
    assert.equal((await json(await fetch(`http://127.0.0.1:${open.port}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } }))).body.user.displayName, 'Ann');
    // A token from one server is worthless to another with a different secret.
    assert.equal((await fetch(`http://127.0.0.1:${closed.port}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  } finally { await closed.stop(); await open.stop(); }
});

test('startup: the deadline worker is running (an overdue game resolves by itself)', async () => {
  const store = createMemoryStore();
  const gameId = store.createGame({ creatorId: 1, seed: 5, forfeitAfterN: 1 });
  for (const [i, country] of ['FRANCE', 'INDIA', 'JAPAN'].entries()) store.addPlayer({ gameId, userId: i + 1, country, startPopulation: 50 });
  await startGame(store, { gameId, userId: 1 }, new Date(Date.now() - 48 * 3600 * 1000)); // opened two days ago, so already overdue
  const s = await startServer({ env: env({ WORKER_INTERVAL_MS: '30' }), store, logger: quiet() });
  try {
    const game = await until(async () => {
      const snap = await store.withTransaction((tx) => tx.loadSnapshot(gameId));
      return snap.game.status === 'FINISHED' ? snap.game : null;
    });
    assert.equal(game.outcome, 'DRAW');                       // nobody submitted, all forfeited on the same turn
  } finally { await s.stop(); }
});

test('shutdown: stop() is idempotent, frees the port, and is not held up by an open event stream', async () => {
  const s = await startServer({ env: env({ ALLOW_SIGNUP: 'true', SHUTDOWN_GRACE_MS: '150' }), logger: quiet() });
  const base = `http://127.0.0.1:${s.port}`;
  const post = (path, token, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  const { token } = await (await post('/api/v1/users', null, { displayName: 'Ann' })).json();
  const { gameId } = await (await post('/api/v1/games', token)).json();

  const ac = new AbortController();
  const stream = await fetch(`${base}/api/v1/games/${gameId}/stream?token=${token}`, { signal: ac.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read();                                         // connected: the "ready" event arrived

  const started = Date.now();
  const first = s.stop();
  assert.equal(s.stop(), first);                               // a second call returns the same promise
  await first;
  assert.ok(Date.now() - started < 3000, 'shutdown waited for the open stream');
  await reader.read().catch(() => {});                         // the server cut the stream
  ac.abort();
  await assert.rejects(fetch(`${base}/healthz`));              // the port is closed
});


// ───────────────────────── Email sign-in configuration ─────────────────────────

const MAIL_BASE = { AUTH_SECRET: SECRET, STORE: 'memory' };
const problems = (e) => { try { readConfig(e); return []; } catch (x) { return x.message.split('\n').slice(1).map((l) => l.replace(/^\s*- /, '')); } };

test('config: email sign-in is off by default; SMTP_URL alone implies smtp; the settings are checked together', () => {
  assert.equal(readConfig(MAIL_BASE).mail, null);
  const smtp = readConfig({ ...MAIL_BASE, SMTP_URL: 'smtps://u:p@mail.example.com', MAIL_FROM: 'game@example.com', APP_URL: 'https://game.example.com/' });
  assert.deepEqual([smtp.mail.transport, smtp.mail.appUrl, smtp.loginLinkMinutes, smtp.trustProxy], ['smtp', 'https://game.example.com', 15, false]);
  assert.equal(readConfig({ ...MAIL_BASE, MAIL_TRANSPORT: 'console', APP_URL: 'http://localhost:3000', LOGIN_LINK_MINUTES: '30', TRUST_PROXY: 'true' }).loginLinkMinutes, 30);

  assert.deepEqual(problems({ ...MAIL_BASE, SMTP_URL: 'smtp://u:hunter2@h.example.com' }), [
    'APP_URL is required for email sign-in and must be a full address such as https://game.example.com',
    'MAIL_FROM must look like "game@example.com" or "Nuclear Destruction <game@example.com>"',
  ]);
  assert.deepEqual(problems({ ...MAIL_BASE, MAIL_TRANSPORT: 'carrier-pigeon', APP_URL: 'https://x.example' }), ['MAIL_TRANSPORT must be "smtp" or "console"']);
  assert.deepEqual(problems({ ...MAIL_BASE, MAIL_TRANSPORT: 'smtp', APP_URL: 'https://x.example', MAIL_FROM: 'a@b.cd' }), ['SMTP_URL is required for MAIL_TRANSPORT=smtp, for example smtps://user:pass@smtp.example.com:465']);
  assert.deepEqual(problems({ ...MAIL_BASE, SMTP_URL: 'https://u:hunter2@x.example', MAIL_FROM: 'a@b.cd', APP_URL: 'https://x.example' }), ['SMTP_URL must start with smtp:// or smtps://']);
  assert.deepEqual(problems({ ...MAIL_BASE, MAIL_TRANSPORT: 'console', APP_URL: 'https://x.example', LOGIN_LINK_MINUTES: '0' }), ['LOGIN_LINK_MINUTES must be a whole number from 1 to 60']);
  assert.ok(!problems({ ...MAIL_BASE, SMTP_URL: 'smtp://u:hunter2@h.example.com' }).join().includes('hunter2'), 'a password is never echoed');
});

test('config: CLIENT_IP_HEADER is lower-cased, optional, and must look like a header name', () => {
  assert.equal(readConfig(MAIL_BASE).clientIpHeader, null);
  assert.equal(readConfig({ ...MAIL_BASE, CLIENT_IP_HEADER: ' CF-Connecting-IP ' }).clientIpHeader, 'cf-connecting-ip');
  for (const bad of ['two words', 'a:b', 'x'.repeat(65), 'header\r\nInjected: 1']) {
    assert.deepEqual(problems({ ...MAIL_BASE, CLIENT_IP_HEADER: bad }), ['CLIENT_IP_HEADER must be a header name such as cf-connecting-ip'], JSON.stringify(bad));
  }
});

test('config: production refuses the console transport and a non-https site address', () => {
  assert.deepEqual(problems({ ...MAIL_BASE, NODE_ENV: 'production', MAIL_TRANSPORT: 'console', APP_URL: 'https://game.example.com' }),
    ['MAIL_TRANSPORT=console prints sign-in links to the log, so it is not allowed when NODE_ENV=production']);
  assert.deepEqual(problems({ ...MAIL_BASE, NODE_ENV: 'production', SMTP_URL: 'smtps://u:p@m.example.com', MAIL_FROM: 'a@b.cd', APP_URL: 'http://game.example.com' }),
    ['APP_URL must start with https:// in production']);
  assert.deepEqual(problems({ ...MAIL_BASE, NODE_ENV: 'production', SMTP_URL: 'smtps://u:p@m.example.com', MAIL_FROM: 'a@b.cd', APP_URL: 'https://game.example.com' }), []);
});

test('startup: with a mailer, the whole sign-in works; with no sign-in method at all it warns', async () => {
  const sent = [];
  const warnings = [];
  const logger = { ...quiet(), warn: (m) => warnings.push(m) };
  const on = await startServer({ env: env({ MAIL_TRANSPORT: 'console', APP_URL: 'http://localhost:3000' }), mailer: { async send(m) { sent.push(m); } }, logger });
  const none = await startServer({ env: env(), logger });
  try {
    const base = `http://127.0.0.1:${on.port}`;
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/v1/auth/email-link', { email: 'Ada@Example.org' })).status, 202);
    assert.equal(sent[0].to, 'ada@example.org');
    const secret = /#\/verify\/([A-Za-z0-9_-]{43})/.exec(sent[0].text)[1];
    assert.ok(sent[0].text.includes('http://localhost:3000/#/verify/'));
    const done = await post('/api/v1/auth/verify', { token: secret, displayName: 'Ada' });
    assert.equal(done.status, 200);
    assert.equal(warnings.filter((w) => /No way to sign in/.test(w)).length, 1, 'only the server with no method warns');
    assert.equal((await fetch(`http://127.0.0.1:${none.port}/api/v1/auth/config`).then((r) => r.json())).emailLogin, false);
  } finally { await on.stop(); await none.stop(); }
});
