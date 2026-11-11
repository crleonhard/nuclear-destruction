// The deadline worker sleeps until something is due instead of polling: which wake-up times it chooses, what moves them earlier,
// and that real deadlines are met on time. Scheduling is tested with timers replaced by a fake, so exact times can be asserted;
// the last tests use real timers and the real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store/memory.js';
import { createApp } from '../src/http/app.js';
import { createTokenAuth } from '../src/http/auth.js';
import { startGame } from '../src/app/pipeline.js';
import { startWorker } from '../src/worker.js';

const HOUR = 3600 * 1000;
const T = new Date('2030-06-01T12:00:00Z');
const quiet = () => ({ errors: [], error(...a) { this.errors.push(a.join(' ')); }, log() {}, warn() {} });
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

/** Timers that only run when told to: setTimeout records the delay, fire() runs the newest live one. */
function fakeTimers() {
  const all = [];
  return {
    setTimeout: (fn, delay) => { const t = { fn, delay, cleared: false, fired: false, unref() {} }; all.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    all,
    live: () => all.filter((t) => !t.cleared && !t.fired),
    armed() { const live = this.live(); assert.equal(live.length, 1, `exactly one wake-up should be planned, found ${live.length}`); return live[0]; },
    async fire() { const t = this.armed(); t.fired = true; t.fn(); await settle(); },
  };
}

/** A store with just what the worker asks for, so scheduling is the only thing under test. */
function stubStore({ deadline = null, due = [], awaitingAi = [] } = {}) {
  const state = { deadline, due, awaitingAi, lookups: 0 };
  const tx = {
    listDueTurns: async () => state.due,
    nextTurnDeadline: async () => { state.lookups++; if (state.failLookup) throw new Error('database away'); return state.deadline; },
    listGamesAwaitingAi: async () => state.awaitingAi,
    listIdleLobbies: async () => [],
  };
  return { state, withTransaction: async (fn) => fn(tx) };
}

function setup({ deadline = null, ...opts } = {}) {
  const clock = { t: new Date(T) };
  const timers = fakeTimers();
  const store = stubStore({ deadline });
  const logger = quiet();
  const worker = startWorker({ store, notify() {}, now: () => clock.t, logger, timers, intervalMs: 6 * HOUR, ...opts });
  return { clock, timers, store, logger, worker };
}

// ───────────────────────── choosing the wake-up ─────────────────────────

test('worker: until the first pass it sleeps the longest sleep; with nothing waiting it keeps sleeping that long', async () => {
  const s = setup();
  assert.equal(s.timers.armed().delay, 6 * HOUR);
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 6 * HOUR, 'no open turn, no reminder, no cleanup: nothing to wake for');
  await s.worker.stop();
});

test('worker: it wakes just after the next deadline, not on a beat', async () => {
  const s = setup({ deadline: new Date(T.getTime() + 2 * HOUR) });
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 2 * HOUR + 25, 'two hours plus a little slack, nothing in between');
  await s.worker.stop();
});

test('worker: a deadline further away than the longest sleep waits for the longest sleep (the safety net)', async () => {
  const s = setup({ deadline: new Date(T.getTime() + 20 * HOUR) });
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 6 * HOUR);
  await s.worker.stop();
});

test('worker: a deadline that fell due during the pass is met almost at once', async () => {
  const s = setup({ deadline: new Date(T.getTime() + 10) });                 // 10 ms after the pass starts
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 35, '10 ms until it is due, plus the slack');
  await s.worker.stop();
});

test('worker: a deadline that was already due when the pass began and is still open (resolving failed) is retried after the retry delay, not in a tight loop', async () => {
  const s = setup({ deadline: new Date(T.getTime() - HOUR) });
  s.store.state.due = [{ gameId: 1, number: 1 }];                           // resolving it throws (the stub has no games), which the worker logs
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 60_000);
  assert.match(s.logger.errors.join('\n'), /game 1/);
  await s.worker.stop();
});

test('worker: a failing deadline lookup is logged and retried soon', async () => {
  const s = setup();
  s.store.state.failLookup = true;
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 60_000);
  assert.match(s.logger.errors.join('\n'), /could not look up the next deadline: database away/);
  await s.worker.stop();
});

test('worker: an AI that could not move is retried after the retry delay', async () => {
  const s = setup();
  s.store.state.awaitingAi = [5];                                          // playing it throws (the stub has no such game)
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 60_000);
  assert.match(s.logger.errors.join('\n'), /AI in game 5/);
  await s.worker.stop();
});

test('worker: the turn-email notifier can ask to be woken earlier (a reminder, or a retry); no answer, or a time in the past, are both fine', async () => {
  const s = setup({ deadline: new Date(T.getTime() + 5 * HOUR) });
  let answer = { nextAt: T.getTime() + HOUR };
  s.worker.stop();
  const timers = fakeTimers();
  const worker = startWorker({ store: s.store, notify() {}, notifier: { tick: async () => answer }, now: () => s.clock.t, logger: quiet(), timers, intervalMs: 6 * HOUR });
  await worker.tick();
  assert.equal(timers.armed().delay, HOUR, 'the reminder is due before the deadline');
  answer = { nextAt: T.getTime() + 6 * HOUR };
  await worker.tick();
  assert.equal(timers.armed().delay, 5 * HOUR + 25, 'a later reminder does not delay the deadline');
  answer = { nextAt: null };
  await worker.tick();
  assert.equal(timers.armed().delay, 5 * HOUR + 25);
  answer = undefined;
  await worker.tick();
  assert.equal(timers.armed().delay, 5 * HOUR + 25, 'a notifier that says nothing changes nothing');
  answer = { nextAt: T.getTime() - HOUR };
  await worker.tick();
  assert.equal(timers.armed().delay, 25, 'never a zero or negative delay');
  await worker.stop();
});

test('worker: with abandoned-lobby cleanup on, it also wakes for the next hourly look', async () => {
  const s = setup({ abandonedLobbyDays: 14 });
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, HOUR);
  s.clock.t = new Date(T.getTime() + HOUR);
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, HOUR, 'and an hour after that');
  await s.worker.stop();
  const off = setup();
  await off.worker.tick();
  assert.equal(off.timers.armed().delay, 6 * HOUR, 'switched off, it never wakes for it');
  await off.worker.stop();
});

test('worker: no sleep is ever longer than setTimeout can hold', async () => {
  const s = setup({ intervalMs: 1e12 });
  assert.equal(s.timers.armed().delay, 2_147_483_647);
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 2_147_483_647);
  await s.worker.stop();
});

test('worker: when the wake-up arrives it runs a pass and plans the next one', async () => {
  const s = setup({ deadline: new Date(T.getTime() + HOUR) });
  await s.worker.tick();
  s.clock.t = new Date(T.getTime() + HOUR + 25);
  s.store.state.deadline = new Date(T.getTime() + 25 * HOUR);               // the turn was resolved and the next one opened
  const lookups = s.store.state.lookups;
  await s.timers.fire();
  assert.ok(s.store.state.lookups > lookups, 'the timer ran a pass');
  assert.equal(s.timers.armed().delay, 6 * HOUR, 'and planned from what it found: the next deadline is beyond the longest sleep');
  await s.worker.stop();
});

// ───────────────────────── poke ─────────────────────────

test('poke: asks for a pass soon, replacing a longer wait; repeated pokes make one wake-up', async () => {
  const s = setup();
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 6 * HOUR);
  s.worker.poke();
  assert.equal(s.timers.armed().delay, 50);
  const made = s.timers.all.length;
  s.worker.poke(); s.worker.poke(); s.worker.poke();
  assert.equal(s.timers.all.length, made, 'a wake-up already due that soon is left alone');
  await s.worker.stop();
});

test('poke: never delays a wake-up that is already sooner', async () => {
  const s = setup({ deadline: new Date(T.getTime() + 20) });
  await s.worker.tick();
  assert.equal(s.timers.armed().delay, 45);
  const made = s.timers.all.length;
  s.worker.poke();
  assert.equal(s.timers.all.length, made, 'the 45 ms wake-up stays');
  assert.equal(s.timers.armed().delay, 45);
  await s.worker.stop();
});

test('poke: during a pass it is not lost: the pass plans another one right away; a manual tick during a pass just asks for the same', async () => {
  const s = setup();
  s.worker.stop();
  const timers = fakeTimers();
  let worker;
  let during;
  worker = startWorker({
    store: s.store, notify() {}, now: () => s.clock.t, logger: quiet(), timers, intervalMs: 6 * HOUR,
    notifier: { tick: async () => { worker.poke(); during = await worker.tick(); } },          // something happens while the pass is running
  });
  await worker.tick();
  assert.equal(during, undefined, 'passes never overlap');
  assert.equal(timers.armed().delay, 50, 'the pass that was running plans one more');
  await worker.tick();                                                                           // that one has the same two events in it...
  await worker.stop();
});

test('poke and stop: stop clears the wake-up and nothing re-arms afterwards; stop waits for a pass in flight', async () => {
  const s = setup();
  s.worker.stop();
  const timers = fakeTimers();
  let release;
  const worker = startWorker({
    store: s.store, notify() {}, now: () => s.clock.t, logger: quiet(), timers, intervalMs: 6 * HOUR,
    notifier: { tick: () => new Promise((resolve) => { release = resolve; }) },
  });
  const pass = worker.tick();
  await settle();
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await settle();
  assert.equal(stopped, false, 'a pass is still running');
  release({ nextAt: null });
  await pass;
  await stopping;
  assert.equal(timers.live().length, 0, 'no wake-up is left behind');
  worker.poke();
  assert.equal(timers.live().length, 0, 'a poke after stop does nothing');
});

// ───────────────────────── the app pokes the worker ─────────────────────────

async function withApp(fn, { notifications = null } = {}) {
  const store = createMemoryStore();
  const pokes = [];
  const app = createApp({ store, auth: createTokenAuth({ secret: 'a-test-secret-that-is-long-enough', store }), allowSignup: true, notifications, onSchedule: () => pokes.push(Date.now()), logger: quiet() });
  const server = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try { await fn({ call, pokes, store }); } finally { await new Promise((r) => server.close(r)); server.closeAllConnections?.(); }
}

test('app: starting a game and resolving a turn poke the worker; lobby changes and plain submissions do not', async () => {
  await withApp(async ({ call, pokes }) => {
    const { token } = (await call('POST', '/api/v1/users', { displayName: 'Ann' })).body;
    const { gameId } = (await call('POST', '/api/v1/games', { aiPlayers: 2 }, token)).body;
    await call('POST', `/api/v1/games/${gameId}/ai`, { persona: 'HAWK' }, token);
    assert.equal(pokes.length, 0, 'setting up a lobby moves no deadline');
    assert.equal((await call('POST', `/api/v1/games/${gameId}/start`, {}, token)).status, 200);
    assert.equal(pokes.length, 1, 'a started game has a new deadline');
    assert.equal((await call('PUT', `/api/v1/games/${gameId}/sheet`, {}, token)).status, 200);
    assert.equal(pokes.length, 1, 'saving a draft moves nothing');
    assert.equal((await call('POST', `/api/v1/games/${gameId}/sheet/submit`, {}, token)).status, 200);
    assert.equal(pokes.length, 2, 'the turn resolved, so the next one has a new deadline');
  });
});

test('app: opting in to turn emails pokes the worker; a refused change does not', async () => {
  let ok = true;
  const notifications = {
    preferences: async () => ({ available: true, canEnable: true, turnEmails: false }),
    setTurnEmails: async (userId, enabled) => (ok ? { ok: true, turnEmails: enabled } : { ok: false, status: 409, errors: [{ code: 'EMAIL_REQUIRED', field: 'request', message: 'no' }] }),
  };
  await withApp(async ({ call, pokes }) => {
    const { token } = (await call('POST', '/api/v1/users', { displayName: 'Ann' })).body;
    assert.equal((await call('PUT', '/api/v1/me/notifications', { turnEmails: true }, token)).status, 200);
    assert.equal(pokes.length, 1);
    ok = false;
    assert.equal((await call('PUT', '/api/v1/me/notifications', { turnEmails: true }, token)).status, 409);
    assert.equal(pokes.length, 1);
  }, { notifications });
});

// ───────────────────────── real time ─────────────────────────

test('real time: a deadline is met when it arrives, even with a long maximum sleep', async () => {
  const store = createMemoryStore();
  const gameId = store.createGame({ creatorId: 1, seed: 5, forfeitAfterN: 5 });
  for (const [i, country] of ['FRANCE', 'INDIA', 'JAPAN'].entries()) store.addPlayer({ gameId, userId: i + 1, country, startPopulation: 50 });
  await startGame(store, { gameId, userId: 1 }, new Date());
  const due = Date.now() + 400;
  for (const t of store.data.turns) t.deadlineAt = new Date(due);          // a 24-hour deadline squeezed into 400 ms
  const worker = startWorker({ store, notify() {}, intervalMs: 60_000, logger: quiet() });
  try {
    await worker.tick();                                                    // plans the wake-up from the deadline, not from the 60 s beat
    const turnNow = async () => (await store.withTransaction((tx) => tx.loadSnapshot(gameId))).game.turnNumber;
    assert.equal(await turnNow(), 1);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await turnNow(), 1, 'not before the deadline');
    const start = Date.now();
    while ((await turnNow()) === 1 && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await turnNow(), 2, 'resolved by the worker on its own');
    assert.ok(Date.now() - due < 1500, `resolved ${Date.now() - due} ms after the deadline, long before the 60 s beat`);
  } finally { await worker.stop(); }
});

test('real time: poke brings a far-off wake-up forward, so a turn that came due while nobody was looking is resolved at once', async () => {
  const store = createMemoryStore();
  const gameId = store.createGame({ creatorId: 1, seed: 5, forfeitAfterN: 5 });
  for (const [i, country] of ['FRANCE', 'INDIA', 'JAPAN'].entries()) store.addPlayer({ gameId, userId: i + 1, country, startPopulation: 50 });
  await startGame(store, { gameId, userId: 1 }, new Date(Date.now() - 48 * HOUR));       // overdue since before the worker existed
  const worker = startWorker({ store, notify() {}, intervalMs: 3_600_000, logger: quiet() });
  try {
    worker.poke();
    const start = Date.now();
    let turn = 1;
    while (turn === 1 && Date.now() - start < 3000) { await new Promise((r) => setTimeout(r, 20)); turn = (await store.withTransaction((tx) => tx.loadSnapshot(gameId))).game.turnNumber; }
    assert.equal(turn, 2);
    assert.ok(Date.now() - start < 2000);
  } finally { await worker.stop(); }
});

test('memory store: transactions run one at a time, so two at once do not lose each other\'s writes', async () => {
  const store = createMemoryStore();
  await Promise.all([
    store.withTransaction(async (tx) => { await new Promise((r) => setTimeout(r, 30)); await tx.createUser('Slow'); }),
    store.withTransaction(async (tx) => { await tx.createUser('Quick'); }),
  ]);
  const names = Object.values(await store.withTransaction((tx) => tx.getUsers([1, 2])));
  assert.deepEqual(names.sort(), ['Quick', 'Slow']);
  await assert.rejects(store.withTransaction(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await store.withTransaction(async (tx) => (await tx.createUser('After')).id), 3, 'a failed transaction does not block the queue or leave anything behind');
});
