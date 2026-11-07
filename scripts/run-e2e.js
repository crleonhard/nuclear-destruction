// Runs the browser tests: plays a full game through the real UI, then checks the end-of-game screens.
//
//   npm run e2e                      screenshots go to a temp folder (its path is printed)
//   npm run e2e -- --shots ./shots   or choose where they go
//
// Needs Python with Playwright and a browser (one-time setup):
//   pip install playwright
//   playwright install chromium
//
// It starts its own throwaway servers (in-memory data, a free port), so it needs no database and touches nothing.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { startFinishedFixture } from '../tests/e2e/finished-fixture.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const quiet = { log() {}, warn() {}, error() {} };

export function parseArgs(argv) {
  const args = { shots: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--shots') { args.shots = argv[++i]; if (!args.shots) throw new Error('--shots needs a folder'); }
    else if (argv[i] === '-h' || argv[i] === '--help') args.help = true;
    else throw new Error(`unknown option "${argv[i]}"`);
  }
  return args;
}

/** Finds a Python that can import Playwright. Returns { cmd } or { problem }. */
export function findPython(spawnSyncImpl = spawnSync) {
  let found = false;
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    const version = spawnSyncImpl(cmd[0], [...cmd.slice(1), '--version'], { stdio: 'ignore' });
    if (version.status !== 0) continue;
    found = true;
    if (spawnSyncImpl(cmd[0], [...cmd.slice(1), '-c', 'import playwright'], { stdio: 'ignore' }).status === 0) return { cmd };
  }
  return { problem: found ? 'Python is installed but Playwright is not. Run: pip install playwright && playwright install chromium'
    : 'Python was not found. Install Python 3, then run: pip install playwright && playwright install chromium' };
}

const runPython = (cmd, script, scriptArgs) => new Promise((resolve) => {
  const child = spawn(cmd[0], [...cmd.slice(1), path.join(ROOT, script), ...scriptArgs], { stdio: 'inherit', cwd: ROOT });
  child.on('exit', (code) => resolve(code ?? 1));
  child.on('error', () => resolve(1));
});

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (args.help) { console.log('Usage: npm run e2e [-- --shots DIR]'); return 0; }
  const python = findPython();
  if (python.problem) { console.error(python.problem); return 2; }
  const shots = args.shots ?? path.join(os.tmpdir(), 'nuclear-destruction-e2e');
  const results = [];

  console.log('\n=== Playing a full game through the UI (three browsers) ===');
  const play = await startServer({
    env: { STORE: 'memory', AUTH_SECRET: 'e2e-play-secret-0123456789', ALLOW_SIGNUP: 'true', PORT: '0', HOST: '127.0.0.1' }, logger: quiet,
  });
  try { results.push(['full game', await runPython(python.cmd, 'tests/e2e/play-through.py', [`http://127.0.0.1:${play.port}`, '--shots', shots])]); }
  finally { await play.stop(); }

  console.log('\n=== Checking the end-of-game screens ===');
  const fx = await startFinishedFixture();
  const fixtureFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'nd-fixture-')), 'fixture.json');
  writeFileSync(fixtureFile, JSON.stringify(fx.fixture));
  try { results.push(['finished games', await runPython(python.cmd, 'tests/e2e/finished-game.py', [`http://127.0.0.1:${fx.port}`, fixtureFile, '--shots', shots])]); }
  finally { await fx.stop(); }

  console.log('\n=== Browser test results ===');
  for (const [name, code] of results) console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`Screenshots: ${shots}`);
  return results.every(([, code]) => code === 0) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main();
}
