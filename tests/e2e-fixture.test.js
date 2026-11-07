// The browser tests' finished-game fixture, checked without a browser: it must really produce a win and a draw,
// the minted tokens must work, and the replay must be open to the players.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFinishedFixture } from './e2e/finished-fixture.js';

test('e2e fixture: a real win and a real draw, signed-in tokens that work, and an open replay', async () => {
  const { port, stop, fixture } = await startFinishedFixture();
  const base = `http://127.0.0.1:${port}`;
  const get = async (path, name) => {
    const user = fixture.users.find((u) => u.name === name);
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${user.token}` } });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.deepEqual(fixture.users.map((u) => u.name), ['Ada', 'Ben', 'Cy']);
    assert.equal((await get('/api/v1/me', 'Ada')).body.user.displayName, 'Ada');

    const win = await get(`/api/v1/games/${fixture.games.win}/replay`, 'Ben');
    assert.deepEqual([win.status, win.body.outcome, win.body.winner, win.body.seed], [200, 'WIN', 'FRANCE', 1111]);
    assert.equal(win.body.sheets.filter((s) => s.source === 'SERVER_DEFAULT').length, 2);
    assert.ok(win.body.events.some((e) => e.type === 'FORFEITED'));

    const draw = await get(`/api/v1/games/${fixture.games.draw}/replay`, 'Cy');
    assert.deepEqual([draw.status, draw.body.outcome, draw.body.winner], [200, 'DRAW', null]);

    const state = await get(`/api/v1/games/${fixture.games.win}/state`, 'Ben');
    assert.deepEqual([state.body.game.status, state.body.assets], ['FINISHED', null]);          // a forfeited player has no assets
    assert.deepEqual(state.body.public.players.map((p) => [p.country, p.alive, p.forfeited]), [['FRANCE', true, false], ['INDIA', false, true], ['JAPAN', false, true]]);
  } finally { await stop(); }
});
