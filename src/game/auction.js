// The factory auction: one clearing price, then one factory at a time.

import { randInt } from './rng.js';

/** Largest integer p >= 1 such that sum(floor(cash/p)) >= k, or null. */
export function clearingPrice(cashes, k) {
  if (k <= 0) return null;
  const capacity = (p) => cashes.reduce((s, c) => s + Math.floor(c / p), 0);
  if (capacity(1) < k) return null;
  let lo = 1;
  let hi = Math.max(...cashes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (capacity(mid) >= k) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * One factory at a time to the minor with the most remaining cash; ties by rng.
 * entries: [{ id, cash }]. Returns { won: {id: n}, draws: [{ tied, pick }] }.
 */
export function allocateFactories(entries, k, p, rng) {
  const rem = new Map(entries.map((e) => [e.id, e.cash]));
  const won = Object.fromEntries(entries.map((e) => [e.id, 0]));
  const draws = [];
  for (let i = 0; i < k; i++) {
    const eligible = [...rem].filter(([, c]) => c >= p);
    if (eligible.length === 0) throw new Error('Allocation underflow (price too high)');
    const top = Math.max(...eligible.map(([, c]) => c));
    const tied = eligible.filter(([, c]) => c === top).map(([id]) => id).sort();
    let pick = tied[0];
    if (tied.length > 1) {
      pick = tied[randInt(rng, tied.length)];
      draws.push({ tied, pick });
    }
    rem.set(pick, rem.get(pick) - p);
    won[pick]++;
  }
  return { won, draws };
}
