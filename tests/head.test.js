// HEAD requests, as sent by uptime monitors: answered on public read-only endpoints, refused elsewhere.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, labelFor } from './support/stores.js';
import { createApp } from '../src/http/app.js';
import { createTokenAuth } from '../src/http/auth.js';

const stores = await openStore();
after(() => stores.close());

async function boot() {
  const store = stores.makeStore();
  const auth = createTokenAuth({ secret: 'a-test-secret-that-is-long-enough' });
  const app = createApp({ store, auth, logger: { error() {}, log() {}, warn() {} } });
  const server = await app.listen(0, '127.0.0.1');
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); server.closeAllConnections(); } };
}

test(`${labelFor(stores.kind)}HEAD /healthz answers 200 with the headers of GET and no body`, async () => {
  const s = await boot();
  try {
    const get = await fetch(`${s.base}/healthz`);
    const head = await fetch(`${s.base}/healthz`, { method: 'HEAD' });
    assert.equal(get.status, 200);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
    assert.equal(await head.text(), '');
    assert.deepEqual(await get.json(), { status: 'up' });
  } finally { s.close(); }
});

test(`${labelFor(stores.kind)}HEAD is answered for other public read-only endpoints, and is not a way around authentication`, async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(`${s.base}/api/v1/auth/config`, { method: 'HEAD' })).status, 200);
    for (const path of ['/api/v1/me', '/api/v1/games', '/api/v1/games/1/state', '/api/v1/games/1/stream']) {
      const r = await fetch(`${s.base}${path}`, { method: 'HEAD' });
      assert.equal(r.status, 405, `${path} must not be reachable by HEAD`);
      assert.equal(await r.text(), '');
    }
  } finally { s.close(); }
});

test(`${labelFor(stores.kind)}HEAD never triggers a write, and unknown paths are still 404`, async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(`${s.base}/api/v1/auth/email-link`, { method: 'HEAD' })).status, 405);
    assert.equal((await fetch(`${s.base}/api/v1/users`, { method: 'HEAD' })).status, 405);
    assert.equal((await fetch(`${s.base}/api/v1/nope`, { method: 'HEAD' })).status, 404);
    assert.equal((await fetch(`${s.base}/healthz`, { method: 'POST' })).status, 405, 'other methods on /healthz are still refused');
  } finally { s.close(); }
});
