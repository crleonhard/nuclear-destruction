// The AI's decisions, as a pure function: hand-built situations, then thousands of random game states in which
// every sheet it writes must pass the real rules validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSheet } from '../src/ai/decide.js';
import { AI_PERSONAS, PERSONAS, isPersona } from '../src/ai/personas.js';
import {
  createInitialState, validateNormalSheet, validateBattleSheet, assetsReport, controlledMinors, minorDisplayName,
  mulberry32, COUNTRIES, MINOR_NAMES,
} from '../src/game/index.js';

const MINORS = MINOR_NAMES.map((n) => `${n}#1`);
const ME = 'FRANCE';

/** A package like the one the API gives a player (src/app/pipeline.js packageFor), with sensible defaults. */
function view({ turn = 1, type = 'NORMAL', assets = {}, players, minors = MINORS, reports = [], battleResult = null, controlled = [] } = {}) {
  const a = { country: ME, population: 50, cash: 100, thirds: 27, factories: 9, missiles: 20, abms: 10, ...assets };
  return {
    turn: { number: turn, type, status: 'OPEN' },
    assets: a,
    controlled,
    reports,
    battleResult,
    public: {
      players: (players ?? [{ country: ME, population: a.population }, { country: 'INDIA', population: 50 }, { country: 'JAPAN', population: 50 }])
        .map((p) => ({ alive: true, forfeited: false, ai: null, ...p })),
      minors: minors.map((id) => ({ id, name: id.split('#')[0], population: 20, destroyed: false })),
    },
  };
}
const decide = (v, persona = 'HAWK', extra = {}) => decideSheet(v, { persona, turnSeed: 7, stableSeed: 11, ...extra });
const sum = (o) => Object.values(o ?? {}).reduce((s, x) => s + x, 0);
const battleOf = (extra = {}) => view({ turn: 4, type: 'BATTLE', battleResult: { fired: [], damaged: [], controllers: {} }, ...extra });

test('personas: three styles, each with every number the decision code reads', () => {
  assert.deepEqual(AI_PERSONAS, ['HAWK', 'DIPLOMAT', 'OPPORTUNIST']);
  for (const p of AI_PERSONAS) {
    assert.ok(isPersona(p));
    for (const k of ['label', 'blurb', 'warTurn', 'minMissiles', 'needsEdge', 'edgeFallback', 'investTurns', 'investShare', 'abmShare', 'abmPeaceStock', 'abmWarStock', 'cores', 'coresGrowEvery', 'margin', 'fireShare']) {
      assert.notEqual(PERSONAS[p][k], undefined, `${p}.${k}`);
    }
  }
  for (const bad of ['hawk', 'NOPE', null, undefined, 3, 'toString', '__proto__']) assert.equal(isPersona(bad), false, String(bad));
  assert.throws(() => decide(view(), 'NOPE'), /unknown AI persona/);
});

test('turn 1: builds with every factory, spends all its cash on a few minors, spies on one player and two minors, no war', () => {
  const s = decide(view());
  assert.deepEqual(s.build, { missiles: 6, abms: 1, factories: 2 });               // 9 factories: 2 grow, 1 ABM, the rest missiles
  assert.equal(s.build.missiles + s.build.abms + s.build.factories, 9);
  assert.equal(sum(s.giveCashToMinors), 100);
  assert.equal(Object.keys(s.giveCashToMinors).length, 3);                         // a hawk starts with 3 minors
  assert.equal(s.spies.filter((x) => x?.kind === 'PLAYER').length, 1);
  assert.equal(s.spies.filter((x) => x?.kind === 'MINOR').length, 2);
  for (const id of Object.keys(s.giveCashToMinors)) assert.ok(MINORS.includes(id));
  assert.equal(s.declareWar, undefined, 'war cannot be declared on turn 1');
});

test('decisions are deterministic, and a player keeps its favourite minors from turn to turn', () => {
  const a = decide(view());
  assert.deepEqual(decide(view()), a);
  const first = Object.keys(a.giveCashToMinors).sort();
  const own = [{ turnNumber: 1, payload: a }];
  const later = decide(view({ turn: 2, assets: { cash: 5 } }), 'HAWK', { ownSheets: own, turnSeed: 99 });
  assert.deepEqual(Object.keys(later.giveCashToMinors).filter((id) => first.includes(id)).length > 0, true, 'it tops up minors it already courts');
  const other = decide(view(), 'HAWK', { stableSeed: 12345 });
  assert.notDeepEqual(Object.keys(other.giveCashToMinors).sort(), first, 'a different player prefers different minors');
});

test('building: growth early, ABMs up to the cap, everything else missiles; wartime fills the ABM cap', () => {
  const peaceLate = decide(view({ turn: 5, assets: { abms: 40 } }), 'HAWK');
  assert.deepEqual(peaceLate.build, { missiles: 9, abms: 0, factories: 0 });       // enough ABMs, past the growth turns
  const war = decide(view({ turn: 6, assets: { abms: 5 }, battleResult: { fired: [], damaged: [], controllers: {} } }), 'HAWK');
  assert.deepEqual(war.build, { missiles: 4, abms: 5, factories: 0 });             // cap is ceil(9/2) = 5
  const tiny = decide(view({ assets: { thirds: 2, factories: 0 } }));
  assert.deepEqual(tiny.build, { missiles: 0, abms: 0, factories: 0 });
  assert.equal(decide(view({ assets: { thirds: 3, factories: 1 }, turn: 8 })).build.abms <= 1, true);
});

test('minors: an unreachable rival is not chased, a reachable one is overtaken with a margin, nothing is over-spent', () => {
  const idx = (id, row) => ({ kind: 'SPY_MINOR', payload: { minor: id, indices: row } });
  const own = [{ turnNumber: 1, payload: { giveCashToMinors: { 'AUSTRALIA#1': 30 } } }];
  // Reachable: INDIA leads AUSTRALIA with 40 against my 30 -> I need 40 + max(2, 10%) + 1 - 30 = 15 more.
  const v = view({ turn: 2, assets: { cash: 60 }, reports: [idx('AUSTRALIA#1', { FRANCE: 30, INDIA: 40, JAPAN: 0 })] });
  const s = decide(v, 'HAWK', { ownSheets: own });
  assert.ok(s.giveCashToMinors['AUSTRALIA#1'] >= 15, JSON.stringify(s.giveCashToMinors));
  assert.equal(sum(s.giveCashToMinors), 60, 'all cash is used');
  // Unreachable: a rival at 500 with 60 cash in hand is dropped from the plan.
  const hopeless = view({ turn: 2, assets: { cash: 60 }, reports: [idx('AUSTRALIA#1', { FRANCE: 30, INDIA: 500, JAPAN: 0 })] });
  const t = decide(hopeless, 'HAWK', { ownSheets: own });
  assert.equal(t.giveCashToMinors?.['AUSTRALIA#1'], undefined);
  assert.ok(!t.spies.some((x) => x?.id === 'AUSTRALIA#1'));
  // A dead rival's stale index does not count.
  const stale = view({ turn: 2, assets: { cash: 60 }, reports: [idx('AUSTRALIA#1', { FRANCE: 30, INDIA: 0, JAPAN: 0, GERMANY: 400 })] });
  assert.ok(decide(stale, 'HAWK', { ownSheets: own }).giveCashToMinors['AUSTRALIA#1'] < 400);
  // No cash, no gifts.
  assert.equal(decide(view({ turn: 2, assets: { cash: 0 } })).giveCashToMinors, undefined);
  // Only destroyed or no minors: no gifts and no minor spies, and nothing breaks.
  const none = decide(view({ minors: [] }));
  assert.equal(none.giveCashToMinors, undefined);
  assert.deepEqual(none.spies.map((x) => x?.kind ?? null), ['PLAYER', null, null]);
});

test('spies: never two on players; in wartime the player spy goes to the weakest rival', () => {
  const players = [{ country: ME, population: 50 }, { country: 'INDIA', population: 80 }, { country: 'JAPAN', population: 12 }, { country: 'USA', population: 40 }];
  const war = decide(view({ turn: 6, players, battleResult: { fired: [], damaged: [], controllers: {} } }));
  assert.deepEqual(war.spies[0], { kind: 'PLAYER', id: 'JAPAN' });
  for (let t = 1; t < 30; t++) assert.equal(decide(view({ turn: t, players })).spies.filter((x) => x?.kind === 'PLAYER').length, 1);
  const alone = decide(view({ players: [{ country: ME, population: 50 }] }));
  assert.equal(alone.spies?.[0] ?? null, null);
});

test('war: a hawk declares as soon as it can; a diplomat waits; the careful styles hold back against a stronger spied rival; nobody declares twice', () => {
  const strong = { assets: { missiles: 60 } };
  assert.equal(decide(view({ turn: 1, ...strong }), 'HAWK').declareWar, undefined);          // never on turn 1
  assert.equal(decide(view({ turn: 2, ...strong }), 'HAWK').declareWar, undefined);          // too early for it
  assert.equal(decide(view({ turn: 3, ...strong }), 'HAWK').declareWar, true);
  assert.equal(decide(view({ turn: 3, assets: { missiles: 5 } }), 'HAWK').declareWar, undefined, 'not with a thin arsenal');
  assert.equal(decide(view({ turn: 9, ...strong }), 'DIPLOMAT').declareWar, undefined);
  assert.equal(decide(view({ turn: 10, assets: { missiles: 70 } }), 'DIPLOMAT').declareWar, true);
  const rival = [{ kind: 'SPY_PLAYER', payload: { country: 'INDIA', missiles: 400, abms: 10 } }];
  assert.equal(decide(view({ turn: 8, ...strong, reports: rival }), 'OPPORTUNIST').declareWar, undefined, 'a spied rival is much stronger');
  assert.equal(decide(view({ turn: 12, ...strong, reports: rival }), 'OPPORTUNIST').declareWar, true, 'but it does not wait forever');
  assert.equal(decide(view({ turn: 9, ...strong, battleResult: { fired: [], damaged: [], controllers: {} } }), 'HAWK').declareWar, undefined, 'war is already on');
});

// ───────────────────────── battle ─────────────────────────

test('battle: eliminates what it can, most dangerous first, never fires at minors or itself, never over-fires a source', () => {
  const players = [{ country: ME, population: 50 }, { country: 'INDIA', population: 20 }, { country: 'JAPAN', population: 30 }, { country: 'USA', population: 90 }];
  const reports = [{ kind: 'SPY_PLAYER', payload: { country: 'JAPAN', missiles: 300, abms: 4 } }, { kind: 'SPY_PLAYER', payload: { country: 'INDIA', missiles: 10, abms: 0 } }];
  const v = battleOf({ players, reports, assets: { missiles: 70 }, controlled: [{ id: 'CUBA#1', name: 'CUBA', missiles: 12 }] });
  const { fire } = decide(v);
  const hits = {};
  for (const [src, orders] of Object.entries(fire)) for (const [t, n] of Object.entries(orders)) hits[t] = (hits[t] ?? 0) + n;
  assert.ok(hits.JAPAN >= 30 + 4 + 1, 'enough to eliminate JAPAN through its 4 ABMs');
  assert.ok(hits.INDIA >= 20 + 0 + 1, 'and INDIA');
  assert.ok(!(ME in hits) && !Object.keys(hits).some((t) => t.includes('#')), 'never itself, never a minor');
  assert.ok(sum(fire.HOME) <= 70 && sum(fire['CUBA#1'] ?? {}) <= 12);
  assert.ok(sum(hits) <= 82, 'never more than it holds');
  assert.equal(violations(validateBattleSheet(battleState(v), ME, { fire })), 0);
});
const violations = (errs) => errs.length;
function battleState(v) {
  const st = createInitialState({ seed: 1, players: v.public.players.slice(0, Math.max(3, v.public.players.length)).map((p) => ({ country: p.country, population: 50 })).concat(v.public.players.length < 3 ? [{ country: 'USA', population: 50 }] : []) });
  st.turnType = 'BATTLE'; st.turnNumber = v.turn.number;
  for (const p of v.public.players) if (st.players[p.country]) { st.players[p.country].population = p.population; st.players[p.country].alive = p.alive; }
  Object.assign(st.players[v.assets.country], { missiles: v.assets.missiles, abms: v.assets.abms });
  for (const m of v.controlled) { st.minors[m.id].missiles = m.missiles; st.minors[m.id].index[v.assets.country] = 99; }
  return st;
}

test('battle: fires from home first, so a war declarer always fires at least one missile from home', () => {
  const v = battleOf({ assets: { missiles: 6 }, controlled: [{ id: 'CUBA#1', name: 'CUBA', missiles: 9 }] });
  const { fire } = decide(v, 'DIPLOMAT');
  assert.ok(sum(fire.HOME) >= 1);
  const tiny = decide(battleOf({ assets: { missiles: 1 } }), 'DIPLOMAT');
  assert.deepEqual(tiny.fire, { HOME: { [Object.keys(tiny.fire.HOME)[0]]: 1 } });
});

test('battle: with nobody it can eliminate, a hawk fires everything and a diplomat holds some back, all on the cheapest target', () => {
  const players = [{ country: ME, population: 50 }, { country: 'INDIA', population: 99 }, { country: 'JAPAN', population: 90 }];
  const v = battleOf({ players, assets: { missiles: 40 } });
  const hawk = decide(v, 'HAWK').fire;
  assert.equal(sum(hawk.HOME), 40);
  assert.deepEqual(Object.keys(hawk.HOME), ['JAPAN'], 'the cheaper of the two');
  assert.equal(sum(decide(v, 'DIPLOMAT').fire.HOME), 24);
  assert.equal(sum(decide(v, 'OPPORTUNIST').fire.HOME), 32);
});

test('battle: revenge breaks ties, including fire that came from a minor its rival controls', () => {
  const players = [{ country: ME, population: 50 }, { country: 'INDIA', population: 70 }, { country: 'JAPAN', population: 70 }];
  const base = { players, assets: { missiles: 30 } };
  const fromJapan = battleOf({ ...base, battleResult: { fired: [{ from: 'CUBA#1', to: ME, n: 15 }], damaged: [], controllers: { 'CUBA#1': 'JAPAN' } } });
  assert.deepEqual(Object.keys(decide(fromJapan).fire.HOME), ['JAPAN']);
  const fromIndia = battleOf({ ...base, battleResult: { fired: [{ from: 'INDIA', to: ME, n: 3 }], damaged: [], controllers: {} } });
  assert.deepEqual(Object.keys(decide(fromIndia).fire.HOME), ['INDIA']);
});

test('battle: nothing to fire, nobody to fire at, or no war yet means an empty sheet', () => {
  assert.deepEqual(decide(battleOf({ assets: { missiles: 0 } })), {});
  assert.deepEqual(decide(battleOf({ players: [{ country: ME, population: 50 }] })), {});
  const dead = battleOf({ players: [{ country: ME, population: 50 }, { country: 'INDIA', population: 0, alive: false }] });
  assert.deepEqual(decide(dead), {});
});

// ───────────────────────── every sheet is valid, in any situation ─────────────────────────

/** A package built from a real resolver state, the way pipeline.js builds it for a seat. */
function packageFromState(state, me, rng) {
  const reports = [];
  const others = Object.values(state.players).filter((p) => p.alive && p.id !== me);
  if (rng() < 0.7 && others.length) {
    const t = others[Math.floor(rng() * others.length)];
    reports.push({ kind: 'SPY_PLAYER', payload: { country: t.id, missiles: t.missiles, abms: t.abms } });
  }
  for (const m of Object.values(state.minors)) {
    if (rng() < 0.15) reports.push({ kind: m.destroyed && rng() < 0.5 ? 'SPY_MINOR' : 'SPY_MINOR', payload: m.destroyed ? { minor: m.id, destroyed: true } : { minor: m.id, indices: { ...m.index } } });
  }
  return {
    turn: { number: state.turnNumber, type: state.turnType, status: 'OPEN' },
    assets: assetsReport(state, me),
    controlled: state.turnType === 'BATTLE' ? controlledMinors(state, me).map((m) => ({ id: m.id, name: minorDisplayName(m), missiles: m.missiles })) : [],
    reports,
    battleResult: state.warDeclared ? { fired: others.slice(0, 2).map((o) => ({ from: o.id, to: me, n: 1 + Math.floor(rng() * 9) })), damaged: [], controllers: {} } : null,
    public: {
      players: Object.values(state.players).map((p) => ({ country: p.id, population: p.population, alive: p.alive, forfeited: false, ai: null })),
      minors: Object.values(state.minors).map((m) => ({ id: m.id, name: minorDisplayName(m), population: m.population, destroyed: m.destroyed })),
    },
  };
}

function randomState(rng) {
  const n = 3 + Math.floor(rng() * 7);
  const pool = [...COUNTRIES];
  const countries = Array.from({ length: n }, () => pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  const state = createInitialState({ seed: Math.floor(rng() * 2 ** 31), players: countries.map((c) => ({ country: c, population: 25 + Math.floor(rng() * 75) })) });
  const pick = (a) => a[Math.floor(rng() * a.length)];
  state.warDeclared = rng() < 0.5;
  state.turnNumber = state.warDeclared ? 2 + Math.floor(rng() * 40) : 1 + Math.floor(rng() * 12);
  state.turnType = state.warDeclared && rng() < 0.5 ? 'BATTLE' : 'NORMAL';
  state.firstBattleDone = state.warDeclared && rng() < 0.7;
  for (const p of Object.values(state.players)) {
    p.cash = pick([0, 0, 1, 5, 40, 100, Math.floor(rng() * 400)]);
    p.thirds = pick([0, 1, 2, 3, 5, 9, 27, Math.floor(rng() * 80)]);
    p.missiles = pick([0, 1, 7, 20, Math.floor(rng() * 300)]);
    p.abms = pick([0, 3, 10, Math.floor(rng() * 60)]);
    p.bonusMissiles = state.turnType === 'BATTLE' && rng() < 0.3 ? 5 : 0;
    p.population = pick([1, 3, 25, 50, 99, Math.floor(1 + rng() * 99)]);
    if (rng() < 0.15) { p.alive = false; p.population = 0; p.cash = p.thirds = p.missiles = p.abms = p.bonusMissiles = 0; }
  }
  for (const m of Object.values(state.minors)) {
    if (rng() < 0.25) { m.destroyed = true; m.population = 0; m.missiles = 0; m.thirds = 0; }
    else { m.missiles = Math.floor(rng() * 40); m.population = 1 + Math.floor(rng() * 20); }
    for (const c of countries) m.index[c] = rng() < 0.4 ? Math.floor(rng() * 150) : 0;
  }
  return { state, countries };
}

test('fuzz: in thousands of random situations every AI sheet passes the real rules validator', () => {
  const rng = mulberry32(2026);
  let checked = 0;
  let normal = 0;
  let battle = 0;
  for (let i = 0; i < 4000; i++) {
    const { state, countries } = randomState(rng);
    const living = countries.filter((c) => state.players[c].alive);
    if (!living.length) continue;
    const me = living[Math.floor(rng() * living.length)];
    // Remembered spy targets as an AI leaves them: a player in slot 0 and minors in slots 1 and 2 (any of them may be gone now).
    const mem = state.players[me].spySlots;
    const survivors = Object.values(state.minors).filter((m) => !m.destroyed);
    const anyMinor = () => (rng() < 0.6 && Object.keys(state.minors).length ? { kind: 'MINOR', id: Object.keys(state.minors)[Math.floor(rng() * 18)] } : null);
    mem[0] = rng() < 0.5 ? { kind: 'PLAYER', id: countries[Math.floor(rng() * countries.length)] } : null;
    mem[1] = anyMinor(); mem[2] = anyMinor();
    void survivors;
    const persona = AI_PERSONAS[i % 3];
    const v = packageFromState(state, me, rng);
    const own = rng() < 0.5 ? [] : [{ turnNumber: 1, payload: { giveCashToMinors: Object.fromEntries(Object.keys(state.minors).slice(0, 3).map((id) => [id, 1 + Math.floor(rng() * 30)])) } }];
    const sheet = decideSheet(v, { persona, ownSheets: own, turnSeed: i, stableSeed: i * 31 });
    const errors = state.turnType === 'BATTLE' ? validateBattleSheet(state, me, sheet) : validateNormalSheet(state, me, sheet);
    assert.deepEqual(errors, [], `case ${i} (${persona}, ${state.turnType}, turn ${state.turnNumber}): ${JSON.stringify(sheet)}`);
    checked++;
    if (state.turnType === 'BATTLE') battle++; else normal++;
  }
  assert.ok(checked > 3000 && normal > 1000 && battle > 500, `${checked} checked (${normal} normal, ${battle} battle)`);
});
