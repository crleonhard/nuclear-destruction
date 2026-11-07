// What happens when a turn opens: free thirds, income, war bonus, asset list.

import { CONFIG } from './constants.js';
import { livingPlayers, wholeFactories } from './state.js';

/** Call when a NORMAL turn opens (not for turn 1). Free third, then $5M income. */
export function beginNormalTurn(state0) {
  const state = structuredClone(state0);
  const events = [];
  for (const p of livingPlayers(state)) {
    if (p.thirds < 3) {
      p.thirds += 1;
      events.push({ type: 'FREE_THIRD', player: p.id });
    }
    p.cash += CONFIG.income;
  }
  return { state, events };
}

/** Call when a BATTLE turn opens. Grants the war bonus on the first battle turn. */
export function beginBattleTurn(state0) {
  const state = structuredClone(state0);
  if (!state.firstBattleDone) {
    for (const id of state.declarers) {
      const p = state.players[id];
      if (p?.alive) p.bonusMissiles = CONFIG.warBonusMissiles;
    }
  }
  return state;
}

/** The start-of-turn asset list. Missiles include any war bonus. */
export function assetsReport(state, playerId) {
  const p = state.players[playerId];
  return {
    country: p.country,
    population: p.population,
    cash: p.cash,
    thirds: p.thirds,
    factories: wholeFactories(p.thirds),
    missiles: p.missiles + p.bonusMissiles,
    abms: p.abms,
  };
}
