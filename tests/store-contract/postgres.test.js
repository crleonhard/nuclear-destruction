// The store contract, run against a real PostgreSQL with the migrations applied.
// Skipped unless PG_TEST_URL is set; `npm run test:db` creates a scratch database and sets it.
import test, { after } from 'node:test';
import { defineStoreContract } from './contract.js';
import { pgAdapter } from './adapters.js';
import { createPgStore } from '../../src/store/postgres.js';

const url = process.env.PG_TEST_URL;
if (!url) {
  test('postgres store contract', { skip: 'set PG_TEST_URL (see: npm run test:db)' }, () => {});
} else {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  after(() => pool.end());
  const store = createPgStore(pool);
  // One database for the whole run: every test creates its own users and game, so they do not interfere.
  defineStoreContract('postgres store', { makeStore: async () => store, adapter: pgAdapter });
}
