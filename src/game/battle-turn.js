// Resolving a battle turn: fire orders, interception, damage, eliminations.

import { livingPlayers, sortedIds, survivingMinors } from './state.js';
import { replenishMinors } from './setup.js';
import { controller, listedMinors } from './control.js';
import { validateBattleSheet } from './validation.js';
import { advance, checkForfeits, checkOutcome, collectComms, eliminate } from './turn-shared.js';

export function applyBattle(incoming, abms) {
  const intercepted = Math.min(incoming, abms);
  return { intercepted, through: incoming - intercepted };
}

// ───────────────────────── Battle turn ─────────────────────────

export function resolveBattleTurn(state0, sheets, rng) { // eslint-disable-line no-unused-vars
  const state = structuredClone(state0);
  const events = [];
  const messages = [];
  const news = [];
  const reports = [];
  const ev = (type, data = {}) => events.push({ type, turn: state0.turnNumber, ...data });
  const firstBattle = !state0.firstBattleDone;

  // Control is fixed from the indices at the start of the battle turn.
  const ctrl = Object.fromEntries(survivingMinors(state0).map((m) => [m.id, controller(m, state0)]));

  const used = {};
  const fires = []; // { source, owner, target, n, penalty? }
  for (const p of livingPlayers(state)) {
    let sheet = sheets[p.id];
    let missed = false;
    if (!sheet) missed = true;
    else {
      const errs = validateBattleSheet(state0, p.id, sheet);
      if (errs.length) { missed = true; ev('SHEET_REJECTED', { player: p.id, errors: errs }); }
    }
    p.missedStreak = missed ? p.missedStreak + 1 : 0;
    if (missed) { sheet = {}; ev('DEFAULT_ORDERS', { player: p.id }); }
    used[p.id] = sheet;

    let homeFired = 0;
    for (const src of sortedIds(sheet.fire ?? {})) {
      for (const target of sortedIds(sheet.fire[src])) {
        const n = sheet.fire[src][target];
        if (!n) continue;
        fires.push({ source: src === 'HOME' ? p.id : src, home: src === 'HOME', owner: p.id, target, n });
        if (src === 'HOME') homeFired += n;
      }
    }
    // Declarer must fire at least one missile from home on the first battle turn.
    let penalty = false;
    if (firstBattle && state0.declarers.includes(p.id) && homeFired === 0) {
      penalty = true;
      fires.push({ source: p.id, home: true, owner: p.id, target: p.id, n: 1, penalty: true });
      homeFired = 1;
      ev('SELF_HIT_PENALTY', { player: p.id });
    }
    // Spend: bonus missiles first, then real stock. The penalty missile is paid from the bonus.
    const fromBonus = Math.min(p.bonusMissiles, homeFired);
    p.missiles -= homeFired - fromBonus;
  }
  // Minor stock is spent for every fire from a minor source.
  for (const f of fires) {
    if (!f.home) state.minors[f.source].missiles -= f.n;
  }
  for (const p of livingPlayers(state)) p.bonusMissiles = 0; // unfired bonus vanishes

  // Tally incoming per target and apply ABMs.
  const incoming = {};
  for (const f of fires) incoming[f.target] = (incoming[f.target] ?? 0) + f.n;
  const damaged = [];
  for (const target of sortedIds(incoming)) {
    const n = incoming[target];
    const player = state.players[target];
    if (player) {
      const { intercepted, through } = applyBattle(n, player.abms);
      player.abms -= intercepted;
      if (through > 0) {
        player.population = Math.max(0, player.population - through);
        player.thirds = Math.max(0, player.thirds - through);
        damaged.push({ target, incoming: n, intercepted, through, population: player.population });
      }
      ev('STRIKE', { target, incoming: n, intercepted, through });
    } else if (state.minors[target]) {
      const minor = state.minors[target];
      const { through } = applyBattle(n, 0);
      minor.population = Math.max(0, minor.population - through);
      if (through > 0) damaged.push({ target, incoming: n, intercepted: 0, through, population: minor.population });
      ev('STRIKE', { target, incoming: n, intercepted: 0, through });
    }
  }

  // Eliminations and destroyed minors (all simultaneous: they already fired).
  for (const p of livingPlayers(state)) {
    if (p.population < 1) eliminate(state, p, events, 'ELIMINATED');
  }
  for (const m of survivingMinors(state)) {
    if (m.population <= 0) {
      m.destroyed = true; m.thirds = 0; m.missiles = 0; m.cash = 0;
      ev('MINOR_DESTROYED', { minor: m.id });
    }
  }

  checkForfeits(state, events);
  collectComms(state, used, messages, news);

  const outcome = checkOutcome(state);
  if (outcome) { state.over = true; state.outcome = outcome; ev('GAME_OVER', outcome); }
  else if (survivingMinors(state).length === 0) replenishMinors(state, events);

  state.firstBattleDone = true;
  advance(state);
  state.turnType = 'NORMAL';

  // Public battle report: who fired at whom, and remaining populations of damaged countries.
  const firedMap = {};
  for (const f of fires) {
    const key = `${f.source}>${f.target}`;
    firedMap[key] = (firedMap[key] ?? 0) + f.n;
  }
  const battleResult = {
    fired: Object.entries(firedMap).map(([k, n]) => {
      const [from, to] = k.split('>');
      return { from, to, n };
    }),
    damaged,
    controllers: ctrl,
  };
  for (const p of livingPlayers(state)) {
    reports.push({ to: p.id, kind: 'FIRST_SECOND', payload: { minors: listedMinors(state, p.id) } });
  }
  return { state, events, reports, messages, news, battleResult };
}
