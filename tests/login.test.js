// Email-link sign-in over real HTTP, on whichever store the suite runs on (memory by default, PostgreSQL with test:db).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore, labelFor } from './support/stores.js';
import { createApp } from '../src/http/app.js';
import { createTokenAuth } from '../src/http/auth.js';
import { createEmailLogin, normalizeEmail, hashSecret } from '../src/http/login.js';
import { createMemoryMailer } from '../src/mail/mailer.js';

const stores = await openStore();
after(() => stores.close());
const scenario = (name, fn) => test(labelFor(stores.kind) + name, fn);

const APP_URL = 'https://game.example.com';
const MIN = 60_000;
let counter = 0;
const unique = (who = 'ada') => `${who}.${process.pid}.${Date.now().toString(36)}.${++counter}@example.org`; // a shared database must not see repeats

async function boot({ login = true, authLimit, trustProxy = false, mailer = createMemoryMailer(), emailLimit } = {}) {
  const clock = { t: new Date('2026-11-05T12:00:00Z') };
  const now = () => clock.t;
  const store = stores.makeStore();
  const auth = createTokenAuth({ secret: 'a-test-secret-that-is-long-enough', now });
  const errors = [];
  const logger = { error: (...a) => errors.push(a.join(' ')), log() {}, warn() {} };
  const service = login ? createEmailLogin({ store, mailer, auth, appUrl: APP_URL, now, logger, ...(emailLimit ? { emailLimit } : {}) }) : null;
  const app = createApp({ store, auth, now, login: service, authLimit, trustProxy, logger });
  const server = await app.listen(0, '127.0.0.1');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  const secretIn = (mail) => /#\/verify\/([A-Za-z0-9_-]{43})/.exec(mail.text)[1];
  const requestLink = async (email, headers) => { const r = await call('POST', '/api/v1/auth/email-link', { email }, headers); return r; };
  const lastSecret = () => secretIn(mailer.sent[mailer.sent.length - 1]);
  return { clock, call, mailer, errors, port, store, requestLink, lastSecret, secretIn, close: async () => { server.close(); server.closeAllConnections(); } };
}

scenario('login: a new person asks for a link, opens it, chooses a name, and is signed in', async () => {
  const s = await boot();
  try {
    const email = unique();
    const asked = await s.requestLink(email);
    assert.equal(asked.status, 202);
    assert.deepEqual(asked.body, { accepted: true });
    assert.equal(s.mailer.sent.length, 1);
    const mail = s.mailer.sent[0];
    assert.equal(mail.to, email);
    assert.match(mail.text, new RegExp(`${APP_URL.replace('.', '\\.')}/#/verify/[A-Za-z0-9_-]{43}\\n`));
    assert.match(mail.text, /expires in 15 minutes/);

    const secret = s.lastSecret();
    const noName = await s.call('POST', '/api/v1/auth/verify', { token: secret });
    assert.equal(noName.status, 422);
    assert.equal(noName.body.errors[0].code, 'NAME_REQUIRED');

    const ok = await s.call('POST', '/api/v1/auth/verify', { token: secret, displayName: '  Ada  ' });   // the link survived the missing name
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.user.displayName, 'Ada');
    const me = await s.call('GET', '/api/v1/me', undefined, { authorization: `Bearer ${ok.body.token}` });
    assert.equal(me.body.user.id, ok.body.user.id);
    assert.equal(me.body.user.displayName, 'Ada');
  } finally { await s.close(); }
});

scenario('login: a returning person gets their own account back, whatever the capitalisation, and keeps their name', async () => {
  const s = await boot();
  try {
    const email = unique('Grace');
    await s.requestLink(email);
    const first = await s.call('POST', '/api/v1/auth/verify', { token: s.lastSecret(), displayName: 'Grace' });
    await s.requestLink(`  ${email.toUpperCase()}  `);
    assert.equal(s.mailer.sent[0].to, email.toLowerCase());
    assert.equal(s.mailer.sent[1].to, email.toLowerCase(), 'addresses are lower-cased and trimmed');
    const again = await s.call('POST', '/api/v1/auth/verify', { token: s.lastSecret(), displayName: 'Someone Else' });
    assert.equal(again.status, 200);
    assert.equal(again.body.user.id, first.body.user.id);
    assert.equal(again.body.user.displayName, 'Grace');
  } finally { await s.close(); }
});

scenario('login: a link works once', async () => {
  const s = await boot();
  try {
    await s.requestLink(unique());
    const secret = s.lastSecret();
    assert.equal((await s.call('POST', '/api/v1/auth/verify', { token: secret, displayName: 'Ada' })).status, 200);
    const second = await s.call('POST', '/api/v1/auth/verify', { token: secret, displayName: 'Ada' });
    assert.equal(second.status, 400);
    assert.equal(second.body.errors[0].code, 'LINK_INVALID');
  } finally { await s.close(); }
});

scenario('login: a link expires after 15 minutes, to the second', async () => {
  const s = await boot();
  try {
    await s.requestLink(unique());
    const secret = s.lastSecret();
    s.clock.t = new Date(s.clock.t.getTime() + 15 * MIN);          // exactly the expiry moment: already too late
    assert.equal((await s.call('POST', '/api/v1/auth/verify', { token: secret, displayName: 'Ada' })).status, 400);
    await s.requestLink(unique());
    const fresh = s.lastSecret();
    s.clock.t = new Date(s.clock.t.getTime() + 15 * MIN - 1000);
    assert.equal((await s.call('POST', '/api/v1/auth/verify', { token: fresh, displayName: 'Ada' })).status, 200);
  } finally { await s.close(); }
});

scenario('login: guesses, malformed secrets and secrets that were never issued are all the same 400', async () => {
  const s = await boot();
  try {
    const attempts = ['', 'short', 'x'.repeat(43), 'x'.repeat(44), `${'a'.repeat(42)}!`, 123, null, ['a'], { a: 1 }];
    for (const token of attempts) {
      const r = await s.call('POST', '/api/v1/auth/verify', { token, displayName: 'Ada' });
      assert.equal(r.status, 400, JSON.stringify(token));
      assert.equal(r.body.errors[0].code, 'LINK_INVALID');
    }
    assert.equal((await s.call('POST', '/api/v1/auth/verify', {})).status, 400);
  } finally { await s.close(); }
});

scenario('login: asking for a link says the same thing for known and unknown addresses (no account discovery)', async () => {
  const s = await boot();
  try {
    const known = unique('known');
    await s.requestLink(known);
    await s.call('POST', '/api/v1/auth/verify', { token: s.lastSecret(), displayName: 'Known' });
    const a = await s.requestLink(known);
    const b = await s.requestLink(unique('stranger'));
    assert.deepEqual([a.status, a.text], [b.status, b.text]);
  } finally { await s.close(); }
});

scenario('login: malformed addresses are refused before anything is stored or sent', async () => {
  const s = await boot();
  try {
    for (const email of ['', 'nope', 'a@b', '@example.org', 'a b@example.org', 'a@exa mple.org', 'a@@example.org', 'a@example..org', 'a@-example.org',
      'a@example.org\r\nBcc: evil@example.org', 'a,b@example.org', '<a@example.org>', `${'x'.repeat(250)}@example.org`, 42, null, undefined]) {
      const r = await s.call('POST', '/api/v1/auth/email-link', { email });
      assert.equal(r.status, 422, JSON.stringify(email));
      assert.equal(r.body.errors[0].code, 'EMAIL_INVALID');
    }
    assert.equal(s.mailer.sent.length, 0);
  } finally { await s.close(); }
});

scenario('login: the link points at the configured site, never at whatever Host header the request claims', async () => {
  const s = await boot();
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/v1/auth/email-link', method: 'POST', headers: { host: 'evil.example.net', 'x-forwarded-host': 'evil.example.net', 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify({ email: unique() }));
    });
    assert.equal(s.mailer.sent.length, 1);
    assert.ok(s.mailer.sent[0].text.includes(`${APP_URL}/#/verify/`));
    assert.ok(!s.mailer.sent[0].text.includes('evil'));
  } finally { await s.close(); }
});

scenario('login: one address cannot be used to flood a mailbox: after 5 links in an hour the rest are quietly not sent', async () => {
  const s = await boot();
  try {
    const email = unique('flood');
    const answers = [];
    for (let i = 0; i < 8; i++) answers.push(await s.requestLink(email));
    assert.equal(s.mailer.sent.length, 5);
    assert.ok(answers.every((a) => a.status === 202 && a.text === answers[0].text), 'the answer never changes, so the limit is not visible');
    s.clock.t = new Date(s.clock.t.getTime() + 61 * MIN);
    await s.requestLink(email);
    assert.equal(s.mailer.sent.length, 6, 'the window moves on');
  } finally { await s.close(); }
});

scenario('login: each client address is limited on both endpoints (429), and addresses are counted separately', async () => {
  const s = await boot({ authLimit: { max: 3, windowMs: 60_000 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.requestLink(unique())).status, 202);
    const blocked = await s.requestLink(unique());
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.errors[0].code, 'RATE_LIMITED');
    for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/api/v1/auth/verify', { token: 'x' })).status, 400);
    assert.equal((await s.call('POST', '/api/v1/auth/verify', { token: 'x' })).status, 429);
    s.clock.t = new Date(s.clock.t.getTime() + 61_000);
    assert.equal((await s.requestLink(unique())).status, 202, 'the window moves on');
  } finally { await s.close(); }
});

scenario('login: behind a trusted proxy the client address comes from the proxy\'s own X-Forwarded-For entry, and a forged one does not help', async () => {
  const s = await boot({ authLimit: { max: 1, windowMs: 60_000 }, trustProxy: true });
  try {
    assert.equal((await s.requestLink(unique(), { 'x-forwarded-for': '203.0.113.1' })).status, 202);
    assert.equal((await s.requestLink(unique(), { 'x-forwarded-for': '203.0.113.2' })).status, 202, 'a different client has its own allowance');
    // An attacker prepends fake addresses; the proxy appends the real one last, so the real one is what counts.
    assert.equal((await s.requestLink(unique(), { 'x-forwarded-for': '198.51.100.9, 203.0.113.1' })).status, 429);
  } finally { await s.close(); }
  const direct = await boot({ authLimit: { max: 1, windowMs: 60_000 }, trustProxy: false });
  try {
    assert.equal((await direct.requestLink(unique(), { 'x-forwarded-for': '203.0.113.1' })).status, 202);
    assert.equal((await direct.requestLink(unique(), { 'x-forwarded-for': '203.0.113.2' })).status, 429, 'without a proxy the header is ignored');
  } finally { await direct.close(); }
});

scenario('login: if the email cannot be sent the person is told (503), nothing about the address or link reaches the log', async () => {
  const broken = { async send() { throw new Error('connect ECONNREFUSED mail.internal:587'); } };
  const s = await boot({ mailer: broken });
  try {
    const email = unique('lost');
    const r = await s.requestLink(email);
    assert.equal(r.status, 503);
    assert.equal(r.body.errors[0].code, 'MAIL_UNAVAILABLE');
    assert.ok(!r.text.includes('ECONNREFUSED') && !r.text.includes('mail.internal'), 'no internals in the response');
    assert.equal(s.errors.length, 1);
    assert.ok(!s.errors[0].includes(email) && !s.errors[0].includes('#/verify'), 'no address or link in the log');
  } finally { await s.close(); }
});

scenario('login: a new account needs a sensible name, and a rejected name does not burn the link', async () => {
  const s = await boot();
  try {
    await s.requestLink(unique());
    const secret = s.lastSecret();
    for (const displayName of [undefined, '', '   ', 'x'.repeat(61), 'two\nlines', 'bell\u0007', 42]) {
      const r = await s.call('POST', '/api/v1/auth/verify', { token: secret, displayName });
      assert.equal(r.status, 422, JSON.stringify(displayName));
      assert.equal(r.body.errors[0].code, 'NAME_REQUIRED');
    }
    assert.equal((await s.call('POST', '/api/v1/auth/verify', { token: secret, displayName: 'x'.repeat(60) })).status, 200);
  } finally { await s.close(); }
});

scenario('login: the server reports which sign-in methods it offers, and the endpoints are 404 when email sign-in is off', async () => {
  const on = await boot();
  try { assert.deepEqual((await on.call('GET', '/api/v1/auth/config')).body, { emailLogin: true, openSignup: false }); } finally { await on.close(); }
  const off = await boot({ login: false });
  try {
    assert.deepEqual((await off.call('GET', '/api/v1/auth/config')).body, { emailLogin: false, openSignup: false });
    assert.equal((await off.call('POST', '/api/v1/auth/email-link', { email: unique() })).status, 404);
    assert.equal((await off.call('POST', '/api/v1/auth/verify', { token: 'x'.repeat(43) })).status, 404);
  } finally { await off.close(); }
});

scenario('login: a sign-in link does not grant access to anyone else\'s account, and tokens do not cross accounts', async () => {
  const s = await boot();
  try {
    const [e1, e2] = [unique('one'), unique('two')];
    await s.requestLink(e1);
    const a = await s.call('POST', '/api/v1/auth/verify', { token: s.lastSecret(), displayName: 'One' });
    await s.requestLink(e2);
    const b = await s.call('POST', '/api/v1/auth/verify', { token: s.lastSecret(), displayName: 'Two' });
    assert.notEqual(a.body.user.id, b.body.user.id);
    const me = await s.call('GET', '/api/v1/me', undefined, { authorization: `Bearer ${b.body.token}` });
    assert.equal(me.body.user.displayName, 'Two');
  } finally { await s.close(); }
});

scenario('login: two people opening the same link at the same instant: exactly one gets in', { skip: stores.kind !== 'postgres' && 'needs a real database: the in-memory store does not isolate concurrent transactions' }, async () => {
  const s = await boot();
  try {
    await s.requestLink(unique());
    const secret = s.lastSecret();
    const results = await Promise.all(Array.from({ length: 6 }, () => s.call('POST', '/api/v1/auth/verify', { token: secret, displayName: 'Racer' })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 400).length, 5);
  } finally { await s.close(); }
});

test('login: addresses are normalised the same way everywhere', () => {
  assert.equal(normalizeEmail('  Ada.Lovelace+games@Example.ORG '), 'ada.lovelace+games@example.org');
  assert.equal(normalizeEmail('a@b.co'), 'a@b.co');
  assert.equal(normalizeEmail('no-at-sign.example.org'), null);
});

test('login: the stored secret is a hash: a copy of the database cannot be used to sign in (memory store)', async () => {
  if (stores.kind !== 'memory') return;
  const s = await boot();
  try {
    await s.requestLink(unique());
    const secret = s.lastSecret();
    const rows = s.store.data.loginLinks;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenHash, hashSecret(secret));
    assert.ok(!JSON.stringify(rows).includes(secret));
    assert.equal(rows[0].tokenHash.length, 64);
  } finally { await s.close(); }
});

test('login: expired links are swept away (older than a day) as new ones are requested (memory store)', async () => {
  if (stores.kind !== 'memory') return;
  const s = await boot();
  try {
    await s.requestLink(unique());
    s.clock.t = new Date(s.clock.t.getTime() + 25 * 3600_000);
    await s.requestLink(unique());
    assert.equal(s.store.data.loginLinks.length, 1);
  } finally { await s.close(); }
});
