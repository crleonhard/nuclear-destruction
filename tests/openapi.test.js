import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createMemoryStore } from '../src/store/memory.js';
import { openStore, labelFor } from './support/stores.js';
import { createApp } from '../src/http/app.js';
import { createTokenAuth } from '../src/http/auth.js';
import { createEmailLogin } from '../src/http/login.js';
import { createMemoryMailer } from '../src/mail/mailer.js';
import { startWorker } from '../src/worker.js';
import { openapi, ERROR_CODES } from '../src/http/openapi.js';
import { check, resolveRef } from './schema-check.js';
import { toYaml } from '../scripts/to-yaml.js';

const METHODS = ['get', 'post', 'put', 'delete'];
const HOUR = 3600 * 1000;
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const operations = () => Object.entries(openapi.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({ path, method: m, op: item[m] })));

// ───────────────────────── Structure of the document ─────────────────────────

const walk = (node, fn) => {
  if (Array.isArray(node)) node.forEach((x) => walk(x, fn));
  else if (node && typeof node === 'object') { fn(node); Object.values(node).forEach((x) => walk(x, fn)); }
};

test('spec: every $ref resolves and no schema is dead', () => {
  const targets = new Set();
  walk(openapi, (n) => { if (typeof n.$ref === 'string') { resolveRef(openapi, n); targets.add(n.$ref); } });
  const dead = Object.keys(openapi.components.schemas).filter((s) => !targets.has(`#/components/schemas/${s}`));
  assert.deepEqual(dead, [], `unreferenced schemas: ${dead.join(', ')}`);
  const deadResp = Object.keys(openapi.components.responses).filter((s) => !targets.has(`#/components/responses/${s}`));
  assert.deepEqual(deadResp, []);
});

test('spec: operations are complete and consistent', () => {
  const ids = new Set();
  const tags = new Set(openapi.tags.map((t) => t.name));
  for (const { path, method, op } of operations()) {
    const label = `${method.toUpperCase()} ${path}`;
    assert.ok(op.operationId && !ids.has(op.operationId), `${label}: missing or duplicate operationId`);
    ids.add(op.operationId);
    assert.ok(op.summary, `${label}: summary`);
    assert.ok(op.tags?.length && op.tags.every((t) => tags.has(t)), `${label}: tags`);
    assert.ok(Object.keys(op.responses).some((c) => /^2/.test(c)), `${label}: needs a 2xx response`);
    const declared = new Set((op.parameters ?? []).map((p) => resolveRef(openapi, p).name));
    for (const [, name] of path.matchAll(/\{(\w+)\}/g)) assert.ok(declared.has(name), `${label}: undeclared path parameter {${name}}`);
    for (const req of op.security ?? openapi.security) {
      for (const scheme of Object.keys(req)) assert.ok(openapi.components.securitySchemes[scheme], `${label}: unknown security scheme ${scheme}`);
    }
    if (op.requestBody) assert.ok(op.requestBody.content['application/json'], `${label}: request body`);
  }
  assert.equal(ids.size, 27);
});

test('spec: documented examples conform to their schemas', () => {
  for (const name of Object.keys(openapi.components.schemas)) {
    const s = openapi.components.schemas[name];
    for (const ex of s.examples ?? []) {
      if (typeof ex === 'object') assert.deepEqual(check(openapi, s, ex), [], `example of ${name}`);
    }
  }
});

test('spec: generated openapi.json and openapi.yaml are up to date', () => {
  assert.deepEqual(JSON.parse(read('../docs/api/openapi.json')), JSON.parse(JSON.stringify(openapi)), 'run: npm run build:openapi');
  assert.equal(read('../docs/api/openapi.yaml'), toYaml(JSON.parse(JSON.stringify(openapi))), 'run: npm run build:openapi');
});

// ───────────────────────── The spec matches the code ─────────────────────────

test('routes: the spec and the server describe exactly the same operations', () => {
  const app = createApp({ store: createMemoryStore(), auth: createTokenAuth({ secret: 'x'.repeat(32) }) });
  const live = new Set(app.routes.map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`));
  const documented = new Set(operations().map(({ method, path }) => `${method.toUpperCase()} ${path}`));
  assert.deepEqual([...documented].filter((x) => !live.has(x)), [], 'documented but not served');
  assert.deepEqual([...live].filter((x) => !documented.has(x)), [], 'served but not documented');
});

test('error codes: every code the server can emit is documented, and every documented code is emitted', () => {
  const files = readdirSync(new URL('../src', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.js') && !f.startsWith('client')).map((f) => `../src/${f}`); // server code only: the browser client has codes of its own (NETWORK, HTTP) for failures that never reach the server
  const emitted = new Set();
  // Only the code position of each call shape counts: fail(404, 'CODE', ...), err(404, 'CODE', ...),
  // err('CODE', field, ...) and { code: 'CODE' }. Other uppercase strings (statuses, countries) are ignored.
  const shapes = [/\bfail\(\s*\d+\s*,\s*'([A-Z][A-Z_]+)'/g, /\berr\(\s*\d+\s*,\s*'([A-Z][A-Z_]+)'/g,
    /\berr\(\s*'([A-Z][A-Z_]+)'/g, /\bcode:\s*'([A-Z][A-Z_]+)'/g];
  for (const f of files) {
    const src = read(f);
    for (const re of shapes) for (const [, code] of src.matchAll(re)) emitted.add(code);
  }
  const documented = new Set(ERROR_CODES);
  assert.deepEqual([...emitted].filter((c) => !documented.has(c)).sort(), [], 'emitted but missing from ErrorCode');
  assert.deepEqual([...documented].filter((c) => !emitted.has(c)).sort(), [], 'documented but never emitted');
  assert.equal(documented.size, ERROR_CODES.length, 'duplicate codes in ErrorCode');
});

// ───────────────────────── The checker itself ─────────────────────────

test('schemaCheck: accepts good data and catches the mistakes it exists to catch', () => {
  const spec = { components: { schemas: { N: { type: 'integer', minimum: 0 } } } };
  const s = {
    type: 'object', required: ['a'], properties: { a: { $ref: '#/components/schemas/N' }, b: { type: ['string', 'null'], maxLength: 3 } },
    additionalProperties: false,
  };
  assert.deepEqual(check(spec, s, { a: 1, b: null }), []);
  assert.match(check(spec, s, {})[0], /missing required "a"/);
  assert.match(check(spec, s, { a: -1 })[0], /minimum/);
  assert.match(check(spec, s, { a: 1.5 })[0], /expected integer/);
  assert.match(check(spec, s, { a: 1, b: 'long!' })[0], /longer than 3/);
  assert.match(check(spec, s, { a: 1, z: 1 })[0], /unexpected property "z"/);
  const one = { oneOf: [{ type: 'string' }, { type: 'null' }] };
  assert.deepEqual(check(spec, one, null), []);
  assert.match(check(spec, one, 5)[0], /exactly one/);
  assert.match(check(spec, { oneOf: [{ type: 'string' }, { type: 'string', minLength: 1 }] }, 'x')[0], /matched 2/);
  assert.match(check(spec, { const: 'up' }, 'down')[0], /expected "up"/);
  assert.deepEqual(check(spec, { type: 'string', format: 'date-time' }, '2026-11-01T00:00:00.000Z'), []);
  assert.match(check(spec, { type: 'string', format: 'date-time' }, 'soon')[0], /date-time/);
});

// ───────────────────────── Conformance: a whole game over real HTTP ─────────────────────────

const stores = await openStore();
after(() => stores.close());
// scenario(name, fn) or scenario(name, { skip, ... }, fn): the options object, when given, comes second (as with node:test).
const scenario = (name, a, b) => {
  const [opts, fn] = typeof a === 'function' ? [{}, a] : [a, b];
  return test(labelFor(stores.kind) + name, opts, fn);
};

const exercised = new Set(); // "METHOD /path status", shared across boots

async function boot({ allowSignup = true, writeLimit = { max: 10_000, windowMs: 60_000 }, email = false, authLimit, mailer = createMemoryMailer(), maxOpenGamesPerUser = 0 } = {}) {
  const clock = { t: new Date('2026-11-01T00:00:00Z') };
  const now = () => clock.t;
  const store = stores.makeStore();
  const auth = createTokenAuth({ secret: 'a-test-secret-that-is-long-enough', now });
  const logger = { error() {} };
  const login = email ? createEmailLogin({ store, mailer, auth, appUrl: 'http://localhost:3000', now, logger }) : null;
  const app = createApp({ store, auth, now, allowSignup, writeLimit, login, authLimit, maxOpenGamesPerUser, logger });
  const server = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Calls a documented operation and fails unless the status, content type and body are all documented. */
  async function call(token, method, specPath, { id, aiUserId, body, raw, headers = {} } = {}) {
    const op = openapi.paths[specPath]?.[method.toLowerCase()];
    assert.ok(op, `${method} ${specPath} is not in the spec`);
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const res = await fetch(base + specPath.replace('{id}', id).replace('{aiUserId}', aiUserId), {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: payload,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }

    const label = `${method} ${specPath} -> ${res.status}`;
    const documented = op.responses[String(res.status)];
    assert.ok(documented, `${label} is not a documented response. Body: ${text}`);
    const def = resolveRef(openapi, documented);
    if (def.content) {
      const ct = res.headers.get('content-type') ?? '';
      const media = Object.entries(def.content).find(([m]) => ct.startsWith(m));
      assert.ok(media, `${label}: content-type "${ct}" is not documented`);
      if (media[0] === 'application/json') {
        assert.deepEqual(check(openapi, media[1].schema, json), [], `${label}: response does not match the spec\n${text}`);
      }
    }
    if (res.status < 300 && body !== undefined && op.requestBody) {
      const reqSchema = op.requestBody.content['application/json'].schema;
      assert.deepEqual(check(openapi, reqSchema, body), [], `${label}: accepted a request body the spec does not describe`);
    }
    exercised.add(`${method} ${specPath} ${res.status}`);
    return { status: res.status, body: json, text, headers: res.headers };
  }
  const signup = async (name) => {
    const r = await call(null, 'POST', '/api/v1/users', { body: { displayName: name } });
    assert.equal(r.status, 201, r.text);
    return { id: r.body.user.id, token: r.body.token };
  };
  const close = async () => { server.close(); server.closeAllConnections(); };
  return { app, store, clock, base, call, signup, close, mailer };
}

const G = '/api/v1/games';
const P = (s) => `${G}/{id}/${s}`;

scenario('conformance: every response and accepted request in a full game matches the spec', async () => {
  const ctx = await boot();
  const { call } = ctx;
  try {
    // Meta
    assert.deepEqual((await call(null, 'GET', '/healthz')).body, { status: 'up' });
    assert.equal((await call(null, 'GET', '/openapi.json')).body.openapi, '3.1.0');

    // Account
    assert.equal((await call(null, 'POST', '/api/v1/users', { body: { displayName: '' } })).status, 422);
    const [a, b, c, d] = [await ctx.signup('Ann'), await ctx.signup('Ben'), await ctx.signup('Cy'), await ctx.signup('Di')];
    assert.equal((await call(a.token, 'GET', '/api/v1/me')).body.user.displayName, 'Ann');
    assert.equal((await call('bogus', 'GET', '/api/v1/me')).status, 401);
    assert.equal((await call(a.token, 'GET', G)).body.games.length, 0);

    // Creating a game: every protocol-level failure is documented too
    assert.equal((await call(a.token, 'POST', G, { body: { turnDeadlineHours: 0 } })).status, 422);
    assert.equal((await call(a.token, 'POST', G, { raw: '{nope' })).status, 400);
    assert.equal((await call(a.token, 'POST', G, { raw: 'x=1', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await call(a.token, 'POST', G, { raw: JSON.stringify({ pad: 'x'.repeat(300 * 1024) }) })).status, 413);
    const created = await call(a.token, 'POST', G, { body: { turnDeadlineHours: 24, forfeitAfterN: 5 } });
    assert.equal(created.status, 201);
    const id = created.body.gameId;
    assert.equal((await call(a.token, 'GET', G)).body.games[0].status, 'LOBBY');

    // Lobby
    assert.equal((await call(c.token, 'GET', P('lobby'), { id: 999 })).status, 404);
    for (const u of [b, c, d]) assert.equal((await call(u.token, 'POST', P('join'), { id })).status, 200);
    assert.equal((await call(b.token, 'POST', P('join'), { id })).status, 409);
    for (const [u, country] of [[a, 'FRANCE'], [b, 'INDIA'], [c, 'JAPAN']]) {
      assert.equal((await call(u.token, 'PUT', P('country'), { id, body: { country } })).status, 200);
    }
    assert.equal((await call(d.token, 'PUT', P('country'), { id, body: { country: 'FRANCE' } })).status, 409);
    assert.equal((await call(d.token, 'PUT', P('country'), { id, body: { country: 'ATLANTIS' } })).status, 422);
    assert.equal((await call(d.token, 'PUT', P('country'), { id, body: { country: null } })).status, 200);
    assert.equal((await call(a.token, 'PUT', P('population'), { id, body: { userId: b.id, population: 60 } })).status, 200);
    assert.equal((await call(b.token, 'PUT', P('population'), { id, body: { userId: a.id, population: 60 } })).status, 403);
    assert.equal((await call(a.token, 'PUT', P('population'), { id, body: { userId: b.id, population: 5 } })).status, 422);
    assert.equal((await call(d.token, 'DELETE', P('membership'), { id })).status, 200);
    assert.equal((await call(a.token, 'DELETE', P('membership'), { id })).status, 409);
    const lobby = await call(c.token, 'GET', P('lobby'), { id });
    assert.equal(lobby.body.seats.length, 3);
    assert.ok(!lobby.text.includes('seed'));

    // Before the game starts the package has only `game` and `public`
    const pre = await call(a.token, 'GET', P('state'), { id });
    assert.equal(pre.body.turn, undefined);
    assert.equal((await call(a.token, 'GET', P('turn'), { id })).body.turn, null);
    assert.equal((await call(b.token, 'POST', P('start'), { id })).status, 403);
    assert.equal((await call(a.token, 'POST', P('start'), { id })).body.turnNumber, 1);
    assert.equal((await call(a.token, 'POST', P('start'), { id })).status, 409);
    assert.equal((await call(d.token, 'GET', P('state'), { id })).status, 403);
    assert.equal((await call(null, 'GET', P('state'), { id })).status, 401);

    // Turn 1: views, validation, drafts, submissions
    const state1 = await call(a.token, 'GET', P('state'), { id });
    assert.equal(state1.body.assets.cash, 100);
    assert.equal((await call(a.token, 'GET', P('turn'), { id })).body.turn.type, 'NORMAL');
    const view = await call(a.token, 'GET', P('sheet'), { id });
    assert.equal(view.body.limits.type, 'NORMAL');
    const sheetA = {
      build: { missiles: 4, abms: 3, factories: 2 },
      spies: [{ kind: 'MINOR', id: 'CUBA#1' }, { kind: 'PLAYER', id: 'INDIA' }, null],
      giveCashToMinors: { 'CUBA#1': 6 },
      messages: { INDIA: { text: 'secret', anonymous: true }, JAPAN: { text: 'hello', anonymous: false } },
      worldNews: { text: 'peace', anonymous: true },
    };
    const dryBad = await call(a.token, 'POST', P('sheet/validate'), { id, body: { build: { abms: 6 } } });
    assert.equal(dryBad.body.valid, false);
    assert.ok(dryBad.body.errors.some((e) => e.code === 'ABM_CAP_EXCEEDED'));
    assert.equal((await call(a.token, 'POST', P('sheet/validate'), { id, body: sheetA })).body.valid, true);
    assert.equal((await call(a.token, 'PUT', P('sheet'), { id, body: { build: { missiles: 99 } } })).status, 422);
    assert.equal((await call(a.token, 'PUT', P('sheet'), { id, body: sheetA })).body.submitted, 0);
    assert.equal((await call(a.token, 'GET', P('sheet'), { id })).body.sheet.build.abms, 3);
    assert.equal((await call(a.token, 'POST', P('sheet/submit'), { id, body: sheetA })).body.submitted, 1);
    assert.equal((await call(b.token, 'POST', P('sheet/submit'), { id, body: {} })).body.resolved, false);
    assert.equal((await call(c.token, 'POST', P('sheet/submit'), { id, body: {} })).body.resolved, true);

    // Turn 2 view: reports, messages, news
    const state2 = await call(a.token, 'GET', P('state'), { id });
    const kinds = state2.body.reports.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ['FIRST_SECOND', 'SPY_MINOR', 'SPY_PLAYER']);
    const inbox = await call(b.token, 'GET', P('state'), { id });
    assert.deepEqual(inbox.body.messages, [{ from: null, text: 'secret' }]);
    assert.deepEqual(inbox.body.news, [{ from: null, text: 'peace' }]);
    assert.equal((await call(a.token, 'GET', P('history'), { id })).body.turns.length, 1);
    assert.equal((await call(a.token, 'GET', P('replay'), { id })).body.errors[0].code, 'GAME_NOT_FINISHED');

    // Turn 2: declare war. Turn 3 is a battle turn.
    for (const [u, body] of [[a, { declareWar: true }], [b, {}], [c, {}]]) {
      assert.equal((await call(u.token, 'POST', P('sheet/submit'), { id, body })).status, 200);
    }
    const state3 = await call(a.token, 'GET', P('state'), { id });
    assert.equal(state3.body.turn.type, 'BATTLE');
    assert.equal(state3.body.controlled[0].id, 'CUBA#1');
    const battleView = await call(a.token, 'GET', P('sheet'), { id });
    assert.equal(battleView.body.limits.type, 'BATTLE');
    const fire = { fire: { HOME: { INDIA: 12 }, 'CUBA#1': { JAPAN: 3 } } };
    assert.equal((await call(a.token, 'POST', P('sheet/validate'), { id, body: fire })).body.valid, true);
    assert.equal((await call(a.token, 'POST', P('sheet/validate'), { id, body: { build: { missiles: 1 } } })).body.valid, false);
    for (const [u, body] of [[a, fire], [b, {}], [c, {}]]) {
      assert.equal((await call(u.token, 'POST', P('sheet/submit'), { id, body })).status, 200);
    }
    const state4 = await call(b.token, 'GET', P('state'), { id });
    assert.equal(state4.body.turn.number, 4);
    assert.ok(state4.body.battleResult.damaged.length >= 1);
    assert.ok(state4.body.battleResult.fired.length >= 2);
    assert.equal((await call(c.token, 'GET', P('history'), { id })).body.turns[2].type, 'BATTLE');

    // The stream: documented as text/event-stream, members only
    const stream = openapi.paths[`${G}/{id}/stream`].get;
    assert.ok(stream.responses['200'].content['text/event-stream']);
    const res = await fetch(`${ctx.base}${G}/${id}/stream?token=${a.token}`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/event-stream'));
    await res.body.cancel();
    exercised.add(`GET ${G}/{id}/stream 200`);
    assert.equal((await call(d.token, 'GET', P('stream'), { id })).status, 403);
    assert.equal((await call(null, 'GET', P('stream'), { id })).status, 401);

    // A second game ends by forfeit, which releases the replay
    const g2 = (await call(a.token, 'POST', G, { body: { forfeitAfterN: 1 } })).body.gameId;
    for (const u of [b, c]) await call(u.token, 'POST', P('join'), { id: g2 });
    for (const [u, country] of [[a, 'USA'], [b, 'BRAZIL'], [c, 'CHINA']]) await call(u.token, 'PUT', P('country'), { id: g2, body: { country } });
    await call(a.token, 'POST', P('start'), { id: g2 });
    await call(a.token, 'PUT', P('sheet'), { id: g2, body: {} });
    const worker = startWorker({ store: ctx.store, notify: ctx.app.notify, intervalMs: 1e9, now: () => ctx.clock.t, logger: { error() {} } });
    ctx.clock.t = new Date(ctx.clock.t.getTime() + 25 * HOUR);
    await worker.tick();
    worker.stop();
    const done = await call(b.token, 'GET', P('state'), { id: g2 });
    assert.equal(done.body.game.status, 'FINISHED');
    const replay = await call(b.token, 'GET', P('replay'), { id: g2 });
    assert.equal(replay.body.winner, 'USA');
    assert.equal(replay.body.outcome, 'WIN');
    assert.ok(replay.body.sheets.some((s) => s.source === 'SERVER_DEFAULT'));
    assert.equal((await call(b.token, 'POST', P('sheet/submit'), { id: g2, body: {} })).status, 409);
    assert.equal((await call(a.token, 'GET', P('sheet'), { id: g2 })).status, 409);
    assert.equal((await call(a.token, 'POST', P('sheet/validate'), { id: g2, body: {} })).status, 409);

    // Unexpected failures are a documented, content-free 500
    const original = ctx.store.withTransaction;
    ctx.store.withTransaction = async () => { throw new Error('db exploded'); };
    let boom;
    try { boom = await call(a.token, 'GET', '/api/v1/me'); } finally { ctx.store.withTransaction = original; }
    assert.equal(boom.status, 500);
    assert.ok(!boom.text.includes('exploded'));
  } finally { await ctx.close(); }
});

scenario('conformance: sign-up disabled (404) and rate limiting (429) are documented responses', async () => {
  const off = await boot({ allowSignup: false });
  try { assert.equal((await off.call(null, 'POST', '/api/v1/users', { body: { displayName: 'x' } })).status, 404); } finally { await off.close(); }

  const limited = await boot({ writeLimit: { max: 1, windowMs: 60_000 } });
  try {
    const u = await limited.signup('Ann');
    assert.equal((await limited.call(u.token, 'POST', G, { body: {} })).status, 201);
    const r = await limited.call(u.token, 'POST', G, { body: {} });
    assert.equal(r.status, 429);
    assert.equal(r.body.errors[0].code, 'RATE_LIMITED');
  } finally { await limited.close(); }
});

scenario('conformance: email sign-in responses and requests match the spec', async () => {
  const tag = `${process.pid}${Date.now().toString(36)}`;
  const mailer = createMemoryMailer();
  const ctx = await boot({ email: true, mailer, allowSignup: false });
  const { call } = ctx;
  try {
    assert.deepEqual((await call(null, 'GET', '/api/v1/auth/config')).body, { emailLogin: true, openSignup: false });
    assert.equal((await call(null, 'POST', '/api/v1/auth/email-link', { body: { email: 'nope' } })).status, 422);
    const asked = await call(null, 'POST', '/api/v1/auth/email-link', { body: { email: `ada.${tag}@example.org` } });
    assert.equal(asked.status, 202);
    const secret = /#\/verify\/([A-Za-z0-9_-]{43})/.exec(mailer.sent[0].text)[1];
    assert.equal((await call(null, 'POST', '/api/v1/auth/verify', { body: { token: 'short' } })).status, 400);
    assert.equal((await call(null, 'POST', '/api/v1/auth/verify', { body: { token: secret } })).status, 422);        // a new address needs a name
    const ok = await call(null, 'POST', '/api/v1/auth/verify', { body: { token: secret, displayName: 'Ada' } });
    assert.equal(ok.status, 200);
    assert.equal((await call(ok.body.token, 'GET', '/api/v1/me')).body.user.displayName, 'Ada');
    assert.equal((await call(null, 'POST', '/api/v1/auth/verify', { body: { token: secret, displayName: 'Ada' } })).status, 400);   // used
    assert.equal((await call(null, 'POST', '/api/v1/auth/email-link', { raw: '{"email":' })).status, 400);
    assert.equal((await call(null, 'POST', '/api/v1/auth/email-link', { raw: 'email=a@b.cd', headers: { 'content-type': 'text/plain' } })).status, 415);
  } finally { await ctx.close(); }

  const off = await boot({ email: false });
  try {
    assert.deepEqual((await off.call(null, 'GET', '/api/v1/auth/config')).body, { emailLogin: false, openSignup: true });
    assert.equal((await off.call(null, 'POST', '/api/v1/auth/email-link', { body: { email: `a.${tag}@example.org` } })).status, 404);
    assert.equal((await off.call(null, 'POST', '/api/v1/auth/verify', { body: { token: 'x'.repeat(43) } })).status, 404);
  } finally { await off.close(); }

  const limited = await boot({ email: true, authLimit: { max: 1, windowMs: 60_000 } });
  try {
    assert.equal((await limited.call(null, 'POST', '/api/v1/auth/email-link', { body: { email: `l1.${tag}@example.org` } })).status, 202);
    assert.equal((await limited.call(null, 'POST', '/api/v1/auth/email-link', { body: { email: `l2.${tag}@example.org` } })).status, 429);
  } finally { await limited.close(); }

  const broken = await boot({ email: true, mailer: { async send() { throw new Error('smtp down'); } } });
  try {
    const r = await broken.call(null, 'POST', '/api/v1/auth/email-link', { body: { email: `b.${tag}@example.org` } });
    assert.equal(r.status, 503);
  } finally { await broken.close(); }
});

scenario('conformance: AI players in the lobby match the spec', async () => {
  const ctx = await boot();
  const { call } = ctx;
  try {
    const [a, b] = [await ctx.signup('Ann'), await ctx.signup('Ben')];
    assert.equal((await call(a.token, 'POST', G, { body: { aiPlayers: 9 } })).status, 422);
    assert.equal((await call(a.token, 'POST', G, { body: { aiPlayers: 'two' } })).status, 422);
    const created = await call(a.token, 'POST', G, { body: { aiPlayers: 2 } });
    assert.equal(created.status, 201);
    const id = created.body.gameId;
    let lobby = (await call(b.token, 'GET', P('lobby'), { id })).body;
    assert.equal(lobby.seats.length, 3);
    assert.equal(lobby.seats.filter((x) => x.ai).length, 2);
    assert.ok(lobby.seats.filter((x) => x.ai).every((x) => ['HAWK', 'DIPLOMAT', 'OPPORTUNIST'].includes(x.ai)));

    const AI = `${G}/{id}/ai`;
    const AI_ONE = `${G}/{id}/ai/{aiUserId}`;
    assert.equal((await call(b.token, 'POST', AI, { id, body: {} })).status, 403);
    assert.equal((await call(a.token, 'POST', AI, { id, body: { persona: 'PACIFIST' } })).status, 422);
    assert.equal((await call(a.token, 'POST', AI, { id: 99999, body: {} })).status, 404);
    const added = await call(a.token, 'POST', AI, { id, body: { persona: 'HAWK' } });
    assert.equal(added.status, 201);
    const noBody = await call(a.token, 'POST', AI, { id });                 // the body is optional: a random style
    assert.equal(noBody.status, 201);
    lobby = (await call(a.token, 'GET', P('lobby'), { id })).body;
    assert.equal(lobby.seats.find((x) => x.userId === added.body.userId).ai, 'HAWK');
    assert.equal(lobby.seats.length, 5);

    assert.equal((await call(b.token, 'DELETE', AI_ONE, { id, aiUserId: added.body.userId })).status, 403);
    assert.equal((await call(a.token, 'DELETE', AI_ONE, { id, aiUserId: b.id })).status, 404);
    assert.equal((await call(a.token, 'DELETE', AI_ONE, { id, aiUserId: 'abc' })).status, 404);
    assert.equal((await call(a.token, 'DELETE', AI_ONE, { id, aiUserId: added.body.userId })).status, 200);
    assert.equal((await call(a.token, 'GET', P('lobby'), { id })).body.seats.length, 4);

    while ((await call(a.token, 'GET', P('lobby'), { id })).body.seats.length < 9) assert.equal((await call(a.token, 'POST', AI, { id, body: {} })).status, 201);
    assert.equal((await call(a.token, 'POST', AI, { id, body: {} })).status, 409);           // full

    assert.equal((await call(a.token, 'POST', P('start'), { id })).status, 200);
    assert.equal((await call(a.token, 'POST', AI, { id, body: {} })).status, 409);           // started
    const bot = (await call(a.token, 'GET', P('lobby'), { id })).body.seats.find((x) => x.ai);
    assert.equal((await call(a.token, 'DELETE', AI_ONE, { id, aiUserId: bot.userId })).status, 409);

    const state = (await call(a.token, 'GET', P('state'), { id })).body;
    assert.equal(state.public.players.filter((x) => x.ai).length, 8);
    assert.equal(state.turn.submitted, 8, 'all eight AIs submitted at once');
  } finally { await ctx.close(); }
});

scenario('conformance: the limit on open games and cancelling a game match the spec', async () => {
  const ctx = await boot({ maxOpenGamesPerUser: 2 });
  const { call } = ctx;
  try {
    const [a, b] = [await ctx.signup('Ann'), await ctx.signup('Ben')];
    const first = await call(a.token, 'POST', G, { body: {} });
    const second = await call(a.token, 'POST', G, { body: { aiPlayers: 2 } });
    assert.deepEqual([first.status, second.status], [201, 201]);
    const blocked = await call(a.token, 'POST', G, { body: {} });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.errors[0].code, 'TOO_MANY_GAMES');
    assert.match(blocked.body.errors[0].message, /2 games that are not finished \(the limit is 2\)/);
    assert.equal((await call(b.token, 'POST', G, { body: {} })).status, 201, 'the limit is per person');

    const ONE = `${G}/{id}`;
    assert.equal((await call(b.token, 'DELETE', ONE, { id: first.body.gameId })).status, 403);
    assert.equal((await call(a.token, 'DELETE', ONE, { id: 999999 })).status, 404);
    assert.equal((await call(a.token, 'DELETE', ONE, { id: first.body.gameId })).status, 200);
    assert.equal((await call(a.token, 'GET', P('lobby'), { id: first.body.gameId })).status, 404, 'a cancelled game is gone');
    assert.equal((await call(a.token, 'POST', G, { body: {} })).status, 201, 'cancelling freed a place');

    assert.equal((await call(a.token, 'POST', P('start'), { id: second.body.gameId })).status, 200);
    const started = await call(a.token, 'DELETE', ONE, { id: second.body.gameId });
    assert.equal(started.status, 409);
    assert.equal(started.body.errors[0].code, 'ALREADY_STARTED');
  } finally { await ctx.close(); }
});

scenario('conformance: the flow exercised every operation successfully', () => {
  const missing = operations()
    .filter(({ method, path }) => ![...exercised].some((e) => e.startsWith(`${method.toUpperCase()} ${path} 2`)))
    .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
  assert.deepEqual(missing, [], 'operations never exercised with a 2xx response');
  // Every documented status code that the tests could reach was reached at least once for the key error classes.
  for (const status of ['400', '401', '403', '404', '409', '413', '415', '422', '429', '500']) {
    assert.ok([...exercised].some((e) => e.endsWith(` ${status}`)), `no test hit a ${status}`);
  }
});
