// Minimal signed-token auth (HMAC-SHA256, no dependencies).
// A token proves "this request is user N" until it expires. How users first get a token
// (sign-up, magic link, invite code, SSO) is a product decision: this file only mints and
// verifies tokens. Swap `createTokenAuth` for your own `{ authenticate, issue }` object freely.

import crypto from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(userId, secret, { ttlSeconds = 30 * 86400, nowMs = Date.now(), sessionVersion = 0 } = {}) {
  const body = b64(JSON.stringify({ uid: userId, exp: Math.floor(nowMs / 1000) + ttlSeconds, sv: sessionVersion }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Returns the user id, or null for anything malformed, forged or expired. (It cannot know about sign-out-everywhere: see readToken.) */
export function verifyToken(token, secret, nowMs = Date.now()) {
  return readToken(token, secret, nowMs)?.uid ?? null;
}

/** Like verifyToken, but returns { uid, sv }: sv is the session version the token was issued under (0 for tokens made before it existed). */
export function readToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const { uid, exp, sv = 0 } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isInteger(uid) || !Number.isInteger(exp) || exp * 1000 <= nowMs) return null;
    if (!Number.isInteger(sv) || sv < 0) return null;
    return { uid, sv };
  } catch { return null; }
}

/**
 * Reads `Authorization: Bearer <token>`; falls back to `?token=` because the browser
 * EventSource API cannot set headers (needed for the SSE stream).
 *
 * With a `store`, a token is also checked against the account on every request: it must carry the account's current
 * session version (so "sign out everywhere" works) and the account must still exist (so a deleted account's tokens stop
 * at once). Without one, tokens are accepted until they expire (used by tests that do not care).
 */
export function createTokenAuth({ secret, store = null, now = () => new Date(), ttlSeconds }) {
  if (!secret || secret.length < 16) throw new Error('auth secret must be at least 16 characters');
  return {
    async authenticate(req, url) {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
      const read = token ? readToken(token, secret, now().getTime()) : null;
      if (!read) return null;
      if (store) {
        const current = await store.getSessionVersion(read.uid);
        if (current == null || current !== read.sv) return null;
      }
      return read.uid;
    },
    /** A token under an explicit session version (0 when you do not know it: only right for accounts never signed out everywhere). */
    issue(userId, sessionVersion = 0) {
      return signToken(userId, secret, { ttlSeconds, nowMs: now().getTime(), sessionVersion });
    },
    /** A token for the account's CURRENT session version. Use this whenever someone has just proved who they are. */
    async issueFor(userId) {
      const sessionVersion = store ? (await store.getSessionVersion(userId)) ?? 0 : 0;
      return this.issue(userId, sessionVersion);
    },
  };
}
