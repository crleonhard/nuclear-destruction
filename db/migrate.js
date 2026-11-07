// Minimal migration runner for the dbmate-format files in ./migrations.
//
//   node db/migrate.js up            apply every pending migration
//   node db/migrate.js down [n]      roll back the last n (default 1); "all" rolls back everything
//   node db/migrate.js status        list migrations and whether they are applied
//
// Uses DATABASE_URL and the `pg` package. It records versions in `schema_migrations`
// (the same table and column dbmate uses), so the two tools can be mixed.
// Each migration runs in its own transaction: a failure leaves the database as it was before it.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/** Splits a dbmate-format file into its `-- migrate:up` and `-- migrate:down` sections. */
export function parseMigration(text, name = 'migration') {
  const marker = /^--\s*migrate:(up|down)\b.*$/gim;
  const hits = [...text.matchAll(marker)];
  const sections = { up: '', down: '' };
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    sections[m[1].toLowerCase()] = text.slice(m.index + m[0].length, end).trim();
  });
  if (!sections.up) throw new Error(`${name}: no "-- migrate:up" section`);
  if (!sections.down) throw new Error(`${name}: no "-- migrate:down" section`);
  return sections;
}

export function listMigrations(dir = DEFAULT_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((file) => {
      const version = file.match(/^(\d+)_/)[1];
      return { version, name: file.replace(/\.sql$/, ''), file, ...parseMigration(readFileSync(path.join(dir, file), 'utf8'), file) };
    })
    .sort((a, b) => Number(a.version) - Number(b.version));
}

async function ensureTable(client) {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version varchar(255) PRIMARY KEY)');
}

async function applied(client, known) {
  await ensureTable(client);
  const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  const versions = rows.map((r) => r.version);
  const unknown = versions.filter((v) => !known.some((m) => m.version === v));
  if (unknown.length) throw new Error(`database has migrations this checkout does not know: ${unknown.join(', ')}`);
  return new Set(versions);
}

async function inTransaction(client, label, fn) {
  await client.query('BEGIN');
  try {
    await fn();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    err.message = `${label}: ${err.message}`;
    throw err;
  }
}

/** Applies pending migrations in order. Returns the names applied. */
export async function migrateUp(client, dir = DEFAULT_DIR, { log = () => {} } = {}) {
  const migrations = listMigrations(dir);
  const done = await applied(client, migrations);
  const ran = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    await inTransaction(client, m.name, async () => {
      await client.query(m.up); // whole section at once: function bodies contain semicolons
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
    });
    log(`applied   ${m.name}`);
    ran.push(m.name);
  }
  return ran;
}

/** Rolls back the last `steps` applied migrations, newest first. Returns the names rolled back. */
export async function migrateDown(client, dir = DEFAULT_DIR, { steps = 1, log = () => {} } = {}) {
  const migrations = listMigrations(dir);
  const done = await applied(client, migrations);
  const ran = [];
  for (const m of [...migrations].reverse()) {
    if (ran.length >= steps) break;
    if (!done.has(m.version)) continue;
    await inTransaction(client, m.name, async () => {
      await client.query(m.down);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [m.version]);
    });
    log(`rolled back ${m.name}`);
    ran.push(m.name);
  }
  return ran;
}

export async function status(client, dir = DEFAULT_DIR) {
  const migrations = listMigrations(dir);
  const done = await applied(client, migrations);
  return migrations.map((m) => ({ version: m.version, name: m.name, applied: done.has(m.version) }));
}

// ───────────────────────── CLI ─────────────────────────

async function connect(url) {
  let pg;
  try { pg = (await import('pg')).default; } catch {
    throw new Error('The "pg" package is required: npm install pg');
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd = 'status', arg] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL'); process.exit(2); }
  const client = await connect(url);
  try {
    if (cmd === 'up') {
      const ran = await migrateUp(client, DEFAULT_DIR, { log: console.log });
      if (!ran.length) console.log('nothing to apply');
    } else if (cmd === 'down') {
      const steps = arg === 'all' ? Infinity : Number(arg ?? 1);
      if (!(steps >= 1)) throw new Error('down takes a positive number or "all"');
      const ran = await migrateDown(client, DEFAULT_DIR, { steps, log: console.log });
      if (!ran.length) console.log('nothing to roll back');
    } else if (cmd === 'status') {
      for (const m of await status(client)) console.log(`${m.applied ? '[x]' : '[ ]'} ${m.name}`);
    } else {
      throw new Error(`unknown command "${cmd}" (use up, down, status)`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
