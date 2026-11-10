// Opt-in turn emails.
//
//   TURN_OPEN      "Turn N of game #G is open": once per turn, only for turns that opened after the person opted in.
//   DEADLINE_SOON  "Turn N closes in about H hours": once per turn, only if they have not submitted a final sheet yet.
//
// Rules this file guarantees:
//   * Off by default. Only a person with an email address can turn it on, and only for themselves.
//   * Each mail goes out at most once per person, game, turn and kind. A claim row is written BEFORE the message is
//     handed to the mail server (so two workers can never both send it); if the server refuses, the claim is removed
//     and a later pass tries again. A crash between claim and send loses that one mail rather than repeating it.
//   * A mail is never sent for a turn whose deadline has passed, to someone who already submitted, to an eliminated or
//     forfeited player, or to an AI player.
//   * A daily cap (default 150 in any rolling 24 hours) and a per-pass cap keep the free mail plan (200 a day, shared
//     with sign-in links) from running dry. Mails over the cap simply wait: they are recomputed from the game state on
//     the next pass, and drop out by themselves once the turn they were about has been resolved.
//   * Every mail carries a one-click "stop these emails" link that needs no sign-in. The page it opens asks for one
//     click (so link scanners cannot switch the setting off), then calls unsubscribe().
//   * Nothing secret is in a mail: the game number, the turn, your own country and the deadline, all things you see anyway.

import crypto from 'node:crypto';
import { fail } from './errors.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const TOKEN_SHAPE = /^[1-9][0-9]{0,15}\.[A-Za-z0-9_-]{43}$/;

/** Stateless "stop emails" tokens: the user id and an HMAC of it. No storage, no expiry, and they open nothing but that switch. */
export function createUnsubscribeTokens({ secret }) {
  if (!secret || secret.length < 16) throw new Error('unsubscribe tokens need a secret of at least 16 characters');
  // A key of its own, so a token can never be confused with (or used as) a login token made from the same secret.
  const key = crypto.createHmac('sha256', secret).update('turn-email-unsubscribe-v1').digest();
  const mac = (userId) => crypto.createHmac('sha256', key).update(`unsubscribe:${userId}`).digest('base64url');
  return {
    issue: (userId) => `${userId}.${mac(userId)}`,
    /** The user id, or null for anything malformed or forged. */
    verify(token) {
      if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
      const [id, given] = token.split('.');
      const expected = Buffer.from(mac(id));
      const got = Buffer.from(given);
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
      const userId = Number(id);
      return Number.isSafeInteger(userId) ? userId : null;
    },
  };
}

/**
 * Decides which mails are due. Pure: candidates in (see store.listTurnNotificationCandidates), a list of
 * { candidate, kind } out, most urgent first.
 */
export function planNotifications(candidates, now, { reminderHours = 4 } = {}) {
  const reminders = [];
  const opens = [];
  for (const c of candidates) {
    if (c.deadlineAt <= now) continue;
    const sent = new Set(c.sentKinds ?? []);
    // Never remind in the first third of a short turn: the reminder would arrive right behind the "turn is open" mail.
    const lead = Math.min(reminderHours * HOUR, (c.deadlineAt - c.opensAt) / 3);
    if (reminderHours > 0 && c.deadlineAt - now <= lead && !sent.has('DEADLINE_SOON')) reminders.push({ candidate: c, kind: 'DEADLINE_SOON' });
    else if (!sent.has('TURN_OPEN') && !sent.has('DEADLINE_SOON') && c.opensAt >= c.since) opens.push({ candidate: c, kind: 'TURN_OPEN' });
  }
  reminders.sort((a, b) => a.candidate.deadlineAt - b.candidate.deadlineAt || a.candidate.userId - b.candidate.userId);
  opens.sort((a, b) => a.candidate.opensAt - b.candidate.opensAt || a.candidate.userId - b.candidate.userId);
  return [...reminders, ...opens];
}

const utc = (d) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const hoursLeft = (ms) => Math.max(1, Math.round(ms / HOUR));

/** The message for one planned notification. `base` is the site address, `unsubscribeUrl` the one-click stop link. */
export function composeMail({ candidate: c, kind }, { now, base, unsubscribeUrl, appName }) {
  const left = hoursLeft(c.deadlineAt - now);
  const turn = `turn ${c.turnNumber} (${c.turnType === 'BATTLE' ? 'a battle turn' : 'a normal turn'})`;
  const subject = kind === 'DEADLINE_SOON'
    ? `${appName}: game #${c.gameId}, turn ${c.turnNumber} closes in about ${left} ${left === 1 ? 'hour' : 'hours'}`
    : `${appName}: game #${c.gameId}, turn ${c.turnNumber} is open`;
  const lines = kind === 'DEADLINE_SOON'
    ? [`You have not submitted your orders for ${turn} of game #${c.gameId} yet.`,
      `It closes in about ${left} ${left === 1 ? 'hour' : 'hours'}, at ${utc(c.deadlineAt)}.`,
      'A saved draft counts as submitted when the turn closes; if you have saved nothing, your country plays the default orders.']
    : [`${turn[0].toUpperCase()}${turn.slice(1)} of game #${c.gameId} is open. You are playing ${c.country}.`,
      `Deadline: ${utc(c.deadlineAt)} (about ${left} ${left === 1 ? 'hour' : 'hours'} from now).`,
      'The turn ends early if every living player submits final orders.'];
  const text = [
    `Hello ${c.displayName},`, '', ...lines, '', `Open the game: ${base}/#/games/${c.gameId}`, '',
    '--',
    `You get this because you turned on turn emails in ${appName}. To stop them, open this link and press the button (no sign-in needed):`,
    unsubscribeUrl, '',
  ].join('\n');
  return { to: c.email, subject, text };
}

export function createNotifications({
  store, mailer, secret, appUrl,
  now = () => new Date(),
  appName = 'Nuclear Destruction',
  reminderHours = 4,        // a reminder goes out this long before a deadline (or at two thirds of a short turn); 0 = no reminders
  dailyLimit = 150,         // mails in any rolling 24 hours; 0 = no cap
  maxPerPass = 40,          // mails in one worker pass, so one pass never holds the worker for minutes
  logger = console,
}) {
  if (!store || !mailer) throw new Error('createNotifications needs a store and a mailer');
  const tokens = createUnsubscribeTokens({ secret });
  const base = new URL(appUrl).origin + new URL(appUrl).pathname.replace(/\/$/, '');
  const unsubscribeUrl = (userId) => `${base}/#/unsubscribe/${tokens.issue(userId)}`;

  /** What the settings screen needs: { available, canEnable, turnEmails }. */
  async function preferences(userId) {
    const s = await store.withTransaction((tx) => tx.getNotificationSettings(userId));
    return { available: true, canEnable: !!s?.hasEmail, turnEmails: !!s?.turnEmailsSince };
  }

  async function setTurnEmails(userId, enabled) {
    if (typeof enabled !== 'boolean') return fail(422, 'NOT_BOOLEAN', 'turnEmails must be true or false');
    return store.withTransaction(async (tx) => {
      const s = await tx.getNotificationSettings(userId);
      if (!s) return fail(404, 'NOT_FOUND', 'No such account');
      if (enabled && !s.hasEmail) return fail(409, 'EMAIL_REQUIRED', 'Turn emails need an account that signed in with an email address.');
      await tx.setTurnEmails(userId, enabled ? now() : null);
      return { ok: true, turnEmails: enabled };
    });
  }

  /** The one-click link in every mail. Works without signing in, and only ever switches the emails off. */
  async function unsubscribe(token) {
    const userId = tokens.verify(token);
    if (userId == null) return fail(400, 'LINK_INVALID', 'This link is not valid. Sign in and turn the emails off on your home page instead.');
    await store.withTransaction((tx) => tx.setTurnEmails(userId, null));
    return { ok: true, turnEmails: false };
  }

  /** One worker pass: sends what is due, within the caps. Returns { sent, waiting, failed }. Never throws. */
  async function tick(at = now()) {
    try {
      await store.withTransaction((tx) => tx.deleteTurnNotificationsSentBefore(new Date(at.getTime() - 30 * DAY)));
      const candidates = await store.withTransaction((tx) => tx.listTurnNotificationCandidates());
      const plan = planNotifications(candidates, at, { reminderHours });
      if (!plan.length) return { sent: 0, waiting: 0, failed: 0 };
      const used = dailyLimit > 0 ? await store.withTransaction((tx) => tx.countTurnNotificationsSince(new Date(at.getTime() - DAY))) : 0;
      const budget = Math.min(maxPerPass, dailyLimit > 0 ? Math.max(0, dailyLimit - used) : Infinity);
      let sent = 0;
      let failed = 0;
      let i = 0;
      for (; i < plan.length && sent < budget; i++) {
        const item = plan[i];
        const key = { userId: item.candidate.userId, gameId: item.candidate.gameId, turnNumber: item.candidate.turnNumber, kind: item.kind };
        const claimed = await store.withTransaction((tx) => tx.claimTurnNotification({ ...key, sentAt: at }));
        if (!claimed) continue;                                  // another worker got there first
        try {
          await mailer.send(composeMail(item, { now: at, base, unsubscribeUrl: unsubscribeUrl(key.userId), appName }));
          sent++;
        } catch (e) {
          await store.withTransaction((tx) => tx.releaseTurnNotification(key)).catch(() => {});
          logger.error(`[notify] could not send a turn email: ${e.message}`);   // never log the address
          failed++;
          break;                                                  // the mail service is unwell: try again on the next pass
        }
      }
      return { sent, waiting: plan.length - i, failed };
    } catch (e) {
      logger.error(`[notify] pass failed: ${e.message}`);
      return { sent: 0, waiting: 0, failed: 0, error: e.message };
    }
  }

  return { preferences, setTurnEmails, unsubscribe, tick, unsubscribeUrl, tokens };
}
