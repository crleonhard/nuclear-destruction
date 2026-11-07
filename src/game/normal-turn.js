// Resolving a normal turn: builds, gifts, auction, minor builds, war declaration, reports.

import { livingPlayers, sortedIds, survivingMinors, wholeFactories } from './state.js';
import { effectiveSpyTargets, listedMinors } from './control.js';
import { allocateFactories, clearingPrice } from './auction.js';
import { defaultNormalSheet, validateNormalSheet } from './validation.js';
import { advance, checkForfeits, checkOutcome, collectComms } from './turn-shared.js';

export function resolveNormalTurn(state0, sheets, rng) {
  const state = structuredClone(state0);
  const events = [];
  const messages = [];
  const news = [];
  const reports = [];
  const ev = (type, data = {}) => events.push({ type, turn: state0.turnNumber, ...data });

  // 0. Normalise sheets (missing or invalid → server default) and track missed streaks.
  const used = {};
  const startF = {};
  const spyPlan = {};
  for (const p of livingPlayers(state)) {
    let sheet = sheets[p.id];
    let missed = false;
    if (!sheet) {
      missed = true;
    } else {
      const errs = validateNormalSheet(state0, p.id, sheet);
      if (errs.length) { missed = true; ev('SHEET_REJECTED', { player: p.id, errors: errs }); }
    }
    if (missed) sheet = defaultNormalSheet(state0, p.id);
    p.missedStreak = missed ? p.missedStreak + 1 : 0;
    used[p.id] = sheet;
    startF[p.id] = wholeFactories(p.thirds);
    spyPlan[p.id] = effectiveSpyTargets(p, sheet.spies);
    if (missed) ev('DEFAULT_ORDERS', { player: p.id });
  }
  const startMinorF = Object.fromEntries(survivingMinors(state).map((m) => [m.id, wholeFactories(m.thirds)]));

  // 1. Builds (from the start-of-turn factory snapshot).
  for (const p of livingPlayers(state)) {
    const b = used[p.id].build ?? {};
    const a = b.abms ?? 0;
    const f = b.factories ?? 0;
    const missiles = startF[p.id] - a - f; // unassigned factories build missiles
    p.missiles += missiles;
    p.abms += a;
    p.thirds += f; // each factory assigned yields 1/3 of a factory
    ev('BUILD', { player: p.id, missiles, abms: a, thirdsAdded: f });
  }

  // 2. Gifts (indices only ever go up).
  for (const p of livingPlayers(state)) {
    const s = used[p.id];
    const survivors = survivingMinors(state);
    const every = s.giveCashToEveryMinor ?? 0;
    if (every > 0) {
      for (const m of survivors) {
        m.cash += every; m.index[p.id] += every; p.cash -= every;
        ev('GIFT_CASH_MINOR', { from: p.id, to: m.id, amount: every, viaEvery: true });
      }
    }
    for (const id of sortedIds(s.giveCashToMinors ?? {})) {
      const amt = s.giveCashToMinors[id];
      if (!amt) continue;
      const m = state.minors[id];
      m.cash += amt; m.index[p.id] += amt; p.cash -= amt;
      ev('GIFT_CASH_MINOR', { from: p.id, to: id, amount: amt });
    }
    for (const id of sortedIds(s.giveMissilesToMinors ?? {})) {
      const n = s.giveMissilesToMinors[id];
      if (!n) continue;
      const m = state.minors[id];
      m.missiles += n; m.index[p.id] += 10 * n; p.missiles -= n;
      ev('GIFT_MISSILES_MINOR', { from: p.id, to: id, amount: n });
    }
    for (const id of sortedIds(s.giveToPlayers ?? {})) {
      const g = s.giveToPlayers[id];
      const to = state.players[id];
      const cash = g.cash ?? 0, missiles = g.missiles ?? 0, factories = g.factories ?? 0;
      p.cash -= cash; to.cash += cash;
      p.missiles -= missiles; to.missiles += missiles;
      p.thirds -= 3 * factories; to.thirds += 3 * factories;
      ev('GIFT_PLAYER', { from: p.id, to: id, cash, missiles, factories });
    }
  }

  // 3. Factory auction (minor cash includes this turn's gifts).
  const sellers = livingPlayers(state).filter((p) => used[p.id].offerFactory);
  if (sellers.length > 0) {
    const bidders = survivingMinors(state);
    const price = clearingPrice(bidders.map((m) => m.cash), sellers.length);
    if (price === null) {
      ev('AUCTION', { offered: sellers.length, sold: 0 });
    } else {
      const { won, draws } = allocateFactories(
        bidders.map((m) => ({ id: m.id, cash: m.cash })), sellers.length, price, rng,
      );
      for (const d of draws) ev('RNG_DRAW', { purpose: 'AUCTION_TIE', ...d });
      for (const m of bidders) {
        const n = won[m.id];
        if (n > 0) { m.cash -= n * price; m.thirds += 3 * n; }
      }
      for (const p of sellers) { p.cash += price; p.thirds -= 3; }
      ev('AUCTION', { offered: sellers.length, sold: sellers.length, price, won });
    }
  }

  // 4. Minors build missiles with the factories they had at turn start.
  for (const m of survivingMinors(state)) m.missiles += startMinorF[m.id];

  // 5. Spy slots remember explicit targets.
  for (const p of livingPlayers(state)) {
    (used[p.id].spies ?? []).forEach((t, i) => { if (t) p.spySlots[i] = t; });
  }

  // 6. War declarations.
  for (const p of livingPlayers(state)) {
    if (used[p.id].declareWar) {
      state.warDeclared = true;
      if (!state.declarers.includes(p.id)) state.declarers.push(p.id);
      ev('WAR_DECLARED', { player: p.id });
    }
  }

  // 7. Forfeits, outcome, comms.
  checkForfeits(state, events);
  collectComms(state, used, messages, news);
  const outcome = checkOutcome(state);
  if (outcome) { state.over = true; state.outcome = outcome; ev('GAME_OVER', outcome); }

  // 8. Reports from the finalised end-of-turn state.
  for (const p of livingPlayers(state)) {
    reports.push({ to: p.id, kind: 'FIRST_SECOND', payload: { minors: listedMinors(state, p.id) } });
    for (const t of spyPlan[p.id]) {
      if (!t) continue;
      if (t.kind === 'PLAYER') {
        const target = state.players[t.id];
        reports.push({ to: p.id, kind: 'SPY_PLAYER', payload: target.alive
          ? { country: t.id, missiles: target.missiles, abms: target.abms }
          : { country: t.id, eliminated: true } });
      } else if (t.kind === 'MINOR') {
        const target = state.minors[t.id];
        reports.push({ to: p.id, kind: 'SPY_MINOR', payload: target && !target.destroyed
          ? { minor: t.id, indices: { ...target.index } }
          : { minor: t.id, destroyed: true } });
      }
    }
  }

  advance(state);
  state.turnType = state.warDeclared ? 'BATTLE' : 'NORMAL';
  return { state, events, reports, messages, news };
}
