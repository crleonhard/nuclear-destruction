// The turn-email screens, run in Node against the small fake DOM: the settings card on the home page and the
// one-click "stop these emails" page. The real-browser run (npm run e2e) covers the rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/client/js/api.js';
import { setTurnEmails, unsubscribeTurnEmails, looksLikeUnsubscribeToken } from '../src/client/js/auth.js';
import { loadEmailSettings } from '../src/client/js/views/email-settings.js';
import { unsubscribeView } from '../src/client/js/views/unsubscribe.js';
import { homeView } from '../src/client/js/views/home.js';
import { FakeElement, find, textOf, byId, button, click, withDom } from './support/fake-dom.js';

const TOKEN = `42.${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'}`;
const apiError = (status, code, message) => new ApiError(status, [{ code, field: 'request', message }]);
const settle = () => new Promise((r) => setImmediate(r));

function fakeApi({ me = { user: { id: 1 }, notifications: { available: true, canEnable: true, turnEmails: false } }, put, post } = {}) {
  const calls = [];
  return {
    calls,
    get: async (path) => { calls.push(['GET', path]); if (me instanceof Error) throw me; return path === '/api/v1/me' ? me : { games: [] }; },
    put: async (path, body) => { calls.push(['PUT', path, body]); if (put instanceof Error) throw put; return put ?? { turnEmails: body.turnEmails }; },
    post: async (path, body) => { calls.push(['POST', path, body]); if (post instanceof Error) throw post; return post ?? { turnEmails: false }; },
  };
}
const flashes = () => { const log = []; const flash = (kind, text) => log.push([kind, text]); return { log, flash }; };

test('auth: the stop-link token has one exact shape, and the calls send what the API documents', async () => {
  assert.equal(looksLikeUnsubscribeToken(TOKEN), true);
  for (const bad of ['', 'x', null, undefined, 42, `0.${TOKEN.split('.')[1]}`, `42.${TOKEN.split('.')[1]}x`, `42.${TOKEN.split('.')[1].slice(1)}`, `42x.${TOKEN.split('.')[1]}`, ` ${TOKEN}`]) assert.equal(looksLikeUnsubscribeToken(bad), false, String(bad));
  const api = fakeApi();
  assert.equal(await setTurnEmails(api, true), true);
  assert.equal(await setTurnEmails(api, false), false);
  await unsubscribeTurnEmails(api, TOKEN);
  assert.deepEqual(api.calls, [
    ['PUT', '/api/v1/me/notifications', { turnEmails: true }],
    ['PUT', '/api/v1/me/notifications', { turnEmails: false }],
    ['POST', '/api/v1/auth/unsubscribe', { token: TOKEN }],
  ]);
});

test('settings card: shows nothing when the server sends no email, or when the lookup fails', withDom(async () => {
  for (const me of [{ user: { id: 1 }, notifications: { available: false, canEnable: false, turnEmails: false } }, { user: { id: 1 } }, new Error('down')]) {
    const holder = new FakeElement('div');
    await loadEmailSettings({ api: fakeApi({ me }), holder, flash: () => {} });
    assert.equal(holder.kids.length, 0);
  }
}));

test('settings card: shows the current choice; ticking saves it; the answer decides what stays ticked', withDom(async () => {
  const api = fakeApi();
  const { log, flash } = flashes();
  const holder = new FakeElement('div');
  await loadEmailSettings({ api, holder, flash });
  assert.match(textOf(holder), /Email notifications/);
  assert.match(textOf(holder), /Off unless you turn it on/);
  const box = byId(holder, 'turn-emails');
  assert.equal(box.attrs.type, 'checkbox');
  assert.ok(!box.checked && !box.disabled);

  box.checked = true;
  await box.listeners.change();
  assert.deepEqual(api.calls.at(-1), ['PUT', '/api/v1/me/notifications', { turnEmails: true }]);
  assert.equal(box.checked, true);
  assert.ok(!box.disabled, 'usable again after saving');
  assert.deepEqual(log.at(-1), ['ok', 'Turn emails are on.']);

  box.checked = false;
  await box.listeners.change();
  assert.deepEqual(api.calls.at(-1), ['PUT', '/api/v1/me/notifications', { turnEmails: false }]);
  assert.deepEqual(log.at(-1), ['ok', 'Turn emails are off.']);
}));

test('settings card: starts ticked when the person already opted in', withDom(async () => {
  const holder = new FakeElement('div');
  await loadEmailSettings({ api: fakeApi({ me: { user: { id: 1 }, notifications: { available: true, canEnable: true, turnEmails: true } } }), holder, flash: () => {} });
  assert.equal(byId(holder, 'turn-emails').checked, true);
}));

test('settings card: a refused change goes back to what the server has, and says why', withDom(async () => {
  const api = fakeApi({ put: apiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.') });
  const { log, flash } = flashes();
  const holder = new FakeElement('div');
  await loadEmailSettings({ api, holder, flash });
  const box = byId(holder, 'turn-emails');
  box.checked = true;
  await box.listeners.change();
  assert.equal(box.checked, false, 'not left ticked when nothing was saved');
  assert.ok(!box.disabled);
  assert.deepEqual(log.at(-1), ['error', 'Cannot reach the server. Check your connection and try again.']);
}));

test('settings card: an account without an email address cannot tick it, and is told why', withDom(async () => {
  const holder = new FakeElement('div');
  await loadEmailSettings({ api: fakeApi({ me: { user: { id: 1 }, notifications: { available: true, canEnable: false, turnEmails: false } } }), holder, flash: () => {} });
  assert.equal(byId(holder, 'turn-emails').disabled, true);
  assert.match(textOf(holder), /need an account that signed in with an email address/);
}));

test('home: the card appears under the game lists, and a failing lookup never breaks the page', withDom(async () => {
  const outlet = new FakeElement('main');
  await homeView({ api: fakeApi(), session: { user: { displayName: 'Ann' } }, outlet, navigate() {}, flash() {} });
  assert.ok(byId(outlet, 'turn-emails'));
  assert.ok(byId(outlet, 'hours'), 'the rest of the page is still there');

  const outlet2 = new FakeElement('main');
  const api = fakeApi({ me: new Error('down') });
  await homeView({ api, session: { user: { displayName: 'Ann' } }, outlet: outlet2, navigate() {}, flash() {} });
  assert.equal(byId(outlet2, 'turn-emails'), null);
  assert.ok(byId(outlet2, 'hours'));
}));

test('stop-link page: nothing is sent until the button is pressed; then the answer is shown', withDom(async () => {
  const api = fakeApi();
  const outlet = new FakeElement('main');
  unsubscribeView({ api, outlet, params: { token: TOKEN } });
  assert.deepEqual(api.calls, [], 'opening the page alone does nothing (mail scanners open links)');
  assert.match(textOf(outlet), /Stop turn emails\?/);
  await click(button(outlet, 'Stop turn emails'));
  assert.deepEqual(api.calls, [['POST', '/api/v1/auth/unsubscribe', { token: TOKEN }]]);
  assert.match(textOf(outlet), /Turn emails are off/);
  assert.equal(button(outlet, 'Stop turn emails'), null);
}));

test('stop-link page: a bad token is explained without calling the server; a server refusal can be retried', withDom(async () => {
  const api = fakeApi();
  const outlet = new FakeElement('main');
  for (const params of [{ token: 'nonsense' }, {}]) {
    unsubscribeView({ api, outlet, params });
    assert.match(textOf(outlet), /This link cannot be used/);
    assert.equal(button(outlet, 'Stop turn emails'), null);
  }
  assert.deepEqual(api.calls, []);

  const refusing = fakeApi({ post: apiError(400, 'LINK_INVALID', 'This link is not valid.') });
  const outlet2 = new FakeElement('main');
  unsubscribeView({ api: refusing, outlet: outlet2, params: { token: TOKEN } });
  await click(button(outlet2, 'Stop turn emails'));
  assert.match(textOf(outlet2), /Could not stop the emails/);
  assert.match(textOf(outlet2), /This link is not valid\./);
  assert.ok(!button(outlet2, 'Stop turn emails').disabled, 'the person can press it again');
}));

test('stop-link page: leaving the page before the answer arrives changes nothing on screen', withDom(async () => {
  let release;
  const api = { post: () => new Promise((r) => { release = r; }) };
  const outlet = new FakeElement('main');
  const view = unsubscribeView({ api, outlet, params: { token: TOKEN } });
  const press = click(button(outlet, 'Stop turn emails')).catch(() => {});
  view.unmount();
  const before = textOf(outlet);
  release({ turnEmails: false });
  await press; await settle();
  assert.equal(textOf(outlet), before);
}));
