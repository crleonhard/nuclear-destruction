// Lobby rules. Everything here happens before a game starts; once started, seats are locked.

import crypto from 'node:crypto';
import { COUNTRIES, CONFIG } from '../game/index.js';
import { fail } from './errors.js';
import { AI_PERSONAS, PERSONAS, isPersona } from '../ai/personas.js';

const isInt = Number.isInteger;

export async function createGame(store, { userId, settings = {} }) {
  const turnDeadlineHours = settings.turnDeadlineHours ?? 24;
  const forfeitAfterN = settings.forfeitAfterN ?? 5;
  const aiPlayers = settings.aiPlayers ?? 0;
  const errors = [];
  if (!isInt(turnDeadlineHours) || turnDeadlineHours < 1 || turnDeadlineHours > 168) {
    errors.push({ code: 'NOT_INTEGER', field: 'turnDeadlineHours', message: 'Whole number of hours, 1-168' });
  }
  if (!isInt(forfeitAfterN) || forfeitAfterN < 0 || forfeitAfterN > 30) {
    errors.push({ code: 'NOT_INTEGER', field: 'forfeitAfterN', message: 'Whole number 0-30 (0 = never forfeit)' });
  }
  if (!isInt(aiPlayers) || aiPlayers < 0 || aiPlayers > CONFIG.maxPlayers - 1) {
    errors.push({ code: 'NOT_INTEGER', field: 'aiPlayers', message: `Whole number 0-${CONFIG.maxPlayers - 1} (you take one of the ${CONFIG.maxPlayers} seats)` });
  }
  if (errors.length) return { ok: false, status: 422, errors };

  // The seed drives country assignment and auction tie-breaks, so it is secret until the game ends.
  const seed = crypto.randomInt(0, 2 ** 32);
  return store.withTransaction(async (tx) => {
    const gameId = await tx.insertGame({ creatorId: userId, seed, turnDeadlineHours, forfeitAfterN });
    await tx.insertPlayer({ gameId, userId });
    for (let i = 0; i < aiPlayers; i++) await addAiSeat(tx, gameId, null);
    return { ok: true, gameId };
  });
}

// ───────────────────────── AI players ─────────────────────────
// An AI player is an ordinary seat held by a server-controlled account with a persona. See src/app/ai.js.

/** Creates an AI account and seats it. persona = a key of PERSONAS, or null for a random one. Caller holds the game lock. */
async function addAiSeat(tx, gameId, persona) {
  const chosen = persona ?? AI_PERSONAS[crypto.randomInt(0, AI_PERSONAS.length)];
  const { players } = await tx.loadSnapshot(gameId);
  const taken = new Set(Object.values(await tx.getUsers(players.map((p) => p.userId))));
  const base = `${PERSONAS[chosen].label} AI`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  const user = await tx.createUser(name, { aiPersona: chosen });
  await tx.insertPlayer({ gameId, userId: user.id });
  return user;
}

/** Creator only. persona = a key of PERSONAS, or null/undefined for a random one. */
export async function addAiPlayer(store, { gameId, userId, persona = null }) {
  if (persona != null && !isPersona(persona)) {
    return { ok: false, status: 422, errors: [{ code: 'PERSONA_INVALID', field: 'persona', message: `Choose one of ${AI_PERSONAS.join(', ')}, or leave it out for a random one` }] };
  }
  return store.withTransaction(async (tx) => {
    const game = await tx.lockGame(gameId);
    if (!game) return fail(404, 'NOT_FOUND', 'No such game');
    if (game.creatorId !== userId) return fail(403, 'FORBIDDEN', 'Only the creator can add AI players');
    if (game.status !== 'LOBBY') return fail(409, 'ALREADY_STARTED', 'AI players can only be added before the game starts');
    const { players } = await tx.loadSnapshot(gameId);
    if (players.length >= CONFIG.maxPlayers) return fail(409, 'GAME_FULL', `A game holds at most ${CONFIG.maxPlayers} players`);
    const user = await addAiSeat(tx, gameId, persona);
    return { ok: true, userId: user.id };
  });
}

/** Creator only. Frees the seat and deletes the AI account. */
export async function removeAiPlayer(store, { gameId, userId, aiUserId }) {
  return store.withTransaction(async (tx) => {
    const game = await tx.lockGame(gameId);
    if (!game) return fail(404, 'NOT_FOUND', 'No such game');
    if (game.creatorId !== userId) return fail(403, 'FORBIDDEN', 'Only the creator can remove AI players');
    if (game.status !== 'LOBBY') return fail(409, 'ALREADY_STARTED', 'AI players can only be removed before the game starts');
    const { players } = await tx.loadSnapshot(gameId);
    const seat = players.find((p) => p.userId === aiUserId);
    const personas = seat ? await tx.getAiPersonas([aiUserId]) : {};
    if (!seat || !personas[aiUserId]) return fail(404, 'NOT_FOUND', 'No AI player with that id in this game');
    await tx.deletePlayer(seat.id);
    await tx.deleteAiUser(aiUserId);
    return { ok: true };
  });
}

export async function joinGame(store, { gameId, userId }) {
  return store.withTransaction(async (tx) => {
    const game = await tx.lockGame(gameId);
    if (!game) return fail(404, 'NOT_FOUND', 'No such game');
    if (game.status !== 'LOBBY') return fail(409, 'ALREADY_STARTED', 'This game has already started');
    const { players } = await tx.loadSnapshot(gameId);
    if (players.some((p) => p.userId === userId)) return fail(409, 'ALREADY_JOINED', 'You are already in this game');
    if (players.length >= CONFIG.maxPlayers) return fail(409, 'GAME_FULL', `A game holds at most ${CONFIG.maxPlayers} players`);
    await tx.insertPlayer({ gameId, userId });
    return { ok: true };
  });
}

/** country = a free country name, or null to release your pick (you will be assigned one at random). */
export async function pickCountry(store, { gameId, userId, country }) {
  if (country !== null && !COUNTRIES.includes(country)) {
    return { ok: false, status: 422, errors: [{ code: 'TARGET_INVALID', field: 'country', message: `Choose one of ${COUNTRIES.join(', ')}` }] };
  }
  return store.withTransaction(async (tx) => {
    const game = await tx.lockGame(gameId);
    if (!game) return fail(404, 'NOT_FOUND', 'No such game');
    if (game.status !== 'LOBBY') return fail(409, 'ALREADY_STARTED', 'Seats are locked once the game starts');
    const { players } = await tx.loadSnapshot(gameId);
    const me = players.find((p) => p.userId === userId);
    if (!me) return fail(403, 'FORBIDDEN', 'You are not in this game');
    if (country && players.some((p) => p.country === country && p.id !== me.id)) {
      return fail(409, 'COUNTRY_TAKEN', `${country} was just taken`);
    }
    await tx.updateLobbyPlayer(me.id, { country });
    return { ok: true, country };
  });
}

export async function leaveGame(store, { gameId, userId }) {
  return store.withTransaction(async (tx) => {
    const game = await tx.lockGame(gameId);
    if (!game) return fail(404, 'NOT_FOUND', 'No such game');
    if (game.status !== 'LOBBY') return fail(409, 'ALREADY_STARTED', 'You cannot leave a game in progress');
    if (game.creatorId === userId) return fail(409, 'CREATOR_CANNOT_LEAVE', 'The creator cannot leave the lobby');
    const { players } = await tx.loadSnapshot(gameId);
    const me = players.find((p) => p.userId === userId);
    if (!me) return fail(403, 'FORBIDDEN', 'You are not in this game');
    await tx.deletePlayer(me.id);
    return { ok: true };
  });
}

/** Creator only. population = 25-99, or null for "random at start". */
export async function setStartPopulation(store, { gameId, userId, targetUserId, population }) {
  if (population !== null && (!isInt(population) || population < 25 || population > 99)) {
    return { ok: false, status: 422, errors: [{ code: 'NOT_INTEGER', field: 'population', message: 'Whole number 25-99, or null for random' }] };
  }
  return store.withTransaction(async (tx) => {
    const game = await tx.lockGame(gameId);
    if (!game) return fail(404, 'NOT_FOUND', 'No such game');
    if (game.creatorId !== userId) return fail(403, 'FORBIDDEN', 'Only the creator can set populations');
    if (game.status !== 'LOBBY') return fail(409, 'ALREADY_STARTED', 'Populations are locked once the game starts');
    const { players } = await tx.loadSnapshot(gameId);
    const target = players.find((p) => p.userId === targetUserId);
    if (!target) return fail(404, 'NOT_FOUND', 'That user is not in this game');
    await tx.updateLobbyPlayer(target.id, { startPopulation: population });
    return { ok: true };
  });
}

/** Public lobby view. The seed is never included. */
export async function getLobby(store, { gameId }) {
  return store.withTransaction(async (tx) => {
    const snap = await tx.loadSnapshot(gameId);
    if (!snap.game) return fail(404, 'NOT_FOUND', 'No such game');
    const names = await tx.getUsers(snap.players.map((p) => p.userId));
    const ai = await tx.getAiPersonas(snap.players.map((p) => p.userId));
    const g = snap.game;
    const seats = [...snap.players]
      .sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id)
      .map((p) => ({ userId: p.userId, displayName: names[p.userId] ?? null, country: p.country, startPopulation: p.startPopulation, ai: ai[p.userId] ?? null }));
    return {
      ok: true,
      game: {
        id: g.id, status: g.status, creatorId: g.creatorId, turnNumber: g.turnNumber,
        settings: { turnDeadlineHours: g.turnDeadlineHours, forfeitAfterN: g.forfeitAfterN },
        limits: { minPlayers: CONFIG.minPlayers, maxPlayers: CONFIG.maxPlayers },
      },
      seats,
      countries: COUNTRIES.map((c) => ({ country: c, takenBy: seats.find((s) => s.country === c)?.displayName ?? null })),
    };
  });
}

export async function myGames(store, { userId }) {
  return store.withTransaction(async (tx) => {
    const games = await tx.listGamesForUser(userId);
    return {
      ok: true,
      games: games.map((g) => ({ id: g.id, status: g.status, turnNumber: g.turnNumber, creatorId: g.creatorId, outcome: g.outcome })),
    };
  });
}
