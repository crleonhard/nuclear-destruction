// store.nextTurnDeadline(): the earliest deadline among open turns of running games, which is what the worker sleeps until.
// Runs on whichever store the suite uses. The games here live in the 1990s, earlier than any other test's, so on a shared
// database theirs can never be the earliest.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, labelFor } from './support/stores.js';
import { createGame, joinGame } from '../src/app/lobby.js';
import { startGame, resolveDueTurns } from '../src/app/pipeline.js';

const stores = await openStore();
after(() => stores.close());
const scenario = (name, fn) => test(labelFor(stores.kind) + name, fn);

const HOUR = 3600 * 1000;
// Every scenario lives in its own year, each earlier than the one before it, because the games it leaves open must never be
// the earliest deadline in a later scenario (on a shared database they all stay). Nothing else in the suite is that old.
const era = (year) => { const T0 = new Date(Date.UTC(year, 0, 1)); return { T0, at: (h) => new Date(T0.getTime() + h * HOUR) }; };

async function game(store, { ai = 0, humans = 3, hours = 24, forfeitAfterN = 5 } = {}) {
  const tx = (fn) => store.withTransaction(fn);
  const people = [];
  for (let i = 0; i < humans; i++) people.push(await tx((t) => t.createUser(`P${i}`)));
  const r = await createGame(store, { userId: people[0].id, settings: { aiPlayers: ai, turnDeadlineHours: hours, forfeitAfterN } });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const p of people.slice(1)) assert.equal((await joinGame(store, { gameId: r.gameId, userId: p.id })).ok, true);
  return { gameId: r.gameId, creator: people[0] };
}
const start = async (store, g, t) => assert.equal((await startGame(store, { gameId: g.gameId, userId: g.creator.id }, t)).ok, true);
const next = (store) => store.withTransaction((tx) => tx.nextTurnDeadline());

scenario('next deadline: a lobby has none; a started game has its turn\'s deadline; the earliest of several wins', async () => {
  const { T0, at } = era(1999);
  const store = stores.makeStore();
  const a = await game(store, { hours: 48 });
  const b = await game(store, { hours: 24 });
  const lobbyOnly = await game(store);
  assert.ok(lobbyOnly.gameId);
  await start(store, a, T0);                                    // deadline T0 + 48 h
  assert.equal((await next(store)).getTime(), at(48).getTime());
  await start(store, b, at(1));                                 // deadline T0 + 25 h, earlier
  assert.equal((await next(store)).getTime(), at(25).getTime());
  assert.ok((await next(store)) instanceof Date);
});

scenario('next deadline: resolving a turn replaces its deadline with the next turn\'s; a finished game has none', async () => {
  const { T0, at } = era(1998);
  const store = stores.makeStore();
  const running = await game(store, { hours: 24, forfeitAfterN: 5 });
  await start(store, running, at(100));                         // deadline T0 + 124 h: far later than the games below
  const over = await game(store, { ai: 3, humans: 1, hours: 1, forfeitAfterN: 1 });
  await start(store, over, T0);                                 // deadline T0 + 1 h
  assert.equal((await next(store)).getTime(), at(1).getTime());
  await resolveDueTurns(store, at(2));                          // the lone person misses the turn and is forfeited; the AIs play the game out
  const afterwards = await next(store);
  assert.equal((await store.withTransaction((tx) => tx.loadSnapshot(over.gameId))).game.status, 'FINISHED');
  assert.equal(afterwards.getTime(), at(124).getTime(), 'the finished game no longer holds the earliest deadline');
  await resolveDueTurns(store, at(125));                        // the first game's turn 1 comes due; turn 2 opens 24 h after that
  assert.equal((await next(store)).getTime(), at(149).getTime());
});
