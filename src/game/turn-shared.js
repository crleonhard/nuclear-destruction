// Pieces shared by normal and battle turns: elimination, forfeits, outcome, messages.

import { livingPlayers, sortedIds } from './state.js';

export function eliminate(state, p, events, reason) {
  p.alive = false;
  if (reason === 'FORFEIT') p.forfeited = true;
  p.cash = 0; p.thirds = 0; p.missiles = 0; p.abms = 0; p.bonusMissiles = 0;
  events.push({ type: reason === 'FORFEIT' ? 'FORFEITED' : 'ELIMINATED', player: p.id });
}

export function checkForfeits(state, events) {
  if (state.forfeitAfterN <= 0) return;
  for (const p of livingPlayers(state)) {
    if (p.missedStreak >= state.forfeitAfterN) eliminate(state, p, events, 'FORFEIT');
  }
}

export function checkOutcome(state) {
  const living = livingPlayers(state);
  if (living.length === 1) return { reason: 'WIN', winner: living[0].id };
  if (living.length === 0) return { reason: 'DRAW' };
  return null;
}

export function collectComms(state, used, messages, news) {
  for (const id of sortedIds(used)) {
    const s = used[id];
    for (const to of sortedIds(s.messages ?? {})) {
      const m = s.messages[to];
      if (!m?.text || !state.players[to]?.alive) continue;
      messages.push({ to, from: m.anonymous ? null : id, sender: id, anonymous: !!m.anonymous, text: m.text });
    }
    if (s.worldNews?.text) {
      news.push({ from: s.worldNews.anonymous ? null : id, sender: id, anonymous: !!s.worldNews.anonymous, text: s.worldNews.text });
    }
  }
}

export function advance(state) {
  state.turnNumber += 1;
}
