// Account basics: names, "sign out everywhere", and deleting an account, with what each does to tokens, games and personal data.
// Runs on whichever store the suite uses (memory by default, PostgreSQL with test:db).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openStore, labelFor } from './support/stores.js';
import { createGame, joinGame, getLobby, myGames } from '../src/app/lobby.js';
import { startGame, submitSheet, resolveDueTurns } from '../src/app/pipeline.js';
import { playAiTurns } from '../src/app/ai.js';
import { cleanDisplayName, renameAccount, signOutEverywhere, deleteAccount, DELETED_NAME, FORMER_PLAYER_NAME } from '../src/app/account.js';
import { createTokenAuth, signToken, readToken, verifyToken } from '../src/http/auth.js';

const stores = await openStore();
after(() => stores.close());
// scenario(name, fn) or scenario(name, { skip, ... }, fn): the options object, when given, comes second (as with node:test).
const scenario = (name, a, b) => {
  const [opts, fn] = typeof a === 'function' ? [{}, a] : [a, b];
  return test(labelFor(stores.kind) + name, opts, fn);
};

const SECRET = 'a-test-secret-that-is-long-enough';
const T0 = new Date('2026-11-01T00:00:00Z');
const HOUR = 3600 * 1000;
const at = (h) => new Date(T0.getTime() + h * HOUR);
let counter = 0;
const unique = (who) => `${who}.${process.pid}.${Date.now().toString(36)}.${++counter}@example.org`;

const req = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
const URL_ = new URL('http://localhost/');

function world() {
  const store = stores.makeStore();
  const tx = (fn) => store.withTransaction(fn);
  const person = async (name, { email = false } = {}) => {
    if (email) {
      const address = unique(name.toLowerCase());
      return { ...(await tx((t) => t.findOrCreateUserByEmail(address, name))).user, email: address };
    }
    return tx((t) => t.createUser(name));
  };
  const game = async (creator, { ai = 0, forfeitAfterN = 5, joiners = [] } = {}) => {
    const r = await createGame(store, { userId: creator.id, settings: { aiPlayers: ai, forfeitAfterN } });
    assert.equal(r.ok, true, JSON.stringify(r));
    for (const j of joiners) assert.equal((await joinGame(store, { gameId: r.gameId, userId: j.id })).ok, true);
    return r.gameId;
  };
  const start = async (gameId, creator) => { const r = await startGame(store, { gameId, userId: creator.id }, T0); assert.equal(r.ok, true, JSON.stringify(r)); };
  const seats = async (gameId) => (await getLobby(store, { gameId })).seats;
  const gameIdsOf = async (u) => (await myGames(store, { userId: u.id })).games?.map((g) => g.gameId ?? g.id) ?? [];
  const status = async (gameId) => (await tx((t) => t.loadSnapshot(gameId))).game?.status ?? null;
  return { store, tx, person, game, start, seats, status, gameIdsOf };
}

// ───────────────────────── names ─────────────────────────

test('names: trimmed, 1 to 60 characters, no control characters', () => {
  assert.deepEqual(cleanDisplayName('  Anna  '), { ok: true, name: 'Anna' });
  assert.deepEqual(cleanDisplayName('x'.repeat(60)), { ok: true, name: 'x'.repeat(60) });
  assert.deepEqual(cleanDisplayName('Zoë 山田'), { ok: true, name: 'Zoë 山田' });
  for (const bad of ['', '   ', 'x'.repeat(61), 'a\nb', 'a\u0000b', 'a\u007fb', 5, null, undefined, {}]) assert.equal(cleanDisplayName(bad).ok, false, String(bad));
  assert.equal(cleanDisplayName('').message, 'Choose the name other players will see.');
  assert.equal(cleanDisplayName('a\nb').message, 'Names are 1 to 60 characters with no line breaks.');
});

scenario('names: a new name shows everywhere at once; AI players, deleted and unknown accounts cannot be renamed', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const gameId = await w.game(ann, { ai: 2 });
  const r = await renameAccount(w.store, { userId: ann.id, displayName: '  Anna  ' });
  assert.deepEqual(r, { ok: true, user: { id: ann.id, displayName: 'Anna' } });
  assert.equal((await w.tx((t) => t.getUsers([ann.id])))[ann.id], 'Anna');
  assert.equal((await w.seats(gameId)).find((s) => s.userId === ann.id).displayName, 'Anna');
  const bad = await renameAccount(w.store, { userId: ann.id, displayName: '' });
  assert.deepEqual([bad.ok, bad.status, bad.errors[0].code, bad.errors[0].field], [false, 422, 'NAME_REQUIRED', 'displayName']);
  assert.equal((await w.tx((t) => t.getUsers([ann.id])))[ann.id], 'Anna', 'a refused name changes nothing');

  const bot = (await w.seats(gameId)).find((s) => s.ai);
  assert.equal((await renameAccount(w.store, { userId: bot.userId, displayName: 'Skynet' })).status, 404);
  assert.equal((await renameAccount(w.store, { userId: 987654321, displayName: 'Nobody' })).status, 404);
  await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE' });
  assert.equal((await renameAccount(w.store, { userId: ann.id, displayName: 'Back again' })).status, 404);
});

// ───────────────────────── tokens and "sign out everywhere" ─────────────────────────

scenario('tokens: valid only while they carry the account\'s current session version; tokens from before the upgrade count as version 0', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const auth = createTokenAuth({ secret: SECRET, store: w.store });
  const check = (token) => auth.authenticate(req(token), URL_);

  const t0 = await auth.issueFor(ann.id);
  assert.equal(readToken(t0, SECRET).sv, 0);
  assert.equal(await check(t0), ann.id);
  assert.equal(await auth.authenticate({ headers: {} }, new URL('http://localhost/?token=' + t0)), ann.id, 'the event stream passes the token in the query string');

  // a token made before the session version existed has no "sv" at all
  const body = Buffer.from(JSON.stringify({ uid: ann.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const legacy = `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
  assert.equal(readToken(legacy, SECRET).sv, 0);
  assert.equal(await check(legacy), ann.id, 'nobody is signed out by the upgrade itself');

  const out = await signOutEverywhere(w.store, { userId: ann.id });
  assert.deepEqual([out.ok, out.sessionVersion], [true, 1]);
  assert.equal(await check(t0), null, 'every earlier token is dead');
  assert.equal(await check(legacy), null);
  const t1 = await auth.issueFor(ann.id);
  assert.equal(readToken(t1, SECRET).sv, 1, 'a new sign-in gets the current version');
  assert.equal(await check(t1), ann.id);
  assert.equal(await check(auth.issue(ann.id, 1)), ann.id);
  assert.equal(await check(auth.issue(ann.id, 2)), null, 'a version the account has not reached is no good either');
  assert.equal((await signOutEverywhere(w.store, { userId: ann.id })).sessionVersion, 2);
  assert.equal(await check(t1), null);

  const ben = await w.person('Ben');
  assert.equal(await check(await auth.issueFor(ben.id)), ben.id, 'other accounts are unaffected');
  assert.equal(await check(auth.issue(987654321)), null, 'an unknown account has no valid token');
  assert.equal((await signOutEverywhere(w.store, { userId: 987654321 })).status, 404);
});

test('tokens: the version is part of what is signed, so it cannot be edited; without a store tokens work until they expire', async () => {
  const token = signToken(7, SECRET, { sessionVersion: 3 });
  assert.deepEqual(readToken(token, SECRET), { uid: 7, sv: 3 });
  assert.equal(verifyToken(token, SECRET), 7);
  const [, sig] = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ uid: 7, exp: Math.floor(Date.now() / 1000) + 3600, sv: 4 })).toString('base64url')}.${sig}`;
  assert.equal(readToken(forged, SECRET), null);
  for (const sv of [-1, 1.5, '1']) {
    const body = Buffer.from(JSON.stringify({ uid: 7, exp: Math.floor(Date.now() / 1000) + 3600, sv })).toString('base64url');
    assert.equal(readToken(`${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`, SECRET), null, String(sv));
  }
  const plain = createTokenAuth({ secret: SECRET });
  assert.equal(await plain.authenticate(req(plain.issue(5)), URL_), 5);
  assert.equal(await plain.issueFor(5).then((t) => readToken(t, SECRET).sv), 0);
});

// ───────────────────────── deleting an account ─────────────────────────

scenario('delete: needs the exact word, and a refusal changes nothing', async () => {
  const w = world();
  const ann = await w.person('Ann', { email: true });
  for (const confirm of [undefined, '', 'delete', 'Delete', ' DELETE', true, 'DELETE ']) {
    const r = await deleteAccount(w.store, { userId: ann.id, confirm });
    assert.deepEqual([r.ok, r.status, r.errors[0].code, r.errors[0].field], [false, 422, 'CONFIRMATION_REQUIRED', 'confirm'], String(confirm));
  }
  assert.equal((await w.tx((t) => t.getAccount(ann.id))).email, ann.email);
  assert.equal(await w.store.getSessionVersion(ann.id), 0);
});

scenario('delete: everything that identifies the person goes; the address can start a fresh account; tokens stop at once', async () => {
  const w = world();
  const ann = await w.person('Ann', { email: true });
  const other = await w.person('Other', { email: true });
  const gameId = await w.game(ann, { ai: 2 });
  await w.start(gameId, ann);
  await w.tx(async (t) => {
    await t.setTurnEmails(ann.id, T0);
    await t.setTurnEmails(other.id, T0);
    await t.claimTurnNotification({ userId: ann.id, gameId, turnNumber: 1, kind: 'TURN_OPEN', sentAt: at(0) });
    await t.insertLoginLink({ tokenHash: `h1.${ann.email}`, email: ann.email, createdAt: at(0), expiresAt: at(1) });
    await t.insertLoginLink({ tokenHash: `h2.${other.email}`, email: other.email, createdAt: at(0), expiresAt: at(1) });
  });
  assert.equal(await w.store.getSessionVersion(ann.id), 0);
  const r = await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE', now: at(2), persona: 'HAWK' });
  assert.equal(r.ok, true);

  assert.equal(await w.tx((t) => t.getAccount(ann.id)), null, 'the account can no longer be looked up');
  assert.equal(await w.store.getSessionVersion(ann.id), null, 'so no token for it works any more');
  assert.equal(await w.tx((t) => t.findUserByEmail(ann.email)), null);
  assert.equal(await w.tx((t) => t.countLoginLinksSince(ann.email, at(-1))), 0, 'pending sign-in links for the address are gone');
  assert.equal(await w.tx((t) => t.countLoginLinksSince(other.email, at(-1))), 1, 'other people\'s are not');
  assert.equal((await w.tx((t) => t.getNotificationSettings(ann.id))).turnEmailsSince, null);
  assert.equal(await w.tx((t) => t.claimTurnNotification({ userId: ann.id, gameId, turnNumber: 1, kind: 'TURN_OPEN', sentAt: at(3) })), true, 'the record of sent mail is gone (the same mail can be claimed afresh)');
  assert.equal((await w.tx((t) => t.getNotificationSettings(other.id))).turnEmailsSince instanceof Date, true, 'other people keep theirs');
  assert.deepEqual(await w.tx((t) => t.listTurnNotificationCandidates()).then((l) => l.filter((c) => c.userId === ann.id)), [], 'and no turn mail can be addressed to the account');

  // the same address is free again: signing in with it makes a brand new account
  const again = await w.tx((t) => t.findOrCreateUserByEmail(ann.email, 'Ann again'));
  assert.equal(again.created, true);
  assert.notEqual(again.user.id, ann.id);
  assert.equal((await w.tx((t) => t.getAccount(again.user.id))).displayName, 'Ann again');
  assert.deepEqual(await w.gameIdsOf(again.user), [], 'with none of the old history');

  const second = await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE' });
  assert.equal(second.status, 404, 'deleting twice is refused');
});

scenario('delete: a lobby the person created is cancelled (with its AI seats); anyone who had joined it loses it', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const ben = await w.person('Ben');
  const gameId = await w.game(ann, { ai: 2, joiners: [ben] });
  const botIds = (await w.seats(gameId)).filter((s) => s.ai).map((s) => s.userId);
  assert.deepEqual(await w.gameIdsOf(ben), [gameId]);
  const r = await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE' });
  assert.deepEqual(r.affected, { cancelled: [gameId], left: [], handed: [] });
  assert.equal(await w.status(gameId), null, 'the game is gone');
  assert.deepEqual(await w.gameIdsOf(ben), []);
  assert.deepEqual(await w.tx((t) => t.getUsers(botIds)), {}, 'so are its AI accounts');
  assert.equal((await w.tx((t) => t.getUsers([ann.id])))[ann.id], DELETED_NAME, 'nobody was handed to an AI, so the plain name');
  assert.deepEqual(await w.tx((t) => t.getAiPersonas([ann.id])), {});
});

scenario('delete: a lobby the person only joined is left; the others stay', async () => {
  const w = world();
  const ben = await w.person('Ben');
  const ann = await w.person('Ann');
  const cy = await w.person('Cy');
  const gameId = await w.game(ben, { joiners: [ann, cy] });
  const r = await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE' });
  assert.deepEqual(r.affected, { cancelled: [], left: [gameId], handed: [] });
  assert.deepEqual((await w.seats(gameId)).map((s) => s.userId).sort(), [ben.id, cy.id].sort());
  assert.equal(await w.status(gameId), 'LOBBY');
});

scenario('delete: a running game gets an AI player in the seat, and carries on without waiting for anyone', async () => {
  const w = world();
  const ann = await w.person('Ann', { email: true });
  const ben = await w.person('Ben');
  const gameId = await w.game(ben, { ai: 1, joiners: [ann] });
  await w.start(gameId, ben);
  const seatBefore = (await w.tx((t) => t.loadSnapshot(gameId))).players.find((p) => p.userId === ann.id);

  const r = await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE', now: at(1), persona: 'DIPLOMAT' });
  assert.deepEqual(r.affected, { cancelled: [], left: [], handed: [gameId] });
  assert.deepEqual(await w.tx((t) => t.getAiPersonas([ann.id])), { [ann.id]: 'DIPLOMAT' });
  const seat = (await w.seats(gameId)).find((s) => s.userId === ann.id);
  assert.equal(seat.displayName, FORMER_PLAYER_NAME);
  assert.equal(seat.ai, 'DIPLOMAT');
  const seatAfter = (await w.tx((t) => t.loadSnapshot(gameId))).players.find((p) => p.userId === ann.id);
  assert.deepEqual([seatAfter.id, seatAfter.country, seatAfter.alive], [seatBefore.id, seatBefore.country, true], 'the same seat, still alive');

  await playAiTurns(w.store, gameId, at(1));                                           // what the route does right afterwards
  const snap = await w.tx((t) => t.loadSnapshot(gameId));
  assert.ok(snap.sheets.some((s) => s.playerId === seatAfter.id && s.isFinal), 'the new AI player has already submitted its orders');
  const done = await submitSheet(w.store, { gameId, userId: ben.id, payload: {}, final: true }, at(2));
  assert.equal(done.resolved, true, 'Ben is the only person left, so his final orders end the turn');
});

scenario('delete: if every person leaves a running game, the AI players finish it', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const gameId = await w.game(ann, { ai: 3, forfeitAfterN: 0 });
  await w.start(gameId, ann);
  const r = await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE', now: at(1) });
  assert.deepEqual(r.affected.handed, [gameId]);
  await playAiTurns(w.store, gameId, at(1));
  assert.equal(await w.status(gameId), 'FINISHED', 'no person remains, so it was played out at once');
});

scenario('delete: a finished game keeps its seat, now under a neutral name', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const gameId = await w.game(ann, { ai: 3, forfeitAfterN: 1 });
  await w.start(gameId, ann);
  await resolveDueTurns(w.store, at(25));                                              // Ann misses turn 1; only AIs remain; the game is played out
  assert.equal(await w.status(gameId), 'FINISHED');
  const r = await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE', now: at(30) });
  assert.deepEqual(r.affected, { cancelled: [], left: [], handed: [] });
  assert.equal(await w.status(gameId), 'FINISHED');
  const seat = (await w.seats(gameId)).find((s) => s.userId === ann.id);
  assert.equal(seat.displayName, DELETED_NAME);
  assert.equal(seat.ai, null, 'nothing was handed over: the game is over');
});

scenario('delete: one account across all three kinds of game is handled in one go', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const ben = await w.person('Ben');
  const mine = await w.game(ann);                                    // lobby she created
  const joined = await w.game(ben, { joiners: [ann] });              // lobby she joined
  const running = await w.game(ben, { ai: 1, joiners: [ann] });      // running game
  await w.start(running, ben);
  const r = await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE', now: at(1) });
  assert.deepEqual(r.affected, { cancelled: [mine], left: [joined], handed: [running] });
  assert.equal(await w.status(mine), null);
  assert.equal((await w.seats(joined)).some((s) => s.userId === ann.id), false);
  assert.equal((await w.seats(running)).find((s) => s.userId === ann.id).displayName, FORMER_PLAYER_NAME);
});

scenario('delete: AI accounts are not anyone\'s to delete', async () => {
  const w = world();
  const ann = await w.person('Ann');
  const gameId = await w.game(ann, { ai: 2 });
  const bot = (await w.seats(gameId)).find((s) => s.ai);
  assert.equal((await deleteAccount(w.store, { userId: bot.userId, confirm: 'DELETE' })).status, 404);
  assert.equal((await w.seats(gameId)).length, 3);
});

scenario('delete: a person deleted a moment ago cannot start another game', async () => {
  const w = world();
  const ann = await w.person('Ann');
  await deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE' });
  const r = await createGame(w.store, { userId: ann.id, settings: {} });
  assert.deepEqual([r.ok, r.status], [false, 404]);
});

scenario('delete: deleting while creating a game never leaves a lobby behind', { skip: stores.kind !== 'postgres' && 'needs real row locking (PostgreSQL)' }, async () => {
  for (let i = 0; i < 5; i++) {
    const w = world();
    const ann = await w.person('Ann');
    await Promise.all([deleteAccount(w.store, { userId: ann.id, confirm: 'DELETE' }), createGame(w.store, { userId: ann.id, settings: { aiPlayers: 1 } })]);
    const left = await w.tx((t) => t.countOpenGamesCreatedBy(ann.id));
    assert.equal(left, 0, 'either the game was cancelled by the deletion or never created');
  }
});
