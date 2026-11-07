// Turn pipeline: the only code that combines the database store with the pure resolver.
//
// Store contract (see ../store/memory.js and ../store/postgres.js). All calls happen inside store.withTransaction:
//   tx.lockGame(gameId)                      -> game row, locked FOR UPDATE
//   tx.loadSnapshot(gameId)                  -> { game, players, minors, minorIndex, spySlots, turn, sheets }
//   tx.loadPrevious({gameId, playerId, turnNumber}) -> { reports, messages, news, battleResult }
//   tx.saveSheet({turnId, gameId, playerId, payload, isFinal})
//   tx.saveStart(plan)  tx.saveResolution(plan)
//   tx.listDueTurns(now)                     -> [{ gameId, number }]
//
// Rules this file guarantees:
//  * One transaction per start or resolution; any failure rolls everything back.
//  * Resolution is idempotent: a turn that is not OPEN is a no-op.
//  * The database always holds the state AT THE START of the open turn (income, free thirds
//    and war bonuses have already been applied).

import {
  createInitialState, resolveTurn as resolveWithRng, beginNormalTurn, beginBattleTurn,
  validateNormalSheet, validateBattleSheet, defaultNormalSheet, assetsReport,
  controlledMinors, minorDisplayName, mulberry32, seedForTurn, livingPlayers, CONFIG,
  wholeFactories, maxAbmFactories, survivingMinors,
} from '../game/index.js';
import { fail } from './errors.js';
import { snapshotToState, stateToWrites, minorKey, toEventRow } from './mapping.js';

const addHours = (d, h) => new Date(d.getTime() + h * 3600 * 1000);

// ───────────────────────── Start a game ─────────────────────────

export async function startGame(store, { gameId, userId }, now = new Date()) {
  return store.withTransaction(async (tx) => {
    const game = await tx.lockGame(gameId);
    if (!game) return fail(404, 'NOT_FOUND', 'No such game');
    if (game.creatorId !== userId) return fail(403, 'FORBIDDEN', 'Only the creator can start the game');
    if (game.status !== 'LOBBY') return fail(409, 'ALREADY_STARTED', 'Game has already started');

    const snap = await tx.loadSnapshot(gameId);
    const seats = [...snap.players].sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id);
    if (seats.length < CONFIG.minPlayers || seats.length > CONFIG.maxPlayers) {
      return fail(422, 'PLAYER_COUNT', `Need ${CONFIG.minPlayers}-${CONFIG.maxPlayers} players, have ${seats.length}`);
    }

    // Unpicked countries and populations are drawn from the game seed, in join order.
    const state = createInitialState({
      seed: game.seed,
      forfeitAfterN: game.forfeitAfterN,
      players: seats.map((s) => ({ country: s.country, population: s.startPopulation })),
    });
    const countries = Object.keys(state.players);
    const playerRows = seats.map((s, i) => {
      const p = state.players[countries[i]];
      return {
        id: s.id, country: p.country, startPopulation: p.population, population: p.population,
        cash: p.cash, thirds: p.thirds, missiles: p.missiles, abms: p.abms,
      };
    });
    const idByCountry = new Map(playerRows.map((r) => [r.country, r.id]));

    const plan = {
      gameId,
      gamePatch: { status: 'ACTIVE', turnNumber: 1, startedAt: now },
      players: playerRows,
      minors: Object.values(state.minors).map((m) => ({
        baseName: m.baseName, generation: m.generation, population: m.population, thirds: m.thirds,
        missiles: m.missiles, cash: 0, destroyed: false,
        index: Object.fromEntries(playerRows.map((r) => [r.id, 0])),
      })),
      spySlots: playerRows.flatMap((r) => [0, 1, 2].map((slot) => ({ playerId: r.id, slot, kind: null, targetId: null }))),
      turn: {
        number: 1, type: 'NORMAL', opensAt: now, deadlineAt: addHours(now, game.turnDeadlineHours),
        rngSeed: seedForTurn(game.seed, 1), stateBefore: state,
      },
      // No opening reports: assets are always computed live from state, and turn 1's starting
      // state is stored in turns.state_before. Report rows belong to the turn that produced them.
      reports: [],
      events: [{ type: 'GAME_STARTED', payload: { players: playerRows.map((r) => ({ playerId: r.id, country: r.country })) } }],
    };
    await tx.saveStart(plan);
    return { ok: true, turnNumber: 1 };
  });
}

// ───────────────────────── Submit a sheet ─────────────────────────

export async function submitSheet(store, { gameId, userId, payload, final = false }, now = new Date()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail(422, 'NOT_INTEGER', 'Sheet must be a JSON object');
  }
  const saved = await store.withTransaction(async (tx) => {
    const game = await tx.lockGame(gameId);
    if (!game) return fail(404, 'NOT_FOUND', 'No such game');
    if (game.status !== 'ACTIVE') return fail(409, 'TURN_CLOSED', 'Game is not active');
    const snap = await tx.loadSnapshot(gameId);
    const me = snap.players.find((p) => p.userId === userId);
    if (!me) return fail(403, 'FORBIDDEN', 'You are not in this game');
    if (!me.alive) return fail(409, 'TARGET_INVALID', 'You have been eliminated');
    if (snap.turn.status !== 'OPEN' || now >= snap.turn.deadlineAt) return fail(409, 'TURN_CLOSED', 'Turn is closed');

    const { state } = snapshotToState(snap);
    const errors = state.turnType === 'BATTLE'
      ? validateBattleSheet(state, me.country, payload)
      : validateNormalSheet(state, me.country, payload);
    if (errors.length) return { ok: false, status: 422, errors };

    await tx.saveSheet({ turnId: snap.turn.id, gameId, playerId: me.id, payload, isFinal: final });

    const finals = new Set(snap.sheets.filter((s) => s.isFinal).map((s) => s.playerId));
    if (final) finals.add(me.id); else finals.delete(me.id);
    const living = snap.players.filter((p) => p.alive);
    return {
      ok: true,
      turnNumber: snap.turn.number,
      finalCount: finals.size,
      activeCount: living.length,
      allFinal: living.every((p) => finals.has(p.id)),
    };
  });

  // Early resolution runs in its own transaction after the sheet commits. It is idempotent,
  // so a racing deadline worker cannot resolve the turn twice.
  if (saved.ok && saved.allFinal) {
    const r = await resolveTurn(store, gameId, { now, expectTurnNumber: saved.turnNumber });
    return { ...saved, resolved: r.resolved, over: r.over ?? false, outcome: r.outcome ?? null };
  }
  return saved;
}

// ───────────────────────── Resolve a turn ─────────────────────────

/**
 * Resolves the currently open turn in ONE transaction. Safe to call repeatedly:
 * returns { resolved: false, reason } when there is nothing to do.
 */
export async function resolveTurn(store, gameId, { now = new Date(), expectTurnNumber = null } = {}) {
  return store.withTransaction(async (tx) => {
    const game = await tx.lockGame(gameId);
    if (!game || game.status !== 'ACTIVE') return { resolved: false, reason: 'NOT_ACTIVE' };
    const snap = await tx.loadSnapshot(gameId);
    if (!snap.turn || snap.turn.status !== 'OPEN') return { resolved: false, reason: 'TURN_NOT_OPEN' };
    if (expectTurnNumber != null && snap.turn.number !== expectTurnNumber) {
      return { resolved: false, reason: 'STALE' };
    }

    const { state, maps } = snapshotToState(snap);
    const closing = snap.turn.number;

    // Saved sheets (draft or final) count as submitted at the deadline. Missing ones are
    // recorded as server defaults; the resolver also counts them as missed turns.
    const sheets = {};
    const have = new Set();
    for (const sh of snap.sheets) {
      sheets[maps.countryById.get(sh.playerId)] = sh.payload;
      have.add(sh.playerId);
    }
    const defaults = snap.players
      .filter((p) => p.alive && !have.has(p.id))
      .map((p) => ({
        playerId: p.id,
        payload: state.turnType === 'BATTLE' ? {} : defaultNormalSheet(state, p.country),
        source: 'SERVER_DEFAULT',
      }));

    const res = resolveWithRng(state, sheets, mulberry32(snap.turn.rngSeed));
    let next = res.state;
    const events = res.events.map(toEventRow);

    // Open the next turn: apply start-of-turn rules so the database holds start-of-turn state.
    const extraReports = [];
    if (!next.over) {
      if (next.turnType === 'NORMAL') {
        const opened = beginNormalTurn(next);
        next = opened.state;
        events.push(...opened.events.map((e) => ({ ...toEventRow(e), payload: { ...toEventRow(e).payload, turn: closing + 1 } })));
      } else {
        next = beginBattleTurn(next);
      }
      for (const p of livingPlayers(next)) {
        const playerId = maps.playerIdByCountry.get(p.country);
        extraReports.push({ playerId, kind: 'ASSETS', payload: assetsReport(next, p.country) });
        if (next.turnType === 'BATTLE') {
          extraReports.push({
            playerId, kind: 'WAR_NOTICE',
            payload: { declarers: next.declarers, first: !next.firstBattleDone },
          });
          extraReports.push({
            playerId, kind: 'FIRE_CONTROL',
            payload: {
              minors: controlledMinors(next, p.country).map((m) => ({ id: m.id, name: minorDisplayName(m), missiles: m.missiles })),
            },
          });
        }
      }
    }

    const writes = stateToWrites(snap, maps, next);
    const over = next.over;
    const gamePatch = {
      warDeclared: next.warDeclared,
      firstBattleDone: next.firstBattleDone,
      replenishCursor: next.replenishCursor,
      turnNumber: over ? closing : closing + 1,
    };
    if (over) {
      Object.assign(gamePatch, {
        status: 'FINISHED',
        outcome: next.outcome.reason,
        winnerPlayerId: next.outcome.winner ? maps.playerIdByCountry.get(next.outcome.winner) : null,
        endedAt: now,
      });
    }

    const plan = {
      gameId,
      turnId: snap.turn.id,
      closeTurn: { resolvedAt: now, stateAfter: res.state },
      defaultSheets: defaults,
      gamePatch,
      ...writes,
      events,
      messages: res.messages.map((m) => ({
        fromPlayerId: maps.playerIdByCountry.get(m.sender), // always recorded; the API hides it when anonymous
        toPlayerId: maps.playerIdByCountry.get(m.to),
        text: m.text,
        anonymous: m.anonymous,
      })),
      news: res.news.map((n) => ({
        fromPlayerId: maps.playerIdByCountry.get(n.sender),
        text: n.text,
        anonymous: n.anonymous,
      })),
      reports: [
        ...res.reports.map((r) => ({ playerId: maps.playerIdByCountry.get(r.to), kind: r.kind, payload: r.payload })),
        ...extraReports,
      ],
      battleResult: res.battleResult ?? null,
      nextTurn: over ? null : {
        number: closing + 1,
        type: next.turnType,
        opensAt: now,
        deadlineAt: addHours(now, game.turnDeadlineHours),
        rngSeed: seedForTurn(game.seed, closing + 1),
        stateBefore: next,
      },
    };
    await tx.saveResolution(plan);
    return { resolved: true, turnNumber: closing, over, outcome: next.outcome };
  });
}

// ───────────────────────── Deadline worker ─────────────────────────

/** Resolve every open turn whose deadline has passed. One transaction per game; failures are isolated. */
export async function resolveDueTurns(store, now = new Date()) {
  const due = await store.withTransaction((tx) => tx.listDueTurns(now));
  const results = [];
  for (const d of due) {
    try {
      results.push({ gameId: d.gameId, ...(await resolveTurn(store, d.gameId, { now, expectTurnNumber: d.number })) });
    } catch (error) {
      results.push({ gameId: d.gameId, resolved: false, reason: 'ERROR', error: String(error?.message ?? error) });
    }
  }
  return results;
}

// ───────────────────────── Player package ─────────────────────────

/** Everything a player is allowed to see at the start of the current turn. */
export async function getPackage(store, { gameId, userId }) {
  return store.withTransaction(async (tx) => {
    const snap = await tx.loadSnapshot(gameId);
    if (!snap.game) return fail(404, 'NOT_FOUND', 'No such game');
    const me = snap.players.find((p) => p.userId === userId);
    if (!me) return fail(403, 'FORBIDDEN', 'You are not in this game');
    const countryById = new Map(snap.players.map((p) => [p.id, p.country]));

    const pub = {
      players: snap.players.map((p) => ({ country: p.country, population: p.population, alive: p.alive, forfeited: p.forfeited })),
      minors: snap.minors.map((m) => ({
        id: minorKey(m),
        name: minorDisplayName(m),
        population: m.population,
        destroyed: m.destroyed,
      })),
    };
    if (!snap.turn) return { ok: true, game: { status: snap.game.status }, public: pub };

    const { state } = snapshotToState(snap);
    const prev = snap.turn.number > 1
      ? await tx.loadPrevious({ gameId, playerId: me.id, turnNumber: snap.turn.number - 1 })
      : { reports: [], messages: [], news: [], battleResult: null };

    return {
      ok: true,
      game: { status: snap.game.status, outcome: snap.game.outcome },
      turn: {
        number: snap.turn.number,
        type: snap.turn.type,
        status: snap.turn.status,
        deadlineAt: snap.turn.deadlineAt,
        submitted: snap.sheets.filter((s) => s.isFinal).length, // a count only, never names
        active: snap.players.filter((p) => p.alive).length,
      },
      assets: me.alive ? assetsReport(state, me.country) : null,
      controlled: snap.turn.type === 'BATTLE' && me.alive
        ? controlledMinors(state, me.country).map((m) => ({ id: m.id, name: minorDisplayName(m), missiles: m.missiles }))
        : [],
      reports: prev.reports.filter((r) => r.kind === 'SPY_PLAYER' || r.kind === 'SPY_MINOR' || r.kind === 'FIRST_SECOND'),
      messages: prev.messages.map((m) => ({
        from: m.anonymous ? null : countryById.get(m.fromPlayerId) ?? null,
        text: m.text,
      })),
      news: prev.news.map((n) => ({ from: n.anonymous ? null : countryById.get(n.fromPlayerId) ?? null, text: n.text })),
      battleResult: prev.battleResult,
      mySheet: snap.sheets.find((s) => s.playerId === me.id)?.payload ?? null,
      public: pub,
    };
  });
}

// ───────────────────────── Sheet helpers (read-only) ─────────────────────────

async function openTurnContext(tx, gameId, userId) {
  const snap = await tx.loadSnapshot(gameId);
  if (!snap.game) return { error: fail(404, 'NOT_FOUND', 'No such game') };
  const me = snap.players.find((p) => p.userId === userId);
  if (!me) return { error: fail(403, 'FORBIDDEN', 'You are not in this game') };
  if (snap.game.status !== 'ACTIVE' || !snap.turn) return { error: fail(409, 'TURN_CLOSED', 'Game is not active') };
  const { state } = snapshotToState(snap);
  return { snap, me, state };
}

function derivedLimits(state, me, payload = {}) {
  const p = state.players[me.country];
  const F = wholeFactories(p.thirds);
  if (state.turnType === 'BATTLE') {
    return {
      type: 'BATTLE',
      homeStock: p.missiles + p.bonusMissiles,
      controlled: controlledMinors(state, me.country).map((m) => ({ id: m.id, name: minorDisplayName(m), missiles: m.missiles })),
    };
  }
  const abms = payload.build?.abms ?? 0;
  const factories = payload.build?.factories ?? 0;
  const builtMissiles = Math.max(0, F - abms - factories);
  return {
    type: 'NORMAL',
    wholeFactories: F,
    abmFactoryCap: maxAbmFactories(F),
    builtMissiles,
    missilePool: p.missiles + builtMissiles,
    cashAvailable: p.cash,
    survivingMinors: survivingMinors(state).length,
    maxFactoriesPerPlayer: 2,
  };
}

/** The caller's saved sheet (or null), what blank spy slots will repeat, and live limits. */
export async function getSheetView(store, { gameId, userId }) {
  return store.withTransaction(async (tx) => {
    const ctx = await openTurnContext(tx, gameId, userId);
    if (ctx.error) return ctx.error;
    const { snap, me, state } = ctx;
    const saved = snap.sheets.find((s) => s.playerId === me.id);
    return {
      ok: true,
      turn: { number: snap.turn.number, type: snap.turn.type, deadlineAt: snap.turn.deadlineAt, status: snap.turn.status },
      sheet: saved?.payload ?? null,
      isFinal: saved?.isFinal ?? false,
      spyDefaults: state.players[me.country].spySlots,
      limits: derivedLimits(state, me, saved?.payload ?? {}),
    };
  });
}

/** Validate without saving. Always 200: `valid` and `errors` describe the sheet. */
export async function dryRunSheet(store, { gameId, userId, payload }) {
  return store.withTransaction(async (tx) => {
    const ctx = await openTurnContext(tx, gameId, userId);
    if (ctx.error) return ctx.error;
    const { me, state } = ctx;
    const errors = state.turnType === 'BATTLE'
      ? validateBattleSheet(state, me.country, payload)
      : validateNormalSheet(state, me.country, payload);
    return { ok: true, valid: errors.length === 0, errors, derived: derivedLimits(state, me, payload) };
  });
}

// ───────────────────────── History and replay ─────────────────────────

/** Public results of past turns: battle reports and world news. Members only. */
export async function getHistory(store, { gameId, userId }) {
  return store.withTransaction(async (tx) => {
    const snap = await tx.loadSnapshot(gameId);
    if (!snap.game) return fail(404, 'NOT_FOUND', 'No such game');
    const me = snap.players.find((p) => p.userId === userId);
    if (!me) return fail(403, 'FORBIDDEN', 'You are not in this game');
    const countryById = new Map(snap.players.map((p) => [p.id, p.country]));
    const turns = await tx.loadHistory(gameId);
    return {
      ok: true,
      turns: turns.map((t) => ({
        number: t.number,
        type: t.type,
        battleResult: t.battleResult,
        news: t.news.map((n) => ({ from: n.anonymous ? null : countryById.get(n.fromPlayerId) ?? null, text: n.text })),
      })),
    };
  });
}

/** Everything (every sheet, the full event log, the seed), but only once the game is finished. */
export async function getReplay(store, { gameId, userId }) {
  return store.withTransaction(async (tx) => {
    const snap = await tx.loadSnapshot(gameId);
    if (!snap.game) return fail(404, 'NOT_FOUND', 'No such game');
    if (!snap.players.some((p) => p.userId === userId)) return fail(403, 'FORBIDDEN', 'You are not in this game');
    if (snap.game.status !== 'FINISHED') return fail(403, 'GAME_NOT_FINISHED', 'The replay is released when the game ends');
    const countryById = new Map(snap.players.map((p) => [p.id, p.country]));
    const r = await tx.loadReplay(gameId);
    return {
      ok: true,
      seed: snap.game.seed,
      outcome: snap.game.outcome,
      winner: snap.game.winnerPlayerId ? countryById.get(snap.game.winnerPlayerId) : null,
      turns: r.turns,
      events: r.events,
      sheets: r.sheets.map((s) => ({ turn: s.turnNumber, player: countryById.get(s.playerId), source: s.source, payload: s.payload })),
    };
  });
}
