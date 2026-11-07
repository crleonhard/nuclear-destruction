// Taking the turns of AI players. This file is the only place that connects the AI's decisions (src/ai) to a game.
//
// An AI player is an ordinary seat. Each turn the server builds the same package a person would see for that seat,
// asks the AI what to put on its sheet, checks the sheet with the same validator as for a person, and submits it
// as final. If the AI ever produced an invalid sheet it falls back to the plain default sheet, so an AI never
// misses a turn and never causes a rejection.
//
// When it runs: right after a game starts and right after each turn resolves (see pipeline.js), and again from the
// deadline worker for any game still waiting on an AI, so a crash between a resolution and the AI's move heals itself.

import { decideSheet } from '../ai/decide.js';
import {
  validateNormalSheet, validateBattleSheet, defaultNormalSheet, seedForTurn,
} from '../game/index.js';
import { snapshotToState } from './mapping.js';
import { packageFor, submitSheet, resolveTurn } from './pipeline.js';

/** The two seeds an AI player's decisions use: one fixed for the whole game, one that changes every turn. */
export function aiSeeds(gameSeed, playerId, turnNumber) {
  return {
    stableSeed: (gameSeed ^ Math.imul(playerId, 0x9e3779b1)) >>> 0,
    turnSeed: seedForTurn((gameSeed ^ Math.imul(playerId, 0x85ebca6b)) >>> 0, turnNumber),
  };
}

/** The most turns one call will play out by itself when only AI players remain (a safety net against a game that never ends). */
export const MAX_FAST_FORWARD_TURNS = 1000;

/**
 * Submits a final sheet for every living AI player that has not submitted this turn.
 *
 * If that leaves only AI players alive, nobody is left to wait for, so the rest of the game is played out right
 * here, one turn after another, without waiting for any deadline, until the game ends. This is a flat loop, not a
 * chain of nested calls. If it hits `maxFastForward` turns the game is left open at the next turn, and the deadline
 * worker carries on from there.
 *
 * Returns { submitted, fallbacks, failed, last, resolved, fastForwarded }; never throws for game-level reasons.
 * `resolved` describes the latest turn resolved by this call; `fastForwarded` counts turns resolved by the loop.
 */
export async function playAiTurns(store, gameId, now = new Date(), { maxFastForward = MAX_FAST_FORWARD_TURNS } = {}) {
  const total = { submitted: 0, fallbacks: [], failed: [], last: null, resolved: null, fastForwarded: 0 };
  for (;;) {
    const round = await playRound(store, gameId, now);
    total.submitted += round.submitted;
    total.fallbacks.push(...round.fallbacks);
    total.failed.push(...round.failed);
    total.last = round.last ?? total.last;
    total.resolved = round.resolved ?? total.resolved;

    if (total.fastForwarded >= maxFastForward || round.failed.length || !(await onlyAiLeft(store, gameId))) return total;
    const next = await resolveTurn(store, gameId, { now, playAi: false });
    if (!next.resolved) return total;
    total.fastForwarded += 1;
    total.resolved = { turnNumber: next.turnNumber, over: next.over, outcome: next.outcome };
    if (next.over) return total;
  }
}

/** True when the game is running, its turn is open, every living player is an AI, and each of them has submitted. */
async function onlyAiLeft(store, gameId) {
  return store.withTransaction(async (tx) => {
    const snap = await tx.loadSnapshot(gameId);
    if (!snap.game || snap.game.status !== 'ACTIVE' || !snap.turn || snap.turn.status !== 'OPEN') return false;
    const personas = await tx.getAiPersonas(snap.players.map((p) => p.userId));
    const living = snap.players.filter((p) => p.alive);
    const final = new Set(snap.sheets.filter((x) => x.isFinal).map((x) => x.playerId));
    return living.length > 0 && living.every((p) => personas[p.userId] && final.has(p.id));
  });
}

/** One pass: every living AI that has not moved this turn moves now. */
async function playRound(store, gameId, now) {
  const todo = await store.withTransaction(async (tx) => {
    const snap = await tx.loadSnapshot(gameId);
    if (!snap.game || snap.game.status !== 'ACTIVE' || !snap.turn || snap.turn.status !== 'OPEN') return [];
    const personas = await tx.getAiPersonas(snap.players.map((p) => p.userId));
    const have = new Set(snap.sheets.map((s) => s.playerId));
    const { state } = snapshotToState(snap);
    const out = [];
    for (const me of snap.players) {
      if (!me.alive || !personas[me.userId] || have.has(me.id)) continue;
      const view = await packageFor(tx, snap, me);
      const ownSheets = await tx.listOwnSheets({ gameId, playerId: me.id, beforeTurn: snap.turn.number });
      const sheet = decideSheet(view, { persona: personas[me.userId], ownSheets, ...aiSeeds(snap.game.seed, me.id, snap.turn.number) });
      const check = (s) => (state.turnType === 'BATTLE' ? validateBattleSheet(state, me.country, s) : validateNormalSheet(state, me.country, s));
      const errors = check(sheet);
      out.push(errors.length
        ? { userId: me.userId, country: me.country, sheet: state.turnType === 'BATTLE' ? {} : defaultNormalSheet(state, me.country), fallbackBecause: errors }
        : { userId: me.userId, country: me.country, sheet });
    }
    return out;
  });

  const result = { submitted: 0, fallbacks: [], failed: [], last: null, resolved: null };
  for (const a of todo) {
    const r = await submitSheet(store, { gameId, userId: a.userId, payload: a.sheet, final: true }, now);
    if (!r.ok) { result.failed.push({ userId: a.userId, status: r.status, errors: r.errors }); continue; }
    result.submitted += 1;
    result.last = r;
    if (a.fallbackBecause) result.fallbacks.push({ userId: a.userId, country: a.country, errors: a.fallbackBecause });
    if (r.resolved) result.resolved = { turnNumber: r.turnNumber, over: r.over, outcome: r.outcome };
  }
  return result;
}

/** Plays every game that is waiting on an AI. Used by the deadline worker as a safety net. */
export async function playPendingAiTurns(store, now = new Date()) {
  const ids = await store.withTransaction((tx) => tx.listGamesAwaitingAi());
  const results = [];
  for (const gameId of ids) {
    try { results.push({ gameId, ...(await playAiTurns(store, gameId, now)) }); }
    catch (error) { results.push({ gameId, error: String(error?.message ?? error), submitted: 0, fallbacks: [], failed: [] }); }
  }
  return results;
}
