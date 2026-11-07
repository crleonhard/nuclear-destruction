// The sign-in screens, run in Node against a small fake DOM (no browser needed): what each state shows, what it
// sends to the server, and what it does with the answer. The real-browser run (npm run e2e) covers the rest.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/client/js/dom.js';
import { ApiError } from '../src/client/js/api.js';
import { getAuthConfig, requestEmailLink, completeEmailLink, looksLikeLinkSecret, errorCode } from '../src/client/js/auth.js';
import { loginView } from '../src/client/js/views/login.js';
import { verifyView } from '../src/client/js/views/verify.js';
import { startRouter } from '../src/client/js/router.js';

// ───────────────────────── a tiny DOM ─────────────────────────

class FakeText { constructor(t) { this.nodeType = 3; this.textContent = t; } }
class FakeElement {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.attrs = {}; this.kids = []; this.dataset = {}; this.listeners = {}; this.className = ''; this.focused = false; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { this.listeners[t] = fn; }
  append(...nodes) { this.kids.push(...nodes); }
  replaceChildren() { this.kids = []; }
  focus() { this.focused = true; }
}
const walk = (node, fn) => { fn(node); for (const k of node.kids ?? []) walk(k, fn); };
const find = (root, pred) => { let hit = null; walk(root, (n) => { if (!hit && n.nodeType === 1 && pred(n)) hit = n; }); return hit; };
const textOf = (root) => { let t = ''; walk(root, (n) => { if (n.nodeType === 3) t += n.textContent; }); return t; };
const byId = (root, id) => find(root, (n) => n.attrs.id === id);
const button = (root, label) => find(root, (n) => n.tagName === 'button' && textOf(n) === label);
const submit = async (form) => { await form.listeners.submit({ preventDefault() {} }); await new Promise((r) => setImmediate(r)); };
const click = async (el) => { await el.listeners.click(); await new Promise((r) => setImmediate(r)); };

function withDom(fn) {
  return async (t) => {
    globalThis.document = { createElement: (tag) => new FakeElement(tag), createTextNode: (x) => new FakeText(x) };
    try { await fn(t); } finally { delete globalThis.document; }
  };
}

const fakeTokens = (initial = null) => { let v = initial; return { get: () => v, set: (x) => { v = x; }, clear: () => { v = null; } }; };
const apiError = (status, code, message) => new ApiError(status, [{ code, field: 'request', message }]);

function context({ responses = {}, tokens = fakeTokens(), user = null, params = {} } = {}) {
  const calls = [];
  const flashes = [];
  const nav = [];
  const outlet = new FakeElement('main');
  const session = { user };
  const api = {
    get: async (path) => { calls.push(['GET', path]); return respond('GET', path); },
    post: async (path, body) => { calls.push(['POST', path, body]); return respond('POST', path); },
  };
  const respond = (method, path) => {
    const r = responses[`${method} ${path}`];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r ?? {};
  };
  return {
    ctx: { api, tokens, session, outlet, params, flash: (kind, text) => flashes.push([kind, text]), renderHeader() { session.rendered = true; }, navigate: (p) => nav.push(['navigate', p]), replace: (p) => nav.push(['replace', p]) },
    calls, flashes, nav, outlet, session, tokens,
  };
}
const settle = () => new Promise((r) => setImmediate(r));
const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
assert.equal(SECRET.length, 43);

// ───────────────────────── auth module ─────────────────────────

test('auth: the link secret has one exact shape; the calls send exactly what the API documents', async () => {
  assert.equal(looksLikeLinkSecret(SECRET), true);
  for (const bad of ['', 'short', `${SECRET}x`, `${SECRET.slice(1)}!`, null, undefined, 42, `${SECRET.slice(0, 42)} `]) assert.equal(looksLikeLinkSecret(bad), false, String(bad));

  const calls = [];
  const api = { get: async (p) => { calls.push(['GET', p]); return { emailLogin: true, openSignup: false }; }, post: async (p, b) => { calls.push(['POST', p, b]); return { user: { id: 3, displayName: 'Ada' }, token: 'T' }; } };
  assert.deepEqual(await getAuthConfig(api), { emailLogin: true, openSignup: false });
  await requestEmailLink(api, '  ada@example.org ');
  const tokens = fakeTokens();
  assert.deepEqual(await completeEmailLink(api, tokens, SECRET), { id: 3, displayName: 'Ada' });
  assert.equal(tokens.get(), 'T');
  await completeEmailLink(api, tokens, SECRET, '  Ada  ');
  assert.deepEqual(calls, [
    ['GET', '/api/v1/auth/config'],
    ['POST', '/api/v1/auth/email-link', { email: 'ada@example.org' }],
    ['POST', '/api/v1/auth/verify', { token: SECRET }],                       // no name unless one was typed
    ['POST', '/api/v1/auth/verify', { token: SECRET, displayName: 'Ada' }],
  ]);
  assert.equal(errorCode(apiError(422, 'NAME_REQUIRED', 'x')), 'NAME_REQUIRED');
  assert.equal(errorCode(new Error('plain')), null);
});

test('auth: a failed sign-in does not touch the stored token', async () => {
  const tokens = fakeTokens('existing');
  const api = { post: async () => { throw apiError(400, 'LINK_INVALID', 'expired'); } };
  await assert.rejects(completeEmailLink(api, tokens, SECRET), (e) => errorCode(e) === 'LINK_INVALID');
  assert.equal(tokens.get(), 'existing');
});

// ───────────────────────── the login screen ─────────────────────────

test('login: with email sign-in on, it asks for an email address, sends it, and then says to check the inbox', withDom(async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const c = context({ responses: { 'GET /api/v1/auth/config': { emailLogin: true, openSignup: true } } });
  const view = loginView(c.ctx);
  await settle();
  const input = byId(c.outlet, 'email');
  assert.ok(input, 'an email field is shown');
  assert.equal(input.attrs.type, 'email');
  assert.equal(input.focused, true);
  assert.equal(byId(c.outlet, 'displayName'), null, 'the development name sign-up is not offered next to the real one');

  input.value = '  ada@example.org ';
  await submit(find(c.outlet, (n) => n.tagName === 'form'));
  assert.deepEqual(c.calls.at(-1), ['POST', '/api/v1/auth/email-link', { email: 'ada@example.org' }]);
  assert.match(textOf(c.outlet), /Check your email/);
  assert.match(textOf(c.outlet), /ada@example\.org/);

  const again = button(c.outlet, 'Send another link');
  assert.equal(again.disabled, true, 'resending is held back at first');
  mock.timers.tick(30_000);
  assert.equal(again.disabled, false);
  await click(again);
  assert.equal(c.calls.filter((x) => x[1] === '/api/v1/auth/email-link').length, 2);
  assert.equal(again.disabled, true, 'and held back again after each send');
  assert.deepEqual(c.flashes.at(-1), ['ok', 'Another link is on its way.']);

  await click(button(c.outlet, 'Use a different address'));
  assert.equal(byId(c.outlet, 'email').value, 'ada@example.org', 'the address is kept for editing');
  view.unmount();
}));

test('login: a refused address shows the server\'s own message and leaves the form usable', withDom(async () => {
  const c = context({ responses: {
    'GET /api/v1/auth/config': { emailLogin: true, openSignup: false },
    'POST /api/v1/auth/email-link': apiError(422, 'EMAIL_INVALID', 'Enter a valid email address'),
  } });
  loginView(c.ctx);
  await settle();
  byId(c.outlet, 'email').value = 'nope';
  const form = find(c.outlet, (n) => n.tagName === 'form');
  await submit(form);
  assert.deepEqual(c.flashes.at(-1), ['error', 'Enter a valid email address']);
  assert.notEqual(button(c.outlet, 'Email me a sign-in link').disabled, true);
  assert.doesNotMatch(textOf(c.outlet), /Check your email/);

  byId(c.outlet, 'email').value = '   ';
  const before = c.calls.length;
  await submit(form);
  assert.equal(c.calls.length, before, 'a blank address is not even sent');
}));

test('login: development sign-up by name still works when that is all the server offers', withDom(async () => {
  const c = context({ responses: {
    'GET /api/v1/auth/config': { emailLogin: false, openSignup: true },
    'POST /api/v1/users': { user: { id: 1, displayName: 'Ann' }, token: 'TOK' },
  } });
  loginView(c.ctx);
  await settle();
  assert.equal(byId(c.outlet, 'email'), null);
  byId(c.outlet, 'displayName').value = ' Ann ';
  await submit(find(c.outlet, (n) => n.tagName === 'form'));
  assert.deepEqual(c.calls.at(-1), ['POST', '/api/v1/users', { displayName: 'Ann' }]);
  assert.equal(c.tokens.get(), 'TOK');
  assert.deepEqual(c.session.user, { id: 1, displayName: 'Ann' });
  assert.deepEqual(c.nav, [['navigate', '/']]);
}));

test('login: a server with no sign-in at all, and one that cannot be reached, are explained', withDom(async () => {
  const none = context({ responses: { 'GET /api/v1/auth/config': { emailLogin: false, openSignup: false } } });
  loginView(none.ctx);
  await settle();
  assert.match(textOf(none.outlet), /not available on this server/);

  let up = false;
  const down = context({ responses: { 'GET /api/v1/auth/config': () => { if (!up) throw apiError(0, 'NETWORK', 'Cannot reach the server.'); return { emailLogin: true, openSignup: false }; } } });
  loginView(down.ctx);
  await settle();
  assert.match(textOf(down.outlet), /Cannot reach the server/);
  up = true;
  await click(button(down.outlet, 'Try again'));
  assert.ok(byId(down.outlet, 'email'), 'trying again loads the form');
}));

test('login: leaving the screen while it loads draws nothing afterwards', withDom(async () => {
  let release;
  const c = context({ responses: { 'GET /api/v1/auth/config': () => new Promise((r) => { release = () => r({ emailLogin: true, openSignup: false }); }) } });
  c.ctx.api.get = async () => { await new Promise((r) => { release = r; }); return { emailLogin: true, openSignup: false }; };
  const view = loginView(c.ctx);
  view.unmount();
  release();
  await settle();
  assert.equal(byId(c.outlet, 'email'), null);
}));

// ───────────────────────── the page the emailed link opens ─────────────────────────

test('verify: nothing is sent until the button is pressed, and the secret is never shown', withDom(async () => {
  const c = context({ params: { token: SECRET } });
  verifyView(c.ctx);
  assert.equal(c.calls.length, 0, 'opening the page uses up nothing');
  assert.match(textOf(c.outlet), /Finish signing in/);
  assert.ok(!textOf(c.outlet).includes(SECRET));
  walk(c.outlet, (n) => { if (n.attrs) for (const v of Object.values(n.attrs)) assert.ok(!String(v).includes(SECRET)); });
}));

test('verify: a returning player clicks once, is signed in, and the used link is replaced in history', withDom(async () => {
  const c = context({ params: { token: SECRET }, responses: { 'POST /api/v1/auth/verify': { user: { id: 9, displayName: 'Ada' }, token: 'TOK9' } } });
  verifyView(c.ctx);
  await submit(find(c.outlet, (n) => n.tagName === 'form'));
  assert.deepEqual(c.calls, [['POST', '/api/v1/auth/verify', { token: SECRET }]]);
  assert.equal(c.tokens.get(), 'TOK9');
  assert.deepEqual(c.session.user, { id: 9, displayName: 'Ada' });
  assert.equal(c.session.rendered, true);
  assert.deepEqual(c.nav, [['replace', '/']], 'replace, not navigate: Back must not return to the used link');
}));

test('verify: a first-time player is asked for a name, and the same link then works', withDom(async () => {
  let named = false;
  const c = context({ params: { token: SECRET }, responses: { 'POST /api/v1/auth/verify': () => {
    if (!named) throw apiError(422, 'NAME_REQUIRED', 'Choose the name other players will see.');
    return { user: { id: 10, displayName: 'Grace' }, token: 'TOK10' };
  } } });
  verifyView(c.ctx);
  const form = find(c.outlet, (n) => n.tagName === 'form');
  await submit(form);
  assert.deepEqual(c.flashes.at(-1), ['info', 'Choose the name other players will see.']);
  assert.equal(byId(c.outlet, 'displayName').focused, true);
  assert.equal(c.tokens.get(), null);
  assert.deepEqual(c.nav, []);
  assert.notEqual(button(c.outlet, 'Sign in').disabled, true, 'the button works again');

  byId(c.outlet, 'displayName').value = ' Grace ';
  named = true;
  await submit(form);
  assert.deepEqual(c.calls.at(-1), ['POST', '/api/v1/auth/verify', { token: SECRET, displayName: 'Grace' }]);
  assert.equal(c.tokens.get(), 'TOK10');
  assert.deepEqual(c.nav, [['replace', '/']]);
}));

test('verify: a used or expired link says so and offers a new one, and any stale session is cleared first', withDom(async () => {
  const tokens = fakeTokens('stale');
  const c = context({ tokens, user: { id: 1, displayName: 'Old' }, params: { token: SECRET }, responses: { 'POST /api/v1/auth/verify': apiError(400, 'LINK_INVALID', 'This sign-in link has expired or was already used. Ask for a new one.') } });
  verifyView(c.ctx);
  assert.match(textOf(c.outlet), /signed in as Old/, 'someone already signed in is told that continuing switches accounts');
  await submit(find(c.outlet, (n) => n.tagName === 'form'));
  assert.match(textOf(c.outlet), /cannot be used/);
  assert.match(textOf(c.outlet), /expired or was already used/);
  assert.equal(tokens.get(), 'stale', 'a failed link changes nothing');
  await click(button(c.outlet, 'Get a new link'));
  assert.deepEqual(c.nav, [['navigate', '/login']]);
  assert.equal(tokens.get(), null, 'so the login screen is reachable');
  assert.equal(c.session.user, null);
}));

test('verify: a malformed or missing link makes no request and explains itself', withDom(async () => {
  for (const [params, pattern] of [[{ token: 'nonsense' }, /not a sign-in link from this site/], [{}, /Open the link from your sign-in email/]]) {
    const c = context({ params });
    verifyView(c.ctx);
    assert.match(textOf(c.outlet), pattern);
    assert.equal(c.calls.length, 0);
    assert.ok(button(c.outlet, 'Get a new link'));
  }
}));

test('verify: other failures (network, rate limit) keep the page and the link, and say what happened', withDom(async () => {
  const c = context({ params: { token: SECRET }, responses: { 'POST /api/v1/auth/verify': apiError(429, 'RATE_LIMITED', 'Too many requests; try again later') } });
  verifyView(c.ctx);
  await submit(find(c.outlet, (n) => n.tagName === 'form'));
  assert.deepEqual(c.flashes.at(-1), ['error', 'Too many requests; try again later']);
  assert.match(textOf(c.outlet), /Finish signing in/);
  assert.notEqual(button(c.outlet, 'Sign in').disabled, true);
}));

// ───────────────────────── router ─────────────────────────

test('router: replace() swaps the current address instead of adding one, with a fallback for simple windows', async () => {
  const listeners = {};
  const replaced = [];
  const win = { location: { hash: '#/verify/x', replace: (u) => replaced.push(u) }, addEventListener: (e, f) => { listeners[e] = f; } };
  const router = startRouter({ routes: [], notFound: async () => ({}), guard: () => null, ctxFor: () => ({}), win });
  router.replace('/');
  assert.deepEqual(replaced, ['#/']);
  const plain = { location: { hash: '#/a' }, addEventListener() {} };
  startRouter({ routes: [], notFound: async () => ({}), guard: () => null, ctxFor: () => ({}), win: plain }).replace('/b');
  assert.equal(plain.location.hash, '#/b');
});
