// Tests of the migrations themselves: constraints, triggers, SQL functions and privacy views.
// Skipped unless PG_TEST_URL is set (see: npm run test:db). Each test builds its own game, so
// they can share one database. Statements run in autocommit mode, so a rejected statement leaves
// nothing behind. SQLSTATEs: 23505 unique, 23503 foreign key, 23514 check (also our triggers).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, controller, listedMinors, COUNTRIES, mulberry32 } from '../src/game/index.js';

const url = process.env.PG_TEST_URL;
const skip = url ? false : 'set PG_TEST_URL (see: npm run test:db)';
const pgtest = (name, fn) => test(`pg schema: ${name}`, { skip }, fn);

let client;
if (url) {
  const { default: pg } = await import('pg');
  client = new pg.Client({ connectionString: url });
  await client.connect();
  after(() => client.end());
}
const q = async (text, params) => (await client.query(text, params)).rows;
const one = async (text, params) => (await q(text, params))[0];
const columnsOf = async (relation) => (await client.query(`SELECT * FROM ${relation} LIMIT 0`)).fields.map((f) => f.name);
async function fails(promise, sqlstate) {
  try { await promise; } catch (e) {
    assert.equal(e.code, sqlstate, `expected SQLSTATE ${sqlstate}, got ${e.code}: ${e.message}`);
    return e;
  }
  return assert.fail(`expected SQLSTATE ${sqlstate}, but the statement succeeded`);
}

// ── builders ──
let n = 0;
const user = async (name = 'u') => (await one('INSERT INTO users (display_name) VALUES ($1) RETURNING id', [`${name}${++n}`])).id;
async function game({ players = 0 } = {}) {
  const creator = await user('creator');
  const { id } = await one('INSERT INTO games (creator_id, seed) VALUES ($1, $2) RETURNING id', [creator, 1234]);
  const ids = [];
  for (let i = 0; i < players; i++) {
    ids.push((await one('INSERT INTO players (game_id, user_id, country) VALUES ($1, $2, $3) RETURNING id', [id, await user(), COUNTRIES[i]])).id);
  }
  return { id, creator, players: ids };
}
const minor = async (gameId, base = 'CUBA', generation = 1) =>
  (await one('INSERT INTO minors (game_id, base_name, generation) VALUES ($1, $2, $3) RETURNING id', [gameId, base, generation])).id;
const turn = async (gameId, number = 1, { status = 'OPEN', type = 'NORMAL' } = {}) =>
  (await one(
    `INSERT INTO turns (game_id, number, type, status, deadline_at, rng_seed, resolved_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 day', 1, $5) RETURNING id`,
    [gameId, number, type, status, status === 'CLOSED' ? new Date() : null])).id;
const sheet = (turnId, gameId, playerId, extra = {}) => q(
  `INSERT INTO sheets (turn_id, game_id, player_id, payload, source) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
  [turnId, gameId, playerId, JSON.stringify(extra.payload ?? {}), extra.source ?? 'PLAYER']);

// ───────────────────────── Shape ─────────────────────────

pgtest('every table, view, function, trigger and enum from the migrations exists', async () => {
  const names = async (sql) => (await q(sql)).map((r) => r.n).sort();
  const tables = await names(`SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  assert.deepEqual(tables, ['battle_results', 'events', 'games', 'login_links', 'messages', 'minor_index', 'minors', 'players', 'reports',
    'schema_migrations', 'sheets', 'spy_slots', 'turns', 'users', 'world_news'].sort());
  const views = await names(`SELECT table_name AS n FROM information_schema.views WHERE table_schema = 'public'`);
  assert.deepEqual(views, ['inbox_messages', 'public_minors', 'public_news', 'public_players', 'replay_events', 'replay_sheets']);
  const fns = await names(`SELECT p.proname AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public'`);
  assert.deepEqual(fns, ['enforce_player_limits', 'forbid_event_mutation', 'forbid_index_decrease', 'guard_sheet_write',
    'listed_minors', 'minor_controller', 'touch_updated_at']);
  const triggers = await names(`SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal`);
  assert.deepEqual(triggers, ['events_append_only', 'minor_index_monotonic', 'players_limit', 'sheets_guard']);
  const enums = await names(`SELECT t.typname AS n FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace WHERE s.nspname = 'public' AND t.typtype = 'e'`);
  assert.deepEqual(enums, ['game_status', 'outcome_kind', 'report_kind', 'sheet_source', 'spy_kind', 'turn_status', 'turn_type']);
});

// ───────────────────────── games and players ─────────────────────────

pgtest('a game holds at most 9 players and only accepts them while in the lobby', async () => {
  const g = await game({ players: 9 });
  await fails(q('INSERT INTO players (game_id, user_id) VALUES ($1, $2)', [g.id, await user()]), '23514');
  const h = await game({ players: 3 });
  await q(`UPDATE games SET status = 'ACTIVE' WHERE id = $1`, [h.id]);
  await fails(q('INSERT INTO players (game_id, user_id) VALUES ($1, $2)', [h.id, await user()]), '23514');
});

pgtest('player constraints: unique country and user per game, valid country, alive and forfeited rules', async () => {
  const g = await game({ players: 2 });
  await fails(q('INSERT INTO players (game_id, user_id, country) VALUES ($1, $2, $3)', [g.id, await user(), COUNTRIES[0]]), '23505'); // already taken
  await fails(q('INSERT INTO players (game_id, user_id, country) VALUES ($1, $2, $3)', [g.id, await user(), 'ATLANTIS']), '23514');
  const uid = (await one('SELECT user_id FROM players WHERE id = $1', [g.players[0]])).user_id;
  await fails(q('INSERT INTO players (game_id, user_id) VALUES ($1, $2)', [g.id, uid]), '23505');
  await q('INSERT INTO players (game_id, user_id) VALUES ($1, $2)', [g.id, await user()]);         // several unpicked seats are fine
  await q('INSERT INTO players (game_id, user_id) VALUES ($1, $2)', [g.id, await user()]);
  await fails(q('UPDATE players SET forfeited = true WHERE id = $1', [g.players[0]]), '23514');     // forfeited players are not alive
  await q('UPDATE players SET cash = 5 WHERE id = $1', [g.players[0]]);
  await fails(q('UPDATE players SET alive = false WHERE id = $1', [g.players[0]]), '23514');        // the dead hold nothing
  await fails(q('UPDATE players SET cash = -1 WHERE id = $1', [g.players[1]]), '23514');
  await fails(q('UPDATE players SET start_population = 24 WHERE id = $1', [g.players[1]]), '23514');
  await q('UPDATE players SET cash = 0, alive = false, forfeited = true WHERE id = $1', [g.players[0]]);
});

pgtest('game constraints: outcome and winner agree, the seed is a uint32, the current turn must exist', async () => {
  const g = await game({ players: 2 });
  const other = await game({ players: 1 });
  await fails(q(`UPDATE games SET status = 'FINISHED' WHERE id = $1`, [g.id]), '23514');
  await fails(q(`UPDATE games SET status = 'FINISHED', outcome = 'WIN' WHERE id = $1`, [g.id]), '23514');
  await fails(q(`UPDATE games SET status = 'FINISHED', outcome = 'DRAW', winner_player_id = $2 WHERE id = $1`, [g.id, g.players[0]]), '23514');
  await fails(q(`UPDATE games SET status = 'FINISHED', outcome = 'WIN', winner_player_id = $2 WHERE id = $1`, [g.id, other.players[0]]), '23503');
  await q(`UPDATE games SET status = 'FINISHED', outcome = 'WIN', winner_player_id = $2 WHERE id = $1`, [g.id, g.players[0]]);
  const h = await game();
  await fails(q('INSERT INTO games (creator_id, seed) VALUES ($1, $2)', [h.creator, 4294967296]), '23514');
  await fails(q('UPDATE games SET turn_number = 3 WHERE id = $1', [h.id]), '23503');
  await turn(h.id, 1);
  await q('UPDATE games SET turn_number = 1 WHERE id = $1', [h.id]);
  await fails(q('UPDATE games SET first_battle_done = true WHERE id = $1', [h.id]), '23514');     // no battle before war
});

// ───────────────────────── minors and indices ─────────────────────────

pgtest('minor constraints: fixed names, population range, destroyed minors hold nothing', async () => {
  const g = await game();
  await fails(q(`INSERT INTO minors (game_id, base_name) VALUES ($1, 'ATLANTIS')`, [g.id]), '23514');
  const id = await minor(g.id);
  await fails(minor(g.id), '23505');                                                              // same name and generation
  await minor(g.id, 'CUBA', 2);                                                                   // a replacement is allowed
  await fails(q('UPDATE minors SET population = 21 WHERE id = $1', [id]), '23514');
  await fails(q('UPDATE minors SET destroyed = true WHERE id = $1', [id]), '23514');
  await fails(q('UPDATE minors SET population = 0 WHERE id = $1', [id]), '23514');
  await fails(q('UPDATE minors SET population = 0, thirds = 0, destroyed = true WHERE id = $1', [id]), '23514'); // still has missiles
  await q('UPDATE minors SET population = 0, thirds = 0, missiles = 0, cash = 0, destroyed = true WHERE id = $1', [id]);
});

pgtest('popularity indices never decrease and cannot cross games', async () => {
  const g = await game({ players: 2 });
  const other = await game({ players: 1 });
  const m = await minor(g.id);
  await q('INSERT INTO minor_index (game_id, minor_id, player_id, value) VALUES ($1, $2, $3, 5)', [g.id, m, g.players[0]]);
  await fails(q('UPDATE minor_index SET value = 3 WHERE minor_id = $1', [m]), '23514');
  await q('UPDATE minor_index SET value = 5 WHERE minor_id = $1', [m]);                           // unchanged is fine
  await q('UPDATE minor_index SET value = 7 WHERE minor_id = $1', [m]);
  await fails(q('INSERT INTO minor_index (game_id, minor_id, player_id, value) VALUES ($1, $2, $3, 1)', [g.id, m, other.players[0]]), '23503');
  await fails(q('INSERT INTO minor_index (game_id, minor_id, player_id, value) VALUES ($1, $2, $3, -1)', [g.id, m, g.players[1]]), '23514');
});

// ───────────────────────── turns, sheets, messages, events ─────────────────────────

pgtest('turn constraints: one active turn per game, valid deadlines, closed turns carry a resolution time', async () => {
  const g = await game();
  const t1 = await turn(g.id, 1);
  await fails(turn(g.id, 2), '23505');                                                            // a second OPEN turn
  await fails(turn(g.id, 1, { status: 'CLOSED' }), '23505');                                      // duplicate number
  await fails(q(`INSERT INTO turns (game_id, number, type, status, deadline_at, rng_seed) VALUES ($1, 9, 'NORMAL', 'CLOSED', now() + interval '1 day', 1)`, [g.id]), '23514');
  await fails(q(`INSERT INTO turns (game_id, number, type, deadline_at, rng_seed) VALUES ($1, 9, 'NORMAL', now() - interval '1 day', 1)`, [g.id]), '23514');
  await q(`UPDATE turns SET status = 'CLOSED', resolved_at = now() WHERE id = $1`, [t1]);
  await turn(g.id, 2);                                                                            // allowed once the first is closed
});

pgtest('sheets: versioned, objects only, same-game only, and locked once resolution starts or the turn closes', async () => {
  const g = await game({ players: 2 });
  const other = await game({ players: 1 });
  const t = await turn(g.id);
  const [first] = await sheet(t, g.id, g.players[0]);
  assert.equal(first.version, 1);
  const [second] = await q(`UPDATE sheets SET payload = '{"a":1}'::jsonb WHERE id = $1 RETURNING version, updated_at`, [first.id]);
  assert.equal(second.version, 2);
  assert.ok(second.updated_at >= first.updated_at);
  await fails(q(`INSERT INTO sheets (turn_id, game_id, player_id, payload) VALUES ($1, $2, $3, '[]'::jsonb)`, [t, g.id, g.players[1]]), '23514');
  await fails(sheet(t, g.id, g.players[0]), '23505');                                              // one sheet per player per turn
  await fails(sheet(t, g.id, other.players[0]), '23503');                                          // a player from another game

  await q(`UPDATE turns SET status = 'RESOLVING' WHERE id = $1`, [t]);
  await fails(sheet(t, g.id, g.players[1], { source: 'PLAYER' }), '23514');                        // players are locked out
  await sheet(t, g.id, g.players[1], { source: 'SERVER_DEFAULT' });                                // the server may still write defaults
  await q(`UPDATE turns SET status = 'CLOSED', resolved_at = now() WHERE id = $1`, [t]);
  await fails(q(`UPDATE sheets SET payload = '{}'::jsonb WHERE id = $1`, [first.id]), '23514');
  await fails(q('DELETE FROM sheets WHERE id = $1', [first.id]), '23514');
});

pgtest('messages and news: one per sender and recipient, no self-messages, length limits', async () => {
  const g = await game({ players: 2 });
  const t = await turn(g.id);
  const msg = (from, to, text) => q(
    'INSERT INTO messages (game_id, turn_id, from_player_id, to_player_id, text) VALUES ($1, $2, $3, $4, $5)', [g.id, t, from, to, text]);
  await msg(g.players[0], g.players[1], 'hello');
  await fails(msg(g.players[0], g.players[1], 'again'), '23505');
  await fails(msg(g.players[0], g.players[0], 'me'), '23514');
  await fails(msg(g.players[1], g.players[0], ''), '23514');
  await fails(msg(g.players[1], g.players[0], 'x'.repeat(501)), '23514');
  await msg(g.players[1], g.players[0], 'x'.repeat(500));
  const news = (text) => q('INSERT INTO world_news (game_id, turn_id, from_player_id, text) VALUES ($1, $2, $3, $4)', [g.id, t, g.players[0], text]);
  await fails(news('y'.repeat(61)), '23514');
  await news('y'.repeat(60));
  await fails(news('second item'), '23505');
});

pgtest('the event log is append-only, but deleting a whole game still cleans it up', async () => {
  const g = await game({ players: 1 });
  const t = await turn(g.id);
  await q(`INSERT INTO events (game_id, turn_id, seq, type) VALUES ($1, $2, 0, 'A'), ($1, $2, 1, 'B')`, [g.id, t]);
  await fails(q(`INSERT INTO events (game_id, turn_id, seq, type) VALUES ($1, $2, 1, 'dup')`, [g.id, t]), '23505');
  await fails(q(`UPDATE events SET type = 'X' WHERE game_id = $1`, [g.id]), '23514');
  await fails(q('DELETE FROM events WHERE game_id = $1', [g.id]), '23514');
  assert.equal((await one('SELECT count(*)::int AS c FROM events WHERE game_id = $1', [g.id])).c, 2);
  await q('DELETE FROM games WHERE id = $1', [g.id]);
  assert.equal((await one('SELECT count(*)::int AS c FROM events WHERE game_id = $1', [g.id])).c, 0);
});

// ───────────────────────── privacy views ─────────────────────────

pgtest('views expose only what other players may see', async () => {
  assert.deepEqual(await columnsOf('public_players'), ['id', 'game_id', 'country', 'population', 'alive', 'forfeited']);
  assert.deepEqual(await columnsOf('public_minors'), ['id', 'game_id', 'base_name', 'generation', 'display_name', 'population', 'destroyed']);

  const g = await game({ players: 2 });
  await minor(g.id, 'CUBA', 1);
  await minor(g.id, 'CUBA', 2);
  const names = (await q('SELECT display_name FROM public_minors WHERE game_id = $1 ORDER BY generation', [g.id])).map((r) => r.display_name);
  assert.deepEqual(names, ['CUBA', 'CUBA (II)']);

  const t = await turn(g.id);
  await q('INSERT INTO messages (game_id, turn_id, from_player_id, to_player_id, text, anonymous) VALUES ($1, $2, $3, $4, $5, true)', [g.id, t, g.players[0], g.players[1], 'secret']);
  await q('INSERT INTO messages (game_id, turn_id, from_player_id, to_player_id, text, anonymous) VALUES ($1, $2, $3, $4, $5, false)', [g.id, t, g.players[1], g.players[0], 'open']);
  const inbox = await q('SELECT text, from_player_id FROM inbox_messages WHERE game_id = $1 ORDER BY text', [g.id]);
  assert.deepEqual(inbox.map((r) => [r.text, r.from_player_id === null]), [['open', false], ['secret', true]]);

  // The replay views stay empty until the game is finished.
  await sheet(t, g.id, g.players[0]);
  await q(`INSERT INTO events (game_id, turn_id, seq, type) VALUES ($1, $2, 0, 'X')`, [g.id, t]);
  assert.equal((await one('SELECT count(*)::int AS c FROM replay_events WHERE game_id = $1', [g.id])).c, 0);
  assert.equal((await one('SELECT count(*)::int AS c FROM replay_sheets WHERE game_id = $1', [g.id])).c, 0);
  await q(`UPDATE games SET status = 'FINISHED', outcome = 'DRAW' WHERE id = $1`, [g.id]);
  assert.equal((await one('SELECT count(*)::int AS c FROM replay_events WHERE game_id = $1', [g.id])).c, 1);
  assert.equal((await one('SELECT count(*)::int AS c FROM replay_sheets WHERE game_id = $1', [g.id])).c, 1);
});

// ───────────────────────── SQL rules match the resolver ─────────────────────────

pgtest('minor_controller() and listed_minors() agree with the resolver on random indices, ties and dead players', async () => {
  const g = await game({ players: 5 });
  const countries = COUNTRIES.slice(0, 5);
  const m = await minor(g.id);
  const rng = mulberry32(2026);
  for (let round = 0; round < 150; round++) {
    const values = countries.map(() => Math.floor(rng() * 4));            // 0-3: plenty of ties and zeros
    const alive = countries.map((_, i) => i === 0 || rng() > 0.3);       // at least one living player
    await q('DELETE FROM minor_index WHERE minor_id = $1', [m]);          // fresh rows: updates may not decrease
    for (let i = 0; i < 5; i++) {
      await q('UPDATE players SET alive = $2 WHERE id = $1', [g.players[i], alive[i]]);
      await q('INSERT INTO minor_index (game_id, minor_id, player_id, value) VALUES ($1, $2, $3, $4)', [g.id, m, g.players[i], values[i]]);
    }
    const state = createInitialState({ seed: 1, players: countries.map((country) => ({ country, population: 50 })) });
    countries.forEach((c, i) => { state.players[c].alive = alive[i]; state.minors['CUBA#1'].index[c] = values[i]; });

    const expectedController = controller(state.minors['CUBA#1'], state);
    const sql = await one('SELECT minor_controller($1) AS c', [m]);
    const sqlController = sql.c === null ? null : countries[g.players.findIndex((id) => String(id) === String(sql.c))];
    assert.equal(sqlController, expectedController, `round ${round}: indices ${values} alive ${alive}`);

    for (let i = 0; i < 5; i++) {
      if (!alive[i]) continue;
      const listed = (await q('SELECT listed_minors($1) AS minor_id', [g.players[i]])).map((r) => String(r.minor_id));
      assert.equal(listed.includes(String(m)), listedMinors(state, countries[i]).includes('CUBA#1'),
        `round ${round}: ${countries[i]} indices ${values} alive ${alive}`);
    }
  }
  // A destroyed minor has no controller.
  await q('UPDATE minors SET population = 0, thirds = 0, missiles = 0, cash = 0, destroyed = true WHERE id = $1', [m]);
  assert.equal((await one('SELECT minor_controller($1) AS c', [m])).c, null);
});

pgtest('email sign-in: emails are unique and lower-case, old accounts need none, and links are single-row, hashed and time-bounded', async () => {
  const tag = `${process.pid}${Date.now().toString(36)}`;
  await q('INSERT INTO users (display_name) VALUES ($1)', ['No email 1']);                         // accounts without an email are fine, and may repeat
  await q('INSERT INTO users (display_name) VALUES ($1)', ['No email 2']);
  await q('INSERT INTO users (display_name, email) VALUES ($1, $2)', ['Ada', `ada.${tag}@example.org`]);
  await fails(q('INSERT INTO users (display_name, email) VALUES ($1, $2)', ['Twin', `ada.${tag}@example.org`]), '23505');
  await fails(q('INSERT INTO users (display_name, email) VALUES ($1, $2)', ['Shouty', `ADA.${tag}@example.org`]), '23514');
  await fails(q('INSERT INTO users (display_name, email) VALUES ($1, $2)', ['Short', 'a']), '23514');

  const link = (hash, email, minutes) => q(
    `INSERT INTO login_links (token_hash, email, created_at, expires_at) VALUES ($1, $2, now(), now() + ($3 || ' minutes')::interval)`, [hash, email, String(minutes)]);
  await link(`h1-${tag}`, `ada.${tag}@example.org`, 15);
  await fails(link(`h1-${tag}`, `ada.${tag}@example.org`, 15), '23505');                            // a secret's hash is unique
  await fails(link(`h2-${tag}`, `ADA.${tag}@example.org`, 15), '23514');
  await fails(link(`h3-${tag}`, `ada.${tag}@example.org`, 0), '23514');                            // must expire after it was created
  assert.equal((await one('SELECT consumed_at FROM login_links WHERE token_hash = $1', [`h1-${tag}`])).consumed_at, null);
});
