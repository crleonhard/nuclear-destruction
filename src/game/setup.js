// Creating a game, and adding replacement minors.

import { CONFIG, COUNTRIES, MINOR_NAMES } from './constants.js';
import { mulberry32, randInt } from './rng.js';
import { makeMinor } from './state.js';

/**
 * players: [{ country?: string|null, population?: number|null }] in join order.
 * Draw order from the seeded RNG: country assignment first (join order),
 * then random populations (join order).
 */
export function createInitialState({ seed, forfeitAfterN = 5, players }) {
  if (players.length < CONFIG.minPlayers || players.length > CONFIG.maxPlayers) {
    throw new Error(`${CONFIG.minPlayers}-${CONFIG.maxPlayers} players required`);
  }
  const rng = mulberry32(seed);
  const chosen = players.map((p) => p.country).filter(Boolean);
  if (new Set(chosen).size !== chosen.length) throw new Error('Duplicate country');
  for (const c of chosen) if (!COUNTRIES.includes(c)) throw new Error(`Unknown country ${c}`);

  const free = COUNTRIES.filter((c) => !chosen.includes(c));
  const countries = players.map((p) => p.country ?? free.splice(randInt(rng, free.length), 1)[0]);
  const populations = players.map((p) => {
    if (p.population == null) return 25 + randInt(rng, 75); // 25..99
    if (!Number.isInteger(p.population) || p.population < 25 || p.population > 99) {
      throw new Error('Population must be an integer 25-99');
    }
    return p.population;
  });

  const state = {
    seed,
    forfeitAfterN,
    turnNumber: 1,
    turnType: 'NORMAL',
    warDeclared: false,
    firstBattleDone: false,
    declarers: [],
    replenishCursor: 0,
    over: false,
    outcome: null, // { reason: 'WIN'|'DRAW', winner?: playerId }
    players: {},
    minors: {},
  };
  countries.forEach((country, i) => {
    state.players[country] = {
      id: country,
      country,
      population: populations[i],
      cash: CONFIG.startCash,
      thirds: CONFIG.startThirds,
      missiles: CONFIG.startMissiles,
      abms: CONFIG.startAbms,
      bonusMissiles: 0,
      alive: true,
      forfeited: false,
      missedStreak: 0,
      spySlots: Array(CONFIG.spySlots).fill(null), // {kind:'PLAYER'|'MINOR', id}
    };
  });
  for (const name of MINOR_NAMES) {
    const m = makeMinor(name, 1, countries);
    state.minors[m.id] = m;
  }
  return state;
}

export function replenishMinors(state, events, count = CONFIG.replenishCount) {
  const playerIds = Object.keys(state.players);
  const created = [];
  for (let i = 0; i < count; i++) {
    const base = MINOR_NAMES[state.replenishCursor % MINOR_NAMES.length];
    const generation = Math.floor(state.replenishCursor / MINOR_NAMES.length) + 2;
    const m = makeMinor(base, generation, playerIds);
    state.minors[m.id] = m;
    state.replenishCursor++;
    created.push(m.id);
  }
  events?.push({ type: 'REPLENISH', minors: created, cursor: state.replenishCursor });
  return created;
}
