// Starts the real entry point (`node src/server.js`) as its own process, the way you would in production,
// and talks to it over HTTP. Config and in-memory-mode tests run everywhere; the PostgreSQL ones need
// PG_TEST_URL (set by `npm run test:db`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeSmtp } from './support/fake-smtp.js';
import { TEST_CERT } from './support/test-cert.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'a-long-enough-secret-123';
const pgSkip = process.env.PG_TEST_URL ? false : 'set PG_TEST_URL (see: npm run test:db)';

/** Launches the server with exactly the given environment. Always cleaned up by `finish()`. */
function launch(environment) {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, ...environment }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const within = (promise, ms, what) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms waiting for ${what}\nstdout: ${out}\nstderr: ${err}`)), ms))]);
  return {
    out: () => out,
    err: () => err,
    exit: (ms = 15_000) => within(exited, ms, 'the process to exit'),
    async port(ms = 20_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = out.match(/listening on (\d+)/);
        if (m) return Number(m[1]);
        if (child.exitCode !== null) throw new Error(`exited early (code ${child.exitCode})\nstdout: ${out}\nstderr: ${err}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`never started listening\nstdout: ${out}\nstderr: ${err}`);
    },
    // A clean stop, the same on every platform. (`child.kill('SIGTERM')` would kill a Windows process outright,
    // skipping its shutdown code, so it is only used in the test that is skipped on Windows.)
    stop() { child.send('shutdown'); return this.exit(); },
    terminate() { child.kill('SIGTERM'); return this.exit(); },
    finish() { if (child.exitCode === null) child.kill('SIGKILL'); },
  };
}

const api = (port) => async (method, path, { token, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// ───────────────────────── Bad configuration: exits 2 before starting anything ─────────────────────────

test('process: missing or invalid configuration exits with code 2 and says exactly what to fix', { timeout: 30_000 }, async () => {
  const bare = launch({});
  try {
    const { code } = await bare.exit();
    assert.equal(code, 2);
    assert.match(bare.err(), /DATABASE_URL is required/);
    assert.match(bare.err(), /AUTH_SECRET must be at least 16 characters/);
    assert.equal(bare.out(), '');
  } finally { bare.finish(); }

  const shortSecret = launch({ STORE: 'memory', AUTH_SECRET: 'hunter2', PORT: 'abc' });
  try {
    assert.equal((await shortSecret.exit()).code, 2);
    assert.match(shortSecret.err(), /PORT must be a whole number/);
    assert.ok(!shortSecret.err().includes('hunter2'), 'the secret must never be printed');
  } finally { shortSecret.finish(); }
});

// ───────────────────────── The real file, in memory mode ─────────────────────────

test('process: boots, serves a signed-in player through creating a game, and exits 0 when asked to shut down', { timeout: 30_000 }, async () => {
  const server = launch({ STORE: 'memory', AUTH_SECRET: SECRET, ALLOW_SIGNUP: 'true', PORT: '0', HOST: '127.0.0.1', WORKER_INTERVAL_MS: '200' });
  try {
    const port = await server.port();
    const call = api(port);
    assert.deepEqual((await call('GET', '/healthz')).body, { status: 'up' });
    const signup = await call('POST', '/api/v1/users', { body: { displayName: 'Ann' } });
    assert.equal(signup.status, 201);
    const { token } = signup.body;
    const created = await call('POST', '/api/v1/games', { token, body: {} });
    assert.equal(created.status, 201);
    const mine = await call('GET', '/api/v1/games', { token });
    assert.deepEqual(mine.body.games.map((g) => g.id), [created.body.gameId]);
    assert.equal((await call('GET', '/openapi.json')).body.openapi, '3.1.0');
    assert.match(server.err(), /lost when this process stops/);

    const { code } = await server.stop();
    assert.equal(code, 0);
    assert.match(server.out(), /shutdown message: shutting down/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  } finally { server.finish(); }
});

test('process: a real SIGTERM also shuts down cleanly (not on Windows, which has no SIGTERM)', { skip: process.platform === 'win32' ? 'Windows cannot deliver SIGTERM' : false, timeout: 30_000 }, async () => {
  const server = launch({ STORE: 'memory', AUTH_SECRET: SECRET, PORT: '0', HOST: '127.0.0.1' });
  try {
    await server.port();
    assert.equal((await server.terminate()).code, 0);
    assert.match(server.out(), /SIGTERM: shutting down/);
  } finally { server.finish(); }
});

// ───────────────────────── The real file, on PostgreSQL ─────────────────────────

test('process (postgres): a game survives a restart, and shutdown is clean', { skip: pgSkip, timeout: 60_000 }, async () => {
  const envFor = () => ({ DATABASE_URL: process.env.PG_TEST_URL, AUTH_SECRET: SECRET, ALLOW_SIGNUP: 'true', PORT: '0', HOST: '127.0.0.1', WORKER_INTERVAL_MS: '200' });
  const first = launch(envFor());
  let tokens;
  let gameId;
  try {
    const call = api(await first.port());
    tokens = [];
    for (const name of ['Ann', 'Ben', 'Cy']) tokens.push((await call('POST', '/api/v1/users', { body: { displayName: name } })).body.token);
    gameId = (await call('POST', '/api/v1/games', { token: tokens[0], body: {} })).body.gameId;
    for (const t of tokens.slice(1)) assert.equal((await call('POST', `/api/v1/games/${gameId}/join`, { token: t })).status, 200);
    for (const [i, country] of ['FRANCE', 'INDIA', 'JAPAN'].entries()) {
      assert.equal((await call('PUT', `/api/v1/games/${gameId}/country`, { token: tokens[i], body: { country } })).status, 200);
    }
    assert.equal((await call('POST', `/api/v1/games/${gameId}/start`, { token: tokens[0] })).status, 200);
    const state = await call('GET', `/api/v1/games/${gameId}/state`, { token: tokens[0] });
    assert.deepEqual([state.body.turn.number, state.body.assets.cash], [1, 100]);
    assert.equal((await call('POST', `/api/v1/games/${gameId}/sheet/submit`, { token: tokens[0], body: { worldNews: { text: 'before restart' } } })).status, 200);
    assert.equal((await first.stop()).code, 0);
  } finally { first.finish(); }

  const second = launch(envFor());                                   // a brand-new process, same database and secret
  try {
    const call = api(await second.port());
    const state = await call('GET', `/api/v1/games/${gameId}/state`, { token: tokens[0] });   // the old token still works
    assert.equal(state.status, 200);
    assert.deepEqual([state.body.turn.number, state.body.turn.submitted, state.body.assets.country], [1, 1, 'FRANCE']);
    assert.equal((await call('GET', `/api/v1/games/${gameId}/sheet`, { token: tokens[0] })).body.isFinal, true);
    assert.equal((await second.stop()).code, 0);
  } finally { second.finish(); }
});

test('process (postgres): an unreachable database exits with code 1 and a clear message', { skip: pgSkip, timeout: 30_000 }, async () => {
  const server = launch({ DATABASE_URL: 'postgres://postgres:nope@127.0.0.1:1/none', AUTH_SECRET: SECRET, PORT: '0', HOST: '127.0.0.1' });
  try {
    assert.equal((await server.exit(25_000)).code, 1);
    assert.match(server.err(), /cannot reach the database/);
    assert.equal(server.out(), '');
  } finally { server.finish(); }
});


// ───────────────────────── Email sign-in, end to end in a real process ─────────────────────────

const LINK_RE = /#\/verify\/([A-Za-z0-9_-]{43})/;
const post = (port, p, body) => api(port)('POST', p, { body });

test('process: sign in with a link from the log (console transport), then play under that account', { timeout: 30_000 }, async () => {
  const server = launch({ STORE: 'memory', AUTH_SECRET: SECRET, PORT: '0', HOST: '127.0.0.1', MAIL_TRANSPORT: 'console', APP_URL: 'http://localhost:3000' });
  try {
    const port = await server.port();
    assert.match(server.err() + server.out(), /MAIL_TRANSPORT=console/);
    assert.equal((await post(port, '/api/v1/auth/email-link', { email: 'ada@example.org' })).status, 202);
    const secret = LINK_RE.exec(server.out())[1];
    const verified = await post(port, '/api/v1/auth/verify', { token: secret, displayName: 'Ada' });
    assert.equal(verified.status, 200);
    const created = await api(port)('POST', '/api/v1/games', { token: verified.body.token, body: {} });
    assert.equal(created.status, 201);
    assert.equal((await post(port, '/api/v1/auth/verify', { token: secret, displayName: 'Ada' })).status, 400, 'the link was used up');
    await server.stop();
  } finally { server.finish(); }
});

test('process: sign in with a link delivered by real SMTP over TLS (a fake mail server, a trusted test certificate)', { timeout: 30_000 }, async () => {
  const smtp = await startFakeSmtp({ implicitTls: true, auth: ['PLAIN'] });
  const dir = mkdtempSync(path.join(tmpdir(), 'nd-ca-'));
  const caFile = path.join(dir, 'ca.pem');
  writeFileSync(caFile, TEST_CERT);
  const server = launch({
    STORE: 'memory', AUTH_SECRET: SECRET, PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'production',
    SMTP_URL: smtp.url(), MAIL_FROM: 'Nuclear Destruction <game@example.com>', APP_URL: 'https://game.example.com', NODE_EXTRA_CA_CERTS: caFile,
  });
  try {
    const port = await server.port();
    assert.equal((await post(port, '/api/v1/auth/email-link', { email: 'Grace@Example.org' })).status, 202);
    const [session] = smtp.sessions;
    assert.equal(session.authenticated, true);
    assert.equal(session.authedOverTls, true);
    assert.ok(session.commands.includes('RCPT TO:<grace@example.org>'));
    const text = Buffer.from(session.message.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.ok(text.includes('https://game.example.com/#/verify/'), 'the link is built from APP_URL');
    const verified = await post(port, '/api/v1/auth/verify', { token: LINK_RE.exec(text)[1], displayName: 'Grace' });
    assert.equal(verified.status, 200);
    assert.equal((await api(port)('GET', '/api/v1/me', { token: verified.body.token })).body.user.displayName, 'Grace');
    assert.ok(!(server.out() + server.err()).includes('#/verify/'), 'no link is ever written to the log in smtp mode');
    await server.stop();
  } finally { server.finish(); await smtp.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('process: when the mail server is down the person is told (503), and the server keeps running', { timeout: 30_000 }, async () => {
  const smtp = await startFakeSmtp({ implicitTls: true, auth: ['PLAIN'] });
  const url = smtp.url();
  await smtp.close();                                                  // nothing is listening on that port any more
  const server = launch({ STORE: 'memory', AUTH_SECRET: SECRET, PORT: '0', HOST: '127.0.0.1', SMTP_URL: url, MAIL_FROM: 'game@example.com', APP_URL: 'https://game.example.com' });
  try {
    const port = await server.port();
    const r = await post(port, '/api/v1/auth/email-link', { email: 'ada@example.org' });
    assert.equal(r.status, 503);
    assert.equal(r.body.errors[0].code, 'MAIL_UNAVAILABLE');
    assert.match(server.err(), /could not send a sign-in email/);
    assert.ok(!server.err().includes('ada@example.org'));
    assert.equal((await api(port)('GET', '/healthz')).status, 200);
    await server.stop();
  } finally { server.finish(); }
});
