// Picks the right resolver for the current turn type.

import { mulberry32, seedForTurn } from './rng.js';
import { resolveNormalTurn } from './normal-turn.js';
import { resolveBattleTurn } from './battle-turn.js';

export function resolveTurn(state, sheets, rng = mulberry32(seedForTurn(state.seed, state.turnNumber))) {
  return state.turnType === 'BATTLE'
    ? resolveBattleTurn(state, sheets, rng)
    : resolveNormalTurn(state, sheets, rng);
}
