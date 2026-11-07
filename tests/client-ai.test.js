// The screens that deal with AI players: creating a game with them, the lobby (chips, add, remove), and the players table in play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement, walk, find, textOf, byId, button, submit, click, withDom } from './support/fake-dom.js';
import { AI_STYLES, aiStyleLabel } from '../src/client/js/format.js';
import { AI_PERSONAS, PERSONAS } from '../src/ai/personas.js';
import { createLobbyView } from '../src/client/js/views/lobby.js';
import { homeView } from '../src/client/js/views/home.js';
import { playersCard } from '../src/client/js/views/panels.js';

const ME = 1;
const seat = (userId, extra = {}) => ({ userId, displayName: `Seat ${userId}`, country: null, startPopulation: null, ai: null, ...extra });
const lobbyData = (seats, { creatorId = ME, max = 9 } = {}) => ({
  lobby: {
    game: { id: 7, status: 'LOBBY', creatorId, turnNumber: null, settings: { turnDeadlineHours: 24, forfeitAfterN: 5 }, limits: { minPlayers: 3, maxPlayers: max } },
    seats, countries: [],
  },
  member: true,
});

function lobby(data, { userId = ME, failWith = null } = {}) {
  const calls = [];
  const flashes = [];
  let resyncs = 0;
  const api = {
    post: async (path, body) => { calls.push(['POST', path, body]); if (failWith) throw failWith; return {}; },
    del: async (path) => { calls.push(['DELETE', path]); if (failWith) throw failWith; return {}; },
    put: async (path, body) => { calls.push(['PUT', path, body]); return {}; },
  };
  const view = createLobbyView({ ctx: { api, session: { user: { id: userId } }, flash: (k, t) => flashes.push([k, t]) }, gameId: 7, resync: async () => { resyncs++; } });
  view.update(data);
  return { view, calls, flashes, resyncs: () => resyncs, el: view.el };
}

test('styles: the client describes exactly the play styles the server has, in the same words', () => {
  assert.deepEqual(Object.keys(AI_STYLES), AI_PERSONAS);
  for (const key of AI_PERSONAS) {
    assert.equal(AI_STYLES[key].label, PERSONAS[key].label);
    assert.equal(AI_STYLES[key].blurb, PERSONAS[key].blurb);
    assert.equal(aiStyleLabel(key), PERSONAS[key].label);
  }
  assert.equal(aiStyleLabel('SOMETHING_NEW'), 'AI', 'an unknown style still shows as an AI');
  assert.equal(aiStyleLabel(null), 'AI');
});

test('lobby: AI seats are marked with their style; only the creator can remove them or add more', withDom(async () => {
  const seats = [seat(1), seat(2, { ai: 'HAWK', displayName: 'Hawk AI' }), seat(3, { ai: 'DIPLOMAT', displayName: 'Diplomat AI' }), seat(4)];
  const creator = lobby(lobbyData(seats));
  const text = textOf(creator.el);
  assert.match(text, /AI · Hawk/);
  assert.match(text, /AI · Diplomat/);
  assert.equal(text.match(/AI ·/g).length, 2, 'people are not marked');
  assert.ok(byId(creator.el, 'ai-style'), 'the creator sees the add-AI controls');
  assert.ok(button(creator.el, 'Add AI player'));
  const removes = [];
  walk(creator.el, (n) => { if (n.tagName === 'button' && textOf(n) === 'Remove') removes.push(n); });
  assert.deepEqual(removes.map((b) => b.attrs['aria-label']), ['Remove Hawk AI', 'Remove Diplomat AI'], 'only AI seats have a Remove button');

  const guest = lobby(lobbyData(seats), { userId: 4 });
  assert.match(textOf(guest.el), /AI · Hawk/, 'everyone can see who is an AI');
  assert.equal(byId(guest.el, 'ai-style'), null);
  assert.equal(button(guest.el, 'Add AI player'), null);
  assert.equal(button(guest.el, 'Remove'), null);
}));

test('lobby: adding sends the chosen style, or nothing for a random one, then refreshes', withDom(async () => {
  const c = lobby(lobbyData([seat(1)]));
  await click(button(c.el, 'Add AI player'));
  assert.deepEqual(c.calls.at(-1), ['POST', '/api/v1/games/7/ai', {}]);
  assert.equal(c.resyncs(), 1);

  byId(c.el, 'ai-style').value = 'OPPORTUNIST';
  await click(button(c.el, 'Add AI player'));
  assert.deepEqual(c.calls.at(-1), ['POST', '/api/v1/games/7/ai', { persona: 'OPPORTUNIST' }]);
  assert.equal(c.resyncs(), 2);
}));

test('lobby: removing an AI deletes that seat, and a failure is shown without crashing', withDom(async () => {
  const c = lobby(lobbyData([seat(1), seat(2, { ai: 'HAWK', displayName: 'Hawk AI' })]));
  await click(button(c.el, 'Remove'));
  assert.deepEqual(c.calls.at(-1), ['DELETE', '/api/v1/games/7/ai/2']);
  assert.equal(c.resyncs(), 1);

  const failing = lobby(lobbyData([seat(1), seat(2, { ai: 'HAWK', displayName: 'Hawk AI' })]), { failWith: new Error('Only the creator can remove AI players') });
  await click(button(failing.el, 'Remove'));
  assert.deepEqual(failing.flashes, [['error', 'Only the creator can remove AI players']]);
  assert.equal(failing.resyncs(), 1, 'the lobby is refreshed even after a failure, so it never shows stale seats');
  await click(button(failing.el, 'Add AI player'));
  assert.equal(failing.flashes.length, 2);
}));

test('lobby: with a full table adding is disabled and says why', withDom(async () => {
  const seats = [seat(1), ...Array.from({ length: 8 }, (_, i) => seat(i + 2, { ai: 'HAWK', displayName: `Hawk AI ${i + 2}` }))];
  const c = lobby(lobbyData(seats));
  assert.ok(button(c.el, 'Add AI player').disabled);
  assert.ok(byId(c.el, 'ai-style').disabled);
  assert.match(textOf(c.el), /The game is full\./);
  assert.match(textOf(c.el), /Players \(9 of 9\)/);
}));

test('lobby: AI players count towards the players needed to start', withDom(async () => {
  const two = lobby(lobbyData([seat(1), seat(2, { ai: 'HAWK', displayName: 'Hawk AI' })]));
  assert.match(textOf(two.el), /Waiting for 1 more player/);
  assert.ok(button(two.el, 'Start game').disabled, 'cannot start with two seats');
  const three = lobby(lobbyData([seat(1), seat(2, { ai: 'HAWK', displayName: 'Hawk AI' }), seat(3, { ai: 'DIPLOMAT', displayName: 'Diplomat AI' })]));
  assert.ok(!button(three.el, 'Start game').disabled, 'three seats (one person, two AIs) can start');
}));

test('home: the create form sends the number of AI players, defaulting to none', withDom(async () => {
  const calls = [];
  const nav = [];
  const outlet = new FakeElement('main');
  const api = { get: async () => ({ games: [] }), post: async (path, body) => { calls.push([path, body]); return { gameId: 12 }; } };
  await homeView({ api, session: { user: { displayName: 'Ann' } }, outlet, navigate: (p) => nav.push(p), flash() {} });
  const ai = byId(outlet, 'ai');
  assert.equal(ai.attrs.type, 'number');
  assert.deepEqual([ai.attrs.min, ai.attrs.max], ['0', '8']);
  const form = find(outlet, (n) => n.tagName === 'form' && byId(n, 'hours'));

  await submit(form);
  assert.deepEqual(calls.at(-1), ['/api/v1/games', { turnDeadlineHours: 24, forfeitAfterN: 5, aiPlayers: 0 }]);
  ai.value = '3';
  await submit(form);
  assert.deepEqual(calls.at(-1), ['/api/v1/games', { turnDeadlineHours: 24, forfeitAfterN: 5, aiPlayers: 3 }]);
  ai.value = '';
  await submit(form);
  assert.equal(calls.at(-1)[1].aiPlayers, 0, 'blank means none');
  assert.deepEqual(nav, ['/games/12', '/games/12', '/games/12']);
}));

test('play: the players table marks AI players and their style', withDom(async () => {
  const card = playersCard([
    { country: 'FRANCE', population: 50, alive: true, forfeited: false, ai: null },
    { country: 'INDIA', population: 40, alive: true, forfeited: false, ai: 'HAWK' },
    { country: 'JAPAN', population: 0, alive: false, forfeited: false, ai: 'OPPORTUNIST' },
  ], 'FRANCE');
  const text = textOf(card);
  assert.match(text, /India.*AI · Hawk/);
  assert.match(text, /Japan.*AI · Opportunist/);
  assert.equal(text.match(/AI ·/g).length, 2);
  assert.match(text, /Eliminated/);
}));
