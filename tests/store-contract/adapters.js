// Test-only helpers that reach "behind" a store to rig a world (set populations, missiles, cash).
// The contract suite uses these in place of reaching into store internals, so it works on any store.

export const memoryAdapter = {
  async setMinorPopulations(store, gameId, population) {
    await store.withTransaction(async (tx) => {
      for (const m of tx.d.minors) if (m.gameId === gameId && !m.destroyed) m.population = population;
    });
  },
  async setPlayerMissiles(store, gameId, country, missiles) {
    await store.withTransaction(async (tx) => {
      for (const p of tx.d.players) if (p.gameId === gameId && p.country === country) p.missiles = missiles;
    });
  },
  async setMinorCash(store, gameId, baseName, cash) {
    await store.withTransaction(async (tx) => {
      for (const m of tx.d.minors) if (m.gameId === gameId && m.baseName === baseName && m.generation === 1) m.cash = cash;
    });
  },
};

export const pgAdapter = {
  async setMinorPopulations(store, gameId, population) {
    await store.withTransaction((tx) => tx.q('UPDATE minors SET population = $2 WHERE game_id = $1 AND NOT destroyed', [gameId, population]));
  },
  async setPlayerMissiles(store, gameId, country, missiles) {
    await store.withTransaction((tx) => tx.q('UPDATE players SET missiles = $3 WHERE game_id = $1 AND country = $2', [gameId, country, missiles]));
  },
  async setMinorCash(store, gameId, baseName, cash) {
    await store.withTransaction((tx) => tx.q('UPDATE minors SET cash = $3 WHERE game_id = $1 AND base_name = $2 AND generation = 1', [gameId, baseName, cash]));
  },
};
