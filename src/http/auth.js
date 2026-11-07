// Minimal signed-token auth (HMAC-SHA256, no dependencies).
// A token proves "this request is user N" until it expires. How users first get a token
// (sign-up, magic link, invite code, SSO) is a product decision: this file only mints and
// verifies tokens. Swap `createTokenAuth` for your own `{ authenticate, issue }` object freely.

import crypto from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(userId, secret, { ttlSeconds = 30 * 86400, nowMs = Date.now() } = {}) {
  const body = b64(JSON.stringify({ uid: userId, exp: Math.floor(nowMs / 1000) + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Returns the user id, or null for anything malformed, forged or expired. */
export function verifyToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isInteger(uid) || !Number.isInteger(exp) || exp * 1000 <= nowMs) return null;
    return uid;
  } catch { return null; }
}

/**
 * Reads `Authorization: Bearer <token>`; falls back to `?token=` because the browser
 * EventSource API cannot set headers (needed for the SSE stream).
 */
export function createTokenAuth({ secret, now = () => new Date(), ttlSeconds }) {
  if (!secret || secret.length < 16) throw new Error('auth secret must be at least 16 characters');
  return {
    async authenticate(req, url) {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
      return token ? verifyToken(token, secret, now().getTime()) : null;
    },
    issue(userId) {
      return signToken(userId, secret, { ttlSeconds, nowMs: now().getTime() });
    },
  };
}
