// Abandoned-lobby cleanup: which lobbies count as abandoned, what is never touched, what removal does, and the worker's part.
// Runs on whichever store the suite uses (memory by default, PostgreSQL with test:db).
//
// Real lobbies are made with the real lobby functions, then back-dated: `backdate` rewrites the creation and seat times,
// the only way to make a lobby "old" without waiting. (On a shared PostgreSQL database other tests' lobbies are always
// recent, so only the ones made here can ever be idle.)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, labelFor } from './support/stores.js';
import { createGame, joinGame, addAiPlayer } from '../src/app/lobby.js';
import { startGame, resolveDueTurns } from '../src/app/pipeline.js';
import { removeAbandonedLobbies } from '../src/app/cleanup.js';
import { startWorker } from '../src/worker.js';

const stores = await openStore();
after(() => stores.close());
// scenario(name, fn) or scenario(name, { skip, ... }, fn): the options object, when given, comes second (as with node:test).
const scenario = (name, a, b) => {
  const [opts, fn] = typeof a === 'function' ? [{}, a] : [a, b];
  return test(labelFor(stores.kind) + name, opts, fn);
};

const DAY = 24 * 3600 * 1000;
const ago = (days, from = Date.now()) => new Date(from - days * DAY);

function world() {
  const store = stores.makeStore();
  const tx = (fn) => store.withTransaction(fn);
  const person = (name) => tx((t) => t.createUser(name));
  const lobby = async (creator, { ai = 0, joiners = [] } = {}) => {
    const r = await createGame(store, { userId: creator.id, settings: { aiPlayers: ai } });
    assert.equal(r.ok, true, JSON.stringify(r));
    for (const j of joiners) assert.equal((await joinGame(store, { gameId: r.gameId, userId: j.id })).ok, true);
    return r.gameId;
  };
  /** Makes a lobby look as if it was created `created` days ago and its seats were taken `seats` days ago. */
  const backdate = async (gameId, created, seats = created, from = Date.now()) => {
    if (stores.kind === 'postgres') {
      await stores.pool.query('UPDATE games SET created_at = $2 WHERE id = $1', [gameId, ago(created, from)]);
      await stores.pool.query('UPDATE players SET joined_at = $2 WHERE game_id = $1', [gameId, ago(seats, from)]);
    } else {
      const d = store.data;
      d.games.find((g) => g.id === gameId).createdAt = ago(created, from);
      for (const p of d.players.filter((x) => x.gameId === gameId)) p.joinedAt = ago(seats, from);
    }
  };
  const exists = async (gameId) => (await tx((t) => t.loadSnapshot(gameId))).game !== null;
  return { store, tx, person, lobby, backdate, exists };
}

scenario('cleanup: an idle lobby is removed with its AI seats and gives the creator the place back; a fresh one stays', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const ben = await w.person('Ben');
  const idle = await w.lobby(ann, { ai: 2, joiners: [ben] });
  const fresh = await w.lobby(ann);
  const botIds = (await w.tx((t) => t.loadSnapshot(idle))).players.map((p) => p.userId).filter((id) => id !== ann.id && id !== ben.id);
  assert.equal(botIds.length, 2);
  await w.backdate(idle, 30);
  assert.equal(await w.tx((t) => t.countOpenGamesCreatedBy(ann.id)), 2);

  const r = await removeAbandonedLobbies(w.store, { now: new Date(), maxAgeDays: 14 });
  assert.ok(r.removed.includes(idle));
  assert.ok(!r.removed.includes(fresh));
  assert.equal(await w.exists(idle), false);
  assert.equal(await w.exists(fresh), true);
  assert.deepEqual(await w.tx((t) => t.getUsers(botIds)), {}, 'the AI accounts went with it');
  assert.equal(await w.tx((t) => t.countOpenGamesCreatedBy(ann.id)), 1, 'one place is free again');
  assert.equal(((await w.tx((t) => t.getUsers([ben.id])))[ben.id]), 'Ben', 'people are not deleted, only their seat in the lobby');
});

scenario('cleanup: anything that adds a seat counts as activity: a person joining, or an AI being added', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const ben = await w.person('Ben');
  const quiet = await w.lobby(ann);                                   // nothing since creation
  const joined = await w.lobby(ann);                                  // old, but Ben joined recently
  const aided = await w.lobby(ann);                                   // old, but an AI was added recently
  const stale = await w.lobby(ann);                                   // old, and Ben joined long ago
  for (const id of [quiet, joined, aided, stale]) await w.backdate(id, 30);
  assert.equal((await joinGame(w.store, { gameId: joined, userId: ben.id })).ok, true);
  assert.equal((await addAiPlayer(w.store, { gameId: aided, userId: ann.id })).ok, true);
  assert.equal((await joinGame(w.store, { gameId: stale, userId: ben.id })).ok, true);
  await w.backdate(stale, 30, 20);

  const r = await removeAbandonedLobbies(w.store, { now: new Date(), maxAgeDays: 14 });
  assert.deepEqual([quiet, stale].filter((id) => !r.removed.includes(id)), [], 'the quiet one and the one with only old seats went');
  assert.deepEqual([joined, aided].filter((id) => r.removed.includes(id)), [], 'a recent join or a recent AI keeps a lobby alive');
  assert.equal(await w.exists(joined), true);
  assert.equal(await w.exists(aided), true);
});

scenario('cleanup: a lobby exactly as old as the limit stays; one millisecond older goes', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const edge = await w.lobby(ann);
  const over = await w.lobby(ann);
  const now = new Date();
  await w.backdate(edge, 14, 14, now.getTime());
  await w.backdate(over, 14, 14, now.getTime() - 1);                   // created and seated 14 days and 1 ms before `now`
  const r = await removeAbandonedLobbies(w.store, { now, maxAgeDays: 14 });
  assert.ok(!r.removed.includes(edge));
  assert.ok(r.removed.includes(over));
});

scenario('cleanup: games that have started or finished are never removed, however long ago anyone moved', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const running = (await createGame(w.store, { userId: ann.id, settings: { aiPlayers: 3 } })).gameId;
  assert.equal((await startGame(w.store, { gameId: running, userId: ann.id }, new Date())).ok, true);
  const over = (await createGame(w.store, { userId: ann.id, settings: { aiPlayers: 3, forfeitAfterN: 1 } })).gameId;
  const t0 = new Date();
  assert.equal((await startGame(w.store, { gameId: over, userId: ann.id }, t0)).ok, true);
  await resolveDueTurns(w.store, new Date(t0.getTime() + 25 * 3600 * 1000));      // Ann misses her turn and the AIs play it out
  assert.equal((await w.tx((t) => t.loadSnapshot(over))).game.status, 'FINISHED');
  for (const id of [running, over]) await w.backdate(id, 400);
  const r = await removeAbandonedLobbies(w.store, { now: new Date(), maxAgeDays: 14 });
  assert.deepEqual([running, over].filter((id) => r.removed.includes(id)), []);
  assert.equal(await w.exists(running), true);
  assert.equal(await w.exists(over), true);
});

scenario('cleanup: 0 (or nothing) switches it off', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const idle = await w.lobby(ann);
  await w.backdate(idle, 500);
  for (const maxAgeDays of [0, -3, undefined, NaN]) assert.deepEqual(await removeAbandonedLobbies(w.store, { now: new Date(), maxAgeDays }), { removed: [] }, String(maxAgeDays));
  assert.equal(await w.exists(idle), true);
});

scenario('cleanup: one pass removes at most `batch` lobbies, oldest first; the next pass carries on', { skip: stores.kind !== 'memory' && 'counts on no other idle lobby being in the store (earlier scenarios leave some behind on a shared one)' }, async () => {
  const w = world();
  const ann = await w.person('Ann');
  const ids = [];
  for (let i = 0; i < 3; i++) { const id = await w.lobby(ann); await w.backdate(id, 40 - i); ids.push(id); }
  assert.deepEqual((await removeAbandonedLobbies(w.store, { now: new Date(), maxAgeDays: 14, batch: 2 })).removed, [ids[0], ids[1]]);
  assert.deepEqual((await removeAbandonedLobbies(w.store, { now: new Date(), maxAgeDays: 14, batch: 2 })).removed, [ids[2]]);
  assert.deepEqual((await removeAbandonedLobbies(w.store, { now: new Date(), maxAgeDays: 14, batch: 2 })).removed, []);
});

scenario('cleanup: someone who joins at the very moment the cleanup looks at a lobby keeps it', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const ben = await w.person('Ben');
  const id = await w.lobby(ann);
  await w.backdate(id, 30);
  let calls = 0;
  const racing = {                                                     // Ben joins between the cleanup listing the lobby and locking it
    withTransaction: async (fn) => {
      if (++calls === 2) assert.equal((await joinGame(w.store, { gameId: id, userId: ben.id })).ok, true);
      return w.store.withTransaction(fn);
    },
  };
  const r = await removeAbandonedLobbies(racing, { now: new Date(), maxAgeDays: 14 });
  assert.ok(!r.removed.includes(id));
  assert.equal(await w.exists(id), true);
  assert.equal(await w.tx((t) => t.countOpenGamesCreatedBy(ann.id)), 1);
});

scenario('cleanup: a lobby that started a moment before the lock is not removed either', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const id = await w.lobby(ann, { ai: 2 });
  await w.backdate(id, 30);
  let calls = 0;
  const racing = {
    withTransaction: async (fn) => {
      if (++calls === 2) assert.equal((await startGame(w.store, { gameId: id, userId: ann.id }, new Date())).ok, true);
      return w.store.withTransaction(fn);
    },
  };
  assert.ok(!(await removeAbandonedLobbies(racing, { now: new Date(), maxAgeDays: 14 })).removed.includes(id));
  assert.equal((await w.tx((t) => t.loadSnapshot(id))).game.status, 'ACTIVE');
});

scenario('store: the idle-lobby query lists exactly the lobbies whose latest seat or creation is older than the cutoff', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const ben = await w.person('Ben');
  const quiet = await w.lobby(ann);
  const joinedRecently = await w.lobby(ann, { joiners: [ben] });
  const joinedLongAgo = await w.lobby(ann, { joiners: [ben] });
  const running = (await createGame(w.store, { userId: ann.id, settings: { aiPlayers: 3 } })).gameId;
  assert.equal((await startGame(w.store, { gameId: running, userId: ann.id }, new Date())).ok, true);
  const recent = await w.lobby(ann);
  const from = Date.now();                                               // one reference time, so the dates below compare exactly
  await w.backdate(quiet, 30, 30, from);
  await w.backdate(joinedRecently, 30, 30, from);                        // the creator's seat is old...
  await w.backdate(joinedLongAgo, 30, 20, from);
  await w.backdate(running, 30, 30, from);
  const bens = (await w.tx((t) => t.loadSnapshot(joinedRecently))).players.find((p) => p.userId === ben.id);
  if (stores.kind === 'postgres') await stores.pool.query('UPDATE players SET joined_at = $2 WHERE id = $1', [bens.id, ago(2, from)]);
  else store_of(w).data.players.find((p) => p.id === bens.id).joinedAt = ago(2, from);            // ...but Ben joined two days ago

  const cutoff = ago(14, from);
  const mine = [quiet, joinedRecently, joinedLongAgo, running, recent];
  const listed = (await w.tx((t) => t.listIdleLobbies(cutoff, 1000))).filter((id) => mine.includes(id));
  assert.deepEqual(listed, [quiet, joinedLongAgo], 'oldest game first; a recent seat, a started game and a fresh lobby are left out');
  assert.equal((await w.tx((t) => t.lobbyLastActivity(joinedRecently))).getTime(), ago(2, from).getTime());
  assert.equal((await w.tx((t) => t.lobbyLastActivity(joinedLongAgo))).getTime(), ago(20, from).getTime(), 'the latest seat, not the creation');
  assert.equal(await w.tx((t) => t.lobbyLastActivity(987654321)), null);
  assert.deepEqual((await w.tx((t) => t.listIdleLobbies(cutoff, 1000))).filter((id) => mine.includes(id)).length, 2);
});

scenario('limit: removing an idle lobby lets the creator open a new game that the limit had refused', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const first = await createGame(w.store, { userId: ann.id, settings: {}, maxOpenGames: 1 });
  assert.equal((await createGame(w.store, { userId: ann.id, settings: {}, maxOpenGames: 1 })).errors[0].code, 'TOO_MANY_GAMES');
  await w.backdate(first.gameId, 30);
  await removeAbandonedLobbies(w.store, { now: new Date(), maxAgeDays: 14 });
  assert.equal((await createGame(w.store, { userId: ann.id, settings: {}, maxOpenGames: 1 })).ok, true);
});

const store_of = (w) => w.store;

// ───────────────────────── the worker ─────────────────────────

const quietLogger = (log = []) => ({ error: (...a) => log.push(['error', a.join(' ')]), log: (...a) => log.push(['log', a.join(' ')]), warn() {} });

scenario('worker: removes idle lobbies, tells connected clients, and looks only once an hour', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const clock = { t: new Date() };
  const told = [];
  const log = [];
  const worker = startWorker({ store: w.store, notify: (id, e) => told.push([id, e]), intervalMs: 3_600_000_000, now: () => clock.t, logger: quietLogger(log), abandonedLobbyDays: 14 });
  try {
    const first = await w.lobby(ann);
    await w.backdate(first, 30);
    await worker.tick();
    assert.equal(await w.exists(first), false);
    assert.deepEqual(told.filter(([id]) => id === first), [[first, { type: 'game_cancelled' }]]);
    assert.ok(log.some(([k, m]) => k === 'log' && /removed \d+ abandoned/.test(m)), 'the removal is logged');

    const second = await w.lobby(ann);
    await w.backdate(second, 30);
    clock.t = new Date(clock.t.getTime() + 30 * 60_000);                // half an hour later: too soon to look again
    await worker.tick();
    assert.equal(await w.exists(second), true);
    clock.t = new Date(clock.t.getTime() + 31 * 60_000);                // over an hour since the last look
    await worker.tick();
    assert.equal(await w.exists(second), false);
  } finally { await worker.stop(); }
});

scenario('worker: with the cleanup switched off (the default) it never removes anything', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const idle = await w.lobby(ann);
  await w.backdate(idle, 500);
  const worker = startWorker({ store: w.store, notify() {}, intervalMs: 3_600_000_000, logger: quietLogger() });
  try { await worker.tick(); } finally { await worker.stop(); }
  assert.equal(await w.exists(idle), true);
});

scenario('worker: a failing cleanup is logged and never stops the rest of the pass', async () => {
  const w = world();
  const log = [];
  let notifierRan = 0;
  const failing = { ...w.store, withTransaction: (fn) => (String(fn).includes('listIdleLobbies') ? Promise.reject(new Error('database away')) : w.store.withTransaction(fn)) };
  const worker = startWorker({ store: failing, notify() {}, notifier: { tick: async () => { notifierRan++; } }, intervalMs: 3_600_000_000, logger: quietLogger(log), abandonedLobbyDays: 14 });
  try { await worker.tick(); await worker.tick(); } finally { await worker.stop(); }
  assert.equal(notifierRan, 2, 'turn emails still went out');
  assert.equal(log.filter(([k, m]) => k === 'error' && /lobby cleanup failed: database away/.test(m)).length, 1, 'logged once; the hourly throttle applies to failures too');
});
