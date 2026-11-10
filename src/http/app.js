// HTTP layer: routing, auth, JSON handling, rate limiting, SSE. Built on node:http only.
//
// createApp({ store, auth }) returns { handle, listen, notify, hub }.
//   handle(req, res)  — plug into http.createServer, or wrap in any framework
//   notify(gameId, event) — push an event to SSE clients (the deadline worker uses this)
//
// Every error body looks like { errors: [{ code, field, message }] }.
// Nothing here knows game rules: it authenticates, parses, calls the pipeline or lobby, and replies.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import {
  startGame, submitSheet, getPackage, getSheetView, dryRunSheet, getHistory, getReplay,
} from '../app/pipeline.js';
import {
  createGame, joinGame, pickCountry, leaveGame, setStartPopulation, getLobby, myGames, addAiPlayer, removeAiPlayer, cancelGame,
} from '../app/lobby.js';
import { openapi } from './openapi.js';

export class HttpError extends Error {
  constructor(status, code, message, field = 'request') {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const BODY_LIMIT = 256 * 1024;

// The browser client is plain files served as-is. Only these types are ever served, and the CSP lets the page
// load scripts and styles from this origin only (so there is no inline script or style anywhere in the client).
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const err = (status, code, message, field) => new HttpError(status, code, message, field);

function compile(path) {
  const parts = path.split('/').filter(Boolean);
  return {
    parts,
    match(pathname) {
      const segs = pathname.split('/').filter(Boolean);
      if (segs.length !== parts.length) return null;
      const params = {};
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith(':')) {
          try { params[parts[i].slice(1)] = decodeURIComponent(segs[i]); } catch { return null; } // bad %-escape => 404
        } else if (parts[i] !== segs[i]) return null;
      }
      return params;
    },
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw err(413, 'PAYLOAD_TOO_LARGE', `Body must be under ${BODY_LIMIT / 1024} KB`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  if (!/\bjson\b/i.test(req.headers['content-type'] ?? '')) {
    throw err(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send Content-Type: application/json');
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw err(400, 'BAD_JSON', 'Body is not valid JSON'); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw err(400, 'BAD_JSON', 'Body must be a JSON object');
  return body;
}

export function createApp({
  store,
  auth,                       // { authenticate(req, url) -> userId|null, issue?(userId) -> token }
  now = () => new Date(),
  allowSignup = false,        // POST /users mints accounts; keep off in production unless you want open sign-up
  login = null,               // email-link sign-in: { requestLink({ email }), verifyLink({ token, displayName }) } (see login.js)
  notifications = null,       // opt-in turn emails: { preferences(userId), setTurnEmails(userId, enabled), unsubscribe(token) } (see ../app/notifications.js)
  authLimit = { max: 20, windowMs: 15 * 60_000 },   // per client address, for each of the two sign-in endpoints
  trustProxy = false,         // true only behind a reverse proxy you control: the client address is then read from X-Forwarded-For
  maxOpenGamesPerUser = 3,    // unfinished games one person may have created at once (0 = no limit)
  clientIpHeader = null,      // behind a proxy that puts the visitor's address in one header (Render/Cloudflare: "cf-connecting-ip"); wins over trustProxy
  corsOrigin = null,          // e.g. 'https://game.example.com'
  writeLimit = { max: 60, windowMs: 60_000 },
  heartbeatMs = 25_000,
  staticDir = new URL('../client/', import.meta.url), // the browser client; null turns static serving off
  logger = console,
}) {
  const staticRoot = staticDir ? path.resolve(typeof staticDir === 'string' ? staticDir : fileURLToPath(staticDir)) : null;
  const hub = new EventEmitter();
  hub.setMaxListeners(0);
  const notify = (gameId, event) => hub.emit(`game:${gameId}`, event);

  const routes = [];
  const route = (method, path, handler, { auth: needsAuth = true } = {}) => {
    routes.push({ method, path, ...compile(path), handler, needsAuth });
  };
  const gameId = (p) => {
    const id = Number(p.id);
    if (!Number.isSafeInteger(id) || id < 1) throw err(404, 'NOT_FOUND', 'No such game');
    return id;
  };
  const str = (v, field, max = 100) => {
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) {
      throw err(422, 'NOT_INTEGER', `${field} must be a non-empty string up to ${max} characters`, field);
    }
    return v.trim();
  };

  // ── Rate limiting for writes (per user, fixed window) ──
  const windows = new Map();
  const limited = (userId) => {
    const t = now().getTime();
    const w = windows.get(userId);
    if (!w || t - w.start >= writeLimit.windowMs) { windows.set(userId, { start: t, n: 1 }); return false; }
    w.n += 1;
    return w.n > writeLimit.max;
  };

  // ── Rate limiting for the sign-in endpoints (per client address, fixed window) ──
  const authWindows = new Map();
  const clientAddress = (req) => {
    if (clientIpHeader) {
      // The proxy sets this header itself, so it is trusted as given; anything that is not an IP address is ignored.
      const first = String(req.headers[clientIpHeader] ?? '').split(',')[0].trim();
      if (isIP(first)) return first;
    } else if (trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];   // the last entry is the one our own proxy appended
    }
    return req.socket.remoteAddress ?? 'unknown';
  };
  const authLimited = (kind, req) => {
    const t = now().getTime();
    if (authWindows.size > 10_000) for (const [k, w] of authWindows) if (t - w.start >= authLimit.windowMs) authWindows.delete(k);
    const key = `${kind}:${clientAddress(req)}`;
    const w = authWindows.get(key);
    if (!w || t - w.start >= authLimit.windowMs) { authWindows.set(key, { start: t, n: 1 }); return false; }
    w.n += 1;
    return w.n > authLimit.max;
  };

  // ───────────────────────── Routes ─────────────────────────

  route('GET', '/healthz', async () => ({ status: 'up' }), { auth: false });
  route('GET', '/openapi.json', async () => ({ body: openapi }), { auth: false });

  route('POST', '/api/v1/users', async ({ body }) => {
    if (!allowSignup || !auth.issue) throw err(404, 'NOT_FOUND', 'Not found');
    const displayName = str(body.displayName, 'displayName', 60);
    const user = await store.withTransaction((tx) => tx.createUser(displayName));
    return { status: 201, body: { user, token: auth.issue(user.id) } };
  }, { auth: false });

  route('GET', '/api/v1/auth/config', async () => ({
    emailLogin: !!login,
    openSignup: !!(allowSignup && auth.issue),
  }), { auth: false });

  route('POST', '/api/v1/auth/email-link', async ({ req, body }) => {
    if (!login) throw err(404, 'NOT_FOUND', 'Not found');
    if (authLimited('link', req)) throw err(429, 'RATE_LIMITED', 'Too many requests; try again later');
    await login.requestLink({ email: body.email });
    return { status: 202, body: { accepted: true } };       // identical for every address, known or not
  }, { auth: false });

  route('POST', '/api/v1/auth/verify', async ({ req, body }) => {
    if (!login) throw err(404, 'NOT_FOUND', 'Not found');
    if (authLimited('verify', req)) throw err(429, 'RATE_LIMITED', 'Too many requests; try again later');
    return login.verifyLink({ token: body.token, displayName: body.displayName });
  }, { auth: false });

  route('GET', '/api/v1/me', async ({ userId }) => {
    const names = await store.withTransaction((tx) => tx.getUsers([userId]));
    const prefs = notifications ? await notifications.preferences(userId) : { available: false, canEnable: false, turnEmails: false };
    return { user: { id: userId, displayName: names[userId] ?? null }, notifications: prefs };
  });

  route('PUT', '/api/v1/me/notifications', async ({ userId, body }) => {
    if (!notifications) throw err(404, 'NOT_FOUND', 'Not found');
    return notifications.setTurnEmails(userId, body.turnEmails);
  });

  // The link at the bottom of every turn email. No sign-in: the token itself says who it is for, and it can only switch the emails off.
  route('POST', '/api/v1/auth/unsubscribe', async ({ req, body }) => {
    if (!notifications) throw err(404, 'NOT_FOUND', 'Not found');
    if (authLimited('unsubscribe', req)) throw err(429, 'RATE_LIMITED', 'Too many requests; try again later');
    return notifications.unsubscribe(body.token);
  }, { auth: false });

  route('GET', '/api/v1/games', async ({ userId }) => myGames(store, { userId }));

  route('POST', '/api/v1/games', async ({ userId, body }) => {
    const r = await createGame(store, { userId, settings: body, maxOpenGames: maxOpenGamesPerUser });
    return r.ok ? { status: 201, body: { gameId: r.gameId } } : r;
  });

  route('GET', '/api/v1/games/:id/lobby', async ({ params }) => getLobby(store, { gameId: gameId(params) }));

  route('POST', '/api/v1/games/:id/join', async ({ params, userId }) => {
    const id = gameId(params);
    const r = await joinGame(store, { gameId: id, userId });
    if (r.ok) notify(id, { type: 'lobby_changed' });
    return r;
  });

  route('PUT', '/api/v1/games/:id/country', async ({ params, userId, body }) => {
    const id = gameId(params);
    if (!('country' in body)) throw err(422, 'TARGET_INVALID', 'Send { "country": "FRANCE" } or { "country": null }', 'country');
    const r = await pickCountry(store, { gameId: id, userId, country: body.country });
    if (r.ok) notify(id, { type: 'lobby_changed' });
    return r;
  });

  route('DELETE', '/api/v1/games/:id', async ({ params, userId }) => {
    const id = gameId(params);
    const r = await cancelGame(store, { gameId: id, userId });
    if (r.ok) notify(id, { type: 'game_cancelled' });
    return r;
  });

  route('DELETE', '/api/v1/games/:id/membership', async ({ params, userId }) => {
    const id = gameId(params);
    const r = await leaveGame(store, { gameId: id, userId });
    if (r.ok) notify(id, { type: 'lobby_changed' });
    return r;
  });

  route('PUT', '/api/v1/games/:id/population', async ({ params, userId, body }) => {
    const id = gameId(params);
    if (!Number.isInteger(body.userId)) throw err(422, 'NOT_INTEGER', 'userId must be a whole number', 'userId');
    const r = await setStartPopulation(store, { gameId: id, userId, targetUserId: body.userId, population: body.population ?? null });
    if (r.ok) notify(id, { type: 'lobby_changed' });
    return r;
  });

  route('POST', '/api/v1/games/:id/ai', async ({ params, userId, body }) => {
    const id = gameId(params);
    const r = await addAiPlayer(store, { gameId: id, userId, persona: body.persona ?? null });
    if (r.ok) notify(id, { type: 'lobby_changed' });
    return r.ok ? { status: 201, body: { userId: r.userId } } : r;
  });

  route('DELETE', '/api/v1/games/:id/ai/:aiUserId', async ({ params, userId }) => {
    const id = gameId(params);
    const aiUserId = Number(params.aiUserId);
    if (!Number.isSafeInteger(aiUserId) || aiUserId < 1) throw err(404, 'NOT_FOUND', 'No AI player with that id in this game');
    const r = await removeAiPlayer(store, { gameId: id, userId, aiUserId });
    if (r.ok) notify(id, { type: 'lobby_changed' });
    return r;
  });

  route('POST', '/api/v1/games/:id/start', async ({ params, userId }) => {
    const id = gameId(params);
    const r = await startGame(store, { gameId: id, userId }, now());
    if (r.ok) notify(id, { type: 'game_started' });
    return r;
  });

  route('GET', '/api/v1/games/:id/state', async ({ params, userId }) => getPackage(store, { gameId: gameId(params), userId }));

  route('GET', '/api/v1/games/:id/turn', async ({ params, userId }) => {
    const r = await getPackage(store, { gameId: gameId(params), userId });
    return r.ok ? { ok: true, game: r.game, turn: r.turn ?? null } : r;
  });

  route('GET', '/api/v1/games/:id/sheet', async ({ params, userId }) => getSheetView(store, { gameId: gameId(params), userId }));

  route('POST', '/api/v1/games/:id/sheet/validate', async ({ params, userId, body }) =>
    dryRunSheet(store, { gameId: gameId(params), userId, payload: body }));

  const saveSheet = (final) => async ({ params, userId, body }) => {
    const id = gameId(params);
    const r = await submitSheet(store, { gameId: id, userId, payload: body, final }, now());
    if (r.ok) {
      if (r.resolved) {
        notify(id, { type: 'turn_resolved', turnNumber: r.turnNumber });
        if (r.over) notify(id, { type: 'game_finished', outcome: r.outcome?.reason ?? null });
      } else if (final) {
        notify(id, { type: 'player_submitted', finalCount: r.finalCount, activeCount: r.activeCount }); // counts only
      }
      return { ok: true, turnNumber: r.turnNumber, final, submitted: r.finalCount, active: r.activeCount, resolved: !!r.resolved };
    }
    return r;
  };
  route('PUT', '/api/v1/games/:id/sheet', saveSheet(false));
  route('POST', '/api/v1/games/:id/sheet/submit', saveSheet(true));

  route('GET', '/api/v1/games/:id/history', async ({ params, userId }) => getHistory(store, { gameId: gameId(params), userId }));
  route('GET', '/api/v1/games/:id/replay', async ({ params, userId }) => getReplay(store, { gameId: gameId(params), userId }));

  // Server-sent events: public, content-free signals. Clients refetch /state when one arrives.
  route('GET', '/api/v1/games/:id/stream', async ({ params, userId, res, req }) => {
    const id = gameId(params);
    const snap = await store.withTransaction((tx) => tx.loadSnapshot(id));
    if (!snap.game) throw err(404, 'NOT_FOUND', 'No such game');
    if (!snap.players.some((p) => p.userId === userId)) throw err(403, 'FORBIDDEN', 'You are not in this game');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
    });
    const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'ready' });
    const listener = (event) => send(event);
    hub.on(`game:${id}`, listener);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs);
    beat.unref?.();
    req.on('close', () => { clearInterval(beat); hub.off(`game:${id}`, listener); });
    return { streaming: true };
  });

  // ───────────────────────── Static files (the browser client) ─────────────────────────

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw err(404, 'NOT_FOUND', 'Not found'); }
    if (rel === '/') rel = '/index.html';
    const type = STATIC_TYPES[path.extname(rel).toLowerCase()];
    if (!type || rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) throw err(404, 'NOT_FOUND', 'Not found');
    const full = path.join(staticRoot, rel);
    if (!full.startsWith(staticRoot + path.sep)) throw err(404, 'NOT_FOUND', 'Not found'); // never leave the client folder
    let body;
    try { body = await readFile(full); } catch { throw err(404, 'NOT_FOUND', 'Not found'); }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  const isStaticPath = (p) => !p.startsWith('/api/') && p !== '/healthz' && p !== '/openapi.json';

  // ───────────────────────── Dispatcher ─────────────────────────

  const baseHeaders = () => ({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, Vary: 'Origin' } : {}),
  });
  const send = (res, status, body) => {
    if (res.headersSent) return;
    res.writeHead(status, baseHeaders());
    res.end(JSON.stringify(body));
  };
  const sendError = (res, e) => send(res, e.status, { errors: [{ code: e.code, field: e.field, message: e.message }] });

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...(corsOrigin ? {
            'Access-Control-Allow-Origin': corsOrigin,
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '600',
          } : {}),
        });
        return res.end();
      }

      if (staticRoot && (req.method === 'GET' || req.method === 'HEAD') && isStaticPath(url.pathname)) {
        return await serveStatic(req, res, url.pathname);
      }

      // HEAD (what many uptime monitors send) is answered for public, read-only GET endpoints such as /healthz: same
      // status and headers, no body. Private routes and the event stream are not offered over HEAD.
      const isHead = req.method === 'HEAD';
      let matched = null;
      let pathExists = false;
      for (const r of routes) {
        const params = r.match(url.pathname);
        if (!params) continue;
        pathExists = true;
        if (isHead ? (r.method === 'GET' && !r.needsAuth) : r.method === req.method) { matched = { r, params }; break; }
      }
      if (!matched) throw pathExists ? err(405, 'METHOD_NOT_ALLOWED', 'Method not allowed') : err(404, 'NOT_FOUND', 'Not found');

      let userId = null;
      if (matched.r.needsAuth) {
        userId = await auth.authenticate(req, url);
        if (userId == null) throw err(401, 'UNAUTHENTICATED', 'Missing, invalid or expired token');
      }
      const isWrite = req.method !== 'GET' && !isHead;
      if (isWrite && userId != null && limited(userId)) throw err(429, 'RATE_LIMITED', 'Too many requests; slow down');

      const body = isWrite && req.method !== 'DELETE' ? await readJson(req) : {};
      const out = await matched.r.handler({ req, res, params: matched.params, query: url.searchParams, body, userId });
      if (out?.streaming) return;

      if (out && out.ok === false) {
        return send(res, Number.isInteger(out.status) ? out.status : 400, { errors: out.errors });
      }
      if (out && out.body !== undefined) return send(res, Number.isInteger(out.status) ? out.status : 200, out.body);
      // A numeric `status` is the HTTP status; anything else (e.g. { status: 'up' }) is ordinary data.
      const { ok, ...rest } = out ?? {}; // eslint-disable-line no-unused-vars
      const httpStatus = Number.isInteger(rest.status) ? rest.status : 200;
      if (Number.isInteger(rest.status)) delete rest.status;
      return send(res, httpStatus, rest);
    } catch (e) {
      if (e instanceof HttpError) return sendError(res, e);
      logger.error('[http] unhandled error', e);
      return send(res, 500, { errors: [{ code: 'INTERNAL', field: 'request', message: 'Something went wrong' }] });
    }
  }

  return {
    handle,
    notify,
    hub,
    routes: routes.map(({ method, path }) => ({ method, path })), // for the contract tests
    listen(port = 3000, host = '0.0.0.0') {
      const server = http.createServer(handle);
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
    },
  };
}
