import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseArgs, withDatabaseName, randomDbName, main, USAGE, TEST_FILES } from './run-db-tests.js';

test('args: defaults, flags and values', () => {
  assert.deepEqual(parseArgs([]), { url: null, docker: false, image: 'postgres:16-alpine', keep: false, help: false });
  assert.deepEqual(parseArgs(['--docker', '--keep', '--image', 'postgres:15', '--url', 'postgres://x/y']),
    { url: 'postgres://x/y', docker: true, image: 'postgres:15', keep: true, help: false });
  assert.equal(parseArgs(['-h']).help, true);
  assert.throws(() => parseArgs(['--url']), /needs a value/);
  assert.throws(() => parseArgs(['--url', '--keep']), /needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('url: only the database name changes; credentials, host, port and query survive', () => {
  assert.equal(withDatabaseName('postgres://u:p%40ss@db.example:5433/postgres?sslmode=require', 'nd_test_x'),
    'postgres://u:p%40ss@db.example:5433/nd_test_x?sslmode=require');
  assert.equal(withDatabaseName('postgresql://localhost/postgres', 'a b'), 'postgresql://localhost/a%20b');
  assert.equal(new URL(withDatabaseName('postgres://localhost', 'nd')).pathname, '/nd');
});

test('database names are unique and safe to quote', () => {
  const names = new Set(Array.from({ length: 200 }, randomDbName));
  assert.equal(names.size, 200);
  for (const n of names) assert.match(n, /^nd_test_[a-z0-9]+_[0-9a-f]{6}$/);
});

test('main: help exits 0, bad usage and a missing database exit 2, all without touching anything', async () => {
  const quiet = async (fn) => {
    const log = console.log; const err = console.error;
    console.log = () => {}; console.error = () => {};
    try { return await fn(); } finally { console.log = log; console.error = err; }
  };
  assert.equal(await quiet(() => main(['--help'], {})), 0);
  assert.equal(await quiet(() => main(['--bogus'], {})), 2);
  assert.equal(await quiet(() => main([], {})), 2);           // no URL and no --docker
  assert.match(USAGE, /--docker/);
});

test('every file the database run depends on exists (a rename would otherwise fail only on a real database)', () => {
  assert.equal(TEST_FILES.length, 10);
  for (const f of TEST_FILES) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `${f} is missing`);
});
