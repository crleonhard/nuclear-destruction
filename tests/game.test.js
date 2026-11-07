import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState, clearingPrice, allocateFactories, applyBattle, controller, listedMinors,
  validateNormalSheet, validateBattleSheet, resolveNormalTurn, resolveBattleTurn, beginNormalTurn,
  beginBattleTurn, mulberry32, seedForTurn, replenishMinors, minorDisplayName, wholeFactories,
  survivingMinors, MINOR_NAMES,
} from '../src/game/index.js';

const fixed = (countries = ['FRANCE', 'INDIA', 'JAPAN', 'USA']) =>
  createInitialState({
    seed: 42,
    players: countries.map((country) => ({ country, population: 50 })),
  });
const rngFor = (s) => mulberry32(seedForTurn(s.seed, s.turnNumber));
const codes = (errs) => errs.map((e) => e.code);

// ── Setup ──

test('setup: 18 minors, correct starting assets, 3-9 players enforced', () => {
  const s = fixed();
  assert.equal(Object.keys(s.minors).length, 18);
  assert.equal(s.players.FRANCE.thirds, 27);
  assert.equal(s.players.FRANCE.cash, 100);
  assert.equal(s.minors['CUBA#1'].missiles, 5);
  assert.throws(() => createInitialState({ seed: 1, players: [{}, {}] }));
  assert.throws(() => createInitialState({ seed: 1, players: Array(10).fill({}) }));
});

test('setup: unpicked countries and populations are random but reproducible', () => {
  const mk = () => createInitialState({ seed: 7, players: [{ country: 'USA' }, {}, {}, {}] });
  const a = mk(); const b = mk();
  assert.deepEqual(Object.keys(a.players), Object.keys(b.players));
  assert.equal(new Set(Object.keys(a.players)).size, 4);
  for (const p of Object.values(a.players)) assert.ok(p.population >= 25 && p.population <= 99);
  assert.deepEqual(a.players, b.players);
});

// ── Auction ──

test('auction: rulebook examples', () => {
  assert.equal(clearingPrice([80, 50, 30], 3), 40);
  assert.equal(clearingPrice([80, 50, 30], 2), 50);
  assert.equal(clearingPrice([80, 50, 30], 1), 80);
  assert.equal(clearingPrice([100, 50], 2), 50);
});

test('auction: no sale when minors cannot afford k at $1', () => {
  assert.equal(clearingPrice([0, 0, 0], 1), null);
  assert.equal(clearingPrice([1], 2), null);
  assert.equal(clearingPrice([1, 1], 2), 1);
  assert.equal(clearingPrice([5, 5], 0), null);
});

test('auction: allocation matches rulebook (A gets 2, B gets 1)', () => {
  const { won } = allocateFactories(
    [{ id: 'A', cash: 80 }, { id: 'B', cash: 50 }, { id: 'C', cash: 30 }], 3, 40, mulberry32(1),
  );
  assert.deepEqual(won, { A: 2, B: 1, C: 0 });
});

test('auction: ties are broken by seeded rng and are reproducible', () => {
  const run = (seed) => allocateFactories(
    [{ id: 'A', cash: 100 }, { id: 'B', cash: 50 }], 2, 50, mulberry32(seed)).won;
  assert.equal(run(5).A >= 1, true);
  assert.deepEqual(run(5), run(5));
  const outcomes = new Set();
  for (let s = 0; s < 40; s++) outcomes.add(JSON.stringify(run(s)));
  assert.equal(outcomes.size, 2); // both {A:2,B:0} and {A:1,B:1} occur
});

// ── Control and ranking ──

test('control: strict highest only, ties and all-zero mean no controller', () => {
  const s = fixed();
  const m = s.minors['CUBA#1'];
  assert.equal(controller(m, s), null);
  m.index.FRANCE = 5; m.index.INDIA = 5;
  assert.equal(controller(m, s), null);
  m.index.INDIA = 6;
  assert.equal(controller(m, s), 'INDIA');
});

test('control: eliminated players are ignored', () => {
  const s = fixed();
  const m = s.minors['CUBA#1'];
  m.index.FRANCE = 9; m.index.INDIA = 4;
  s.players.FRANCE.alive = false;
  assert.equal(controller(m, s), 'INDIA');
});

test('ranking: competition ranking table from the spec', () => {
  const s = fixed(['FRANCE', 'INDIA', 'JAPAN', 'USA']);
  const m = s.minors['CUBA#1'];
  const check = (vals, expected) => {
    [m.index.FRANCE, m.index.INDIA, m.index.JAPAN, m.index.USA] = vals;
    const listedFor = ['FRANCE', 'INDIA', 'JAPAN', 'USA'].filter((id) => listedMinors(s, id).includes('CUBA#1'));
    assert.deepEqual(listedFor, expected, JSON.stringify(vals));
  };
  check([10, 5, 3, 0], ['FRANCE', 'INDIA']);
  check([10, 10, 5, 0], ['FRANCE', 'INDIA']);
  check([10, 5, 5, 3], ['FRANCE', 'INDIA', 'JAPAN']);
  check([7, 7, 7, 0], ['FRANCE', 'INDIA', 'JAPAN']);
  check([0, 0, 0, 0], []);
});

// ── Validation ──

test('validation: build limits', () => {
  const s = fixed();
  assert.deepEqual(codes(validateNormalSheet(s, 'FRANCE', { build: { missiles: 4, abms: 3, factories: 2 } })), []);
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { build: { missiles: 10 } })).includes('BUILD_OVER_CAPACITY'));
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { build: { abms: 6 } })).includes('ABM_CAP_EXCEEDED'));
  assert.deepEqual(codes(validateNormalSheet(s, 'FRANCE', { build: { abms: 5 } })), []); // ceil(9/2) = 5
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { build: { abms: 1.5 } })).includes('NOT_INTEGER'));
});

test('validation: fractional factories do not build (7 and 2/3 factories => 7)', () => {
  const s = fixed();
  s.players.FRANCE.thirds = 23;
  assert.equal(wholeFactories(23), 7);
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { build: { missiles: 8 } })).includes('BUILD_OVER_CAPACITY'));
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { build: { abms: 5 } })).includes('ABM_CAP_EXCEEDED')); // cap is 4
});

test('validation: cash, missile pool and factory gift limits', () => {
  const s = fixed();
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { giveCashToMinors: { 'CUBA#1': 101 } })).includes('CASH_OVER_START'));
  // "every minor" costs amount x 18
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { giveCashToEveryMinor: 6 })).includes('CASH_OVER_START'));
  assert.deepEqual(codes(validateNormalSheet(s, 'FRANCE', { giveCashToEveryMinor: 5 })), []);
  // pool = 20 stock + 9 built (all factories default to missiles)
  assert.deepEqual(codes(validateNormalSheet(s, 'FRANCE', { giveMissilesToMinors: { 'CUBA#1': 29 } })), []);
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { giveMissilesToMinors: { 'CUBA#1': 30 } })).includes('MISSILE_POOL_EXCEEDED'));
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { giveToPlayers: { INDIA: { factories: 3 } } })).includes('FACTORY_GIFT_LIMIT'));
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { giveToPlayers: { FRANCE: { cash: 1 } } })).includes('TARGET_INVALID'));
});

test('validation: defaulted spy targets count toward the one-player-spy limit', () => {
  const s = fixed();
  s.players.FRANCE.spySlots[0] = { kind: 'PLAYER', id: 'INDIA' };
  const errs = validateNormalSheet(s, 'FRANCE', { spies: [null, { kind: 'PLAYER', id: 'JAPAN' }, null] });
  assert.ok(codes(errs).includes('SPY_PLAYER_LIMIT'));
  assert.match(errs.find((e) => e.code === 'SPY_PLAYER_LIMIT').message, /repeating last turn/);
  // Overriding the defaulted slot with a minor fixes it.
  const ok = validateNormalSheet(s, 'FRANCE', {
    spies: [{ kind: 'MINOR', id: 'CUBA#1' }, { kind: 'PLAYER', id: 'JAPAN' }, null],
  });
  assert.deepEqual(codes(ok), []);
});

test('validation: war not allowed on turn 1; messages limited', () => {
  const s = fixed();
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { declareWar: true })).includes('WAR_NOT_ALLOWED'));
  s.turnNumber = 2;
  assert.deepEqual(codes(validateNormalSheet(s, 'FRANCE', { declareWar: true })), []);
  const long = 'x'.repeat(501);
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { messages: { INDIA: { text: long } } })).includes('MESSAGE_INVALID'));
  assert.ok(codes(validateNormalSheet(s, 'FRANCE', { worldNews: { text: 'y'.repeat(61) } })).includes('MESSAGE_INVALID'));
});

// ── Normal turn resolution ──

test('normal turn: default build, thirds accumulate, free third and income', () => {
  let s = fixed();
  const r = resolveNormalTurn(s, {
    FRANCE: { build: { missiles: 4, abms: 3, factories: 2 } },
    INDIA: {}, JAPAN: {}, USA: {},
  }, rngFor(s));
  assert.equal(r.state.players.FRANCE.thirds, 29); // +2 thirds
  assert.equal(r.state.players.FRANCE.abms, 13);
  assert.equal(r.state.players.FRANCE.missiles, 20 + 4); // 9 factories: 3 ABMs, 2 new factories, 4 missiles
  assert.equal(r.state.turnNumber, 2);
  s = beginNormalTurn(r.state).state;
  assert.equal(s.players.FRANCE.cash, 105);
  // A player under one whole factory gets a free third at the next normal turn start.
  s.players.USA.thirds = 2;
  s = beginNormalTurn(s).state;
  assert.equal(s.players.USA.thirds, 3);
});

test('normal turn: gifts raise indices (+1 per $1M, +10 per missile) and spend resources', () => {
  const s = fixed();
  const r = resolveNormalTurn(s, {
    FRANCE: { giveCashToMinors: { 'CUBA#1': 7 }, giveMissilesToMinors: { 'CUBA#1': 2 } },
    INDIA: {}, JAPAN: {}, USA: {},
  }, rngFor(s));
  const cuba = r.state.minors['CUBA#1'];
  assert.equal(cuba.index.FRANCE, 7 + 20);
  assert.equal(cuba.cash, 7);
  assert.equal(cuba.missiles, 5 + 2 + 1); // gift plus its own factory build
  assert.equal(r.state.players.FRANCE.cash, 93);
  assert.equal(controller(cuba, r.state), 'FRANCE');
});

test('normal turn: factory gift moves whole factories; seller still builds with it', () => {
  const s = fixed();
  const r = resolveNormalTurn(s, {
    FRANCE: { giveToPlayers: { INDIA: { factories: 2 } } },
    INDIA: {}, JAPAN: {}, USA: {},
  }, rngFor(s));
  assert.equal(r.state.players.FRANCE.thirds, 27 - 6);
  assert.equal(r.state.players.INDIA.thirds, 27 + 6);
  assert.equal(r.state.players.FRANCE.missiles, 20 + 9); // built with all 9 at turn start
  assert.equal(r.state.players.INDIA.missiles, 20 + 9);
});

test('normal turn: factory sale pays the uniform price and moves the factory', () => {
  const s = fixed();
  s.minors['CUBA#1'].cash = 80; s.minors['TOGO#1'].cash = 50; s.minors['RWANDA#1'].cash = 30;
  const r = resolveNormalTurn(s, {
    FRANCE: { offerFactory: true }, INDIA: { offerFactory: true }, JAPAN: { offerFactory: true }, USA: {},
  }, rngFor(s));
  assert.equal(r.state.players.FRANCE.cash, 140);
  assert.equal(r.state.players.FRANCE.thirds, 24);
  assert.equal(r.state.minors['CUBA#1'].thirds, 3 + 6);
  assert.equal(r.state.minors['CUBA#1'].cash, 0);
  assert.equal(r.state.minors['TOGO#1'].thirds, 3 + 3);
  assert.equal(r.state.minors['TOGO#1'].cash, 10);
  assert.equal(r.state.minors['RWANDA#1'].cash, 30);
});

test('normal turn: failed sale leaves factories with owners', () => {
  const s = fixed();
  const r = resolveNormalTurn(s, { FRANCE: { offerFactory: true }, INDIA: {}, JAPAN: {}, USA: {} }, rngFor(s));
  assert.equal(r.state.players.FRANCE.thirds, 27);
  assert.equal(r.state.players.FRANCE.cash, 100);
});

test('normal turn: spy reports show end-of-turn values, after gifts', () => {
  const s = fixed();
  const r = resolveNormalTurn(s, {
    FRANCE: { spies: [{ kind: 'MINOR', id: 'CUBA#1' }, { kind: 'PLAYER', id: 'INDIA' }, null] },
    INDIA: { giveCashToMinors: { 'CUBA#1': 4 }, giveMissilesToMinors: { 'TOGO#1': 3 } },
    JAPAN: {}, USA: {},
  }, rngFor(s));
  const minorSpy = r.reports.find((x) => x.to === 'FRANCE' && x.kind === 'SPY_MINOR');
  assert.equal(minorSpy.payload.indices.INDIA, 4);
  const playerSpy = r.reports.find((x) => x.to === 'FRANCE' && x.kind === 'SPY_PLAYER');
  assert.equal(playerSpy.payload.missiles, 20 + 9 - 3);
  assert.equal(playerSpy.payload.abms, 10);
  // Spy slots remembered for next turn.
  assert.deepEqual(r.state.players.FRANCE.spySlots[0], { kind: 'MINOR', id: 'CUBA#1' });
});

test('normal turn: missed turn gets defaults; forfeit after N misses', () => {
  let s = fixed();
  s.forfeitAfterN = 2;
  let r = resolveNormalTurn(s, { FRANCE: {}, INDIA: {}, JAPAN: {} }, rngFor(s)); // USA missed
  assert.equal(r.state.players.USA.missedStreak, 1);
  assert.equal(r.state.players.USA.missiles, 29); // all factories built missiles
  assert.equal(r.state.players.USA.alive, true);
  s = r.state;
  r = resolveNormalTurn(s, { FRANCE: {}, INDIA: {}, JAPAN: {} }, rngFor(s));
  assert.equal(r.state.players.USA.alive, false);
  assert.equal(r.state.players.USA.forfeited, true);
});

test('normal turn: a valid sheet resets the missed streak', () => {
  const s = fixed();
  s.players.USA.missedStreak = 3;
  const r = resolveNormalTurn(s, { FRANCE: {}, INDIA: {}, JAPAN: {}, USA: {} }, rngFor(s));
  assert.equal(r.state.players.USA.missedStreak, 0);
});

test('normal turn: war declaration switches the next turn to BATTLE', () => {
  const s = fixed(); s.turnNumber = 2;
  const r = resolveNormalTurn(s, { FRANCE: { declareWar: true }, INDIA: {}, JAPAN: {}, USA: {} }, rngFor(s));
  assert.equal(r.state.warDeclared, true);
  assert.deepEqual(r.state.declarers, ['FRANCE']);
  assert.equal(r.state.turnType, 'BATTLE');
});

test('messages: anonymous hides sender; delivered only to living recipients', () => {
  const s = fixed();
  const r = resolveNormalTurn(s, {
    FRANCE: { messages: { INDIA: { text: 'hi', anonymous: true }, JAPAN: { text: 'yo' } } },
    INDIA: {}, JAPAN: {}, USA: {},
  }, rngFor(s));
  assert.deepEqual(r.messages.find((m) => m.to === 'INDIA'), { to: 'INDIA', from: null, sender: 'FRANCE', anonymous: true, text: 'hi' });
  assert.equal(r.messages.find((m) => m.to === 'JAPAN').from, 'FRANCE');
});

// ── Battle ──

test('battle math: ABMs intercept up to their count and the rest are retained', () => {
  assert.deepEqual(applyBattle(4, 10), { intercepted: 4, through: 0 });
  assert.deepEqual(applyBattle(15, 10), { intercepted: 10, through: 5 });
  assert.deepEqual(applyBattle(0, 10), { intercepted: 0, through: 0 });
});

const warState = () => {
  let s = fixed(); s.turnNumber = 2;
  s = resolveNormalTurn(s, { FRANCE: { declareWar: true }, INDIA: {}, JAPAN: {}, USA: {} }, rngFor(s)).state;
  return beginBattleTurn(s);
};

test('battle: declarer gets 5 bonus missiles and fires them first', () => {
  const s = warState();
  assert.equal(s.players.FRANCE.bonusMissiles, 5);
  const r = resolveBattleTurn(s, {
    FRANCE: { fire: { HOME: { INDIA: 5 } } }, INDIA: {}, JAPAN: {}, USA: {},
  }, rngFor(s));
  assert.equal(r.state.players.FRANCE.missiles, s.players.FRANCE.missiles); // bonus paid for it
  assert.equal(r.state.players.FRANCE.bonusMissiles, 0);
  assert.equal(r.state.players.INDIA.abms, 10 - 5);
  assert.equal(r.state.players.INDIA.population, 50); // all intercepted
});

test('battle: declarer who fires nothing takes a self-hit paid from the bonus, subject to ABMs', () => {
  const s = warState();
  const r = resolveBattleTurn(s, { FRANCE: {}, INDIA: {}, JAPAN: {}, USA: {} }, rngFor(s));
  assert.ok(r.events.some((e) => e.type === 'SELF_HIT_PENALTY' && e.player === 'FRANCE'));
  assert.equal(r.state.players.FRANCE.abms, 10 - 1);
  assert.equal(r.state.players.FRANCE.population, 50);
  assert.equal(r.state.players.FRANCE.missiles, s.players.FRANCE.missiles); // real stock untouched
});

test('battle: unintercepted missiles cost population and a third of a factory each', () => {
  const s = warState();
  s.players.INDIA.abms = 2;
  const r = resolveBattleTurn(s, {
    FRANCE: { fire: { HOME: { INDIA: 5 } } }, INDIA: {}, JAPAN: {}, USA: { fire: { HOME: { INDIA: 3 } } },
  }, rngFor(s));
  // 8 incoming, 2 intercepted, 6 through
  assert.equal(r.state.players.INDIA.population, 44);
  assert.equal(r.state.players.INDIA.thirds, 27 - 6);
  assert.equal(r.state.players.INDIA.abms, 0);
  assert.equal(r.state.players.USA.missiles, s.players.USA.missiles - 3);
  assert.deepEqual(r.battleResult.damaged.map((d) => d.target), ['INDIA']);
});

test('battle: 20 missiles wipe out a minor; control comes from start of turn; simultaneity holds', () => {
  const s = warState();
  const cuba = s.minors['CUBA#1'];
  cuba.index.USA = 50; cuba.missiles = 4;
  s.players.USA.missiles = 30;
  const r = resolveBattleTurn(s, {
    FRANCE: {}, INDIA: {}, JAPAN: {},
    USA: { fire: { HOME: { 'CUBA#1': 20 }, 'CUBA#1': { INDIA: 4 } } }, // fires from CUBA although it is dying
  }, rngFor(s));
  assert.equal(r.state.minors['CUBA#1'].destroyed, true);
  assert.equal(r.state.players.INDIA.population, 50 - 0); // 4 incoming, all intercepted by ABMs
  assert.equal(r.battleResult.fired.some((f) => f.from === 'CUBA#1' && f.to === 'INDIA'), true);
});

test('battle: cannot fire minors you do not control or more than stock', () => {
  const s = warState();
  assert.ok(codes(validateBattleSheet(s, 'INDIA', { fire: { 'CUBA#1': { USA: 1 } } })).includes('TARGET_INVALID'));
  assert.ok(codes(validateBattleSheet(s, 'INDIA', { fire: { HOME: { USA: 99 } } })).includes('FIRE_OVER_STOCK'));
  assert.ok(codes(validateBattleSheet(s, 'INDIA', { build: { missiles: 1 } })).includes('NOT_YOUR_TURN_TYPE'));
});

test('battle: elimination, win, and all-eliminated draw', () => {
  let s = warState();
  for (const id of ['INDIA', 'JAPAN']) { s.players[id].alive = false; }
  s.players.USA.abms = 0; s.players.USA.population = 3;
  s.players.FRANCE.abms = 0; s.players.FRANCE.population = 3;
  s.players.FRANCE.missiles = 10; s.players.USA.missiles = 10;
  let r = resolveBattleTurn(s, {
    FRANCE: { fire: { HOME: { USA: 3 } } }, USA: {},
  }, rngFor(s));
  assert.equal(r.state.over, true);
  assert.deepEqual(r.state.outcome, { reason: 'WIN', winner: 'FRANCE' });

  // Both wiped out on the same turn: no winner.
  r = resolveBattleTurn(s, {
    FRANCE: { fire: { HOME: { USA: 3 } } }, USA: { fire: { HOME: { FRANCE: 3 } } },
  }, rngFor(s));
  assert.deepEqual(r.state.outcome, { reason: 'DRAW' });
});

test('battle: missed battle turn fires nothing and keeps missiles', () => {
  const s = warState();
  const r = resolveBattleTurn(s, { FRANCE: { fire: { HOME: { INDIA: 1 } } } }, rngFor(s));
  assert.equal(r.state.players.USA.missiles, s.players.USA.missiles);
  assert.equal(r.state.players.USA.missedStreak, 1);
});

test('battle: every minor destroyed triggers replenishment with generation suffixes', () => {
  const s = warState();
  for (const m of Object.values(s.minors)) m.population = 1;
  // France wipes out a minor per missile (bonus + real), others sit.
  s.players.FRANCE.missiles = 30;
  const fire = {};
  for (const m of Object.values(s.minors)) fire[m.id] = 1;
  s.players.FRANCE.bonusMissiles = 0;
  const r = resolveBattleTurn(s, { FRANCE: { fire: { HOME: fire } }, INDIA: {}, JAPAN: {}, USA: {} }, rngFor(s));
  const alive = survivingMinors(r.state);
  assert.equal(alive.length, 5);
  assert.deepEqual(alive.map(minorDisplayName), ['AUSTRALIA (II)', 'BELGIUM (II)', 'CUBA (II)', 'DENMARK (II)', 'ESTONIA (II)']);
  assert.ok(alive.every((m) => Object.values(m.index).every((v) => v === 0)));
  assert.equal(r.state.replenishCursor, 5);
});

test('replenish: names wrap around the list and bump the generation', () => {
  const s = fixed();
  s.replenishCursor = 17;
  const ids = replenishMinors(s, []);
  assert.deepEqual(ids.slice(0, 2), ['URUGUAY#2', 'AUSTRALIA#3']);
  assert.equal(minorDisplayName(s.minors['AUSTRALIA#3']), 'AUSTRALIA (III)');
  assert.equal(MINOR_NAMES.length, 18);
});

// ── Determinism ──

test('determinism: same state, sheets and seed give identical results', () => {
  const s = fixed();
  s.minors['CUBA#1'].cash = 100; s.minors['TOGO#1'].cash = 50;
  const sheets = { FRANCE: { offerFactory: true }, INDIA: { offerFactory: true }, JAPAN: {}, USA: {} };
  const a = resolveNormalTurn(s, sheets, rngFor(s));
  const b = resolveNormalTurn(s, sheets, rngFor(s));
  assert.deepEqual(a, b);
});

test('resolver does not mutate its input state', () => {
  const s = fixed();
  const snapshot = JSON.stringify(s);
  resolveNormalTurn(s, { FRANCE: { build: { abms: 5 } }, INDIA: {}, JAPAN: {}, USA: {} }, rngFor(s));
  assert.equal(JSON.stringify(s), snapshot);
});
