// Cancelling a game from its lobby: only the creator sees the control, it takes two clicks, and success sends them home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byId, button, textOf, click, withDom } from './support/fake-dom.js';
import { createLobbyView } from '../src/client/js/views/lobby.js';

const ME = 1;
const seat = (userId, extra = {}) => ({ userId, displayName: `Seat ${userId}`, country: null, startPopulation: null, ai: null, ...extra });
let abandonedAfterDays = 0;
const data = (seats, creatorId = ME) => ({
  lobby: { game: { id: 7, status: 'LOBBY', creatorId, turnNumber: null, settings: { turnDeadlineHours: 24, forfeitAfterN: 5 }, limits: { minPlayers: 3, maxPlayers: 9, abandonedAfterDays } }, seats, countries: [] },
  member: true,
});

function lobby(seats, { userId = ME, failWith = null } = {}) {
  const calls = [];
  const flashes = [];
  const nav = [];
  let resyncs = 0;
  const api = {
    post: async (path, body) => { calls.push(['POST', path, body]); return {}; },
    put: async (path, body) => { calls.push(['PUT', path, body]); return {}; },
    del: async (path) => { calls.push(['DELETE', path]); if (failWith) throw failWith; return {}; },
  };
  const view = createLobbyView({
    ctx: { api, session: { user: { id: userId } }, flash: (k, t) => flashes.push([k, t]), navigate: (p) => nav.push(p) },
    gameId: 7,
    resync: async () => { resyncs++; },
  });
  view.update(data(seats));
  return { el: view.el, calls, flashes, nav, resyncs: () => resyncs };
}

const people = [seat(1), seat(2), seat(3)];

test('cancel: only the creator is offered it', withDom(async () => {
  assert.ok(button(lobby(people).el, 'Cancel game'));
  assert.match(textOf(lobby(people).el), /Cancelling frees one of your places/);
  const guest = lobby(people, { userId: 2 });
  assert.equal(button(guest.el, 'Cancel game'), null);
  assert.equal(button(guest.el, 'Yes, cancel the game'), null);
}));

test('cancel: the first click only asks; nothing is sent until the second', withDom(async () => {
  const c = lobby(people);
  await click(button(c.el, 'Cancel game'));
  assert.deepEqual(c.calls, [], 'asking sends nothing');
  assert.match(textOf(c.el), /removes the game, everyone's seats and any AI players/);
  assert.ok(button(c.el, 'Yes, cancel the game'));
  assert.equal(button(c.el, 'Cancel game'), null, 'the first button is replaced by the question');

  await click(button(c.el, 'Keep it'));
  assert.deepEqual(c.calls, []);
  assert.ok(button(c.el, 'Cancel game'), 'back to the start');
  assert.doesNotMatch(textOf(c.el), /cannot be undone/);
}));

test('cancel: confirming deletes the game, says so, and sends the creator to their games', withDom(async () => {
  const c = lobby(people);
  await click(button(c.el, 'Cancel game'));
  await click(button(c.el, 'Yes, cancel the game'));
  assert.deepEqual(c.calls, [['DELETE', '/api/v1/games/7']]);
  assert.deepEqual(c.flashes, [['ok', 'Game cancelled.']]);
  assert.deepEqual(c.nav, ['/']);
  assert.equal(c.resyncs(), 0, 'it does not reload a game that no longer exists');
}));

test('cancel: a failure is shown, the question is dismissed and the lobby is refreshed', withDom(async () => {
  const c = lobby(people, { failWith: new Error('A game that has started cannot be cancelled') });
  await click(button(c.el, 'Cancel game'));
  await click(button(c.el, 'Yes, cancel the game'));
  assert.deepEqual(c.flashes, [['error', 'A game that has started cannot be cancelled']]);
  assert.deepEqual(c.nav, [], 'they stay where they are');
  assert.equal(c.resyncs(), 1);
}));

test('cancel: it sits alongside the AI controls without interfering with them', withDom(async () => {
  const c = lobby([seat(1), seat(2, { ai: 'HAWK', displayName: 'Hawk AI' }), seat(3, { ai: 'DIPLOMAT', displayName: 'Diplomat AI' })]);
  assert.ok(byId(c.el, 'ai-style'));
  assert.ok(button(c.el, 'Cancel game'));
  assert.ok(button(c.el, 'Add AI player'));
  await click(button(c.el, 'Cancel game'));
  assert.ok(button(c.el, 'Add AI player'), 'asking to cancel does not remove other controls');
}));

test('cancel: the creator is told when idle lobbies are removed automatically, with the number of days the server uses', withDom(async () => {
  try {
    abandonedAfterDays = 14;
    assert.match(textOf(lobby(people).el), /A game nobody joins for 14 days is removed automatically\./);
    abandonedAfterDays = 1;
    assert.match(textOf(lobby(people).el), /nobody joins for 1 day is removed/);
    abandonedAfterDays = 0;
    assert.doesNotMatch(textOf(lobby(people).el), /removed automatically/, 'nothing is promised when the server never removes lobbies');
    abandonedAfterDays = 14;
    assert.doesNotMatch(textOf(lobby(people, { userId: 2 }).el), /removed automatically/, 'guests have no cancel card, so no sentence about it');
  } finally { abandonedAfterDays = 0; }
}));
