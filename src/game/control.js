// Who controls each minor, who ranks where, and where spies point.

import { CONFIG } from './constants.js';
import { livingPlayers, survivingMinors } from './state.js';

/** Strictly highest index among living players, else null (ties and all-zero included). */
export function controller(minor, state) {
  if (minor.destroyed) return null;
  let best = -1;
  let holders = [];
  for (const p of livingPlayers(state)) {
    const v = minor.index[p.id] ?? 0;
    if (v > best) { best = v; holders = [p.id]; }
    else if (v === best) holders.push(p.id);
  }
  return holders.length === 1 ? holders[0] : null;
}

export const controlledMinors = (state, playerId) =>
  survivingMinors(state).filter((m) => controller(m, state) === playerId);

/** Minors where playerId ranks 1st or 2nd (competition ranking), index > 0 only. */
export function listedMinors(state, playerId) {
  const out = [];
  for (const m of survivingMinors(state)) {
    const mine = m.index[playerId] ?? 0;
    if (mine <= 0) continue;
    const ahead = livingPlayers(state).filter(
      (p) => p.id !== playerId && (m.index[p.id] ?? 0) > mine,
    ).length;
    if (ahead < 2) out.push(m.id);
  }
  return out;
}

// ───────────────────────── Spies ─────────────────────────

export const effectiveSpyTargets = (player, spies) =>
  Array.from({ length: CONFIG.spySlots }, (_, i) => spies?.[i] ?? player.spySlots[i] ?? null);

export function targetExists(state, t) {
  if (!t) return false;
  if (t.kind === 'PLAYER') return !!state.players[t.id]?.alive;
  if (t.kind === 'MINOR') return !!state.minors[t.id] && !state.minors[t.id].destroyed;
  return false;
}
