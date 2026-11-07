import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/store/memory.js';
import { seedForTurn } from '../../src/game/index.js';
import { startGame, submitSheet } from '../../src/app/pipeline.js';
import { memoryAdapter } from './adapters.js';
import { defineStoreContract } from './contract.js';

// The shared behaviour every store must have. A fresh in-memory store for every test.
defineStoreContract('memory store', { makeStore: async () => createMemoryStore(), adapter: memoryAdapter });

// ───────────────────────── Things only the in-memory store can show ─────────────────────────
// (The contract suite deliberately uses only the public API, so it cannot look at stored snapshots
// or internals. These tests can, because they know this store's shape.)

const T0 = new Date('2026-11-01T00:00:00Z');

async function startedGame(store, seed = 99) {
  const gameId = store.createGame({ creatorId: 1, seed });
  for (const [i, country] of ['FRANCE', 'INDIA', 'JAPAN'].entries()) {
    store.addPlayer({ gameId, userId: i + 1, country, startPopulation: 50 });
  }
  assert.equal((await startGame(store, { gameId, userId: 1 }, T0)).ok, true);
  return gameId;
}
const turnRow = (store, gameId, number) => store.data.turns.find((t) => t.gameId === gameId && t.number === number);

test('memory store: each turn records its seed, and stores the state before and after it', async () => {
  const store = createMemoryStore();
  const gameId = await startedGame(store, 99);
  for (const userId of [1, 2, 3]) await submitSheet(store, { gameId, userId, payload: {}, final: true }, new Date(T0.getTime() + 3600e3));
  const t1 = turnRow(store, gameId, 1);
  const t2 = turnRow(store, gameId, 2);
  assert.equal(t1.rngSeed, seedForTurn(99, 1));
  assert.equal(t2.rngSeed, seedForTurn(99, 2));
  assert.equal(t1.stateBefore.players.FRANCE.cash, 100);        // what turn 1 started from
  assert.equal(t1.stateAfter.players.FRANCE.missiles, 29);      // what the resolver produced
  assert.equal(t2.stateBefore.players.FRANCE.cash, 105);        // turn 2 opens with income already applied
  assert.equal(t2.stateAfter, null);                            // still open
});

test('memory store: a thrown error discards every change made in the transaction', async () => {
  const store = createMemoryStore();
  const before = JSON.stringify(store.data);
  await assert.rejects(store.withTransaction(async (tx) => {
    await tx.createUser('Ghost');
    await tx.insertGame({ creatorId: 1, seed: 1, turnDeadlineHours: 24, forfeitAfterN: 5 });
    throw new Error('abort');
  }), /abort/);
  assert.equal(JSON.stringify(store.data), before);
});

test('memory store: like the database trigger, it refuses player sheets on a closed turn', async () => {
  const store = createMemoryStore();
  const gameId = await startedGame(store);
  for (const userId of [1, 2, 3]) await submitSheet(store, { gameId, userId, payload: {}, final: true }, new Date(T0.getTime() + 3600e3));
  const closed = turnRow(store, gameId, 1);
  assert.equal(closed.status, 'CLOSED');
  const playerId = store.data.players.find((p) => p.gameId === gameId).id;
  await assert.rejects(
    store.withTransaction((tx) => tx.saveSheet({ turnId: closed.id, gameId, playerId, payload: {}, isFinal: true })),
    /not accepting player sheets/);
});

test('memory store: simulated mid-resolution failure leaves the turn open (the hook the contract suite avoids)', async () => {
  const store = createMemoryStore();
  const gameId = await startedGame(store);
  for (const userId of [1, 2]) await submitSheet(store, { gameId, userId, payload: {}, final: true }, new Date(T0.getTime() + 3600e3));
  store.hooks.failDuringSave = true;
  await assert.rejects(submitSheet(store, { gameId, userId: 3, payload: {}, final: true }, new Date(T0.getTime() + 3600e3)), /simulated failure/);
  assert.equal(turnRow(store, gameId, 1).status, 'OPEN');
  assert.equal(turnRow(store, gameId, 2), undefined);
  assert.equal(store.data.players.find((p) => p.country === 'FRANCE').cash, 100);
});
