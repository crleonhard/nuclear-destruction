// Sign-in by emailed link ("magic link").
//
//   1. requestLink: the person types an email address. We store a hash of a random one-time secret and mail
//      them a link containing the secret. The reply is the same whether or not the address has an account.
//   2. verifyLink: the page the link opens sends the secret back. If it is unused and unexpired we mark it
//      used, find or create the account for that address, and return an ordinary login token.
//
// Design choices that matter:
//   - The secret is 256 random bits and only its SHA-256 hash is stored.
//   - The link puts the secret after a "#", which browsers never send to servers, proxies or logs, and never
//     leak in a Referer header. The page then POSTs it. Mail scanners that merely fetch links consume nothing.
//   - A link works once, for 15 minutes by default.
//   - The link's address comes from configuration (APP_URL), never from the request's Host header.
//   - Asking for a link never reveals whether an account exists: same reply, same work.
//   - A new account's display name is asked for only after the link is opened, so it is chosen by someone
//     who has proven they own the address.

import { cleanDisplayName } from '../app/account.js';
import crypto from 'node:crypto';
import { HttpError } from './app.js';

const err = (status, code, message, field) => new HttpError(status, code, message, field);
const HOUR = 3600 * 1000;

/** Lower-cases and checks an address. Returns null if it cannot be one. Deliberately simple: the real test is that mail arrives. */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/.test(email)) return null;
  if (email.split('@')[1].split('.').some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return null;
  return email;
}

export const newSecret = () => crypto.randomBytes(32).toString('base64url');
export const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function createEmailLogin({
  store, mailer, auth, appUrl,
  now = () => new Date(),
  ttlMs = 15 * 60_000,
  emailLimit = { max: 5, windowMs: HOUR },   // links per address per window; the rest are silently not sent
  appName = 'Nuclear Destruction',
  logger = console,
}) {
  if (!store || !mailer || !auth?.issue) throw new Error('createEmailLogin needs a store, a mailer and an auth object that can issue tokens');
  const base = new URL(appUrl).origin + new URL(appUrl).pathname.replace(/\/$/, '');
  const linkFor = (secret) => `${base}/#/verify/${secret}`;
  const minutes = Math.round(ttlMs / 60_000);

  async function requestLink({ email: raw }) {
    const email = normalizeEmail(raw);
    if (!email) throw err(422, 'EMAIL_INVALID', 'Enter a valid email address', 'email');

    const t = now();
    const secret = newSecret();
    const send = await store.withTransaction(async (tx) => {
      await tx.deleteLoginLinksExpiredBefore(new Date(t.getTime() - 24 * HOUR)); // housekeeping rides along
      if (await tx.countLoginLinksSince(email, new Date(t.getTime() - emailLimit.windowMs)) >= emailLimit.max) return false;
      await tx.insertLoginLink({ tokenHash: hashSecret(secret), email, createdAt: t, expiresAt: new Date(t.getTime() + ttlMs) });
      return true;
    });
    if (!send) return { ok: true };            // over the limit: say nothing, send nothing

    try {
      await mailer.send({
        to: email,
        subject: `Your ${appName} sign-in link`,
        text: [
          `Sign in to ${appName}`,
          '',
          `Open this link to sign in. It works once and expires in ${minutes} minutes:`,
          '',
          linkFor(secret),
          '',
          'If you did not ask for this, ignore this email: nobody can sign in without the link.',
          '',
        ].join('\n'),
      });
    } catch (e) {
      logger.error(`[login] could not send a sign-in email: ${e.message}`);   // never log the address or the link
      throw err(503, 'MAIL_UNAVAILABLE', 'We could not send the email right now. Please try again in a few minutes.', 'email');
    }
    return { ok: true };
  }

  async function verifyLink({ token, displayName }) {
    if (typeof token !== 'string' || !SECRET_SHAPE.test(token)) throw err(400, 'LINK_INVALID', 'This sign-in link is not valid. Ask for a new one.', 'token');
    const t = now();
    const user = await store.withTransaction(async (tx) => {
      const link = await tx.consumeLoginLink(hashSecret(token), t);
      if (!link) throw err(400, 'LINK_INVALID', 'This sign-in link has expired or was already used. Ask for a new one.', 'token');
      const existing = await tx.findUserByEmail(link.email);
      if (existing) return existing;
      // New address: a name is needed. Throwing rolls the transaction back, so the link stays usable.
      const name = cleanDisplayName(displayName);
      if (!name.ok) throw err(422, 'NAME_REQUIRED', name.message, 'displayName');
      return (await tx.findOrCreateUserByEmail(link.email, name.name)).user;
    });
    return { user, token: auth.issueFor ? await auth.issueFor(user.id) : auth.issue(user.id) };
  }

  return { requestLink, verifyLink };
}
