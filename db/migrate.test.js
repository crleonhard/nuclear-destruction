import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMigration, listMigrations, migrateUp, migrateDown, status, DEFAULT_DIR } from './migrate.js';

/** A pretend database connection: records every statement and fakes the schema_migrations table. */
function fakeClient({ failOn = null } = {}) {
  const versions = new Set();
  const log = [];
  return {
    log,
    versions,
    async query(text, params = []) {
      log.push(text.trim().split('\n')[0].slice(0, 60));
      if (failOn && text.includes(failOn)) throw new Error('boom');
      if (/^SELECT version/i.test(text)) return { rows: [...versions].sort().map((version) => ({ version })) };
      if (/^INSERT INTO schema_migrations/i.test(text)) versions.add(params[0]);
      if (/^DELETE FROM schema_migrations/i.test(text)) versions.delete(params[0]);
      return { rows: [] };
    },
  };
}
const tmpDir = (files) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
};

test('parse: splits up and down, keeps semicolons inside function bodies, rejects incomplete files', () => {
  const m = parseMigration('-- migrate:up\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;\n\n-- migrate:down\nDROP FUNCTION f();\n');
  assert.match(m.up, /^CREATE FUNCTION f\(\)[\s\S]*LANGUAGE sql;$/);
  assert.equal(m.down, 'DROP FUNCTION f();');
  assert.throws(() => parseMigration('-- migrate:up\nSELECT 1;'), /no "-- migrate:down"/);
  assert.throws(() => parseMigration('SELECT 1;'), /no "-- migrate:up"/);
  assert.equal(parseMigration('-- migrate:down\nB;\n-- migrate:up\nA;').up, 'A;'); // order does not matter
});

test('the real migrations: eight, ordered, each with up and down, and every object created is dropped', () => {
  const ms = listMigrations(DEFAULT_DIR);
  assert.deepEqual(ms.map((m) => m.version), ['001', '002', '003', '004', '005', '006', '007', '008']);
  for (const m of ms) {
    assert.ok(m.up.length > 0 && m.down.length > 0, m.name);
    for (const [, kind, name] of m.up.matchAll(/CREATE\s+(TABLE|TYPE|FUNCTION|VIEW)\s+(\w+)/gi)) {
      assert.match(m.down, new RegExp(`\\b${name}\\b`), `${m.name}: ${kind} ${name} is never dropped in the down section`);
    }
  }
});

test('up applies everything once, in order, each in its own transaction; a second run does nothing', async () => {
  const dir = tmpDir({
    '001_a.sql': '-- migrate:up\nCREATE TABLE a (id int);\n-- migrate:down\nDROP TABLE a;',
    '002_b.sql': '-- migrate:up\nCREATE TABLE b (id int);\n-- migrate:down\nDROP TABLE b;',
    'README.md': 'ignored',
  });
  const c = fakeClient();
  assert.deepEqual(await migrateUp(c, dir), ['001_a', '002_b']);
  assert.deepEqual([...c.versions], ['001', '002']);
  assert.deepEqual(c.log.filter((l) => /^(BEGIN|COMMIT|CREATE TABLE [ab])/.test(l)),
    ['BEGIN', 'CREATE TABLE a (id int);', 'COMMIT', 'BEGIN', 'CREATE TABLE b (id int);', 'COMMIT']);
  assert.deepEqual(await migrateUp(c, dir), []);
});

test('a failing migration rolls back, keeps earlier ones, records nothing, and names itself', async () => {
  const dir = tmpDir({
    '001_a.sql': '-- migrate:up\nCREATE TABLE a (id int);\n-- migrate:down\nDROP TABLE a;',
    '002_bad.sql': '-- migrate:up\nCREATE TABLE bad (id int);\n-- migrate:down\nDROP TABLE bad;',
  });
  const c = fakeClient({ failOn: 'CREATE TABLE bad' });
  await assert.rejects(migrateUp(c, dir), /002_bad: boom/);
  assert.deepEqual([...c.versions], ['001']);
  assert.equal(c.log.at(-1), 'ROLLBACK');
});

test('down rolls back newest first, by count or all, and status reflects it', async () => {
  const dir = tmpDir({
    '001_a.sql': '-- migrate:up\nUP_A;\n-- migrate:down\nDOWN_A;',
    '002_b.sql': '-- migrate:up\nUP_B;\n-- migrate:down\nDOWN_B;',
    '003_c.sql': '-- migrate:up\nUP_C;\n-- migrate:down\nDOWN_C;',
  });
  const c = fakeClient();
  await migrateUp(c, dir);
  assert.deepEqual(await migrateDown(c, dir), ['003_c']);
  assert.deepEqual((await status(c, dir)).map((m) => m.applied), [true, true, false]);
  assert.deepEqual(await migrateDown(c, dir, { steps: Infinity }), ['002_b', '001_a']);
  assert.deepEqual([...c.versions], []);
  assert.deepEqual(await migrateDown(c, dir), []);
  assert.deepEqual(c.log.filter((l) => /^DOWN_/.test(l)), ['DOWN_C;', 'DOWN_B;', 'DOWN_A;']);
});

test('a database ahead of this checkout is refused rather than guessed at', async () => {
  const dir = tmpDir({ '001_a.sql': '-- migrate:up\nUP;\n-- migrate:down\nDOWN;' });
  const c = fakeClient();
  c.versions.add('009');
  await assert.rejects(migrateUp(c, dir), /does not know: 009/);
});
