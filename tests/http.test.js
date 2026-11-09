import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, labelFor } from './support/stores.js';
import { createApp } from '../src/http/app.js';
import { createTokenAuth, signToken, verifyToken } from '../src/http/auth.js';
import { startWorker } from '../src/worker.js';

const stores = await openStore();
after(() => stores.close());
// scenario(name, fn) or scenario(name, { skip, ... }, fn): the options object, when given, comes second (as with node:test).
const scenario = (name, a, b) => {
  const [opts, fn] = typeof a === 'function' ? [{}, a] : [a, b];
  return test(labelFor(stores.kind) + name, opts, fn);
};

const SECRET = 'a-test-secret-that-is-long-enough';
const HOUR = 3600 * 1000;

async function boot({ allowSignup = true, writeLimit = { max: 10_000, windowMs: 60_000 }, maxOpenGamesPerUser = 3 } = {}) {
  const clock = { t: new Date('2026-11-01T00:00:00Z') };
  const now = () => clock.t;
  const store = stores.makeStore();
  const auth = createTokenAuth({ secret: SECRET, now });
  const app = createApp({ store, auth, now, allowSignup, writeLimit, maxOpenGamesPerUser, logger: { error() {} } });
  const server = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const seen = []; // every response body text, for leak checks

  const call = async (token, method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    seen.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  const signup = async (name) => {
    const r = await call(null, 'POST', '/api/v1/users', { displayName: name });
    assert.equal(r.status, 201, r.text);
    return { id: r.body.user.id, token: r.body.token };
  };
  const stream = async (token, gameId) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/games/${gameId}/stream?token=${token}`, { signal: ac.signal });
    if (res.status !== 200) { await res.text(); return { status: res.status, close() {} }; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    return {
      status: 200,
      async next(match, ms = 2000) {
        const deadline = Date.now() + ms;
        while (!buf.includes(match)) {
          const left = deadline - Date.now();
          if (left <= 0) throw new Error(`timeout waiting for ${match}; got ${buf}`);
          const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), left))]);
          if (chunk?.value) buf += dec.decode(chunk.value);
          if (chunk?.done) break;
        }
        return buf;
      },
      close: () => ac.abort(),
    };
  };
  const close = async () => { server.close(); server.closeAllConnections(); };
  return { app, store, auth, clock, base, call, signup, stream, seen, close };
}

/** n users; user 0 creates the game, the rest join and pick countries. Not started. */
async function lobby(ctx, n = 3, settings = {}) {
  const names = ['FRANCE', 'INDIA', 'JAPAN', 'USA', 'BRAZIL', 'CHINA', 'ENGLAND', 'GERMANY', 'RUSSIA'];
  const users = [];
  for (let i = 0; i < n; i++) users.push(await ctx.signup(`Player ${i + 1}`));
  const c = await ctx.call(users[0].token, 'POST', '/api/v1/games', settings);
  assert.equal(c.status, 201, c.text);
  const gameId = c.body.gameId;
  for (let i = 1; i < n; i++) assert.equal((await ctx.call(users[i].token, 'POST', `/api/v1/games/${gameId}/join`)).status, 200);
  for (let i = 0; i < n; i++) {
    assert.equal((await ctx.call(users[i].token, 'PUT', `/api/v1/games/${gameId}/country`, { country: names[i] })).status, 200);
  }
  return { users, gameId, countries: names.slice(0, n) };
}
const startIt = async (ctx, g) => {
  const r = await ctx.call(g.users[0].token, 'POST', `/api/v1/games/${g.gameId}/start`);
  assert.equal(r.status, 200, r.text);
};
const submitAll = async (ctx, g, sheetFor = () => ({})) => {
  let last;
  for (let i = 0; i < g.users.length; i++) {
    last = await ctx.call(g.users[i].token, 'POST', `/api/v1/games/${g.gameId}/sheet/submit`, sheetFor(g.countries[i]));
    assert.equal(last.status, 200, last.text);
  }
  return last;
};

// ───────────────────────── Auth tokens ─────────────────────────

test('tokens: sign, verify, reject forged, tampered and expired', () => {
  const t = signToken(7, SECRET, { nowMs: 1_000_000 });
  assert.equal(verifyToken(t, SECRET, 1_000_000), 7);
  assert.equal(verifyToken(t, 'another-secret-of-sufficient-length', 1_000_000), null);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 8, exp: 9_999_999_999 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`, SECRET, 1_000_000), null);
  assert.equal(verifyToken(`${body}.${sig}x`, SECRET, 1_000_000), null);
  assert.equal(verifyToken(t, SECRET, 1_000_000 + 31 * 86400 * 1000), null);
  assert.equal(verifyToken('nonsense', SECRET), null);
  assert.equal(verifyToken(undefined, SECRET), null);
  assert.throws(() => createTokenAuth({ secret: 'short' }));
});

// ───────────────────────── Protocol basics ─────────────────────────

scenario('protocol: routing, auth and body handling errors', async () => {
  const ctx = await boot();
  try {
    assert.deepEqual((await ctx.call(null, 'GET', '/healthz')).body, { status: 'up' });
    assert.equal((await ctx.call(null, 'GET', '/nope')).status, 404);
    assert.equal((await ctx.call(null, 'GET', '/api/v1/me')).status, 401);
    assert.equal((await ctx.call('garbage', 'GET', '/api/v1/me')).status, 401);
    const u = await ctx.signup('Ann');
    const me = await ctx.call(u.token, 'GET', '/api/v1/me');
    assert.deepEqual(me.body.user, { id: u.id, displayName: 'Ann' });
    assert.equal((await ctx.call(u.token, 'DELETE', '/api/v1/me')).status, 405);
    assert.equal((await ctx.call(u.token, 'GET', '/api/v1/games/abc/lobby')).status, 404);
    assert.equal((await ctx.call(u.token, 'GET', '/api/v1/games/%E0%A4%A/lobby')).status, 404); // bad %-escape
    assert.equal((await ctx.call(u.token, 'POST', '/api/v1/games', '{not json', { 'content-type': 'application/json' })).status, 400);
    assert.equal((await ctx.call(u.token, 'POST', '/api/v1/games', '[1]', { 'content-type': 'application/json' })).status, 400);
    assert.equal((await ctx.call(u.token, 'POST', '/api/v1/games', 'x=1', { 'content-type': 'text/plain' })).status, 415);
    const big = await ctx.call(u.token, 'POST', '/api/v1/games', JSON.stringify({ pad: 'x'.repeat(300 * 1024) }), { 'content-type': 'application/json' });
    assert.equal(big.status, 413);
    assert.equal(big.body.errors[0].code, 'PAYLOAD_TOO_LARGE');
    ctx.clock.t = new Date(ctx.clock.t.getTime() + 31 * 24 * HOUR);
    assert.equal((await ctx.call(u.token, 'GET', '/api/v1/me')).status, 401); // expired
  } finally { await ctx.close(); }
});

scenario('signup: off by default, validated when on', async () => {
  const off = await boot({ allowSignup: false });
  try { assert.equal((await off.call(null, 'POST', '/api/v1/users', { displayName: 'x' })).status, 404); } finally { await off.close(); }
  const on = await boot();
  try {
    assert.equal((await on.call(null, 'POST', '/api/v1/users', { displayName: '' })).status, 422);
    assert.equal((await on.call(null, 'POST', '/api/v1/users', { displayName: 5 })).status, 422);
  } finally { await on.close(); }
});

scenario('rate limit: writes are limited per user; reads are not', async () => {
  const ctx = await boot({ writeLimit: { max: 3, windowMs: 60_000 }, maxOpenGamesPerUser: 0 });   // this test is about rate limits, not the game limit
  try {
    const u = await ctx.signup('Ann');
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await ctx.call(u.token, 'POST', '/api/v1/games', {})).status);
    assert.deepEqual(codes, [201, 201, 201, 429, 429]);
    assert.equal((await ctx.call(u.token, 'GET', '/api/v1/me')).status, 200);
    ctx.clock.t = new Date(ctx.clock.t.getTime() + 61_000);
    assert.equal((await ctx.call(u.token, 'POST', '/api/v1/games', {})).status, 201);
  } finally { await ctx.close(); }
});

// ───────────────────────── Lobby ─────────────────────────

scenario('lobby: settings validation, seats, conflicts, creator powers and limits', async () => {
  const ctx = await boot();
  try {
    const a = await ctx.signup('A'); const b = await ctx.signup('B'); const c = await ctx.signup('C');
    assert.equal((await ctx.call(a.token, 'POST', '/api/v1/games', { turnDeadlineHours: 0 })).status, 422);
    assert.equal((await ctx.call(a.token, 'POST', '/api/v1/games', { forfeitAfterN: -1 })).status, 422);
    const { body: { gameId } } = await ctx.call(a.token, 'POST', '/api/v1/games', { turnDeadlineHours: 12 });
    const path = (s) => `/api/v1/games/${gameId}/${s}`;

    assert.equal((await ctx.call(b.token, 'POST', path('join'))).status, 200);
    assert.equal((await ctx.call(b.token, 'POST', path('join'))).status, 409);          // already joined
    assert.equal((await ctx.call(a.token, 'PUT', path('country'), { country: 'FRANCE' })).status, 200);
    const taken = await ctx.call(b.token, 'PUT', path('country'), { country: 'FRANCE' });
    assert.deepEqual([taken.status, taken.body.errors[0].code], [409, 'COUNTRY_TAKEN']);
    assert.equal((await ctx.call(b.token, 'PUT', path('country'), { country: 'ATLANTIS' })).status, 422);
    assert.equal((await ctx.call(b.token, 'PUT', path('country'), {})).status, 422);
    assert.equal((await ctx.call(b.token, 'PUT', path('country'), { country: 'INDIA' })).status, 200);
    assert.equal((await ctx.call(a.token, 'PUT', path('country'), { country: null })).status, 200); // release
    assert.equal((await ctx.call(c.token, 'PUT', path('country'), { country: 'FRANCE' })).status, 403); // not a member

    assert.equal((await ctx.call(b.token, 'PUT', path('population'), { userId: a.id, population: 50 })).status, 403);
    assert.equal((await ctx.call(a.token, 'PUT', path('population'), { userId: b.id, population: 5 })).status, 422);
    assert.equal((await ctx.call(a.token, 'PUT', path('population'), { userId: b.id, population: 60 })).status, 200);
    assert.equal((await ctx.call(a.token, 'PUT', path('population'), { userId: c.id, population: 60 })).status, 404);

    const lobbyView = await ctx.call(c.token, 'GET', path('lobby')); // anyone signed in can look (to follow an invite)
    assert.equal(lobbyView.status, 200);
    assert.equal(lobbyView.body.game.settings.turnDeadlineHours, 12);
    assert.deepEqual(lobbyView.body.seats.map((s) => [s.displayName, s.country, s.startPopulation]),
      [['A', null, null], ['B', 'INDIA', 60]]);
    assert.equal(lobbyView.body.countries.find((x) => x.country === 'INDIA').takenBy, 'B');
    assert.ok(!lobbyView.text.includes('seed'));

    assert.equal((await ctx.call(a.token, 'DELETE', path('membership'))).status, 409);   // creator cannot leave
    assert.equal((await ctx.call(b.token, 'DELETE', path('membership'))).status, 200);
    assert.equal((await ctx.call(a.token, 'POST', path('start'))).status, 422);          // 1 player
    assert.equal((await ctx.call(c.token, 'POST', path('start'))).status, 403);          // not the creator
    const mine = await ctx.call(a.token, 'GET', '/api/v1/games');
    assert.deepEqual(mine.body.games.map((g) => [g.id, g.status]), [[gameId, 'LOBBY']]);
  } finally { await ctx.close(); }
});

scenario('lobby: a game holds at most 9 players and locks when it starts', async () => {
  const ctx = await boot();
  try {
    const users = [];
    for (let i = 0; i < 10; i++) users.push(await ctx.signup(`P${i}`));
    const { body: { gameId } } = await ctx.call(users[0].token, 'POST', '/api/v1/games', {});
    for (let i = 1; i < 9; i++) assert.equal((await ctx.call(users[i].token, 'POST', `/api/v1/games/${gameId}/join`)).status, 200);
    const full = await ctx.call(users[9].token, 'POST', `/api/v1/games/${gameId}/join`);
    assert.deepEqual([full.status, full.body.errors[0].code], [409, 'GAME_FULL']);
    assert.equal((await ctx.call(users[0].token, 'POST', `/api/v1/games/${gameId}/start`)).status, 200);
    assert.equal((await ctx.call(users[0].token, 'POST', `/api/v1/games/${gameId}/start`)).status, 409);
    const late = await ctx.call(users[9].token, 'POST', `/api/v1/games/${gameId}/join`);
    assert.equal(late.body.errors[0].code, 'ALREADY_STARTED');
    assert.equal((await ctx.call(users[1].token, 'PUT', `/api/v1/games/${gameId}/country`, { country: 'USA' })).status, 409);
  } finally { await ctx.close(); }
});

// ───────────────────────── Playing ─────────────────────────

scenario('play: state, sheet view, dry run, drafts, early resolution, history, SSE', async () => {
  const ctx = await boot();
  try {
    const g = await lobby(ctx, 3);
    await startIt(ctx, g);
    const [a, b, c] = g.users;
    const p = (s) => `/api/v1/games/${g.gameId}/${s}`;
    const sse = await ctx.stream(a.token, g.gameId);
    await sse.next('event: ready');

    const state = await ctx.call(a.token, 'GET', p('state'));
    assert.equal(state.body.assets.country, 'FRANCE');
    assert.equal(state.body.assets.cash, 100);
    assert.equal(state.body.turn.number, 1);
    assert.equal(state.body.turn.submitted, 0);
    for (const pl of state.body.public.players) assert.deepEqual(Object.keys(pl).sort(), ['ai', 'alive', 'country', 'forfeited', 'population']);

    const view = await ctx.call(a.token, 'GET', p('sheet'));
    assert.equal(view.body.sheet, null);
    assert.equal(view.body.limits.wholeFactories, 9);
    assert.equal(view.body.limits.abmFactoryCap, 5);
    assert.deepEqual(view.body.spyDefaults, [null, null, null]);

    // Dry run reports problems and live numbers without saving anything.
    const dry = await ctx.call(a.token, 'POST', p('sheet/validate'), { build: { missiles: 4, abms: 6, factories: 0 } });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.valid, false);
    assert.ok(dry.body.errors.some((e) => e.code === 'ABM_CAP_EXCEEDED'));
    assert.equal((await ctx.call(a.token, 'GET', p('sheet'))).body.sheet, null);

    // Saving an invalid sheet is a 422 with machine-readable codes.
    const bad = await ctx.call(a.token, 'PUT', p('sheet'), { build: { missiles: 99 } });
    assert.deepEqual([bad.status, bad.body.errors[0].code], [422, 'BUILD_OVER_CAPACITY']);

    // Draft, then final.
    assert.equal((await ctx.call(a.token, 'PUT', p('sheet'), { build: { abms: 3, factories: 2 }, messages: { INDIA: { text: 'hi', anonymous: true } } })).status, 200);
    assert.equal((await ctx.call(a.token, 'GET', p('sheet'))).body.sheet.build.abms, 3);
    const first = await ctx.call(a.token, 'POST', p('sheet/submit'), { build: { abms: 3, factories: 2 }, messages: { INDIA: { text: 'hi', anonymous: true } } });
    assert.deepEqual([first.body.submitted, first.body.active, first.body.resolved], [1, 3, false]);
    const evt = await sse.next('player_submitted');
    assert.match(evt, /"finalCount":1/);

    assert.equal((await ctx.call(b.token, 'GET', p('turn'))).body.turn.submitted, 1);       // a count, never names
    assert.equal((await ctx.call(b.token, 'POST', p('sheet/submit'), {})).body.resolved, false);
    const last = await ctx.call(c.token, 'POST', p('sheet/submit'), {});
    assert.equal(last.body.resolved, true);
    await sse.next('turn_resolved');

    const after = await ctx.call(b.token, 'GET', p('state'));
    assert.equal(after.body.turn.number, 2);
    assert.equal(after.body.assets.cash, 105);
    assert.deepEqual(after.body.messages, [{ from: null, text: 'hi' }]);                    // anonymous sender hidden
    const hist = await ctx.call(b.token, 'GET', p('history'));
    assert.equal(hist.body.turns.length, 1);
    assert.equal(hist.body.turns[0].number, 1);
    assert.equal((await ctx.call(a.token, 'GET', p('replay'))).body.errors[0].code, 'GAME_NOT_FINISHED');
    sse.close();
  } finally { await ctx.close(); }
});

scenario('play: strangers see nothing; late and battle-turn rules surface as 4xx', async () => {
  const ctx = await boot();
  try {
    const g = await lobby(ctx, 3);
    await startIt(ctx, g);
    const out = await ctx.signup('Outsider');
    const p = (s) => `/api/v1/games/${g.gameId}/${s}`;
    for (const [m, s, body] of [['GET', 'state'], ['GET', 'turn'], ['GET', 'sheet'], ['GET', 'history'], ['GET', 'replay'],
      ['PUT', 'sheet', {}], ['POST', 'sheet/submit', {}], ['POST', 'sheet/validate', {}]]) {
      assert.equal((await ctx.call(out.token, m, p(s), body)).status, 403, `${m} ${s}`);
    }
    assert.equal((await ctx.stream(out.token, g.gameId)).status, 403);
    ctx.clock.t = new Date(ctx.clock.t.getTime() + 25 * HOUR);                                // past the deadline
    const late = await ctx.call(g.users[0].token, 'PUT', p('sheet'), {});
    assert.deepEqual([late.status, late.body.errors[0].code], [409, 'TURN_CLOSED']);
    assert.equal((await ctx.call(g.users[0].token, 'GET', '/api/v1/games/99999/state')).status, 404);
  } finally { await ctx.close(); }
});

scenario('play: war over HTTP gives a battle sheet view and rejects normal-turn fields', async () => {
  const ctx = await boot();
  try {
    const g = await lobby(ctx, 3);
    await startIt(ctx, g);
    await submitAll(ctx, g);
    await submitAll(ctx, g, (c) => (c === 'FRANCE' ? { declareWar: true } : {}));
    const p = (s) => `/api/v1/games/${g.gameId}/${s}`;
    const a = g.users[0];
    const st = await ctx.call(a.token, 'GET', p('state'));
    assert.equal(st.body.turn.type, 'BATTLE');
    assert.equal(st.body.assets.missiles, 20 + 9 + 9 + 5);                                   // two turns of builds plus the +5 war bonus
    const view = await ctx.call(a.token, 'GET', p('sheet'));
    assert.equal(view.body.limits.type, 'BATTLE');
    assert.equal(view.body.limits.homeStock, st.body.assets.missiles);
    const bad = await ctx.call(a.token, 'PUT', p('sheet'), { build: { missiles: 1 } });
    assert.equal(bad.body.errors[0].code, 'NOT_YOUR_TURN_TYPE');
    const over = await ctx.call(a.token, 'PUT', p('sheet'), { fire: { HOME: { INDIA: 9999 } } });
    assert.equal(over.body.errors[0].code, 'FIRE_OVER_STOCK');
    const ok = await ctx.call(a.token, 'PUT', p('sheet'), { fire: { HOME: { INDIA: 5 } } });
    assert.equal(ok.status, 200);
  } finally { await ctx.close(); }
});

// ───────────────────────── Deadlines, endings, secrecy ─────────────────────────

scenario('deadline worker + SSE + replay: seed stays secret until the game ends', async () => {
  const ctx = await boot();
  try {
    const g = await lobby(ctx, 3, { forfeitAfterN: 1 });
    await startIt(ctx, g);
    const [a, b] = g.users;
    const p = (s) => `/api/v1/games/${g.gameId}/${s}`;
    const sse = await ctx.stream(b.token, g.gameId);
    await sse.next('event: ready');

    // Only FRANCE saves a sheet; INDIA and JAPAN miss the deadline and are forfeited at N = 1.
    assert.equal((await ctx.call(a.token, 'PUT', p('sheet'), {})).status, 200);
    const worker = startWorker({ store: ctx.store, notify: ctx.app.notify, intervalMs: 1e9, now: () => ctx.clock.t, logger: { error() {} } });
    const mine = (rs) => rs.filter((r) => r.gameId === g.gameId);                             // a shared database holds other games too
    assert.deepEqual(mine(await worker.tick()), []);                                          // not due yet
    ctx.clock.t = new Date(ctx.clock.t.getTime() + 24 * HOUR);
    const results = mine(await worker.tick());
    assert.equal(results.length, 1);
    assert.equal(results[0].over, true);
    await sse.next('turn_resolved');
    const text = await sse.next('game_finished');
    assert.match(text, /"outcome":"WIN"/);
    worker.stop();

    const state = await ctx.call(a.token, 'GET', p('state'));
    assert.equal(state.body.game.status, 'FINISHED');
    assert.equal(state.body.game.outcome, 'WIN');
    assert.equal((await ctx.call(b.token, 'POST', p('sheet/submit'), {})).status, 409);

    // The seed never appeared in a single response before the replay was released.
    assert.ok(ctx.seen.every((t) => !t.includes('"seed"')), 'seed leaked');
    const replay = await ctx.call(b.token, 'GET', p('replay'));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.winner, 'FRANCE');
    assert.equal(typeof replay.body.seed, 'number');
    assert.ok(replay.body.events.some((e) => e.type === 'FORFEITED'));
    assert.ok(replay.body.sheets.some((s) => s.source === 'SERVER_DEFAULT'));
    sse.close();
  } finally { await ctx.close(); }
});

scenario('errors never leak internals: an unexpected failure is a plain 500', async () => {
  const ctx = await boot();
  try {
    const u = await ctx.signup('Ann');
    const original = ctx.store.withTransaction;
    ctx.store.withTransaction = async () => { throw new Error('db exploded: password=hunter2'); };
    let r;
    try { r = await ctx.call(u.token, 'GET', '/api/v1/me'); } finally { ctx.store.withTransaction = original; }
    assert.equal(r.status, 500);
    assert.equal(r.body.errors[0].code, 'INTERNAL');
    assert.ok(!r.text.includes('hunter2'));
  } finally { await ctx.close(); }
});
