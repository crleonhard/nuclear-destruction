// Runs the database-backed tests against a throwaway PostgreSQL database.
//
//   npm run test:db                      uses TEST_DATABASE_URL (or DATABASE_URL) as the admin connection
//   npm run test:db -- --url postgres://postgres:secret@localhost:5432/postgres
//   npm run test:db:docker               starts a disposable postgres container, no setup needed
//
// What it does, in order:
//   1. creates a scratch database (nd_test_<random>) on that server
//   2. applies every migration, then rolls ALL of them back and checks nothing is left behind,
//      then applies them again (proves the down sections work)
//   3. runs the store contract suite, the schema tests, the HTTP and API-contract tests, and the real-process
//      server tests against it
//      (PG_TEST_URL is set for them), one file at a time: they share the database, and the deadline
//      worker looks at every game in it, so files must not overlap
//   4. drops the scratch database (and stops the container). Pass --keep to leave them for inspection.
//
// The admin connection needs permission to CREATE DATABASE. Nothing outside the scratch database is touched.
// Exit code: 0 all passed, 1 a step failed or tests failed, 2 bad usage or missing prerequisites.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateUp, migrateDown, status, DEFAULT_DIR } from '../db/migrate.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const TEST_FILES = [
  'tests/store-contract/postgres.test.js',   // the shared store behaviour suite
  'tests/schema-postgres.test.js',           // constraints, triggers, SQL functions, views
  'tests/http.test.js',                      // the web layer on top of the PostgreSQL store
  'tests/openapi.test.js',                   // every response in a full game checked against the API spec
  'tests/server-process.test.js',            // the real `node src/server.js`: boots on PostgreSQL, survives a restart, exits cleanly
  'tests/login.test.js',                     // email sign-in on PostgreSQL: single use, expiry, limits, concurrent opens
  'tests/ai-play.test.js',                   // AI players on PostgreSQL: lobby, taking turns, the worker safety net, self-play
  'tests/head.test.js',                      // HEAD requests (uptime monitors) on the PostgreSQL-backed server
];

export const USAGE = `Usage: node scripts/run-db-tests.js [options]

  --url <postgres-url>   admin connection (default: $TEST_DATABASE_URL, then $DATABASE_URL)
  --docker               start a disposable Postgres container instead of using --url
  --image <image>        container image for --docker (default: postgres:16-alpine)
  --keep                 do not drop the scratch database or stop the container
  -h, --help             show this help`;

export function parseArgs(argv) {
  const args = { url: null, docker: false, image: 'postgres:16-alpine', keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--docker') args.docker = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--url' || a === '--image') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      args[a === '--url' ? 'url' : 'image'] = v;
    } else throw new Error(`unknown option "${a}"`);
  }
  return args;
}

/** The same connection URL pointed at a different database. */
export function withDatabaseName(url, name) {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

export const randomDbName = () => `nd_test_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;

// ───────────────────────── helpers with side effects ─────────────────────────

const step = (n, total, text) => console.log(`\n[${n}/${total}] ${text}`);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

async function loadPg() {
  try { return (await import('pg')).default; } catch {
    throw Object.assign(new Error('The "pg" package is required: npm install pg'), { exitCode: 2 });
  }
}

function startDocker(image) {
  if (run('docker', ['--version']).status !== 0) {
    throw Object.assign(new Error('Docker is not available. Install it, or pass --url for an existing server.'), { exitCode: 2 });
  }
  const name = `nd-test-${randomBytes(3).toString('hex')}`;
  const started = run('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432', image]);
  if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr.trim()}`);
  const mapped = run('docker', ['port', name, '5432/tcp']).stdout;
  const port = mapped.split('\n').map((l) => l.match(/:(\d+)\s*$/)?.[1]).find(Boolean);
  if (!port) { run('docker', ['stop', name]); throw new Error(`could not find the mapped port in: ${mapped}`); }
  return { name, url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres` };
}

async function waitForServer(pg, url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const c = new pg.Client({ connectionString: url });
    try { await c.connect(); await c.query('SELECT 1'); await c.end(); return; } catch (e) { last = e; await c.end().catch(() => {}); }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`database did not become ready within ${timeoutMs / 1000}s: ${last?.message}`);
}

/** Everything the migrations create that should be gone after a full rollback. */
async function leftovers(client) {
  const rows = async (sql) => (await client.query(sql)).rows.map((r) => r.n);
  return [
    ...(await rows(`SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`)).map((n) => `table ${n}`),
    ...(await rows(`SELECT p.proname AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public'`)).map((n) => `function ${n}`),
    ...(await rows(`SELECT t.typname AS n FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace WHERE s.nspname = 'public' AND t.typtype = 'e'`)).map((n) => `type ${n}`),
  ];
}

// ───────────────────────── main ─────────────────────────

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`${e.message}\n\n${USAGE}`); return 2; }
  if (args.help) { console.log(USAGE); return 0; }

  let adminUrl = args.url ?? env.TEST_DATABASE_URL ?? env.DATABASE_URL;
  if (!adminUrl && !args.docker) { console.error(`No database given.\n\n${USAGE}`); return 2; }

  const cleanups = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { console.error(`cleanup: ${e.message}`); } }
  };
  const onSignal = async (sig) => { console.error(`\n${sig}: cleaning up`); await cleanup(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const pg = await loadPg();
    const total = 4;

    if (args.docker) {
      step(0, total, `starting a disposable ${args.image} container`);
      const c = startDocker(args.image);
      adminUrl = c.url;
      cleanups.push(async () => {
        if (args.keep) console.log(`kept container ${c.name}; stop it with: docker stop ${c.name}`);
        else run('docker', ['stop', c.name]);
      });
      await waitForServer(pg, adminUrl);
    }

    step(1, total, 'creating a scratch database');
    const dbName = randomDbName();
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    cleanups.push(() => admin.end());
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const dbUrl = withDatabaseName(adminUrl, dbName);
    cleanups.push(async () => {
      if (args.keep) { console.log(`kept database ${dbName}\n  ${dbUrl}`); return; }
      try { await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } // PostgreSQL 13+
      catch { await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`); }
    });
    console.log(`  ${dbName}`);

    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    cleanups.push(() => db.end());

    step(2, total, 'migrations: up, fully down, up again');
    const applied = await migrateUp(db, DEFAULT_DIR, { log: (m) => console.log(`  ${m}`) });
    console.log(`  ${applied.length} applied`);
    await migrateDown(db, DEFAULT_DIR, { steps: Infinity, log: (m) => console.log(`  ${m}`) });
    const left = await leftovers(db);
    if (left.length) throw new Error(`rolling back every migration left behind: ${left.join(', ')}`);
    console.log('  nothing left behind');
    await migrateUp(db, DEFAULT_DIR);
    const st = await status(db, DEFAULT_DIR);
    if (!st.every((m) => m.applied)) throw new Error('not every migration is applied after the second run');
    console.log(`  re-applied all ${st.length}`);
    await db.end();
    cleanups.splice(cleanups.length - 1, 1); // db client already closed

    step(3, total, 'running the database tests');
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...TEST_FILES], {
      cwd: ROOT, stdio: 'inherit', env: { ...env, PG_TEST_URL: dbUrl },
    });
    const ok = result.status === 0;

    step(4, total, args.keep ? 'keeping the scratch database' : 'cleaning up');
    await cleanup();
    console.log(ok ? '\nAll database tests passed.' : '\nDatabase tests FAILED.');
    return ok ? 0 : 1;
  } catch (err) {
    console.error(`\n${err.message}`);
    await cleanup();
    return err.exitCode ?? 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main();
}
