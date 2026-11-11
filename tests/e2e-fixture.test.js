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

test('e2e account fixture: sign-in mails can be read, and a worker pass sends turn emails on request', async () => {
  const { startAccountFixture } = await import('./e2e/account-fixture.js');
  const { port, controlPort, stop } = await startAccountFixture();
  const base = `http://127.0.0.1:${port}`;
  const control = `http://127.0.0.1:${controlPort}`;
  const post = (path, body, token) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const config = await fetch(`${base}/api/v1/auth/config`).then((r) => r.json());
    assert.deepEqual([config.emailLogin, config.openSignup], [true, false], 'email sign-in only: the browser test sees the real login screen');
    assert.deepEqual(await fetch(`${control}/mails`).then((r) => r.json()), []);

    assert.equal((await post('/api/v1/auth/email-link', { email: 'ada@example.org' })).status, 202);
    const mails = await fetch(`${control}/mails`).then((r) => r.json());
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'ada@example.org');
    const secret = /#\/verify\/([A-Za-z0-9_-]{43})/.exec(mails[0].text)[1];
    assert.ok(mails[0].text.includes(`http://127.0.0.1:${port}/#/verify/`), 'links point at the real server');
    const { token } = (await post('/api/v1/auth/verify', { token: secret, displayName: 'Ada' })).body;

    assert.equal((await fetch(`${control}/tick`, { method: 'POST' })).status, 200);
    await fetch(`${base}/api/v1/me/notifications`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ turnEmails: true }) });
    const { gameId } = (await post('/api/v1/games', { aiPlayers: 2 }, token)).body;
    await post(`/api/v1/games/${gameId}/start`, {}, token);
    await fetch(`${control}/tick`, { method: 'POST' });
    const after = await fetch(`${control}/mails`).then((r) => r.json());
    assert.equal(after.length, 2, 'the sign-in link and one turn email');
    assert.match(after[1].subject, /turn 1 is open/);
    assert.equal((await fetch(`${control}/nope`)).status, 404);
  } finally { await stop(); }
});
