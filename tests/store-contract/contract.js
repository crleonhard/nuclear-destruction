// The store contract: behaviour every store must have, written against the public store and
// pipeline API only. It runs on the in-memory store in every `npm test`, and on PostgreSQL via
// `npm run test:db`. Any difference between the two shows up as a failure in exactly one of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startGame, submitSheet, resolveTurn, resolveDueTurns, getPackage, getHistory, getReplay,
} from '../../src/app/pipeline.js';
import { createGame, joinGame, pickCountry, leaveGame, getLobby, myGames } from '../../src/app/lobby.js';

const T0 = new Date('2026-11-01T00:00:00Z');
const hours = (h) => new Date(T0.getTime() + h * 3600 * 1000);
const COUNTRIES = ['FRANCE', 'INDIA', 'JAPAN'];
const keyOf = (m) => `${m.baseName}#${m.generation}`;

export function defineStoreContract(label, { makeStore, adapter }) {
  const t = (name, fn) => test(`${label}: ${name}`, async () => fn(await makeStore()));

  // ───────── helpers: public API only ─────────
  const read = (store, fn) => store.withTransaction(fn);
  const snap = (store, gameId) => read(store, (tx) => tx.loadSnapshot(gameId));
  const replay = (store, gameId) => read(store, (tx) => tx.loadReplay(gameId));
  const previous = (store, gameId, playerId, turnNumber) => read(store, (tx) => tx.loadPrevious({ gameId, playerId, turnNumber }));
  const who = (s, country) => s.players.find((p) => p.country === country);

  async function makeGame(store, { countries = COUNTRIES, seed = 12345, forfeitAfterN = 5, population = 50 } = {}) {
    const users = [];
    for (let i = 0; i < countries.length; i++) users.push((await read(store, (tx) => tx.createUser(`Player ${i + 1}`))).id);
    const gameId = await read(store, (tx) => tx.insertGame({ creatorId: users[0], seed, turnDeadlineHours: 24, forfeitAfterN }));
    const playerIds = [];
    for (let i = 0; i < countries.length; i++) {
      playerIds.push(await read(store, async (tx) => {
        const id = await tx.insertPlayer({ gameId, userId: users[i] });
        await tx.updateLobbyPlayer(id, { country: countries[i], startPopulation: population });
        return id;
      }));
    }
    return { gameId, users, playerIds, countries };
  }
  const started = async (store, opts) => {
    const g = await makeGame(store, opts);
    const r = await startGame(store, { gameId: g.gameId, userId: g.users[0] }, T0);
    assert.equal(r.ok, true, JSON.stringify(r));
    return g;
  };
  /** Every living player submits a final sheet; the last one triggers resolution. */
  async function allFinal(store, g, sheetFor = () => ({}), now = hours(1)) {
    let last;
    for (let i = 0; i < g.countries.length; i++) {
      last = await submitSheet(store, { gameId: g.gameId, userId: g.users[i], payload: sheetFor(g.countries[i]), final: true }, now);
      assert.equal(last.ok, true, JSON.stringify(last));
    }
    return last;
  }

  // ───────── starting a game ─────────

  t('start builds the whole world and opens turn 1', async (store) => {
    const g = await makeGame(store);
    assert.equal((await startGame(store, { gameId: g.gameId, userId: g.users[0] }, T0)).ok, true);
    const s = await snap(store, g.gameId);
    assert.equal(s.game.status, 'ACTIVE');
    assert.equal(s.game.turnNumber, 1);
    assert.equal(s.players.length, 3);
    for (const p of s.players) {
      assert.deepEqual([p.population, p.cash, p.thirds, p.missiles, p.abms, p.bonusMissiles, p.alive], [50, 100, 27, 20, 10, 0, true]);
    }
    assert.equal(s.minors.length, 18);
    assert.deepEqual(s.minors.slice(0, 3).map((m) => [m.baseName, m.generation, m.population, m.thirds, m.missiles, m.cash]),
      [['AUSTRALIA', 1, 20, 3, 5, 0], ['BELGIUM', 1, 20, 3, 5, 0], ['CUBA', 1, 20, 3, 5, 0]]);
    assert.equal(s.minorIndex.length, 18 * 3);
    assert.ok(s.minorIndex.every((r) => r.value === 0));
    assert.equal(s.spySlots.length, 9);
    assert.ok(s.spySlots.every((x) => x.kind === null && x.targetId === null));
    assert.deepEqual([s.turn.number, s.turn.type, s.turn.status], [1, 'NORMAL', 'OPEN']);
    assert.equal(s.turn.deadlineAt.getTime(), hours(24).getTime());
    const r = await replay(store, g.gameId);
    assert.deepEqual(r.events.map((e) => e.type), ['GAME_STARTED']);
  });

  t('start refuses strangers, small games and double starts', async (store) => {
    const g = await makeGame(store);
    assert.equal((await startGame(store, { gameId: g.gameId, userId: g.users[1] }, T0)).status, 403);
    const small = await makeGame(store, { countries: ['FRANCE', 'INDIA'] });
    assert.equal((await startGame(store, { gameId: small.gameId, userId: small.users[0] }, T0)).status, 422);
    assert.equal((await startGame(store, { gameId: g.gameId, userId: g.users[0] }, T0)).ok, true);
    assert.equal((await startGame(store, { gameId: g.gameId, userId: g.users[0] }, T0)).status, 409);
  });

  t('unpicked countries and populations are drawn from the seed: distinct, in range, repeatable', async (store) => {
    const run = async () => {
      const users = [];
      for (let i = 0; i < 4; i++) users.push((await read(store, (tx) => tx.createUser(`R${i}`))).id);
      const gameId = await read(store, (tx) => tx.insertGame({ creatorId: users[0], seed: 777, turnDeadlineHours: 24, forfeitAfterN: 5 }));
      for (const u of users) await read(store, (tx) => tx.insertPlayer({ gameId, userId: u }));
      assert.equal((await startGame(store, { gameId, userId: users[0] }, T0)).ok, true);
      const s = await snap(store, gameId);
      return [...s.players].sort((a, b) => a.id - b.id).map((p) => [p.country, p.startPopulation]);
    };
    const a = await run();
    const b = await run();
    assert.deepEqual(a, b);
    assert.equal(new Set(a.map((x) => x[0])).size, 4);
    for (const [, pop] of a) assert.ok(pop >= 25 && pop <= 99);
  });

  // ───────── submitting ─────────

  t('an invalid sheet is rejected and nothing is saved; strangers and late sheets are refused', async (store) => {
    const g = await started(store);
    const bad = await submitSheet(store, { gameId: g.gameId, userId: g.users[0], payload: { build: { missiles: 99 } } }, hours(1));
    assert.deepEqual([bad.ok, bad.status, bad.errors[0].code], [false, 422, 'BUILD_OVER_CAPACITY']);
    assert.equal((await snap(store, g.gameId)).sheets.length, 0);
    const stranger = await read(store, (tx) => tx.createUser('Stranger'));
    assert.equal((await submitSheet(store, { gameId: g.gameId, userId: stranger.id, payload: {} }, hours(1))).status, 403);
    assert.equal((await submitSheet(store, { gameId: g.gameId, userId: g.users[0], payload: {} }, hours(24))).status, 409);
  });

  t('drafts are replaced in place and bump a version; the turn waits for everyone to be final', async (store) => {
    const g = await started(store);
    await submitSheet(store, { gameId: g.gameId, userId: g.users[0], payload: { worldNews: { text: 'one' } } }, hours(1));
    const r = await submitSheet(store, { gameId: g.gameId, userId: g.users[0], payload: { worldNews: { text: 'two' } }, final: true }, hours(2));
    assert.equal(r.finalCount, 1);
    const s = await snap(store, g.gameId);
    assert.equal(s.sheets.length, 1);
    assert.equal(s.sheets[0].version, 2);
    assert.equal(s.sheets[0].isFinal, true);
    assert.equal(s.sheets[0].payload.worldNews.text, 'two');
    assert.equal(s.turn.status, 'OPEN');
  });

  // ───────── resolving ─────────

  t('early resolution closes the turn, opens the next with income, and logs events in order', async (store) => {
    const g = await started(store);
    const last = await allFinal(store, g);
    assert.equal(last.resolved, true);
    const s = await snap(store, g.gameId);
    assert.equal(s.game.turnNumber, 2);
    assert.deepEqual([s.turn.number, s.turn.status], [2, 'OPEN']);
    assert.equal(s.turn.deadlineAt.getTime(), hours(25).getTime());
    const f = who(s, 'FRANCE');
    assert.deepEqual([f.cash, f.missiles], [105, 29]);              // income applied; empty sheet builds missiles
    const r = await replay(store, g.gameId);
    assert.deepEqual(r.turns.map((x) => x.number), [1, 2]);
    assert.deepEqual(r.events.map((e) => e.seq), r.events.map((_, i) => i)); // contiguous from 0
    const assets = await Promise.all(g.playerIds.map((id) => previous(store, g.gameId, id, 1)));
    assert.ok(assets.every((p) => p.reports.some((x) => x.kind === 'ASSETS')));
  });

  t('resolving the same turn twice changes nothing', async (store) => {
    const g = await started(store);
    await allFinal(store, g);
    const before = JSON.stringify(await snap(store, g.gameId));
    assert.deepEqual(await resolveTurn(store, g.gameId, { now: hours(2), expectTurnNumber: 1 }), { resolved: false, reason: 'STALE' });
    assert.equal(JSON.stringify(await snap(store, g.gameId)), before);
  });

  t('the deadline worker applies defaults, counts misses, and treats a saved draft as submitted', async (store) => {
    const g = await started(store);
    await submitSheet(store, { gameId: g.gameId, userId: g.users[0], payload: {} }, hours(1)); // FRANCE: draft only
    const mine = (results) => results.filter((r) => r.gameId === g.gameId);
    assert.deepEqual(mine(await resolveDueTurns(store, hours(23))), []);
    const res = mine(await resolveDueTurns(store, hours(24)));
    assert.equal(res.length, 1);
    assert.equal(res[0].resolved, true);
    const s = await snap(store, g.gameId);
    assert.deepEqual([who(s, 'FRANCE').missedStreak, who(s, 'INDIA').missedStreak, who(s, 'JAPAN').missedStreak], [0, 1, 1]);
    assert.equal(who(s, 'INDIA').missiles, 29);
    const r = await replay(store, g.gameId);
    assert.equal(r.sheets.filter((x) => x.source === 'SERVER_DEFAULT').length, 2);
    assert.deepEqual(mine(await resolveDueTurns(store, hours(24))).filter((x) => x.turnNumber === 1), []); // already done
  });

  t('forfeits can end a game: winner recorded, no next turn, replay and history available', async (store) => {
    const g = await started(store, { forfeitAfterN: 1, seed: 4242 });
    await submitSheet(store, { gameId: g.gameId, userId: g.users[0], payload: {} }, hours(1));
    await resolveDueTurns(store, hours(24));
    const s = await snap(store, g.gameId);
    assert.deepEqual([s.game.status, s.game.outcome, s.game.winnerPlayerId], ['FINISHED', 'WIN', g.playerIds[0]]);
    assert.equal(s.game.turnNumber, 1);
    assert.deepEqual([who(s, 'INDIA').alive, who(s, 'INDIA').forfeited], [false, true]);
    assert.equal(who(s, 'INDIA').cash, 0);
    assert.equal((await replay(store, g.gameId)).turns.length, 1);
    assert.equal((await submitSheet(store, { gameId: g.gameId, userId: g.users[0], payload: {} }, hours(25))).status, 409);

    const rp = await getReplay(store, { gameId: g.gameId, userId: g.users[1] });
    assert.deepEqual([rp.ok, rp.seed, rp.winner, rp.outcome], [true, 4242, 'FRANCE', 'WIN']);
    assert.ok(rp.events.some((e) => e.type === 'FORFEITED'));
    assert.equal(rp.sheets.filter((x) => x.source === 'SERVER_DEFAULT').length, 2);
    assert.equal((await getHistory(store, { gameId: g.gameId, userId: g.users[1] })).turns.length, 1);
  });

  t('replay stays locked until the game ends', async (store) => {
    const g = await started(store);
    const r = await getReplay(store, { gameId: g.gameId, userId: g.users[0] });
    assert.deepEqual([r.ok, r.status, r.errors[0].code], [false, 403, 'GAME_NOT_FINISHED']);
  });

  t('war: bonus, notices, self-hit penalty, income resumes, battle result stored', async (store) => {
    const g = await started(store);
    await allFinal(store, g);                                                                       // turn 1
    await allFinal(store, g, (c) => (c === 'FRANCE' ? { declareWar: true } : {}), hours(2));         // turn 2
    let s = await snap(store, g.gameId);
    assert.equal(s.turn.type, 'BATTLE');
    assert.deepEqual([who(s, 'FRANCE').bonusMissiles, who(s, 'FRANCE').isDeclarer, s.game.warDeclared], [5, true, true]);
    const notices = await previous(store, g.gameId, g.playerIds[1], 2);
    assert.deepEqual(notices.reports.map((r) => r.kind).sort(), ['ASSETS', 'FIRE_CONTROL', 'FIRST_SECOND', 'WAR_NOTICE']);
    const cashDuringBattle = who(s, 'INDIA').cash;
    await allFinal(store, g, () => ({}), hours(3));                                                 // turn 3: nobody fires
    s = await snap(store, g.gameId);
    assert.equal(s.turn.type, 'NORMAL');
    assert.equal(who(s, 'FRANCE').abms, 9);                                                          // self-hit intercepted
    assert.equal(who(s, 'FRANCE').bonusMissiles, 0);
    assert.equal(who(s, 'INDIA').cash, cashDuringBattle + 5);
    const r = await replay(store, g.gameId);
    assert.ok(r.events.some((e) => e.type === 'SELF_HIT_PENALTY'));
    const hist = await getHistory(store, { gameId: g.gameId, userId: g.users[1] });
    assert.equal(hist.turns[2].type, 'BATTLE');
    assert.ok(hist.turns[2].battleResult.fired.length >= 1);
  });

  t('the factory auction pays one price, moves factories and cash, and spends minor cash', async (store) => {
    const g = await started(store);
    await adapter.setMinorCash(store, g.gameId, 'CUBA', 80);
    await adapter.setMinorCash(store, g.gameId, 'TOGO', 50);
    await adapter.setMinorCash(store, g.gameId, 'RWANDA', 30);
    await allFinal(store, g, () => ({ offerFactory: true }));
    const s = await snap(store, g.gameId);
    const m = (base) => s.minors.find((x) => x.baseName === base && x.generation === 1);
    assert.deepEqual([m('CUBA').thirds, m('CUBA').cash], [3 + 6, 0]);   // 3 offered at $40: CUBA buys 2, TOGO 1
    assert.deepEqual([m('TOGO').thirds, m('TOGO').cash], [3 + 3, 10]);
    assert.deepEqual([m('RWANDA').thirds, m('RWANDA').cash], [3, 30]);
    for (const p of s.players) assert.deepEqual([p.cash, p.thirds], [100 + 40 + 5, 24]);
  });

  t('destroying every minor creates replacements with a generation suffix and zero indices', async (store) => {
    const g = await started(store);
    await adapter.setMinorPopulations(store, g.gameId, 1);
    await adapter.setPlayerMissiles(store, g.gameId, 'FRANCE', 40);
    await allFinal(store, g);
    await allFinal(store, g, (c) => (c === 'FRANCE' ? { declareWar: true } : {}), hours(2));
    const before = await snap(store, g.gameId);
    const fire = Object.fromEntries(before.minors.map((m) => [keyOf(m), 1]));
    await allFinal(store, g, (c) => (c === 'FRANCE' ? { fire: { HOME: fire } } : {}), hours(3));
    const s = await snap(store, g.gameId);
    const alive = s.minors.filter((m) => !m.destroyed);
    assert.deepEqual(alive.map(keyOf), ['AUSTRALIA#2', 'BELGIUM#2', 'CUBA#2', 'DENMARK#2', 'ESTONIA#2']);
    assert.equal(s.game.replenishCursor, 5);
    const rows = s.minorIndex.filter((r) => alive.some((m) => m.id === r.minorId));
    assert.equal(rows.length, 15);
    assert.ok(rows.every((r) => r.value === 0));
  });

  t('the same seed and the same sheets give identical results in two different games', async (store) => {
    const play = async () => {
      const g = await started(store, { seed: 2024 });
      await adapter.setMinorCash(store, g.gameId, 'CUBA', 100);
      await adapter.setMinorCash(store, g.gameId, 'TOGO', 50);
      await allFinal(store, g, (c) => (c === 'JAPAN' ? {} : { offerFactory: true, giveCashToMinors: { 'CUBA#1': 3 } }));
      const s = await snap(store, g.gameId);
      const r = await replay(store, g.gameId);
      return JSON.stringify({
        players: s.players.map((p) => [p.country, p.cash, p.thirds, p.missiles, p.abms]),
        minors: s.minors.map((m) => [keyOf(m), m.population, m.thirds, m.missiles, m.cash]),
        events: r.events.filter((e) => ['AUCTION', 'RNG_DRAW', 'BUILD'].includes(e.type)).map((e) => [e.type, e.payload]),
      });
    };
    assert.equal(await play(), await play());
  });

  // ───────── atomicity ─────────

  t('a failure after writes rolls everything back; a retry then succeeds', async (store) => {
    const g = await started(store);
    for (let i = 0; i < 2; i++) await submitSheet(store, { gameId: g.gameId, userId: g.users[i], payload: {}, final: true }, hours(1));
    // A store whose resolution writes succeed and then blow up, so only a rollback can save us.
    const failing = {
      withTransaction: (fn) => store.withTransaction((tx) => fn(new Proxy(tx, {
        get(target, key) {
          if (key === 'saveResolution') return async (plan) => { await target.saveResolution(plan); throw new Error('simulated failure after writes'); };
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }))),
    };
    await assert.rejects(submitSheet(failing, { gameId: g.gameId, userId: g.users[2], payload: {}, final: true }, hours(1)), /simulated failure/);
    const s = await snap(store, g.gameId);
    assert.deepEqual([s.turn.number, s.turn.status, who(s, 'FRANCE').cash, who(s, 'FRANCE').missiles], [1, 'OPEN', 100, 20]);
    assert.equal(s.sheets.length, 3);                                  // the sheet itself had committed earlier
    const r = await replay(store, g.gameId);
    assert.deepEqual([r.turns.length, r.events.length], [1, 1]);       // only GAME_STARTED survived
    assert.equal((await resolveTurn(store, g.gameId, { now: hours(2), expectTurnNumber: 1 })).resolved, true);
    assert.equal(who(await snap(store, g.gameId), 'FRANCE').cash, 105);
  });

  // ───────── what players may see ─────────

  t('packages hide other players: anonymous senders, spies that repeat, counts instead of names', async (store) => {
    const g = await started(store);
    await allFinal(store, g, (c) => (c === 'FRANCE'
      ? {
        messages: { INDIA: { text: 'secret', anonymous: true }, JAPAN: { text: 'hello' } },
        spies: [{ kind: 'MINOR', id: 'CUBA#1' }, null, null],
        giveCashToMinors: { 'CUBA#1': 6 },
        worldNews: { text: 'peace', anonymous: true },
      }
      : {}));
    const india = await getPackage(store, { gameId: g.gameId, userId: g.users[1] });
    assert.deepEqual(india.messages, [{ from: null, text: 'secret' }]);
    assert.deepEqual(india.news, [{ from: null, text: 'peace' }]);
    const japan = await getPackage(store, { gameId: g.gameId, userId: g.users[2] });
    assert.deepEqual(japan.messages, [{ from: 'FRANCE', text: 'hello' }]);
    for (const p of india.public.players) assert.deepEqual(Object.keys(p).sort(), ['ai', 'alive', 'country', 'forfeited', 'population']);
    assert.equal(typeof india.turn.submitted, 'number');
    assert.equal(india.assets.cash, 105);

    const france = await getPackage(store, { gameId: g.gameId, userId: g.users[0] });
    assert.equal(france.reports.find((r) => r.kind === 'SPY_MINOR').payload.indices.FRANCE, 6);
    await allFinal(store, g, () => ({}), hours(2));                      // no spy orders: the slot repeats
    const france2 = await getPackage(store, { gameId: g.gameId, userId: g.users[0] });
    assert.ok(france2.reports.some((r) => r.kind === 'SPY_MINOR' && r.payload.minor === 'CUBA#1'));
    const s = await snap(store, g.gameId);
    const slot = s.spySlots.find((x) => x.playerId === g.playerIds[0] && x.slot === 0);
    assert.equal(slot.kind, 'MINOR');
    assert.equal(s.minors.find((m) => m.id === slot.targetId).baseName, 'CUBA');
  });

  // ───────── the lobby ─────────

  t('lobby operations: create, join, pick, leave, list, and the database refuses duplicate countries', async (store) => {
    const newUser = async (name) => (await read(store, (tx) => tx.createUser(name))).id;
    const [ua, ub, uc] = [await newUser('A'), await newUser('B'), await newUser('C')];
    const created = await createGame(store, { userId: ua, settings: { turnDeadlineHours: 12, forfeitAfterN: 2 } });
    assert.equal(created.ok, true);
    const gameId = created.gameId;
    assert.equal((await joinGame(store, { gameId, userId: ub })).ok, true);
    assert.equal((await joinGame(store, { gameId, userId: ub })).status, 409);
    assert.equal((await pickCountry(store, { gameId, userId: ua, country: 'FRANCE' })).ok, true);
    assert.equal((await pickCountry(store, { gameId, userId: ub, country: 'FRANCE' })).status, 409);
    assert.equal((await pickCountry(store, { gameId, userId: uc, country: 'USA' })).status, 403);

    // Even if the application check were bypassed, the store itself refuses a duplicate country.
    const bRow = (await snap(store, gameId)).players.find((p) => p.userId === ub);
    await assert.rejects(read(store, (tx) => tx.updateLobbyPlayer(bRow.id, { country: 'FRANCE' })));

    const lobby = await getLobby(store, { gameId });
    assert.deepEqual(lobby.seats.map((x) => [x.displayName, x.country]), [['A', 'FRANCE'], ['B', null]]);
    assert.deepEqual([lobby.game.settings.turnDeadlineHours, lobby.game.settings.forfeitAfterN], [12, 2]);
    assert.ok(!JSON.stringify(lobby).includes('seed'));
    assert.equal((await leaveGame(store, { gameId, userId: ua })).status, 409);   // the creator cannot leave
    assert.equal((await leaveGame(store, { gameId, userId: ub })).ok, true);
    assert.deepEqual((await myGames(store, { userId: ub })).games, []);
    assert.deepEqual((await myGames(store, { userId: ua })).games.map((x) => [x.id, x.status]), [[gameId, 'LOBBY']]);
    assert.deepEqual(await read(store, (tx) => tx.getUsers([ua, ub])), { [ua]: 'A', [ub]: 'B' });
  });

  // ───────── email sign-in links ─────────
  const emailOf = (tag) => `${tag}.${process.pid}.${Date.now().toString(36)}@example.org`; // a shared database must not see repeats
  const hashOf = (tag) => `${tag}-${process.pid}-${Date.now().toString(36)}-${'0'.repeat(20)}`;

  t('login links: a link is consumed exactly once, and only while it is live', async (store) => {
    const email = emailOf('once');
    const h = hashOf('once');
    const T = new Date('2026-11-05T12:00:00Z');
    await read(store, (tx) => tx.insertLoginLink({ tokenHash: h, email, createdAt: T, expiresAt: new Date(T.getTime() + 900_000) }));
    assert.equal(await read(store, (tx) => tx.consumeLoginLink(hashOf('never-issued'), T)), null);
    assert.deepEqual(await read(store, (tx) => tx.consumeLoginLink(h, new Date(T.getTime() + 1000))), { email });
    assert.equal(await read(store, (tx) => tx.consumeLoginLink(h, new Date(T.getTime() + 2000))), null, 'second use');

    const late = hashOf('late');
    await read(store, (tx) => tx.insertLoginLink({ tokenHash: late, email, createdAt: T, expiresAt: new Date(T.getTime() + 900_000) }));
    assert.equal(await read(store, (tx) => tx.consumeLoginLink(late, new Date(T.getTime() + 900_000))), null, 'expired at the expiry moment');
  });

  t('login links: a rolled-back consume leaves the link usable', async (store) => {
    const email = emailOf('rollback');
    const h = hashOf('rollback');
    const T = new Date('2026-11-05T12:00:00Z');
    await read(store, (tx) => tx.insertLoginLink({ tokenHash: h, email, createdAt: T, expiresAt: new Date(T.getTime() + 900_000) }));
    await assert.rejects(read(store, async (tx) => { await tx.consumeLoginLink(h, T); throw new Error('abort'); }), /abort/);
    assert.deepEqual(await read(store, (tx) => tx.consumeLoginLink(h, T)), { email });
  });

  t('login links: counting recent requests per address, and sweeping old ones', async (store) => {
    const email = emailOf('count');
    const other = emailOf('other');
    const T = new Date('2026-11-05T12:00:00Z');
    const at = (min) => new Date(T.getTime() + min * 60_000);
    for (const [i, min] of [0, 10, 50].entries()) {
      await read(store, (tx) => tx.insertLoginLink({ tokenHash: hashOf(`c${i}`), email, createdAt: at(min), expiresAt: at(min + 15) }));
    }
    await read(store, (tx) => tx.insertLoginLink({ tokenHash: hashOf('o'), email: other, createdAt: at(5), expiresAt: at(20) }));
    assert.equal(await read(store, (tx) => tx.countLoginLinksSince(email, at(-1))), 3);
    assert.equal(await read(store, (tx) => tx.countLoginLinksSince(email, at(5))), 2);
    assert.equal(await read(store, (tx) => tx.countLoginLinksSince(emailOf('nobody'), at(-1))), 0);
    const swept = await read(store, (tx) => tx.deleteLoginLinksExpiredBefore(at(26)));
    assert.ok(swept >= 3, 'links expired before the cutoff are removed');
    assert.equal(await read(store, (tx) => tx.countLoginLinksSince(email, at(-1))), 1);
  });

  t('users by email: found or created once, and the same address always gives the same user', async (store) => {
    const email = emailOf('user');
    assert.equal(await read(store, (tx) => tx.findUserByEmail(email)), null);
    const first = await read(store, (tx) => tx.findOrCreateUserByEmail(email, 'Ada'));
    assert.equal(first.created, true);
    assert.equal(first.user.displayName, 'Ada');
    const again = await read(store, (tx) => tx.findOrCreateUserByEmail(email, 'A Different Name'));
    assert.deepEqual(again, { user: first.user, created: false });
    assert.deepEqual(await read(store, (tx) => tx.findUserByEmail(email)), first.user);
    assert.deepEqual(await read(store, (tx) => tx.getUsers([first.user.id])), { [first.user.id]: 'Ada' });
    const plain = await read(store, (tx) => tx.createUser('No Email'));   // old-style accounts still work
    assert.notEqual(plain.id, first.user.id);
  });

  // ───────── AI players ─────────

  t('ai accounts: personas are reported for AI users only, and only AI accounts can be deleted', async (store) => {
    const person = await read(store, (tx) => tx.createUser('A Person'));
    const bot = await read(store, (tx) => tx.createUser('Hawk AI', { aiPersona: 'HAWK' }));
    const bot2 = await read(store, (tx) => tx.createUser('Diplomat AI', { aiPersona: 'DIPLOMAT' }));
    assert.deepEqual(await read(store, (tx) => tx.getAiPersonas([person.id, bot.id, bot2.id, 999999])), { [bot.id]: 'HAWK', [bot2.id]: 'DIPLOMAT' });
    assert.deepEqual(await read(store, (tx) => tx.getAiPersonas([])), {});
    assert.deepEqual(await read(store, (tx) => tx.getAiPersonas([person.id])), {});
    assert.equal(await read(store, (tx) => tx.deleteAiUser(person.id)), 0, 'a person is never deleted');
    assert.deepEqual(await read(store, (tx) => tx.getUsers([person.id])), { [person.id]: 'A Person' });
    assert.equal(await read(store, (tx) => tx.deleteAiUser(bot.id)), 1);
    assert.deepEqual(await read(store, (tx) => tx.getUsers([bot.id, bot2.id])), { [bot2.id]: 'Diplomat AI' });
    assert.equal(await read(store, (tx) => tx.deleteAiUser(bot.id)), 0, 'already gone');
  });

  t('own sheets: a player\'s earlier sheets come back oldest first, never anyone else\'s, never the current turn\'s', async (store) => {
    const g = await started(store, { countries: COUNTRIES });
    const sheet1 = { giveCashToMinors: { 'CUBA#1': 7 } };
    const sheet2 = { giveCashToMinors: { 'CUBA#1': 3 }, giveMissilesToMinors: { 'CUBA#1': 1 } };
    await allFinal(store, g, (c) => (c === 'FRANCE' ? sheet1 : { build: { missiles: 9 } }), hours(1));
    await allFinal(store, g, (c) => (c === 'FRANCE' ? sheet2 : {}), hours(2));
    const france = who(await snap(store, g.gameId), 'FRANCE').id;
    const india = who(await snap(store, g.gameId), 'INDIA').id;
    const own = (playerId, beforeTurn) => read(store, (tx) => tx.listOwnSheets({ gameId: g.gameId, playerId, beforeTurn }));
    assert.deepEqual(await own(france, 3), [{ turnNumber: 1, payload: sheet1 }, { turnNumber: 2, payload: sheet2 }]);
    assert.deepEqual(await own(france, 2), [{ turnNumber: 1, payload: sheet1 }]);
    assert.deepEqual(await own(france, 1), []);
    assert.deepEqual((await own(india, 3)).map((x) => x.turnNumber), [1, 2]);
    assert.deepEqual((await own(india, 3))[0].payload, { build: { missiles: 9 } });
  });

  t('games awaiting an AI: listed while a living AI has no sheet for the open turn, not after', async (store) => {
    const person = await read(store, (tx) => tx.createUser('Person'));
    const bots = [await read(store, (tx) => tx.createUser('Hawk AI', { aiPersona: 'HAWK' })), await read(store, (tx) => tx.createUser('Diplomat AI', { aiPersona: 'DIPLOMAT' }))];
    const users = [person, ...bots];
    const gameId = await read(store, (tx) => tx.insertGame({ creatorId: person.id, seed: 777, turnDeadlineHours: 24, forfeitAfterN: 5 }));
    for (let i = 0; i < 3; i++) {
      await read(store, async (tx) => { const id = await tx.insertPlayer({ gameId, userId: users[i].id }); await tx.updateLobbyPlayer(id, { country: COUNTRIES[i], startPopulation: 50 }); });
    }
    const awaiting = async () => (await read(store, (tx) => tx.listGamesAwaitingAi())).includes(gameId);
    assert.equal(await awaiting(), false, 'a lobby is not waiting on anyone');
    assert.equal((await startGame(store, { gameId, userId: person.id }, T0, { playAi: false })).ok, true);
    assert.equal(await awaiting(), true);
    assert.equal((await submitSheet(store, { gameId, userId: bots[0].id, payload: {}, final: true }, hours(1))).ok, true);
    assert.equal(await awaiting(), true, 'one AI is still missing');
    assert.equal((await submitSheet(store, { gameId, userId: bots[1].id, payload: {}, final: false }, hours(1))).ok, true);
    assert.equal(await awaiting(), false, 'a saved draft counts: the AI has a sheet');
    // The person finishing resolves the turn (the bots are final or drafted); next turn the AIs are missing again.
    assert.equal((await resolveTurn(store, gameId, { now: hours(2), playAi: false })).resolved, true);
    assert.equal(await awaiting(), true);
  });

  t('AI players move by themselves: starting a game and resolving a turn both leave every living AI with a final sheet', async (store) => {
    const person = await read(store, (tx) => tx.createUser('Person'));
    const made = await createGame(store, { userId: person.id, settings: { aiPlayers: 2 } });
    assert.equal((await startGame(store, { gameId: made.gameId, userId: person.id }, T0)).ok, true);
    const finalsOf = async () => { const s = await snap(store, made.gameId); return [s.game.turnNumber, s.sheets.filter((x) => x.isFinal).length]; };
    assert.deepEqual(await finalsOf(), [1, 2]);
    assert.equal((await submitSheet(store, { gameId: made.gameId, userId: person.id, payload: {}, final: true }, hours(1))).resolved, true);
    assert.deepEqual(await finalsOf(), [2, 2]);
  });

  // ───────── limits and cancelling ─────────

  t('open games: only unfinished games a person created are counted', async (store) => {
    const a = await read(store, (tx) => tx.createUser('Creator A'));
    const b = await read(store, (tx) => tx.createUser('Creator B'));
    const count = (id) => read(store, (tx) => tx.countOpenGamesCreatedBy(id));
    assert.equal(await count(a.id), 0);
    const g1 = await read(store, (tx) => tx.insertGame({ creatorId: a.id, seed: 1, turnDeadlineHours: 24, forfeitAfterN: 5 }));
    await read(store, (tx) => tx.insertGame({ creatorId: a.id, seed: 2, turnDeadlineHours: 24, forfeitAfterN: 5 }));
    await read(store, (tx) => tx.insertGame({ creatorId: b.id, seed: 3, turnDeadlineHours: 24, forfeitAfterN: 5 }));
    assert.equal(await count(a.id), 2, 'lobbies count');
    assert.equal(await count(b.id), 1, 'and only the creator\'s own');
    await read(store, (tx) => tx.deleteLobbyGame(g1));
    assert.equal(await count(a.id), 1);
  });

  t('open games: a game that has started still counts (finished games are covered in tests/game-limit.test.js)', async (store) => {
    const g = await started(store, { countries: COUNTRIES });
    const creator = (await snap(store, g.gameId)).game.creatorId;
    assert.equal((await snap(store, g.gameId)).game.status, 'ACTIVE');
    assert.equal(await read(store, (tx) => tx.countOpenGamesCreatedBy(creator)), 1);
  });

  t('cancelling a lobby: the game and its seats go, a started game stays, an unknown game is a no-op', async (store) => {
    const person = await read(store, (tx) => tx.createUser('Host'));
    const made = await createGame(store, { userId: person.id, settings: { aiPlayers: 2 } });
    assert.equal((await snap(store, made.gameId)).players.length, 3);
    assert.equal(await read(store, (tx) => tx.deleteLobbyGame(made.gameId)), 1);
    const after = await snap(store, made.gameId);
    assert.equal(after.game, null);
    assert.deepEqual(after.players, []);
    assert.equal(await read(store, (tx) => tx.deleteLobbyGame(made.gameId)), 0, 'already gone');
    assert.equal(await read(store, (tx) => tx.deleteLobbyGame(999999)), 0);

    const running = await started(store, { countries: COUNTRIES });
    assert.equal(await read(store, (tx) => tx.deleteLobbyGame(running.gameId)), 0, 'a started game is never deleted');
    assert.equal((await snap(store, running.gameId)).game.status, 'ACTIVE');
  });
}
