// Opt-in turn emails: who may turn them on, who gets which mail and when, that nothing is ever sent twice, the daily
// cap, a failing mail server, and the one-click unsubscribe link. Runs on whichever store the suite uses
// (memory by default, PostgreSQL with test:db).
//
// Each scenario lives in its own year (see `year`), because on a shared database every scenario's games stay behind:
// a game from an earlier year has a deadline that has long passed, so it can never receive mail in a later scenario.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, labelFor } from './support/stores.js';
import { createGame, joinGame } from '../src/app/lobby.js';
import { startGame, submitSheet } from '../src/app/pipeline.js';
import { createNotifications, createUnsubscribeTokens, planNotifications, composeMail } from '../src/app/notifications.js';
import { createMemoryMailer } from '../src/mail/mailer.js';
import { startWorker } from '../src/worker.js';

const stores = await openStore();
after(() => stores.close());
// scenario(name, fn) or scenario(name, { skip, ... }, fn): the options object, when given, comes second (as with node:test).
const scenario = (name, a, b) => {
  const [opts, fn] = typeof a === 'function' ? [{}, a] : [a, b];
  return test(labelFor(stores.kind) + name, opts, fn);
};

const HOUR = 3600 * 1000;
const APP_URL = 'https://game.example.com';
const SECRET = 'a-test-secret-that-is-long-enough';
let counter = 0;
const unique = (who) => `${who}.${process.pid}.${Date.now().toString(36)}.${++counter}@example.org`;
let yearCounter = 2040;
const year = () => new Date(Date.UTC(yearCounter++, 0, 1));

/** A game with `humans` email accounts (the first creates it) and `ai` AI players, started at `t0`. */
async function world({ humans = 2, ai = 1, hours = 24, notify = {} } = {}) {
  const store = stores.makeStore();
  const tx = (fn) => store.withTransaction(fn);
  const t0 = year();
  const clock = { t: t0 };
  const mailer = createMemoryMailer();
  const errors = [];
  const logger = { error: (...a) => errors.push(a.join(' ')), log() {}, warn() {} };
  const service = createNotifications({ store, mailer, secret: SECRET, appUrl: APP_URL, now: () => clock.t, logger, ...notify });
  const people = [];
  for (let i = 0; i < humans; i++) {
    const email = unique(`p${i + 1}`);
    const { user } = await tx((t) => t.findOrCreateUserByEmail(email, `Player ${i + 1}`));
    people.push({ ...user, email });
  }
  const created = await createGame(store, { userId: people[0].id, settings: { aiPlayers: ai, turnDeadlineHours: hours } });
  assert.equal(created.ok, true, JSON.stringify(created));
  for (const p of people.slice(1)) assert.equal((await joinGame(store, { gameId: created.gameId, userId: p.id })).ok, true);
  return {
    store, tx, t0, clock, mailer, errors, logger, service, people, gameId: created.gameId,
    at: (h) => new Date(t0.getTime() + h * HOUR),
    start: async () => { const r = await startGame(store, { gameId: created.gameId, userId: people[0].id }, t0); assert.equal(r.ok, true, JSON.stringify(r)); },
    optIn: async (p) => assert.equal((await service.setTurnEmails(p.id, true)).turnEmails, true),
    mailsTo: (p) => mailer.sent.filter((m) => m.to === p.email),
  };
}
const candidate = (over = {}) => ({
  userId: 1, email: 'a@example.org', displayName: 'Ada', since: new Date('2040-01-01T00:00:00Z'), gameId: 7, country: 'FRANCE',
  turnNumber: 3, turnType: 'NORMAL', opensAt: new Date('2040-01-02T00:00:00Z'), deadlineAt: new Date('2040-01-03T00:00:00Z'), sentKinds: [], ...over,
});

// ───────────────────────── planning (pure) ─────────────────────────

test('plan: a new turn gets one "open" mail; a reminder replaces it once the deadline is near; nothing repeats', () => {
  const c = candidate();
  const at = (h) => new Date(c.opensAt.getTime() + h * HOUR);
  assert.deepEqual(planNotifications([c], at(1)).map((p) => p.kind), ['TURN_OPEN']);
  assert.deepEqual(planNotifications([c], at(19)).map((p) => p.kind), ['TURN_OPEN'], '5 hours before the deadline is not near yet, so the "open" mail still goes');
  assert.deepEqual(planNotifications([{ ...c, sentKinds: ['TURN_OPEN'] }], at(19)), [], 'and with that sent there is nothing to do yet');
  assert.deepEqual(planNotifications([c], at(20)).map((p) => p.kind), ['DEADLINE_SOON'], 'exactly 4 hours before');
  assert.deepEqual(planNotifications([c], at(20), { reminderHours: 0 }).map((p) => p.kind), ['TURN_OPEN'], 'no reminders when switched off');
  assert.deepEqual(planNotifications([{ ...c, sentKinds: ['TURN_OPEN'] }], at(1)), []);
  assert.deepEqual(planNotifications([{ ...c, sentKinds: ['TURN_OPEN'] }], at(21)).map((p) => p.kind), ['DEADLINE_SOON']);
  assert.deepEqual(planNotifications([{ ...c, sentKinds: ['TURN_OPEN', 'DEADLINE_SOON'] }], at(22)), []);
  assert.deepEqual(planNotifications([{ ...c, sentKinds: ['DEADLINE_SOON'] }], at(21)), [], 'once a reminder went out, a late "open" would be noise');
  assert.deepEqual(planNotifications([c], at(24)), [], 'the deadline has passed');
  assert.deepEqual(planNotifications([c], at(30)), []);
});

test('plan: only turns that opened after the person opted in get an "open" mail, but reminders cover any turn', () => {
  const c = candidate({ since: new Date('2040-01-02T06:00:00Z') });                 // opted in six hours after the turn opened
  const at = (h) => new Date(c.opensAt.getTime() + h * HOUR);
  assert.deepEqual(planNotifications([c], at(7)), []);
  assert.deepEqual(planNotifications([c], at(21)).map((p) => p.kind), ['DEADLINE_SOON']);
});

test('plan: in a short turn the reminder waits for the last third, so it never lands right behind the "open" mail', () => {
  const c = candidate({ deadlineAt: new Date('2040-01-02T03:00:00Z') });           // a 3-hour turn: the reminder lead is 1 hour
  const at = (min) => new Date(c.opensAt.getTime() + min * 60_000);
  assert.deepEqual(planNotifications([c], at(30)).map((p) => p.kind), ['TURN_OPEN']);
  assert.deepEqual(planNotifications([{ ...c, sentKinds: ['TURN_OPEN'] }], at(100)), []);
  assert.deepEqual(planNotifications([{ ...c, sentKinds: ['TURN_OPEN'] }], at(121)).map((p) => p.kind), ['DEADLINE_SOON']);
});

test('plan: reminders come first, soonest deadline first, then "open" mails oldest first', () => {
  const now = new Date('2040-01-02T21:00:00Z');
  const soon = candidate({ userId: 1, deadlineAt: new Date('2040-01-03T00:00:00Z') });
  const sooner = candidate({ userId: 2, deadlineAt: new Date('2040-01-02T23:00:00Z') });
  const fresh = candidate({ userId: 3, opensAt: new Date('2040-01-02T20:00:00Z'), deadlineAt: new Date('2040-01-03T20:00:00Z') });
  const older = candidate({ userId: 4, opensAt: new Date('2040-01-02T19:00:00Z'), deadlineAt: new Date('2040-01-03T19:00:00Z') });
  assert.deepEqual(planNotifications([fresh, soon, older, sooner], now).map((p) => [p.candidate.userId, p.kind]),
    [[2, 'DEADLINE_SOON'], [1, 'DEADLINE_SOON'], [4, 'TURN_OPEN'], [3, 'TURN_OPEN']]);
});

test('mail: says what, where, when and how to stop, and keeps the address out of the subject', () => {
  const c = candidate();
  const now = new Date('2040-01-02T01:00:00Z');
  const open = composeMail({ candidate: c, kind: 'TURN_OPEN' }, { now, base: APP_URL, unsubscribeUrl: `${APP_URL}/#/unsubscribe/TOKEN`, appName: 'Nuclear Destruction' });
  assert.equal(open.to, 'a@example.org');
  assert.equal(open.subject, 'Nuclear Destruction: game #7, turn 3 is open');
  assert.match(open.text, /^Hello Ada,/);
  assert.match(open.text, /Turn 3 \(a normal turn\) of game #7 is open\. You are playing FRANCE\./);
  assert.match(open.text, /Deadline: 2040-01-03 00:00 UTC \(about 23 hours from now\)/);
  assert.ok(open.text.includes(`${APP_URL}/#/games/7`));
  assert.ok(open.text.includes(`${APP_URL}/#/unsubscribe/TOKEN`));
  const soon = composeMail({ candidate: { ...c, turnType: 'BATTLE' }, kind: 'DEADLINE_SOON' }, { now: new Date('2040-01-02T23:30:00Z'), base: APP_URL, unsubscribeUrl: 'u', appName: 'Nuclear Destruction' });
  assert.equal(soon.subject, 'Nuclear Destruction: game #7, turn 3 closes in about 1 hour');
  assert.match(soon.text, /battle turn/);
  assert.match(soon.text, /closes in about 1 hour, at 2040-01-03 00:00 UTC/);
  assert.ok(!soon.subject.includes('@'));
});

test('unsubscribe tokens: only the genuine token for a user verifies, and nothing else', () => {
  const tokens = createUnsubscribeTokens({ secret: SECRET });
  const other = createUnsubscribeTokens({ secret: 'another-secret-that-is-long-enough' });
  const t = tokens.issue(42);
  assert.match(t, /^42\.[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.verify(t), 42);
  assert.equal(other.verify(t), null, 'a different secret does not verify it');
  assert.equal(tokens.verify(t.replace(/^42/, '43')), null, 'one person\'s token does not work for another');
  const [, mac] = t.split('.');
  for (const bad of [null, undefined, 42, '', 'x', '42', '42.', `.${mac}`, `0.${mac}`, `042.${mac}`, `42.${mac}x`, `42.${mac.slice(1)}`, `${t} `, `-1.${mac}`]) assert.equal(tokens.verify(bad), null, String(bad));
  assert.throws(() => createUnsubscribeTokens({ secret: 'short' }), /at least 16/);
});

// ───────────────────────── settings ─────────────────────────

scenario('settings: off by default; needs an email address; re-enabling keeps the original moment; off again clears it', async () => {
  const w = await world({ humans: 1, ai: 2 });
  const [ann] = w.people;
  assert.deepEqual(await w.service.preferences(ann.id), { available: true, canEnable: true, turnEmails: false });
  assert.equal((await w.service.setTurnEmails(ann.id, 'yes')).errors[0].code, 'NOT_BOOLEAN');
  assert.equal((await w.service.setTurnEmails(ann.id, undefined)).errors[0].code, 'NOT_BOOLEAN');

  const nameOnly = await w.tx((t) => t.createUser('Name only'));
  assert.deepEqual(await w.service.preferences(nameOnly.id), { available: true, canEnable: false, turnEmails: false });
  const refused = await w.service.setTurnEmails(nameOnly.id, true);
  assert.equal(refused.ok, false);
  assert.equal(refused.errors[0].code, 'EMAIL_REQUIRED');
  assert.equal((await w.service.setTurnEmails(nameOnly.id, false)).ok, true, 'switching off is always allowed');
  assert.equal((await w.service.setTurnEmails(987654321, true)).status, 404);

  w.clock.t = w.at(1);
  assert.equal((await w.service.setTurnEmails(ann.id, true)).turnEmails, true);
  const first = (await w.tx((t) => t.getNotificationSettings(ann.id))).turnEmailsSince;
  assert.equal(first.getTime(), w.at(1).getTime());
  w.clock.t = w.at(5);
  await w.service.setTurnEmails(ann.id, true);                                   // pressing it twice changes nothing
  assert.equal((await w.tx((t) => t.getNotificationSettings(ann.id))).turnEmailsSince.getTime(), first.getTime());
  assert.equal((await w.service.preferences(ann.id)).turnEmails, true);
  assert.equal((await w.service.setTurnEmails(ann.id, false)).turnEmails, false);
  assert.equal((await w.tx((t) => t.getNotificationSettings(ann.id))).turnEmailsSince, null);
  assert.equal((await w.service.preferences(ann.id)).turnEmails, false);
});

// ───────────────────────── sending ─────────────────────────

scenario('sending: nobody who has not opted in is ever mailed, whatever the game does', async () => {
  const w = await world();
  await w.start();
  assert.equal((await w.service.tick(w.at(1))).sent, 0);
  assert.equal((await w.service.tick(w.at(21))).sent, 0);
  assert.deepEqual(w.mailsTo(w.people[0]).concat(w.mailsTo(w.people[1])), []);
});

scenario('sending: the opted-in person gets one "turn is open" mail; the other player and the AI get none; nothing repeats', async () => {
  const w = await world();
  const [ann, bob] = w.people;
  await w.optIn(ann);                                                            // before the game starts, so turn 1 counts
  await w.start();
  const r = await w.service.tick(w.at(0));
  assert.equal(r.sent >= 1, true);
  const mails = w.mailsTo(ann);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, `Nuclear Destruction: game #${w.gameId}, turn 1 is open`);
  assert.match(mails[0].text, /^Hello Player 1,/);
  assert.match(mails[0].text, /Turn 1 \(a normal turn\)/);
  assert.match(mails[0].text, /Deadline: \d{4}-\d\d-\d\d \d\d:\d\d UTC \(about 24 hours from now\)/);
  assert.ok(mails[0].text.includes(`${APP_URL}/#/games/${w.gameId}`));
  const link = /(https:\/\/game\.example\.com\/#\/unsubscribe\/(\d+\.[A-Za-z0-9_-]{43}))/.exec(mails[0].text);
  assert.ok(link, 'every mail carries the stop link');
  assert.equal(w.service.tokens.verify(link[2]), ann.id);
  assert.deepEqual(w.mailsTo(bob), []);
  assert.ok(w.mailer.sent.every((m) => m.to.includes('@example.org')), 'AI players have no address, so nothing else was sent');
  const again = await w.service.tick(w.at(0.5));
  assert.equal(w.mailsTo(ann).length, 1, 'a second pass sends nothing new');
  assert.equal(again.sent, 0);
});

scenario('sending: opting in while a turn is already running gives no "open" mail for it, but the reminder still comes, once', async () => {
  const w = await world();
  const [ann] = w.people;
  await w.start();
  w.clock.t = w.at(1);
  await w.optIn(ann);
  await w.service.tick(w.at(1));
  await w.service.tick(w.at(19));                                                // five hours before the deadline: too early
  assert.deepEqual(w.mailsTo(ann), []);
  await w.service.tick(w.at(21));                                                // three hours before
  const mails = w.mailsTo(ann);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, `Nuclear Destruction: game #${w.gameId}, turn 1 closes in about 3 hours`);
  assert.match(mails[0].text, /not submitted your orders/);
  await w.service.tick(w.at(22));
  await w.service.tick(w.at(23.5));
  assert.equal(w.mailsTo(ann).length, 1, 'one reminder per turn');
  await w.service.tick(w.at(25));                                                // the deadline has passed: never mail about a closed turn
  assert.equal(w.mailsTo(ann).length, 1);
});

scenario('sending: someone who has already submitted final orders gets no reminder; a saved draft does not count as final', async () => {
  const w = await world({ humans: 2, ai: 1 });
  const [ann, bob] = w.people;
  await w.optIn(ann);
  await w.optIn(bob);
  await w.start();
  await w.service.tick(w.at(0));
  w.mailer.sent.length = 0;
  assert.equal((await submitSheet(w.store, { gameId: w.gameId, userId: ann.id, payload: {}, final: true }, w.at(2))).ok, true);
  assert.equal((await submitSheet(w.store, { gameId: w.gameId, userId: bob.id, payload: {}, final: false }, w.at(2))).ok, true);
  await w.service.tick(w.at(21));
  assert.deepEqual(w.mailsTo(ann), [], 'Ann is done');
  assert.equal(w.mailsTo(bob).length, 1, 'Bob only saved a draft');
});

scenario('sending: the next turn gets its own mail, and a person who stopped the emails gets nothing more', async () => {
  const w = await world({ humans: 2, ai: 1 });
  const [ann, bob] = w.people;
  await w.optIn(ann);
  await w.optIn(bob);
  await w.start();
  await w.service.tick(w.at(0));
  assert.equal(w.mailsTo(ann).length, 1);
  // Both people finish early, so turn 2 opens at hour 2.
  await submitSheet(w.store, { gameId: w.gameId, userId: ann.id, payload: {}, final: true }, w.at(2));
  const done = await submitSheet(w.store, { gameId: w.gameId, userId: bob.id, payload: {}, final: true }, w.at(2));
  assert.equal(done.resolved, true);
  await w.service.setTurnEmails(bob.id, false);
  await w.service.tick(w.at(2));
  assert.deepEqual(w.mailsTo(ann).map((m) => m.subject.replace(/#\d+/, '#N')), ['Nuclear Destruction: game #N, turn 1 is open', 'Nuclear Destruction: game #N, turn 2 is open']);
  assert.equal(w.mailsTo(bob).length, 1, 'only the first mail; Bob switched off before turn 2');
});

scenario('limits: the daily cap holds mail back (the rest waits), and a later pass with room sends it', async () => {
  const w = await world({ humans: 2, ai: 1 });
  const [ann, bob] = w.people;
  await w.optIn(ann);
  await w.optIn(bob);
  await w.start();
  const used = await w.tx((t) => t.countTurnNotificationsSince(new Date(w.t0.getTime() - 24 * HOUR)));
  const capped = createNotifications({ store: w.store, mailer: w.mailer, secret: SECRET, appUrl: APP_URL, now: () => w.clock.t, logger: w.logger, dailyLimit: used + 1 });
  const first = await capped.tick(w.at(0));
  assert.equal(first.sent, 1);
  assert.ok(first.waiting >= 1);
  const second = await capped.tick(w.at(1));
  assert.equal(second.sent, 0, 'still inside the same 24 hours');
  assert.equal(w.mailer.sent.length, 1);
  const roomy = createNotifications({ store: w.store, mailer: w.mailer, secret: SECRET, appUrl: APP_URL, now: () => w.clock.t, logger: w.logger, dailyLimit: 0 });  // 0 = no cap
  await roomy.tick(w.at(1));
  assert.equal(w.mailsTo(ann).length, 1);
  assert.equal(w.mailsTo(bob).length, 1);
});

scenario('limits: one pass sends at most maxPerPass mails; the next pass carries on', async () => {
  const w = await world({ humans: 3, ai: 0, notify: { maxPerPass: 2, dailyLimit: 0 } });
  for (const p of w.people) await w.optIn(p);
  await w.start();
  assert.equal((await w.service.tick(w.at(0))).sent, 2);
  assert.equal((await w.service.tick(w.at(0))).sent, 1);
  assert.equal((await w.service.tick(w.at(0))).sent, 0);
  assert.equal(new Set(w.mailer.sent.map((m) => m.to)).size, 3);
});

scenario('failure: when the mail server refuses, nothing is lost: the pass stops, logs without the address, and the next one sends', async () => {
  const w = await world({ humans: 1, ai: 2 });
  const [ann] = w.people;
  await w.optIn(ann);
  await w.start();
  const down = { async send() { throw new Error('SMTP says no'); } };
  const broken = createNotifications({ store: w.store, mailer: down, secret: SECRET, appUrl: APP_URL, now: () => w.clock.t, logger: w.logger });
  const r = await broken.tick(w.at(0));
  assert.equal(r.failed, 1);
  assert.equal(r.sent, 0);
  assert.equal(w.errors.length, 1);
  assert.ok(!w.errors[0].includes(ann.email), 'the log never carries an address');
  assert.deepEqual(w.mailsTo(ann), []);
  await w.service.tick(w.at(0.1));
  assert.equal(w.mailsTo(ann).length, 1, 'the claim was released, so the mail is sent once the server recovers');
});

scenario('failure: a store error inside a pass is logged and swallowed, never thrown into the worker', async () => {
  const w = await world({ humans: 1, ai: 2 });
  const broken = { withTransaction: async () => { throw new Error('database away'); } };
  const service = createNotifications({ store: broken, mailer: w.mailer, secret: SECRET, appUrl: APP_URL, logger: w.logger });
  const r = await service.tick(w.at(0));
  assert.equal(r.sent, 0);
  assert.match(r.error, /database away/);
  assert.equal(w.errors.length, 1);
});

scenario('concurrency: two workers passing at the same moment send each mail once', { skip: stores.kind !== 'postgres' && 'needs real row locking (PostgreSQL)' }, async () => {
  const w = await world({ humans: 2, ai: 1 });
  const [ann, bob] = w.people;
  await w.optIn(ann);
  await w.optIn(bob);
  await w.start();
  const other = createNotifications({ store: w.store, mailer: w.mailer, secret: SECRET, appUrl: APP_URL, now: () => w.clock.t, logger: w.logger });
  await Promise.all([w.service.tick(w.at(0)), other.tick(w.at(0)), w.service.tick(w.at(0)), other.tick(w.at(0))]);
  assert.equal(w.mailsTo(ann).length, 1);
  assert.equal(w.mailsTo(bob).length, 1);
});

scenario('store: a claim succeeds once per person, game, turn and kind; release reopens it; counting and sweeping use the sent time', async () => {
  const w = await world({ humans: 1, ai: 2 });
  const [ann] = w.people;
  await w.start();
  const key = { userId: ann.id, gameId: w.gameId, turnNumber: 1, kind: 'TURN_OPEN' };
  const claim = (extra = {}, sentAt = w.at(0)) => w.tx((t) => t.claimTurnNotification({ ...key, ...extra, sentAt }));
  assert.equal(await claim(), true);
  assert.equal(await claim(), false, 'the same mail cannot be claimed twice');
  assert.equal(await claim({ kind: 'DEADLINE_SOON' }, w.at(1)), true, 'another kind is another mail');
  assert.equal(await claim({ turnNumber: 2 }, w.at(2)), true, 'another turn is another mail');
  assert.equal(await w.tx((t) => t.countTurnNotificationsSince(w.at(0))), 3);
  assert.equal(await w.tx((t) => t.countTurnNotificationsSince(w.at(1))), 2);
  await w.tx((t) => t.releaseTurnNotification(key));
  assert.equal(await w.tx((t) => t.countTurnNotificationsSince(w.at(0))), 2);
  assert.equal(await claim(), true, 'a released claim can be taken again');
  // The sweep is global, so on a shared database it may also remove rows left by earlier scenarios: check what it did to ours.
  assert.ok(await w.tx((t) => t.deleteTurnNotificationsSentBefore(w.at(1))) >= 1, 'the older one is swept');
  assert.equal(await claim({ kind: 'DEADLINE_SOON' }, w.at(1)), false, 'a row sent at the cutoff stays');
  assert.equal(await claim({ turnNumber: 2 }, w.at(2)), false, 'a newer row stays');
  assert.equal(await claim(), true, 'the swept row is gone, so it can be claimed again');
});

scenario('store: the candidate list holds only living, opted-in people in an open turn, with what was already sent', async () => {
  const w = await world({ humans: 2, ai: 1 });
  const [ann, bob] = w.people;
  await w.optIn(ann);
  assert.deepEqual(await w.tx((t) => t.listTurnNotificationCandidates()).then((l) => l.filter((c) => c.gameId === w.gameId)), [], 'a lobby is not a turn');
  await w.start();
  const mine = async () => (await w.tx((t) => t.listTurnNotificationCandidates())).filter((c) => c.gameId === w.gameId);
  let list = await mine();
  assert.equal(list.length, 1, 'Bob has not opted in, and the AI has no address');
  assert.equal(list[0].userId, ann.id);
  assert.equal(list[0].email, ann.email);
  assert.equal(list[0].displayName, 'Player 1');
  assert.equal(list[0].turnNumber, 1);
  assert.equal(list[0].turnType, 'NORMAL');
  assert.equal(list[0].deadlineAt.getTime(), w.at(24).getTime());
  assert.equal(list[0].opensAt.getTime(), w.at(0).getTime());
  assert.ok(list[0].since instanceof Date);
  assert.ok(typeof list[0].country === 'string');
  assert.deepEqual(list[0].sentKinds, []);
  await w.tx((t) => t.claimTurnNotification({ userId: ann.id, gameId: w.gameId, turnNumber: 1, kind: 'TURN_OPEN', sentAt: w.at(0) }));
  assert.deepEqual((await mine())[0].sentKinds, ['TURN_OPEN']);
  await w.optIn(bob);
  assert.equal((await mine()).length, 2);
});

// ───────────────────────── unsubscribe ─────────────────────────

scenario('unsubscribe: the link in a mail switches the emails off without signing in; forged links do nothing', async () => {
  const w = await world();
  const [ann, bob] = w.people;
  await w.optIn(ann);
  await w.optIn(bob);
  const token = w.service.tokens.issue(ann.id);
  const bad = await w.service.unsubscribe(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')));
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(bad.errors[0].code, 'LINK_INVALID');
  assert.equal((await w.service.unsubscribe(undefined)).errors[0].code, 'LINK_INVALID');
  assert.equal((await w.service.preferences(ann.id)).turnEmails, true, 'a forged token changes nothing');
  assert.deepEqual(await w.service.unsubscribe(token), { ok: true, turnEmails: false });
  assert.equal((await w.service.preferences(ann.id)).turnEmails, false);
  assert.equal((await w.service.preferences(bob.id)).turnEmails, true, 'only the token\'s owner is affected');
  assert.deepEqual(await w.service.unsubscribe(token), { ok: true, turnEmails: false }, 'harmless to repeat');
  await w.service.setTurnEmails(ann.id, true);
  assert.deepEqual(await w.service.unsubscribe(token), { ok: true, turnEmails: false }, 'the same link keeps working after opting in again');
});

// ───────────────────────── the worker ─────────────────────────

scenario('worker: each pass ends by running the notifier, and a missing notifier is fine', async () => {
  const store = stores.makeStore();
  let passes = 0;
  const logger = { error() {}, log() {}, warn() {} };
  const w1 = startWorker({ store, notify() {}, notifier: { tick: async () => { passes++; } }, intervalMs: 3_600_000, logger });
  await w1.tick();
  await w1.tick();
  await w1.stop();
  assert.equal(passes, 2);
  const w2 = startWorker({ store, notify() {}, intervalMs: 3_600_000, logger });
  await w2.tick();
  await w2.stop();
});
