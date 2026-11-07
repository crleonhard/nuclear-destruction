// Static checks on the browser client and how the server delivers it. No browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../src/store/memory.js';
import { createApp, CONTENT_SECURITY_POLICY } from '../src/http/app.js';
import { createTokenAuth } from '../src/http/auth.js';
import { openapi } from '../src/http/openapi.js';

const CLIENT = fileURLToPath(new URL('../src/client/', import.meta.url));
const files = readdirSync(CLIENT, { recursive: true }).filter((f) => /\.(js|css|html)$/.test(f)).map((f) => f.split(path.sep).join('/')).sort();
const js = files.filter((f) => f.endsWith('.js'));
const read = (f) => readFileSync(path.join(CLIENT, f), 'utf8');

async function serve() {
  const app = createApp({ store: createMemoryStore(), auth: createTokenAuth({ secret: 'a-test-secret-long-enough' }), logger: { error() {} } });
  const server = await app.listen(0, '127.0.0.1');
  return { base: `http://127.0.0.1:${server.address().port}`, close: async () => { server.close(); server.closeAllConnections(); } };
}

// ───────────────────────── What is served, and how ─────────────────────────

test('serving: the page, scripts and styles come with the right types and a strict policy', async () => {
  const s = await serve();
  try {
    for (const [url, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/js/main.js', 'text/javascript'], ['/css/app.css', 'text/css']]) {
      const res = await fetch(s.base + url);
      assert.equal(res.status, 200, url);
      assert.ok(res.headers.get('content-type').startsWith(type), `${url}: ${res.headers.get('content-type')}`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      await res.arrayBuffer();
    }
    const head = await fetch(`${s.base}/js/main.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()), '');
    assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(CONTENT_SECURITY_POLICY));
    assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  } finally { await s.close(); }
});

test('serving: nothing outside the client folder can be reached, and the API is not shadowed', async () => {
  const s = await serve();
  try {
    const attempts = ['/../package.json', '/%2e%2e/package.json', '/js/../../package.json', '/js/%2e%2e/%2e%2e/package.json', '/..%2fpackage.json',
      '/js%5c..%5c..%5cpackage.json', '/index.html%00.js', '/%00', '/js/', '/js', '/css', '/package.json', '/src/server.js', '/js/main.js.map', '/.env', '/%E0%A4%A'];
    for (const a of attempts) {
      const res = await fetch(s.base + a);
      const body = await res.text();
      assert.equal(res.status, 404, `${a} -> ${res.status}`);
      assert.deepEqual(JSON.parse(body).errors[0].code, 'NOT_FOUND', a);
      assert.ok(!body.includes('"name"') && !body.includes('nuclear-destruction'), `${a} leaked a file`);
    }
    assert.equal((await fetch(`${s.base}/api/v1/me`)).status, 401);           // still the API's own answer
    assert.equal((await fetch(`${s.base}/api/v1/nope`)).status, 404);
    assert.deepEqual(await (await fetch(`${s.base}/healthz`)).json(), { status: 'up' });
    assert.equal((await (await fetch(`${s.base}/openapi.json`)).json()).openapi, '3.1.0');
    assert.equal((await fetch(s.base, { method: 'POST' })).status, 404);      // only GET and HEAD serve files
  } finally { await s.close(); }
});

// ───────────────────────── The client is well-formed ─────────────────────────

test('client: every file parses, and every import resolves to a file inside the client', () => {
  assert.ok(js.length >= 14, `found ${js.length} scripts`);
  for (const f of js) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(CLIENT, f)], { stdio: 'pipe' }), `${f} has a syntax error`);
    for (const [, spec] of read(f).matchAll(/(?:from\s+|import\s*\()\s*'([^']+)'/g)) {
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${f}: "${spec}" must be a relative import (there is no bundler)`);
      const target = path.resolve(path.dirname(path.join(CLIENT, f)), spec);
      assert.ok(target.startsWith(CLIENT) && existsSync(target), `${f}: import "${spec}" does not exist`);
    }
  }
  const html = read('index.html');
  for (const [, src] of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) assert.ok(existsSync(path.join(CLIENT, src)), `index.html references missing ${src}`);
});

test('client: every script is reachable through the server', async () => {
  const s = await serve();
  try {
    for (const f of files) {
      const res = await fetch(`${s.base}/${f}`);
      assert.equal(res.status, 200, f);
      await res.arrayBuffer();
    }
  } finally { await s.close(); }
});

test('client: nothing that could turn player-written text into markup or code', () => {
  const forbidden = [/\binnerHTML\b/, /\bouterHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/, /setTimeout\s*\(\s*['"`]/, /setInterval\s*\(\s*['"`]/, /javascript:/i, /\.srcdoc\b/];
  for (const f of js) {
    const code = read(f);
    for (const re of forbidden) assert.ok(!re.test(code), `${f} uses ${re}`);
  }
  const html = read('index.html');
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), 'inline <script> in index.html');
  assert.ok(!/\sstyle\s*=/i.test(html), 'inline style attribute in index.html');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler in index.html');
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(read('css/app.css')), 'stylesheet loads something from elsewhere');
  assert.ok(!/https?:\/\//.test(js.map(read).join('\n').replace(/https?:\/\/\S*(?:example|localhost)\S*/g, '')), 'a script references an external URL');
});

// ───────────────────────── The client matches the API contract ─────────────────────────

test('client: every API call it makes exists in the OpenAPI spec, with the right method', () => {
  const spec = new Set(Object.entries(openapi.paths).flatMap(([p, item]) => ['get', 'post', 'put', 'delete'].filter((m) => item[m]).map((m) => `${m} ${p}`)));
  const verb = { get: 'get', post: 'post', put: 'put', del: 'delete' };
  const found = new Set();
  for (const f of js) {
    for (const [, v, raw] of read(f).matchAll(/api\.(get|post|put|del)\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      const p = raw.replace(/\$\{base\}/g, '/api/v1/games/{id}').replace(/\$\{[^}]+\}/g, '{id}');
      assert.ok(spec.has(`${verb[v]} ${p}`), `${f}: ${v.toUpperCase()} ${raw} is not in the API spec`);
      found.add(`${verb[v]} ${p}`);
    }
  }
  // The live stream is opened with EventSource rather than api.*, so check it by hand.
  assert.ok(read('js/api.js').includes('/api/v1/games/${gameId}/stream'));
  assert.ok(spec.has('get /api/v1/games/{id}/stream'));
  // Every game action a player can take is used somewhere in the client.
  for (const op of ['post /api/v1/users', 'get /api/v1/auth/config', 'post /api/v1/auth/email-link', 'post /api/v1/auth/verify', 'get /api/v1/me', 'get /api/v1/games', 'post /api/v1/games', 'get /api/v1/games/{id}/lobby', 'post /api/v1/games/{id}/join',
    'put /api/v1/games/{id}/country', 'delete /api/v1/games/{id}/membership', 'put /api/v1/games/{id}/population', 'post /api/v1/games/{id}/start',
    'get /api/v1/games/{id}/state', 'get /api/v1/games/{id}/turn', 'get /api/v1/games/{id}/sheet', 'post /api/v1/games/{id}/sheet/validate',
    'put /api/v1/games/{id}/sheet', 'post /api/v1/games/{id}/sheet/submit', 'get /api/v1/games/{id}/history', 'get /api/v1/games/{id}/replay']) {
    assert.ok(found.has(op), `the client never calls ${op}`);
  }
});
