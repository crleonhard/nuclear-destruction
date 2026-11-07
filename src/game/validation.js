// Checking a turn sheet against the rules, and the default sheet.

import { CONFIG } from './constants.js';
import { isNat, maxAbmFactories, survivingMinors, wholeFactories } from './state.js';
import { controlledMinors, effectiveSpyTargets, targetExists } from './control.js';

function* numericFields(sheet) {
  const b = sheet.build ?? {};
  for (const k of ['missiles', 'abms', 'factories']) if (b[k] !== undefined) yield [`build.${k}`, b[k]];
  if (sheet.giveCashToEveryMinor !== undefined) yield ['giveCashToEveryMinor', sheet.giveCashToEveryMinor];
  for (const [id, v] of Object.entries(sheet.giveCashToMinors ?? {})) yield [`giveCashToMinors.${id}`, v];
  for (const [id, v] of Object.entries(sheet.giveMissilesToMinors ?? {})) yield [`giveMissilesToMinors.${id}`, v];
  for (const [id, g] of Object.entries(sheet.giveToPlayers ?? {})) {
    for (const k of ['cash', 'missiles', 'factories']) {
      if (g?.[k] !== undefined) yield [`giveToPlayers.${id}.${k}`, g[k]];
    }
  }
}

function validateComms(state, p, sheet, err) {
  for (const [to, msg] of Object.entries(sheet.messages ?? {})) {
    if (!msg || typeof msg.text !== 'string' || msg.text.length === 0) continue; // empty = no message
    if (!state.players[to]?.alive || to === p.id) {
      err('MESSAGE_INVALID', `messages.${to}`, 'Recipient must be another living player');
    } else if (msg.text.length > CONFIG.maxMessageChars) {
      err('MESSAGE_INVALID', `messages.${to}`, `Max ${CONFIG.maxMessageChars} characters`);
    }
  }
  const news = sheet.worldNews;
  if (news?.text && news.text.length > CONFIG.maxNewsChars) {
    err('MESSAGE_INVALID', 'worldNews', `Max ${CONFIG.maxNewsChars} characters`);
  }
}

export function validateNormalSheet(state, playerId, sheet) {
  const errors = [];
  const err = (code, field, message) => errors.push({ code, field, message });
  const p = state.players[playerId];
  if (!p?.alive) return [{ code: 'TARGET_INVALID', field: 'player', message: 'Player is not active' }];
  if (state.turnType !== 'NORMAL') {
    return [{ code: 'NOT_YOUR_TURN_TYPE', field: 'sheet', message: 'This is a battle turn' }];
  }
  sheet = sheet ?? {};

  for (const [field, v] of numericFields(sheet)) {
    if (!isNat(v)) err('NOT_INTEGER', field, 'Must be a whole number, 0 or more');
  }
  if (errors.length) return errors;

  const F = wholeFactories(p.thirds);
  const bm = sheet.build?.missiles ?? 0;
  const ba = sheet.build?.abms ?? 0;
  const bf = sheet.build?.factories ?? 0;
  if (bm + ba + bf > F) err('BUILD_OVER_CAPACITY', 'build', `Assigned ${bm + ba + bf} factories but have ${F}`);
  if (ba > maxAbmFactories(F)) err('ABM_CAP_EXCEEDED', 'build.abms', `At most ${maxAbmFactories(F)} factories on ABMs`);
  const built = Math.max(0, F - ba - bf);

  const survivors = survivingMinors(state);
  const minorOk = (id) => !!state.minors[id] && !state.minors[id].destroyed;
  const playerOk = (id) => !!state.players[id]?.alive && id !== playerId;

  let cashTotal = (sheet.giveCashToEveryMinor ?? 0) * survivors.length;
  for (const [id, v] of Object.entries(sheet.giveCashToMinors ?? {})) {
    if (!minorOk(id)) err('TARGET_INVALID', `giveCashToMinors.${id}`, 'Unknown or destroyed minor');
    cashTotal += v;
  }
  let missilesGiven = 0;
  for (const [id, v] of Object.entries(sheet.giveMissilesToMinors ?? {})) {
    if (!minorOk(id)) err('TARGET_INVALID', `giveMissilesToMinors.${id}`, 'Unknown or destroyed minor');
    missilesGiven += v;
  }
  let factoriesGiven = 0;
  for (const [id, g] of Object.entries(sheet.giveToPlayers ?? {})) {
    if (!playerOk(id)) { err('TARGET_INVALID', `giveToPlayers.${id}`, 'Must be another living player'); continue; }
    cashTotal += g.cash ?? 0;
    missilesGiven += g.missiles ?? 0;
    const fg = g.factories ?? 0;
    if (fg > 2) err('FACTORY_GIFT_LIMIT', `giveToPlayers.${id}.factories`, 'At most 2 factories to one player');
    factoriesGiven += fg;
  }
  if (cashTotal > p.cash) err('CASH_OVER_START', 'cash', `Giving $${cashTotal} but start-of-turn cash is $${p.cash}`);
  if (missilesGiven > p.missiles + built) {
    err('MISSILE_POOL_EXCEEDED', 'missiles', `Giving ${missilesGiven} but pool is ${p.missiles + built}`);
  }
  if (factoriesGiven + (sheet.offerFactory ? 1 : 0) > F) {
    err('FACTORY_GIFT_LIMIT', 'factories', `Given plus offered (${factoriesGiven + (sheet.offerFactory ? 1 : 0)}) exceeds ${F}`);
  }

  // Spies: validate EFFECTIVE targets, including defaulted slots.
  const plan = effectiveSpyTargets(p, sheet.spies);
  const playerSlots = [];
  plan.forEach((t, i) => {
    if (!t) return;
    const explicit = sheet.spies?.[i] != null;
    if (!targetExists(state, t)) {
      if (explicit) err('TARGET_INVALID', `spies[${i}]`, 'Unknown, destroyed or eliminated target');
      return; // a defaulted target that no longer exists simply does nothing
    }
    if (t.kind === 'PLAYER') playerSlots.push(`slot ${i + 1}${explicit ? '' : ' (repeating last turn)'}`);
  });
  if (playerSlots.length > 1) {
    err('SPY_PLAYER_LIMIT', 'spies', `Only one spy may go to a player per turn: ${playerSlots.join(', ')}`);
  }

  validateComms(state, p, sheet, err);

  if (sheet.declareWar && (state.turnNumber === 1 || state.warDeclared)) {
    err('WAR_NOT_ALLOWED', 'declareWar', 'War may not be declared on turn 1 or after war has begun');
  }
  return errors;
}

const hasContent = (v) => !!v && (typeof v !== 'object' || Object.keys(v).length > 0);

export function validateBattleSheet(state, playerId, sheet) {
  const errors = [];
  const err = (code, field, message) => errors.push({ code, field, message });
  const p = state.players[playerId];
  if (!p?.alive) return [{ code: 'TARGET_INVALID', field: 'player', message: 'Player is not active' }];
  if (state.turnType !== 'BATTLE') {
    return [{ code: 'NOT_YOUR_TURN_TYPE', field: 'sheet', message: 'This is a normal turn' }];
  }
  sheet = sheet ?? {};
  for (const k of ['build', 'spies', 'giveCashToMinors', 'giveCashToEveryMinor', 'giveMissilesToMinors',
    'giveToPlayers', 'offerFactory', 'declareWar']) {
    if (hasContent(sheet[k])) err('NOT_YOUR_TURN_TYPE', k, 'Not allowed on battle turns');
  }

  const stock = { HOME: p.missiles + p.bonusMissiles };
  for (const m of controlledMinors(state, playerId)) stock[m.id] = m.missiles;
  const targetOk = (id) =>
    !!state.players[id]?.alive || (!!state.minors[id] && !state.minors[id].destroyed);

  for (const [src, orders] of Object.entries(sheet.fire ?? {})) {
    if (!(src in stock)) { err('TARGET_INVALID', `fire.${src}`, 'Not a source you control'); continue; }
    let total = 0;
    for (const [target, n] of Object.entries(orders ?? {})) {
      if (!isNat(n)) { err('NOT_INTEGER', `fire.${src}.${target}`, 'Must be a whole number, 0 or more'); continue; }
      if (!targetOk(target)) err('TARGET_INVALID', `fire.${src}.${target}`, 'Unknown, destroyed or eliminated target');
      total += n;
    }
    if (total > stock[src]) err('FIRE_OVER_STOCK', `fire.${src}`, `Firing ${total} but holds ${stock[src]}`);
  }
  validateComms(state, p, sheet, err);
  return errors;
}

// ───────────────────────── Default sheets ─────────────────────────

export function defaultNormalSheet(state, playerId) {
  const F = wholeFactories(state.players[playerId].thirds);
  return { build: { missiles: F, abms: 0, factories: 0 }, spies: [null, null, null] };
}
