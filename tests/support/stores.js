// Chooses the store the HTTP and API-contract tests run on.
//   (default)               a fresh in-memory store for every test
//   PG_TEST_URL=postgres..  one real PostgreSQL database shared by every test (what `npm run test:db` uses)
//   ND_SHARED_MEMORY=1      one in-memory store shared by every test: a quick way to check that tests
//                           do not depend on starting from an empty database, without needing PostgreSQL
import { createMemoryStore } from '../../src/store/memory.js';

export async function openStore() {
  const url = process.env.PG_TEST_URL;
  if (url) {
    const { default: pg } = await import('pg');
    const { createPgStore } = await import('../../src/store/postgres.js');
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    const store = createPgStore(pool);
    return { kind: 'postgres', makeStore: () => store, pool, close: () => pool.end() };
  }
  if (process.env.ND_SHARED_MEMORY) {
    const store = createMemoryStore();
    return { kind: 'shared memory', makeStore: () => store, close: async () => {} };
  }
  return { kind: 'memory', makeStore: () => createMemoryStore(), close: async () => {} };
}

/** Test names get a prefix when not running on the default store, so output says where it ran. */
export const labelFor = (kind) => (kind === 'memory' ? '' : `[${kind}] `);
