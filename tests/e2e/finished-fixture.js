// A server with finished games already in it, for browser tests of the end-of-game screens.
// A real game cannot reach them inside a test (turns last hours), so this seeds two games that started
// three days ago with a one-turn forfeit rule, and lets the real deadline worker finish them:
//   "win":  FRANCE (Ada) saved a sheet; INDIA (Ben) and JAPAN (Cy) missed the deadline and were forfeited, so Ada wins
//   "draw": nobody submitted, everyone was forfeited on the same turn, so nobody wins
import { createMemoryStore } from '../../src/store/memory.js';
import { createTokenAuth } from '../../src/http/auth.js';
import { startServer } from '../../src/server.js';
import { startGame, submitSheet } from '../../src/app/pipeline.js';

const quiet = { log() {}, warn() {}, error() {} };

export async function seedFinishedGames() {
  const store = createMemoryStore();
  const users = [];
  for (const name of ['Ada', 'Ben', 'Cy']) users.push(await store.withTransaction((tx) => tx.createUser(name)));
  const countries = ['FRANCE', 'INDIA', 'JAPAN'];
  const longAgo = new Date(Date.now() - 3 * 86400 * 1000);

  async function make(seed, draft) {
    const gameId = store.createGame({ creatorId: users[0].id, seed, forfeitAfterN: 1 });
    users.forEach((u, i) => store.addPlayer({ gameId, userId: u.id, country: countries[i], startPopulation: 50 }));
    await startGame(store, { gameId, userId: users[0].id }, longAgo);
    if (draft) await submitSheet(store, { gameId, userId: users[0].id, payload: { worldNews: { text: 'Ada was here' } } }, new Date(longAgo.getTime() + 3600 * 1000));
    return gameId;
  }
  const win = await make(1111, true);
  const draw = await make(2222, false);
  return { store, users, games: { win, draw } };
}

async function waitUntilFinished(store, gameIds, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const snaps = await Promise.all(gameIds.map((id) => store.withTransaction((tx) => tx.loadSnapshot(id))));
    if (snaps.every((s) => s.game.status === 'FINISHED')) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the seeded games did not finish');
}

/** Starts the server on a free port with the seeded games finished. Returns { port, stop, fixture }. */
export async function startFinishedFixture({ secret = 'e2e-fixture-secret-0123456789' } = {}) {
  const seeded = await seedFinishedGames();
  const server = await startServer({
    env: { AUTH_SECRET: secret, STORE: 'memory', PORT: '0', HOST: '127.0.0.1', WORKER_INTERVAL_MS: '30' },
    store: seeded.store, logger: quiet,
  });
  await waitUntilFinished(seeded.store, Object.values(seeded.games));
  const auth = createTokenAuth({ secret });
  const fixture = {
    games: seeded.games,
    users: seeded.users.map((u) => ({ id: u.id, name: u.displayName, token: auth.issue(u.id) })),
  };
  return { port: server.port, stop: server.stop, fixture };
}

// `node tests/e2e/finished-fixture.js` prints one READY line (JSON) and then serves until it is stopped.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const { port, stop, fixture } = await startFinishedFixture();
  console.log(`READY ${JSON.stringify({ port, ...fixture })}`);
  const done = async () => { await stop(); process.exit(0); };
  process.once('SIGINT', done);
  process.once('SIGTERM', done);
  if (typeof process.send === 'function') process.on('message', (m) => { if (m === 'shutdown') done(); });
}
