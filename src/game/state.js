// Small helpers for reading game state: factories, minors, living players.

import { CONFIG } from './constants.js';

export const wholeFactories = (thirds) => Math.floor(thirds / 3);
export const maxAbmFactories = (F) => Math.ceil(F / 2);
export const isNat = (x) => Number.isInteger(x) && x >= 0;

function roman(n) {
  const map = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s;
}

export const minorId = (base, generation) => `${base}#${generation}`;
export const minorDisplayName = (m) =>
  m.generation === 1 ? m.baseName : `${m.baseName} (${roman(m.generation)})`;

export function makeMinor(baseName, generation, playerIds) {
  return {
    id: minorId(baseName, generation),
    baseName,
    generation,
    population: CONFIG.minorPopulation,
    thirds: CONFIG.minorThirds,
    missiles: CONFIG.minorMissiles,
    cash: 0, // server-only bidding cash
    destroyed: false,
    index: Object.fromEntries(playerIds.map((id) => [id, 0])),
  };
}

export const sortedIds = (obj) => Object.keys(obj).sort();
export const livingPlayers = (state) =>
  sortedIds(state.players).map((id) => state.players[id]).filter((p) => p.alive);
export const survivingMinors = (state) =>
  sortedIds(state.minors).map((id) => state.minors[id]).filter((m) => !m.destroyed);
