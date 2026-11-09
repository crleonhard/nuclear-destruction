// Tests for the browser client's pure modules, run in Node with small fakes for fetch, storage and the DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roman, label, plural, thirdsText, countdown, describeField, prettyErrors } from '../src/client/js/format.js';
import { emptyForm, formToSheet, sheetToForm, fillMessages, committed, firedBySource, parseCount } from '../src/client/js/sheet-model.js';
import { createApi, ApiError, openStream } from '../src/client/js/api.js';
import { createTokenStore, signUp, signOut } from '../src/client/js/auth.js';
import { matchRoute, startRouter, currentPath } from '../src/client/js/router.js';
import { h, mount } from '../src/client/js/dom.js';
import { createInitialState, validateNormalSheet, validateBattleSheet } from '../src/game/index.js';

// ───────────────────────── format ─────────────────────────

test('format: names, numerals, plurals and fractions of factories', () => {
  assert.equal(roman(2), 'II'); assert.equal(roman(19), 'XIX'); assert.equal(roman(4), 'IV');
  assert.deepEqual(['FRANCE', 'USA', 'CUBA#1', 'CUBA#2', 'GUATEMALA#3', '', undefined].map(label), ['France', 'USA', 'Cuba', 'Cuba (II)', 'Guatemala (III)', '', '']);
  assert.deepEqual([plural(1, 'player'), plural(3, 'player'), plural(0, 'country', 'countries')], ['1 player', '3 players', '0 countries']);
  assert.deepEqual([27, 23, 4, 2, 1, 0].map(thirdsText), ['9', '7 2/3', '1 1/3', '2/3', '1/3', '0']);
});

test('format: the countdown reads naturally at every scale', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const at = (ms) => countdown(new Date(now + ms).toISOString(), now);
  assert.deepEqual(at(3 * 86400e3 + 5 * 3600e3), { text: '3d 5h', overdue: false, urgent: false });
  assert.equal(at(23 * 3600e3 + 59 * 60e3).text, '23h 59m');
  assert.deepEqual(at(4 * 60e3 + 7e3), { text: '4m 07s', overdue: false, urgent: true });
  assert.deepEqual(at(0), { text: 'deadline passed', overdue: true, urgent: true });
  assert.equal(at(-5000).overdue, true);
  assert.equal(countdown('not a date', now).overdue, true);
});

test('format: server error fields become plain words', () => {
  assert.equal(describeField('build.abms'), 'Build: ABM factories');
  assert.equal(describeField('giveCashToMinors.CUBA#2'), 'Cash to Cuba (II)');
  assert.equal(describeField('giveToPlayers.INDIA.factories'), 'Factories to India');
  assert.equal(describeField('messages.USA'), 'Message to USA');
  assert.equal(describeField('fire.HOME'), 'Fire from your home country');
  assert.equal(describeField('fire.TOGO#1'), 'Fire from Togo');
  assert.equal(describeField('cash'), 'Total cash given');
  assert.equal(describeField('spies'), 'Spies');
  assert.equal(describeField('request'), '');
  assert.deepEqual(prettyErrors([{ code: 'X', field: 'build', message: 'm' }]), [{ where: 'Build', message: 'm', code: 'X' }]);
});

// ───────────────────────── sheet model ─────────────────────────

test('sheet: a blank form is an empty sheet; zeros and blanks are left out', () => {
  assert.deepEqual(formToSheet(emptyForm()), { sheet: {}, problems: [] });
  const f = emptyForm();
  f.build.abms = '0'; f.minorCash['CUBA#1'] = '0'; f.players.INDIA = { cash: '0', missiles: '', factories: '0' }; f.messages.INDIA = { text: '   ', anonymous: true };
  assert.deepEqual(formToSheet(f).sheet, { build: { abms: 0 } });          // an explicit 0 build is kept, everything else is noise
});

test('sheet: a full normal form becomes exactly the JSON the API takes, and loads back unchanged', () => {
  const f = emptyForm();
  f.build = { missiles: '4', abms: '3', factories: '2' };
  f.spies[0] = { kind: 'MINOR', id: 'CUBA#1' }; f.spies[2] = { kind: 'PLAYER', id: 'INDIA' };
  f.cashEvery = '1'; f.minorCash['CUBA#1'] = '6'; f.minorMissiles['TOGO#1'] = '2';
  f.players.INDIA = { cash: '5', missiles: '', factories: '1' };
  f.offerFactory = true; f.declareWar = true;
  f.messages.INDIA = { text: ' hello ', anonymous: true };
  f.news = { text: 'peace', anonymous: false };
  const { sheet, problems } = formToSheet(f);
  assert.deepEqual(problems, []);
  assert.deepEqual(sheet, {
    build: { missiles: 4, abms: 3, factories: 2 },
    spies: [{ kind: 'MINOR', id: 'CUBA#1' }, null, { kind: 'PLAYER', id: 'INDIA' }],
    giveCashToEveryMinor: 1, giveCashToMinors: { 'CUBA#1': 6 }, giveMissilesToMinors: { 'TOGO#1': 2 },
    giveToPlayers: { INDIA: { cash: 5, factories: 1 } },
    offerFactory: true, declareWar: true,
    messages: { INDIA: { text: 'hello', anonymous: true } },
    worldNews: { text: 'peace', anonymous: false },
  });
  assert.deepEqual(formToSheet(sheetToForm(sheet)).sheet, sheet);           // the round trip is lossless
});

test('sheet: input that is not a whole number is reported, never silently changed', () => {
  assert.deepEqual([parseCount(''), parseCount(' 7 '), parseCount('1.5'), parseCount('-2'), parseCount('abc')].map((r) => Object.keys(r)[0]),
    ['empty', 'value', 'error', 'error', 'error']);
  const f = emptyForm();
  f.build.missiles = '1.5'; f.minorCash['CUBA#1'] = 'lots'; f.build.abms = '2';
  const { sheet, problems } = formToSheet(f);
  assert.deepEqual(sheet, { build: { abms: 2 } });
  assert.deepEqual(problems.map((p) => p.field), ['build.missiles', 'giveCashToMinors.CUBA#1']);
});

test('sheet: battle forms merge duplicate targets, drop zero rows, and flag a missing target', () => {
  const f = emptyForm();
  f.fire.HOME = [{ target: 'INDIA', count: '3' }, { target: 'INDIA', count: '2' }, { target: 'CUBA#1', count: '0' }, { target: '', count: '' }];
  f.fire['TOGO#1'] = [{ target: '', count: '4' }];
  const { sheet, problems } = formToSheet(f, { battle: true });
  assert.deepEqual(sheet, { fire: { HOME: { INDIA: 5 } } });
  assert.deepEqual(problems, [{ field: 'fire.TOGO#1', message: 'Row 1: choose a target.' }]);
  assert.deepEqual(firedBySource(f), { HOME: 5, 'TOGO#1': 4 });
  const normalOnly = emptyForm(); normalOnly.build.missiles = '5';
  assert.deepEqual(formToSheet(normalOnly, { battle: true }).sheet, {});    // battle sheets never carry normal-turn fields
});

test('sheet: "send the same text to everyone" fills one message per country', () => {
  const f = fillMessages(emptyForm(), ['INDIA', 'JAPAN'], 'truce?', true);
  assert.deepEqual(formToSheet(f).sheet.messages, { INDIA: { text: 'truce?', anonymous: true }, JAPAN: { text: 'truce?', anonymous: true } });
});

test('sheet: the running totals match what the server will check', () => {
  const f = emptyForm();
  f.build = { missiles: '4', abms: '3', factories: '2' };
  f.cashEvery = '2'; f.minorCash['CUBA#1'] = '5'; f.players.INDIA = { cash: '10', missiles: '3', factories: '2' };
  f.minorMissiles['TOGO#1'] = '4'; f.offerFactory = true;
  assert.deepEqual(committed(f, { survivingMinors: 18 }), { cash: 2 * 18 + 5 + 10, missiles: 4 + 3, factoriesGiven: 3, buildAssigned: 9 });
});

test('sheet: what the form produces is accepted (or rejected for the right reason) by the real rules', () => {
  const state = createInitialState({ seed: 1, players: ['FRANCE', 'INDIA', 'JAPAN'].map((country) => ({ country, population: 50 })) });
  const ok = emptyForm();
  ok.build = { missiles: '4', abms: '3', factories: '2' };
  ok.spies[0] = { kind: 'MINOR', id: 'CUBA#1' };
  ok.minorCash['CUBA#1'] = '6'; ok.players.INDIA = { cash: '5', missiles: '', factories: '1' };
  ok.messages.INDIA = { text: 'hi', anonymous: false };
  assert.deepEqual(validateNormalSheet(state, 'FRANCE', formToSheet(ok).sheet), []);

  const bad = emptyForm();
  bad.build.abms = '6'; bad.minorCash['CUBA#1'] = '101';
  const codes = validateNormalSheet(state, 'FRANCE', formToSheet(bad).sheet).map((e) => e.code).sort();
  assert.deepEqual(codes, ['ABM_CAP_EXCEEDED', 'CASH_OVER_START']);

  state.turnType = 'BATTLE';
  const war = emptyForm(); war.fire.HOME = [{ target: 'INDIA', count: '5' }];
  assert.deepEqual(validateBattleSheet(state, 'FRANCE', formToSheet(war, { battle: true }).sheet), []);
});

// ───────────────────────── api ─────────────────────────

const fakeTokens = (initial = null) => { let t = initial; return { get: () => t, set: (v) => { t = v; }, clear: () => { t = null; } }; };
const reply = (status, body) => ({ ok: status < 400, status, json: async () => { if (body === undefined) throw new Error('no body'); return body; } });

test('api: sends the token and JSON only when there is something to send', async () => {
  const calls = [];
  const api = createApi({ tokens: fakeTokens('tok'), fetchImpl: async (path, init) => { calls.push([path, init]); return reply(200, { hello: 1 }); } });
  assert.deepEqual(await api.get('/x'), { hello: 1 });
  await api.post('/y', { a: 1 });
  assert.deepEqual(calls[0][1], { method: 'GET', headers: { Authorization: 'Bearer tok' }, body: undefined });
  assert.deepEqual(calls[1][1].headers, { Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
  assert.equal(calls[1][1].body, '{"a":1}');
  const anonymous = createApi({ tokens: fakeTokens(), fetchImpl: async (p, init) => { calls.push([p, init]); return reply(200, {}); } });
  await anonymous.get('/z');
  assert.equal(calls.at(-1)[1].headers.Authorization, undefined);
});

test('api: failures become ApiError with the server\'s own error list; 401 ends the session; a dead network is explained', async () => {
  const errs = [{ code: 'BUILD_OVER_CAPACITY', field: 'build', message: 'Assigned 11 but have 9' }];
  const api = createApi({ tokens: fakeTokens('t'), fetchImpl: async () => reply(422, { errors: errs }) });
  await assert.rejects(api.put('/s', {}), (e) => e instanceof ApiError && e.status === 422 && e.errors === errs && /Assigned 11/.test(e.message));

  let signedOut = 0;
  const tokens = fakeTokens('t');
  const expired = createApi({ tokens, fetchImpl: async () => reply(401, { errors: [{ code: 'UNAUTHENTICATED', field: 'request', message: 'expired' }] }), onUnauthenticated: () => { signedOut++; } });
  await assert.rejects(expired.get('/me'), (e) => e.status === 401);
  assert.deepEqual([tokens.get(), signedOut], [null, 1]);
  const noToken = createApi({ tokens: fakeTokens(), fetchImpl: async () => reply(401, { errors: [{ code: 'UNAUTHENTICATED', field: 'request', message: 'x' }] }), onUnauthenticated: () => { signedOut++; } });
  await assert.rejects(noToken.get('/me'));
  assert.equal(signedOut, 1);                                              // a failed sign-in is not a lost session

  const down = createApi({ tokens: fakeTokens(), fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.get('/x'), (e) => e.status === 0 && e.errors[0].code === 'NETWORK' && /Cannot reach the server/.test(e.message));
  const html = createApi({ tokens: fakeTokens(), fetchImpl: async () => reply(502) });
  await assert.rejects(html.get('/x'), (e) => e.status === 502 && /Request failed \(502\)/.test(e.message));
});

test('api: the event stream passes the token in the URL, decodes events, ignores junk, and closes', () => {
  const sources = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; sources.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    close() { this.closed = true; }
  }
  const seen = [];
  const stream = openStream(12, 'a b+c', (e) => seen.push(e), FakeEventSource);
  const src = sources[0];
  assert.equal(src.url, '/api/v1/games/12/stream?token=a%20b%2Bc');
  src.listeners.turn_resolved({ data: '{"type":"turn_resolved","turnNumber":3}' });
  src.listeners.player_submitted({ data: '{"finalCount":2,"activeCount":3}' });
  src.listeners.ready({ data: 'not json' });
  assert.equal(typeof src.listeners.game_cancelled, 'function', 'a cancelled game is announced to everyone watching it');
  assert.deepEqual(seen, [{ type: 'turn_resolved', turnNumber: 3 }, { type: 'player_submitted', finalCount: 2, activeCount: 3 }, { type: 'ready' }]);
  stream.close();
  assert.equal(src.closed, true);
});

// ───────────────────────── auth ─────────────────────────

test('auth: tokens survive unavailable storage; sign-up stores the token and returns the user', async () => {
  const mem = new Map();
  const store = createTokenStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) });
  store.set('abc'); assert.equal(store.get(), 'abc'); store.clear(); assert.equal(store.get(), null);

  const broken = createTokenStore({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } });
  assert.doesNotThrow(() => { broken.set('x'); broken.clear(); });
  assert.equal(broken.get(), null);
  assert.equal(createTokenStore(undefined).get(), null);

  const tokens = fakeTokens();
  const api = { post: async (path, body) => { assert.deepEqual([path, body], ['/api/v1/users', { displayName: 'Ann' }]); return { user: { id: 4, displayName: 'Ann' }, token: 'T' }; } };
  assert.deepEqual(await signUp(api, tokens, 'Ann'), { id: 4, displayName: 'Ann' });
  assert.equal(tokens.get(), 'T');
  signOut(tokens); assert.equal(tokens.get(), null);
});

// ───────────────────────── router ─────────────────────────

test('router: patterns, parameters, decoding, and no partial matches', () => {
  const routes = [{ pattern: '/', view: 'home' }, { pattern: '/games/:id', view: 'game' }, { pattern: '/games/:id/history', view: 'history' }];
  assert.equal(matchRoute(routes, '/').route.view, 'home');
  assert.deepEqual(matchRoute(routes, '/games/12').params, { id: '12' });
  assert.equal(matchRoute(routes, '/games/12/history').route.view, 'history');
  assert.deepEqual(matchRoute(routes, '/games/a%20b').params, { id: 'a b' });
  for (const bad of ['/games', '/games/1/2/3', '/nope', '/games/%E0%A4%A']) assert.equal(matchRoute(routes, bad), null, bad);
  assert.deepEqual([currentPath(''), currentPath('#/'), currentPath('#/games/3')], ['/', '/', '/games/3']);
});

function fakeWindow(hash = '') {
  const listeners = [];
  return { location: { hash }, addEventListener: (t, fn) => { if (t === 'hashchange') listeners.push(fn); }, go(h2) { this.location.hash = h2; return Promise.all(listeners.map((fn) => fn())); } };
}

test('router: the old view is closed before the next opens, guards redirect, and a slow view that lost the race is closed too', async () => {
  const log = [];
  const view = (name, delay = 0) => async () => {
    await new Promise((r) => setTimeout(r, delay));
    log.push(`mount ${name}`);
    return { unmount: () => log.push(`unmount ${name}`) };
  };
  const win = fakeWindow('#/');
  const router = startRouter({
    routes: [{ pattern: '/', view: view('home') }, { pattern: '/games/:id', view: view('game') }, { pattern: '/slow', view: view('slow', 40) }, { pattern: '/login', view: view('login') }],
    notFound: view('missing'), ctxFor: (params) => ({ params }), win,
    guard: (path) => (path === '/private' ? '/login' : null),
  });
  await router.render();
  await win.go('#/games/2');
  await win.go('#/nowhere');
  assert.deepEqual(log, ['mount home', 'unmount home', 'mount game', 'unmount game', 'mount missing']);

  log.length = 0;
  await win.go('#/private');                       // redirected: the hash changes, which renders /login
  assert.equal(win.location.hash, '#/login');
  await router.render();
  assert.ok(log.includes('mount login'));

  log.length = 0;
  const slow = win.go('#/slow');                   // starts mounting slowly...
  win.location.hash = '#/';
  const fast = router.render();                    // ...but the user has already moved on
  await Promise.all([slow, fast]);
  assert.ok(log.includes('unmount slow'), 'the late view must be closed so its timers and streams do not leak');
  assert.ok(log.indexOf('mount home') > -1);
});

// ───────────────────────── dom ─────────────────────────

class FakeNode { constructor(nodeType) { this.nodeType = nodeType; } }
class FakeText extends FakeNode { constructor(t) { super(3); this.textContent = t; } }
class FakeElement extends FakeNode {
  constructor(tag) { super(1); this.tagName = tag; this.attrs = {}; this.kids = []; this.dataset = {}; this.listeners = {}; this.className = ''; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { this.listeners[t] = fn; }
  append(...nodes) { this.kids.push(...nodes); }
  replaceChildren() { this.kids = []; }
}

test('dom: user text is only ever text; properties, handlers and children behave', () => {
  globalThis.document = { createElement: (t) => new FakeElement(t), createTextNode: (t) => new FakeText(t) };
  try {
    const evil = '<img src=x onerror=alert(1)>';
    const el = h('div', { class: 'a b', dataset: { id: '7' }, title: evil, onClick: () => {}, disabled: true, hidden: false, value: 'v', for: null }, evil, null, false, ['x', ['y']], 3);
    assert.equal(el.className, 'a b');
    assert.equal(el.dataset.id, '7');
    assert.equal(el.attrs.title, evil);                           // an attribute value, not parsed
    assert.equal(typeof el.listeners.click, 'function');          // onClick -> "click"
    assert.equal(el.disabled, true);
    assert.equal(el.hidden, undefined);                           // false is skipped
    assert.equal(el.value, 'v');
    assert.deepEqual(el.kids.map((k) => [k.nodeType, k.textContent]), [[3, evil], [3, 'x'], [3, 'y'], [3, '3']]);
    assert.ok(el.kids.every((k) => k.nodeType === 3), 'no element was created from the text');

    const inner = h('span', {}, 'in');
    const outer = h('p', {}, inner);
    assert.equal(outer.kids[0], inner);                           // real nodes are appended as they are
    mount(outer, 'fresh', h('b', {}, 'bold'));
    assert.deepEqual(outer.kids.map((k) => k.nodeType), [3, 1]);
  } finally { delete globalThis.document; }
});
