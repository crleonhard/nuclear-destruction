// The limit on how many unfinished games one person can have created, and cancelling a game in its lobby.
// Runs on whichever store the suite uses (memory by default, PostgreSQL with test:db).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, labelFor } from './support/stores.js';
import { createGame, joinGame, getLobby, cancelGame, myGames } from '../src/app/lobby.js';
import { startGame, resolveDueTurns } from '../src/app/pipeline.js';

const stores = await openStore();
after(() => stores.close());
// scenario(name, fn) or scenario(name, { skip, ... }, fn): the options object, when given, comes second (as with node:test).
const scenario = (name, a, b) => {
  const [opts, fn] = typeof a === 'function' ? [{}, a] : [a, b];
  return test(labelFor(stores.kind) + name, opts, fn);
};

const T0 = new Date('2026-11-01T00:00:00Z');
const at = (h) => new Date(T0.getTime() + h * 3600 * 1000);

async function world() {
  const store = stores.makeStore();
  const user = async (name) => (await store.withTransaction((tx) => tx.createUser(name))).id;
  const create = (userId, { limit = 3, settings = {} } = {}) => createGame(store, { userId, settings, maxOpenGames: limit });
  return { store, user, create };
}

scenario('limit: a person can have only so many unfinished games, and the message says how many', async () => {
  const w = await world();
  const ann = await w.user('Ann');
  for (let i = 0; i < 3; i++) assert.equal((await w.create(ann)).ok, true, `game ${i + 1}`);
  const fourth = await w.create(ann);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.status, 409);
  assert.equal(fourth.errors[0].code, 'TOO_MANY_GAMES');
  assert.match(fourth.errors[0].message, /already have 3 games that are not finished \(the limit is 3\)/);
  assert.match(fourth.errors[0].message, /Finish or cancel one/);

  const one = await world();
  const bob = await one.user('Bob');
  await one.create(bob, { limit: 1 });
  assert.match((await one.create(bob, { limit: 1 })).errors[0].message, /already have 1 game that is not finished \(the limit is 1\)/, 'singular wording');
});

scenario('limit: it is per person, 0 means no limit, and an invalid request is refused before the limit is looked at', async () => {
  const w = await world();
  const [ann, bob] = [await w.user('Ann'), await w.user('Bob')];
  await w.create(ann, { limit: 1 });
  assert.equal((await w.create(ann, { limit: 1 })).status, 409);
  assert.equal((await w.create(bob, { limit: 1 })).ok, true, 'someone else is unaffected');
  for (let i = 0; i < 6; i++) assert.equal((await w.create(ann, { limit: 0 })).ok, true, 'no limit');
  const invalid = await w.create(ann, { limit: 1, settings: { aiPlayers: 99 } });
  assert.equal(invalid.status, 422, 'a malformed request is a 422, not a 409');
});

scenario('limit: games the person only joined do not count, but games that have started do', async () => {
  const w = await world();
  const [host, guest] = [await w.user('Host'), await w.user('Guest')];
  assert.equal((await w.create(host, { limit: 1 })).ok, true);
  for (let i = 0; i < 3; i++) {
    const g = await w.create(await w.user(`Other${i}`), { limit: 1 });
    assert.equal((await joinGame(w.store, { gameId: g.gameId, userId: guest })).ok, true);
  }
  assert.equal((await w.create(guest, { limit: 1 })).ok, true, 'three joined games do not use up the guest\'s place');
  assert.equal((await w.create(host, { limit: 1 })).status, 409);

  const ai = await w.create(await w.user('Solo'), { limit: 1, settings: { aiPlayers: 2 } });
  const solo = (await getLobby(w.store, { gameId: ai.gameId })).game.creatorId;
  assert.equal((await startGame(w.store, { gameId: ai.gameId, userId: solo }, T0)).ok, true);
  assert.equal((await w.create(solo, { limit: 1 })).status, 409, 'a running game still counts');
});

scenario('limit: a finished game stops counting', async () => {
  const w = await world();
  const ann = await w.user('Ann');
  const made = await w.create(ann, { limit: 1, settings: { aiPlayers: 3, forfeitAfterN: 1 } });
  assert.equal((await startGame(w.store, { gameId: made.gameId, userId: ann }, T0)).ok, true);
  assert.equal((await w.create(ann, { limit: 1 })).status, 409, 'while it runs');
  await resolveDueTurns(w.store, at(25));                         // Ann misses turn 1 and is forfeited; the AIs play the game out
  const lobby = await getLobby(w.store, { gameId: made.gameId });
  assert.equal(lobby.game.status, 'FINISHED');
  assert.equal((await w.create(ann, { limit: 1 })).ok, true, 'a place is free again');
});

scenario('limit: simultaneous requests cannot slip past it', { skip: stores.kind !== 'postgres' && 'needs a real database: the in-memory store does not isolate concurrent transactions' }, async () => {
  const w = await world();
  const ann = await w.user('Ann');
  const results = await Promise.all(Array.from({ length: 8 }, () => w.create(ann, { limit: 3 })));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
});

scenario('cancel: the creator removes a lobby, its seats and its AI players, and gets a place back', async () => {
  const w = await world();
  const [host, guest] = [await w.user('Host'), await w.user('Guest')];
  const made = await w.create(host, { limit: 1, settings: { aiPlayers: 2 } });
  assert.equal((await joinGame(w.store, { gameId: made.gameId, userId: guest })).ok, true);
  const seats = (await getLobby(w.store, { gameId: made.gameId })).seats;
  const aiIds = seats.filter((s) => s.ai).map((s) => s.userId);
  assert.equal(aiIds.length, 2);
  assert.equal((await w.create(host, { limit: 1 })).status, 409);

  assert.deepEqual(await cancelGame(w.store, { gameId: made.gameId, userId: host }), { ok: true });
  assert.equal((await getLobby(w.store, { gameId: made.gameId })).status, 404);
  assert.deepEqual(await w.store.withTransaction((tx) => tx.getUsers(aiIds)), {}, 'the AI accounts are gone');
  assert.equal((await myGames(w.store, { userId: guest })).games?.length ?? (await myGames(w.store, { userId: guest })).length, 0, 'the guest\'s list no longer shows it');
  assert.equal((await w.store.withTransaction((tx) => tx.getUsers([guest])))[guest], 'Guest', 'a person\'s account is untouched');
  assert.equal((await w.create(host, { limit: 1 })).ok, true, 'the place is free again');
  assert.equal((await cancelGame(w.store, { gameId: made.gameId, userId: host })).status, 404, 'cancelling twice');
});

scenario('cancel: only the creator, only in the lobby; another game\'s AI players are not touched', async () => {
  const w = await world();
  const [host, guest, other] = [await w.user('Host'), await w.user('Guest'), await w.user('Other')];
  const made = await w.create(host, { settings: { aiPlayers: 2 } });
  await joinGame(w.store, { gameId: made.gameId, userId: guest });
  const keep = await w.create(other, { settings: { aiPlayers: 2 } });
  const keepAi = (await getLobby(w.store, { gameId: keep.gameId })).seats.filter((s) => s.ai).map((s) => s.userId);

  const notCreator = await cancelGame(w.store, { gameId: made.gameId, userId: guest });
  assert.deepEqual([notCreator.status, notCreator.errors[0].code], [403, 'FORBIDDEN']);
  assert.equal((await cancelGame(w.store, { gameId: 999999, userId: host })).status, 404);

  assert.equal((await cancelGame(w.store, { gameId: made.gameId, userId: host })).ok, true);
  const names = await w.store.withTransaction((tx) => tx.getUsers(keepAi));
  assert.equal(Object.keys(names).length, 2, 'the other game keeps its AI players');
  assert.equal((await getLobby(w.store, { gameId: keep.gameId })).seats.length, 3);

  assert.equal((await startGame(w.store, { gameId: keep.gameId, userId: other }, T0)).ok, true);
  const started = await cancelGame(w.store, { gameId: keep.gameId, userId: other });
  assert.deepEqual([started.status, started.errors[0].code], [409, 'ALREADY_STARTED']);
  assert.equal((await getLobby(w.store, { gameId: keep.gameId })).game.status, 'ACTIVE', 'a started game is untouched');
});
