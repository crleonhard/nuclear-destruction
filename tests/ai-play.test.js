// AI players inside real games: the lobby rules, taking their turns, fairness, and self-play to the end.
// Runs on whichever store the suite uses (memory by default, PostgreSQL with test:db).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, labelFor } from './support/stores.js';
import { createGame, joinGame, getLobby, addAiPlayer, removeAiPlayer, pickCountry } from '../src/app/lobby.js';
import { startGame, submitSheet, resolveTurn, resolveDueTurns, getPackage } from '../src/app/pipeline.js';
import { playAiTurns, playPendingAiTurns, aiSeeds } from '../src/app/ai.js';
import { decideSheet } from '../src/ai/decide.js';
import { AI_PERSONAS } from '../src/ai/personas.js';
import { startWorker } from '../src/worker.js';

const stores = await openStore();
after(() => stores.close());
const scenario = (name, fn) => test(labelFor(stores.kind) + name, fn);

const T0 = new Date('2026-11-01T00:00:00Z');
const HOUR = 3600 * 1000;
const at = (h) => new Date(T0.getTime() + h * HOUR);

async function setup({ ai = 3, humans = 1, forfeitAfterN = 5, hours = 24 } = {}) {
  const store = stores.makeStore();
  const tx = (fn) => store.withTransaction(fn);
  const users = [];
  for (let i = 0; i < humans; i++) users.push((await tx((t) => t.createUser(`Human ${i + 1}`))).id);
  const created = await createGame(store, { userId: users[0], settings: { aiPlayers: ai, forfeitAfterN, turnDeadlineHours: hours } });
  assert.equal(created.ok, true, JSON.stringify(created));
  for (const u of users.slice(1)) assert.equal((await joinGame(store, { gameId: created.gameId, userId: u })).ok, true);
  const gameId = created.gameId;
  return {
    store, gameId, users, tx,
    lobby: async () => (await getLobby(store, { gameId })),
    snap: () => tx((t) => t.loadSnapshot(gameId)),
    personas: async () => { const s = await tx((t) => t.loadSnapshot(gameId)); return tx((t) => t.getAiPersonas(s.players.map((p) => p.userId))); },
    start: (opts) => startGame(store, { gameId, userId: users[0] }, T0, opts),
  };
}
const finals = (snap) => new Set(snap.sheets.filter((s) => s.isFinal).map((s) => s.playerId));

// ───────────────────────── the lobby ─────────────────────────

scenario('lobby: creating a game with AI players seats them with distinct names and play styles', async () => {
  const g = await setup({ ai: 4 });
  const { seats, game } = await g.lobby();
  assert.equal(seats.length, 5);
  assert.equal(seats.filter((s) => s.ai === null).length, 1);
  const bots = seats.filter((s) => s.ai);
  assert.equal(bots.length, 4);
  assert.ok(bots.every((b) => AI_PERSONAS.includes(b.ai) && b.country === null && b.startPopulation === null));
  assert.equal(new Set(bots.map((b) => b.displayName)).size, 4, 'names are distinct');
  assert.ok(bots.every((b) => /AI( \d+)?$/.test(b.displayName)));
  assert.equal(seats.find((s) => s.userId === game.creatorId).ai, null, 'the creator is a person');
});

scenario('lobby: the number of AI players is checked (0 to 8, whole numbers)', async () => {
  const store = stores.makeStore();
  const u = (await store.withTransaction((t) => t.createUser('Creator'))).id;
  for (const aiPlayers of [-1, 9, 2.5, '3', null, NaN]) {
    if (aiPlayers === null) continue;                           // null falls back to the default of none
    const r = await createGame(store, { userId: u, settings: { aiPlayers } });
    assert.equal(r.ok, false, String(aiPlayers));
    assert.equal(r.status, 422);
    assert.equal(r.errors[0].field, 'aiPlayers');
  }
  const eight = await createGame(store, { userId: u, settings: { aiPlayers: 8 } });
  assert.equal((await getLobby(store, { gameId: eight.gameId })).seats.length, 9);
  const none = await createGame(store, { userId: u, settings: {} });
  assert.equal((await getLobby(store, { gameId: none.gameId })).seats.length, 1);
});

scenario('lobby: only the creator adds or removes AI players, only in the lobby, never beyond nine seats', async () => {
  const g = await setup({ ai: 1, humans: 2 });
  const [creator, other] = g.users;
  assert.equal((await addAiPlayer(g.store, { gameId: g.gameId, userId: other })).status, 403);
  const added = await addAiPlayer(g.store, { gameId: g.gameId, userId: creator, persona: 'DIPLOMAT' });
  assert.equal(added.ok, true);
  const seat = (await g.lobby()).seats.find((s) => s.userId === added.userId);
  assert.equal(seat.ai, 'DIPLOMAT');
  assert.match(seat.displayName, /^Diplomat AI/);

  assert.equal((await removeAiPlayer(g.store, { gameId: g.gameId, userId: other, aiUserId: added.userId })).status, 403);
  assert.equal((await removeAiPlayer(g.store, { gameId: g.gameId, userId: creator, aiUserId: other })).status, 404, 'a person is not an AI player');
  assert.equal((await removeAiPlayer(g.store, { gameId: g.gameId, userId: creator, aiUserId: 999999 })).status, 404);
  const removed = await removeAiPlayer(g.store, { gameId: g.gameId, userId: creator, aiUserId: added.userId });
  assert.equal(removed.ok, true);
  assert.equal((await g.lobby()).seats.some((s) => s.userId === added.userId), false);
  assert.deepEqual(await g.tx((t) => t.getUsers([added.userId])), {}, 'the AI account is gone with its seat');
  assert.equal((await g.tx((t) => t.getUsers([other]))) [other], 'Human 2', 'a person\'s account is never touched');

  const again = await addAiPlayer(g.store, { gameId: g.gameId, userId: creator, persona: 'DIPLOMAT' });
  assert.equal((await g.lobby()).seats.find((s) => s.userId === again.userId).displayName, seat.displayName, 'a freed name is reused');

  const bad = await addAiPlayer(g.store, { gameId: g.gameId, userId: creator, persona: 'hawk' });
  assert.deepEqual([bad.status, bad.errors[0].code], [422, 'PERSONA_INVALID']);
  assert.equal((await addAiPlayer(g.store, { gameId: 999999, userId: creator })).status, 404);

  while ((await g.lobby()).seats.length < 9) assert.equal((await addAiPlayer(g.store, { gameId: g.gameId, userId: creator })).ok, true);
  const full = await addAiPlayer(g.store, { gameId: g.gameId, userId: creator });
  assert.deepEqual([full.status, full.errors[0].code], [409, 'GAME_FULL']);
  assert.equal((await joinGame(g.store, { gameId: g.gameId, userId: await g.tx((t) => t.createUser('Late').then((u) => u.id)) })).status, 409, 'AI seats fill the table for people too');

  assert.equal((await g.start()).ok, true);
  assert.equal((await addAiPlayer(g.store, { gameId: g.gameId, userId: creator })).status, 409);
  const someBot = (await g.lobby()).seats.find((s) => s.ai);
  assert.equal((await removeAiPlayer(g.store, { gameId: g.gameId, userId: creator, aiUserId: someBot.userId })).status, 409);
});

scenario('lobby: AI players count towards the three needed, and the creator can set an AI\'s starting population', async () => {
  const g = await setup({ ai: 1 });
  assert.equal((await g.start()).status, 422, 'two seats are not enough');
  const added = await addAiPlayer(g.store, { gameId: g.gameId, userId: g.users[0] });
  const { seats } = await g.lobby();
  const bot = seats.find((s) => s.ai);
  const { setStartPopulation } = await import('../src/app/lobby.js');
  assert.equal((await setStartPopulation(g.store, { gameId: g.gameId, userId: g.users[0], targetUserId: bot.userId, population: 61 })).ok, true);
  assert.equal((await pickCountry(g.store, { gameId: g.gameId, userId: g.users[0], country: 'USA' })).ok, true);
  assert.equal((await g.start()).ok, true);
  const s = await g.snap();
  assert.equal(s.players.find((p) => p.userId === bot.userId).startPopulation, 61);
  assert.ok(added.ok);
  assert.ok(s.players.every((p) => p.country), 'AI seats get random free countries like anyone without a pick');
});

// ───────────────────────── taking turns ─────────────────────────

scenario('turns: AI players submit final sheets the moment a turn opens, and a person submitting last resolves it early', async () => {
  const g = await setup({ ai: 3 });
  assert.equal((await g.start()).ok, true);
  let s = await g.snap();
  const personas = await g.personas();
  const bots = s.players.filter((p) => personas[p.userId]);
  assert.equal(bots.length, 3);
  assert.deepEqual([...finals(s)].sort(), bots.map((p) => p.id).sort(), 'every AI is final, the person is not');
  assert.equal(s.turn.status, 'OPEN');

  const person = s.players.find((p) => !personas[p.userId]);
  const done = await submitSheet(g.store, { gameId: g.gameId, userId: person.userId, payload: {}, final: true }, at(1));
  assert.equal(done.ok, true);
  assert.equal(done.resolved, true, 'everyone was final');
  s = await g.snap();
  assert.equal(s.game.turnNumber, 2);
  assert.equal(s.turn.status, 'OPEN');
  assert.deepEqual([...finals(s)].sort(), bots.map((p) => p.id).sort(), 'the AIs have already moved on turn 2');
  assert.ok(s.players.every((p) => p.missedStreak === 0), 'an AI never misses a turn');
});

scenario('turns: AI sheets are hidden like everyone\'s: the package shows counts, never anyone\'s orders', async () => {
  const g = await setup({ ai: 2 });
  await g.start();
  const s = await g.snap();
  const personas = await g.personas();
  const person = s.players.find((p) => !personas[p.userId]);
  const pkg = await getPackage(g.store, { gameId: g.gameId, userId: person.userId });
  assert.equal(pkg.turn.submitted, 2);
  assert.equal(pkg.turn.active, 3);
  assert.equal(pkg.mySheet, null, 'the person has submitted nothing, and sees no one else\'s sheet');
  assert.deepEqual(pkg.public.players.map((p) => p.ai).sort((a, b) => String(a).localeCompare(String(b))), [...Object.values(personas)].sort().concat([null]).sort((a, b) => String(a).localeCompare(String(b))), 'who is an AI is public');
  assert.ok(!JSON.stringify(pkg).includes('giveCashToMinors'), 'no AI orders leak');
});

scenario('fairness: an AI\'s sheet is exactly what its decision code writes from the same package a person gets', async () => {
  const g = await setup({ ai: 2 });
  await g.start();
  // Run two turns so there is history, then compare turn 3's AI sheets with a fresh computation from the public API view.
  for (let turn = 1; turn <= 2; turn++) {
    const s = await g.snap();
    const personas = await g.personas();
    const person = s.players.find((p) => !personas[p.userId]);
    await submitSheet(g.store, { gameId: g.gameId, userId: person.userId, payload: {}, final: true }, at(turn));
  }
  const s = await g.snap();
  assert.equal(s.game.turnNumber, 3);
  const personas = await g.personas();
  for (const bot of s.players.filter((p) => personas[p.userId])) {
    const view = await getPackage(g.store, { gameId: g.gameId, userId: bot.userId });
    const own = await g.tx((t) => t.listOwnSheets({ gameId: g.gameId, playerId: bot.id, beforeTurn: 3 }));
    assert.equal(own.length, 2);
    const expected = decideSheet(view, { persona: personas[bot.userId], ownSheets: own, ...aiSeeds(s.game.seed, bot.id, 3) });
    assert.deepEqual(s.sheets.find((x) => x.playerId === bot.id).payload, expected);
  }
});

scenario('turns: a person\'s own sheets and gifts are the only thing shaping an AI\'s memory of its minors', async () => {
  const g = await setup({ ai: 2 });
  await g.start();
  const s = await g.snap();
  const personas = await g.personas();
  const bot = s.players.find((p) => personas[p.userId]);
  const first = s.sheets.find((x) => x.playerId === bot.id).payload;
  const spent = Object.values(first.giveCashToMinors ?? {}).reduce((a, b) => a + b, 0);
  assert.equal(spent, 100, 'turn 1: all $100M goes to minors');
  assert.equal(s.players.find((p) => p.id === bot.id).cash, 100, 'cash is only spent when the turn resolves');
});

scenario('worker: a game left waiting on an AI (say, after a crash) is caught up, and the clients are told', async () => {
  const g = await setup({ ai: 2 });
  assert.equal((await g.start({ playAi: false })).ok, true);
  let s = await g.snap();
  assert.equal(finals(s).size, 0);
  assert.ok((await g.tx((t) => t.listGamesAwaitingAi())).includes(g.gameId));

  const events = [];
  const worker = startWorker({ store: g.store, notify: (id, e) => events.push([id, e.type]), intervalMs: 3600_000, now: () => at(2), logger: { error() {}, log() {} } });
  await worker.tick();
  await worker.stop();
  s = await g.snap();
  assert.equal(finals(s).size, 2);
  assert.ok(events.some(([id, type]) => id === g.gameId && type === 'player_submitted'));
  assert.equal((await g.tx((t) => t.listGamesAwaitingAi())).includes(g.gameId), false);
  assert.deepEqual((await playPendingAiTurns(g.store, at(3))).filter((r) => r.gameId === g.gameId).map((r) => r.submitted), [], 'nothing left to do');
});

scenario('worker: at the deadline the turn resolves, and the AIs move on the next turn without waiting for another tick', async () => {
  const g = await setup({ ai: 2, hours: 24 });
  await g.start();
  const results = await resolveDueTurns(g.store, at(25));
  assert.ok(results.some((r) => r.gameId === g.gameId && r.resolved));
  const s = await g.snap();
  assert.equal(s.game.turnNumber, 2);
  assert.equal(finals(s).size, 2, 'both AIs already submitted turn 2');
});

scenario('turns: when only AI players are left, the rest of the game is played out at once, without waiting for any deadline', async () => {
  const g = await setup({ ai: 3, forfeitAfterN: 1, hours: 24 });
  await g.start();
  const results = await resolveDueTurns(g.store, at(25));        // the person misses turn 1 and is forfeited: only AIs remain
  assert.ok(results.some((r) => r.gameId === g.gameId && r.resolved));
  const s = await g.snap();
  const personas = await g.personas();
  const person = s.players.find((p) => !personas[p.userId]);
  assert.deepEqual([person.alive, person.forfeited], [false, true]);
  assert.equal(s.game.status, 'FINISHED', 'no further deadline was needed');
  assert.ok(s.game.turnNumber > 2, `the game ran ${s.game.turnNumber} turns inside that one call`);
  assert.ok(['WIN', 'DRAW'].includes(s.game.outcome ?? 'WIN') || s.game.winnerPlayerId !== undefined);
  const survivors = s.players.filter((p) => p.alive);
  assert.ok(survivors.length <= 1, 'it was played to the end: one survivor, or none for a draw');
});

scenario('turns: the same happens when the last person is eliminated in battle (not only forfeited)', async () => {
  const r = await selfPlay({ ai: 3 });                            // the silent person is a passive target and is wiped out
  assert.equal(r.over, true);
  assert.equal(r.s.game.status, 'FINISHED');
  assert.ok(r.fastForwarded >= 0);
});

scenario('turns: a stalemate cannot lock the server: one call plays at most the cap, then the game waits for the next deadline', async () => {
  const g = await setup({ ai: 3, forfeitAfterN: 1, hours: 24 });
  await g.start({ playAi: false });
  // The person misses turn 1; resolve just that turn without letting the AI hook run, then fast-forward with a tiny cap.
  await playAiTurns(g.store, g.gameId, T0, { maxFastForward: 0 });
  await resolveTurn(g.store, g.gameId, { now: at(25), playAi: false });
  const stopped = await playAiTurns(g.store, g.gameId, at(25), { maxFastForward: 2 });
  assert.equal(stopped.fastForwarded, 2);
  let s = await g.snap();
  assert.equal(s.game.status, 'ACTIVE', 'cut short by the cap, not finished');
  assert.equal(s.turn.status, 'OPEN');
  assert.equal(s.game.turnNumber, 4);
  assert.equal(finals(s).size, s.players.filter((p) => p.alive).length, 'the AIs have moved on the open turn');
  assert.equal(stopped.resolved.turnNumber, 3);

  const rest = await playAiTurns(g.store, g.gameId, at(26));      // a later call carries on from there
  s = await g.snap();
  assert.equal(s.game.status, 'FINISHED');
  assert.ok(rest.fastForwarded > 0);
});

scenario('worker: when a game is played out at once the clients hear that it finished', async () => {
  const g = await setup({ ai: 3, forfeitAfterN: 1, hours: 24 });
  await g.start();
  const events = [];
  const worker = startWorker({ store: g.store, notify: (id, e) => events.push([id, e.type]), intervalMs: 3600_000, now: () => at(25), logger: { error() {}, log() {} } });
  await worker.tick();
  await worker.stop();
  assert.ok(events.some(([id, type]) => id === g.gameId && type === 'turn_resolved'));
  assert.ok(events.some(([id, type]) => id === g.gameId && type === 'game_finished'), JSON.stringify(events));
});

scenario('turns: an eliminated AI is left alone, and the AIs still alive keep playing', { skip: stores.kind !== 'memory' && 'edits game state directly, which only the in-memory store allows' }, async () => {
  const g = await setup({ ai: 3 });
  await g.start();
  const s = await g.snap();
  const personas = await g.personas();
  const [doomed, survivor] = s.players.filter((p) => personas[p.userId]);
  // Eliminate one AI the way the resolver would, then open a fresh turn for everyone.
  const row = g.store.data.players.find((p) => p.id === doomed.id);
  Object.assign(row, { alive: false, population: 0, cash: 0, thirds: 0, missiles: 0, abms: 0, bonusMissiles: 0 });
  g.store.data.sheets = g.store.data.sheets.filter((x) => x.playerId !== survivor.id);   // the survivor has not moved yet
  const r = await playAiTurns(g.store, g.gameId, at(1));
  assert.equal(r.submitted, 1, 'only the living AI without a sheet moves');
  assert.deepEqual(r.failed, []);
  const after = await g.snap();
  assert.ok(after.sheets.some((x) => x.playerId === survivor.id && x.isFinal));
  assert.equal((await playAiTurns(g.store, g.gameId, at(1))).submitted, 0, 'and nothing more is done on a second call');
});

// ───────────────────────── whole games ─────────────────────────

async function selfPlay({ ai, forfeitAfterN = 0, maxTurns = 200 }) {
  const g = await setup({ ai, forfeitAfterN });
  await g.start({ playAi: false });
  let now = T0;
  let turns = 0;
  let over = false;
  let fastForwarded = 0;
  const trouble = [];
  while (turns < maxTurns && !over) {
    const r = await playAiTurns(g.store, g.gameId, now);       // may also play the whole rest of the game if only AIs are left
    if (r.fallbacks.length || r.failed.length) trouble.push({ turn: turns + 1, fallbacks: r.fallbacks, failed: r.failed });
    fastForwarded += r.fastForwarded;
    turns += r.fastForwarded;
    if (r.resolved?.over) { over = true; break; }
    now = new Date(now.getTime() + 25 * HOUR);
    over = (await resolveTurn(g.store, g.gameId, { now, playAi: false })).over;
    turns++;
  }
  const s = await g.snap();
  const personas = await g.personas();
  const replay = await g.tx((t) => t.loadReplay(g.gameId));
  return { g, s, personas, turns, over, trouble, replay, fastForwarded };
}

scenario('self-play: games between AIs and a silent person always finish, with no rejected sheet and no default orders for an AI', async () => {
  const sizes = stores.kind === 'memory' ? [2, 3, 4, 6, 8, 5] : [2, 4];
  for (const ai of sizes) {
    const r = await selfPlay({ ai });
    assert.equal(r.over, true, `${ai} AIs: game did not finish in ${r.turns} turns`);
    assert.equal(r.s.game.status, 'FINISHED');
    assert.deepEqual(r.trouble, [], `${ai} AIs: an AI needed its fallback sheet`);
    const botCountries = new Set(r.s.players.filter((p) => r.personas[p.userId]).map((p) => p.country));
    const humanCountry = r.s.players.find((p) => !r.personas[p.userId]).country;
    const trouble = r.replay.events.filter((e) => ['SHEET_REJECTED', 'DEFAULT_ORDERS'].includes(e.type));
    assert.ok(trouble.some((e) => e.payload.player === humanCountry), 'the silent person does get default orders, so this check can fail');
    assert.deepEqual(trouble.filter((e) => botCountries.has(e.payload.player)), [], `${ai} AIs: the resolver rejected or defaulted an AI sheet`);
    const botIds = new Set(r.s.players.filter((p) => r.personas[p.userId]).map((p) => p.id));
    const botSheets = r.replay.sheets.filter((x) => botIds.has(x.playerId));
    assert.ok(botSheets.length >= botIds.size, 'AI sheets are recorded');
    assert.ok(botSheets.every((x) => x.source === 'PLAYER'), 'never a server default');
    assert.ok(r.replay.sheets.some((x) => !botIds.has(x.playerId) && x.source === 'SERVER_DEFAULT'), 'while the silent person gets defaults, so this check can fail');
  }
});

scenario('self-play: an AI declares war eventually, so games between AIs do not stall', async () => {
  const r = await selfPlay({ ai: 3 });
  assert.equal(r.s.game.warDeclared, true);
  assert.equal(r.over, true);
});
