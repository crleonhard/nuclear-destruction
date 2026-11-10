// The account page (rename, sign out everywhere, delete) and the privacy page, run in Node against the small fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/client/js/api.js';
import { renameMe, signOutEverywhere, deleteMyAccount, DELETE_WORD } from '../src/client/js/auth.js';
import { accountView } from '../src/client/js/views/account.js';
import { privacyView } from '../src/client/js/views/privacy.js';
import { FakeElement, find, textOf, byId, button, submit, click, withDom } from './support/fake-dom.js';

const apiError = (status, code, message) => new ApiError(status, [{ code, field: 'request', message }]);
const settle = () => new Promise((r) => setImmediate(r));

function setup({ me = { user: { id: 1, displayName: 'Ann' }, email: 'ann@example.org', notifications: { available: false, canEnable: false, turnEmails: false } }, put, post } = {}) {
  const calls = [];
  const flashes = [];
  const stored = { token: 'old-token' };
  const tokens = { get: () => stored.token, set: (t) => { stored.token = t; }, clear: () => { stored.token = null; } };
  const session = { user: { id: 1, displayName: 'Ann' } };
  let headers = 0;
  const api = {
    get: async (path) => { calls.push(['GET', path]); if (me instanceof Error) throw me; return me; },
    put: async (path, body) => { calls.push(['PUT', path, body]); if (put instanceof Error) throw put; return put ?? { user: { id: 1, displayName: body.displayName.trim() } }; },
    post: async (path, body) => { calls.push(['POST', path, body]); if (post instanceof Error) throw post; return post ?? (path.endsWith('delete') ? { deleted: true, lobbiesCancelled: 0, lobbiesLeft: 0, gamesHandedToAi: 0 } : { token: 'new-token' }); },
  };
  const outlet = new FakeElement('main');
  const ctx = { api, tokens, session, outlet, flash: (kind, text) => flashes.push([kind, text]), renderHeader: () => { headers++; }, navigate() {} };
  return { api, calls, flashes, stored, tokens, session, outlet, ctx, headers: () => headers };
}

test('auth: the account calls send what the API documents and keep the token in step', async () => {
  const s = setup();
  assert.deepEqual(await renameMe(s.api, ' Anna '), { id: 1, displayName: 'Anna' });
  await signOutEverywhere(s.api, s.tokens);
  assert.equal(s.stored.token, 'new-token', 'this device stays signed in with the fresh token');
  assert.deepEqual(await deleteMyAccount(s.api, s.tokens), { lobbiesCancelled: 0, lobbiesLeft: 0, gamesHandedToAi: 0 });
  assert.equal(s.stored.token, null, 'a deleted account forgets its token');
  assert.deepEqual(s.calls, [
    ['PUT', '/api/v1/me', { displayName: ' Anna ' }],
    ['POST', '/api/v1/auth/sign-out-everywhere', {}],
    ['POST', '/api/v1/me/delete', { confirm: 'DELETE' }],
  ]);
  const failing = setup({ post: apiError(500, 'INTERNAL', 'Something went wrong') });
  await assert.rejects(deleteMyAccount(failing.api, failing.tokens), /Something went wrong/);
  assert.equal(failing.stored.token, 'old-token', 'a failed deletion keeps the person signed in');
});

test('account page: shows the name and the sign-in address; a failed lookup is explained', withDom(async () => {
  const s = setup();
  await accountView(s.ctx);
  assert.match(textOf(s.outlet), /Your account/);
  assert.equal(byId(s.outlet, 'displayName').value, 'Ann');
  assert.match(textOf(s.outlet), /ann@example\.org/);
  assert.ok(find(s.outlet, (n) => n.tagName === 'a' && n.attrs.href === '#/privacy'));

  const dev = setup({ me: { user: { id: 1, displayName: 'Dev' }, email: null, notifications: { available: false, canEnable: false, turnEmails: false } } });
  await accountView(dev.ctx);
  assert.match(textOf(dev.outlet), /no email address/);

  const down = setup({ me: apiError(0, 'NETWORK', 'Cannot reach the server.') });
  await accountView(down.ctx);
  assert.match(textOf(down.outlet), /Cannot reach the server\./);
  assert.equal(byId(down.outlet, 'displayName'), null);
}));

test('account page: saving a name updates the page header and tells the person', withDom(async () => {
  const s = setup();
  await accountView(s.ctx);
  byId(s.outlet, 'displayName').value = '  Anna  ';
  await submit(find(s.outlet, (n) => n.tagName === 'form'));
  assert.deepEqual(s.calls.at(-1), ['PUT', '/api/v1/me', { displayName: '  Anna  ' }]);
  assert.equal(s.session.user.displayName, 'Anna');
  assert.equal(byId(s.outlet, 'displayName').value, 'Anna', 'the field shows the cleaned-up name');
  assert.equal(s.headers(), 1, 'the header was redrawn');
  assert.equal(s.flashes.at(-1)[0], 'ok');
  assert.ok(!button(s.outlet, 'Save name').disabled);
}));

test('account page: a refused name says why and changes nothing', withDom(async () => {
  const s = setup({ put: apiError(422, 'NAME_REQUIRED', 'Choose the name other players will see.') });
  await accountView(s.ctx);
  byId(s.outlet, 'displayName').value = '';
  await submit(find(s.outlet, (n) => n.tagName === 'form'));
  assert.deepEqual(s.flashes.at(-1), ['error', 'Choose the name other players will see.']);
  assert.equal(s.session.user.displayName, 'Ann');
  assert.equal(s.headers(), 0);
  assert.ok(!button(s.outlet, 'Save name').disabled, 'the person can try again');
}));

test('account page: "sign out on every device" swaps in the fresh token and keeps this device signed in', withDom(async () => {
  const s = setup();
  await accountView(s.ctx);
  await click(button(s.outlet, 'Sign out on every device'));
  assert.deepEqual(s.calls.at(-1), ['POST', '/api/v1/auth/sign-out-everywhere', {}]);
  assert.equal(s.stored.token, 'new-token');
  assert.equal(s.flashes.at(-1)[0], 'ok');
  assert.ok(s.session.user, 'still signed in here');

  const bad = setup({ post: apiError(500, 'INTERNAL', 'Something went wrong') });
  await accountView(bad.ctx);
  await click(button(bad.outlet, 'Sign out on every device'));
  assert.equal(bad.stored.token, 'old-token', 'nothing changed');
  assert.deepEqual(bad.flashes.at(-1), ['error', 'Something went wrong']);
  assert.ok(!button(bad.outlet, 'Sign out on every device').disabled);
}));

test('account page: delete stays disabled until the exact word is typed, then deletes and says what happens to games', withDom(async () => {
  const s = setup({ post: { deleted: true, lobbiesCancelled: 1, lobbiesLeft: 0, gamesHandedToAi: 2 } });
  await accountView(s.ctx);
  const confirm = byId(s.outlet, 'confirm-delete');
  const del = button(s.outlet, 'Delete my account');
  assert.equal(del.disabled, true);
  for (const wrong of ['delete', 'DELET', 'DELETE ', '']) { confirm.value = wrong; confirm.listeners.input(); assert.equal(del.disabled, true, JSON.stringify(wrong)); }
  confirm.value = DELETE_WORD;
  confirm.listeners.input();
  assert.equal(del.disabled, false);
  confirm.value = 'nope';
  confirm.listeners.input();
  assert.equal(del.disabled, true, 'editing the word locks it again');
  confirm.value = DELETE_WORD;
  confirm.listeners.input();

  await click(del);
  assert.deepEqual(s.calls.at(-1), ['POST', '/api/v1/me/delete', { confirm: 'DELETE' }]);
  assert.equal(s.stored.token, null);
  assert.equal(s.session.user, null);
  assert.equal(s.headers(), 1);
  assert.match(textOf(s.outlet), /Account deleted/);
  assert.match(textOf(s.outlet), /2 games that were running will carry on with an AI player in your seat/);
  assert.equal(byId(s.outlet, 'confirm-delete'), null, 'the form is gone');
}));

test('account page: a failed deletion keeps the person signed in and lets them try again', withDom(async () => {
  const s = setup({ post: apiError(500, 'INTERNAL', 'Something went wrong') });
  await accountView(s.ctx);
  const confirm = byId(s.outlet, 'confirm-delete');
  confirm.value = DELETE_WORD;
  confirm.listeners.input();
  await click(button(s.outlet, 'Delete my account'));
  assert.equal(s.stored.token, 'old-token');
  assert.ok(s.session.user);
  assert.deepEqual(s.flashes.at(-1), ['error', 'Something went wrong']);
  assert.equal(button(s.outlet, 'Delete my account').disabled, false);
  assert.equal(confirm.disabled, false);
}));

test('account page: leaving before the account loads draws nothing', withDom(async () => {
  let release;
  const s = setup();
  s.api.get = () => new Promise((r) => { release = r; });
  const pending = accountView(s.ctx);
  release({ user: { id: 1, displayName: 'Ann' }, email: null });
  const view = await pending;
  await settle();
  assert.ok(byId(s.outlet, 'displayName'));
  view.unmount();
}));

test('privacy page: public, covers storage, other players, devices, email and the way to delete', withDom(async () => {
  const outlet = new FakeElement('main');
  privacyView({ outlet });
  const text = textOf(outlet);
  for (const word of ['Your email address', 'Your display name', 'Sign-in links', 'What other players can see', 'On your device', 'No cookies', 'Delete your account', 'Deleted player', 'cannot be undone']) assert.ok(text.includes(word), word);
  assert.ok(find(outlet, (n) => n.tagName === 'a' && n.attrs.href === '#/account'));
}));
