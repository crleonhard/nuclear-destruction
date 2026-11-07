// What an AI player puts on its sheet. Pure: no database, no clock, no hidden state.
//
// An AI sees exactly what a person sees: the player package for its seat (its own assets, last turn's spy
// reports, messages, news and battle result, and the public table of countries and minors), plus its own
// earlier sheets, which any player could keep in a notebook. It never reads the real game state.
//
//   view       what GET /games/:id/state returns for this player
//   persona    a key of PERSONAS
//   ownSheets  this player's own sheets from earlier turns: [{ turnNumber, payload }]
//   turnSeed   a number that changes every turn (for small random choices)
//   stableSeed a number that stays the same all game for this player (so its favourite minors are stable)
//
// Returns the sheet payload. The caller still validates it exactly as it would a person's sheet.

import { PERSONAS } from './personas.js';
import { mulberry32 } from '../game/rng.js';

const hashStr = (s) => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const stableKey = (stableSeed, id) => mulberry32((stableSeed ^ hashStr(id)) >>> 0)();

export function decideSheet(view, { persona, ownSheets = [], turnSeed = 0, stableSeed = 0 }) {
  const P = PERSONAS[persona];
  if (!P) throw new Error(`unknown AI persona ${persona}`);
  const ctx = { P, view, ownSheets, rng: mulberry32(turnSeed >>> 0), stableSeed };
  return view.turn.type === 'BATTLE' ? battleSheet(ctx) : normalSheet(ctx);
}

// ───────────────────────── what the AI knows ─────────────────────────

function knowledge(view) {
  const me = view.assets.country;
  const enemies = view.public.players.filter((p) => p.alive && p.country !== me);
  const minors = view.public.minors.filter((m) => !m.destroyed);
  const intel = {};          // country -> { missiles, abms } from last turn's spy reports
  const minorIndices = {};   // minor id -> { country: index } from last turn's spy reports
  for (const r of view.reports ?? []) {
    if (r.kind === 'SPY_PLAYER' && !r.payload.eliminated) intel[r.payload.country] = { missiles: r.payload.missiles, abms: r.payload.abms };
    if (r.kind === 'SPY_MINOR' && !r.payload.destroyed) minorIndices[r.payload.minor] = r.payload.indices;
  }
  const war = view.battleResult != null;   // a battle result exists only once a battle turn has happened
  return { me, enemies, minors, intel, minorIndices, war, turn: view.turn.number };
}

/** My own popularity in each minor, rebuilt from my own past gifts (it only ever rises, and only by my gifts). */
function ownIndices(ownSheets) {
  const idx = {};
  for (const { payload } of ownSheets) {
    for (const [id, v] of Object.entries(payload?.giveCashToMinors ?? {})) idx[id] = (idx[id] ?? 0) + v;
    for (const [id, v] of Object.entries(payload?.giveMissilesToMinors ?? {})) idx[id] = (idx[id] ?? 0) + 10 * v;
  }
  return idx;
}

// ───────────────────────── normal turns ─────────────────────────

function normalSheet({ P, view, ownSheets, stableSeed }) {
  const k = knowledge(view);
  const { assets } = view;
  const F = assets.factories;
  const sheet = {};

  // Build. Early on some factories grow the economy; ABMs rise with the threat; the rest build missiles.
  const cap = Math.ceil(F / 2);
  const abmWanted = k.war
    ? (assets.abms < P.abmWarStock ? cap : Math.floor(cap / 2))
    : (assets.abms < P.abmPeaceStock ? Math.round(F * P.abmShare) : 0);
  const abms = Math.max(0, Math.min(cap, abmWanted, F));
  const growth = !k.war && k.turn <= P.investTurns ? Math.min(Math.round(F * P.investShare), F - abms) : 0;
  const missilesBuilt = F - abms - growth;
  sheet.build = { missiles: missilesBuilt, abms, factories: growth };

  // Minors to court: the ones it already leads, then a stable personal order.
  const mine = ownIndices(ownSheets);
  const rivalMax = (id) => {
    const row = k.minorIndices[id];
    if (!row) return null;
    const living = new Set(k.enemies.map((e) => e.country));
    return Math.max(0, ...Object.entries(row).filter(([c]) => living.has(c)).map(([, v]) => v));
  };
  const wanted = Math.min(k.minors.length, P.cores + Math.floor(k.turn / P.coresGrowEvery));
  const unwinnable = (id) => { const r = rivalMax(id); return r != null && r - (mine[id] ?? 0) > 2 * assets.cash + 20; };
  const order = k.minors.map((m) => m.id)
    .filter((id) => !unwinnable(id))
    .sort((a, b) => (mine[b] ?? 0) - (mine[a] ?? 0) || stableKey(stableSeed, a) - stableKey(stableSeed, b));
  const cores = order.slice(0, wanted);

  // Spies: at most one on a player (a rotating rival, or the weakest one in wartime), two on the minors it cares most about.
  const spies = [null, null, null];
  if (k.enemies.length) {
    const target = k.war
      ? [...k.enemies].sort((a, b) => a.population - b.population || a.country.localeCompare(b.country))[0]
      : [...k.enemies].sort((a, b) => a.country.localeCompare(b.country))[(k.turn + hashStr(k.me)) % k.enemies.length];
    spies[0] = { kind: 'PLAYER', id: target.country };
  }
  if (cores[0]) spies[1] = { kind: 'MINOR', id: cores[0] };
  if (cores[1]) spies[2] = { kind: 'MINOR', id: cores[1] };
  if (spies.some(Boolean)) sheet.spies = spies;

  // Cash has no use except gifts, so all of it goes to minors: first the ones where a known rival must be overtaken
  // (cheapest first, never a partial gift to a lost cause), then whatever is left spreads evenly.
  if (cores.length && assets.cash > 0) {
    const gifts = {};
    let budget = assets.cash;
    const needs = cores.map((id) => {
      const r = rivalMax(id);
      if (r == null) return null;
      const margin = Math.max(2, Math.ceil(r * P.margin));
      return { id, need: Math.max(0, r + margin + 1 - (mine[id] ?? 0)) };
    }).filter(Boolean).sort((a, b) => a.need - b.need);
    const funded = [];
    for (const { id, need } of needs) {
      if (need > budget) continue;
      if (need > 0) { gifts[id] = (gifts[id] ?? 0) + need; budget -= need; }
      funded.push(id);
    }
    const spread = funded.length ? funded : cores;
    const each = Math.floor(budget / spread.length);
    let extra = budget - each * spread.length;
    for (const id of spread) {
      const add = each + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      if (add > 0) gifts[id] = (gifts[id] ?? 0) + add;
    }
    if (Object.keys(gifts).length) sheet.giveCashToMinors = gifts;
  }

  // War: when it is its time and it has enough missiles (and, for the careful styles, no spied rival looks stronger).
  if (!k.war && k.turn >= 2 && k.turn >= P.warTurn) {
    const stock = assets.missiles + missilesBuilt;
    const rivalStronger = Object.values(k.intel).some((i) => i.missiles > stock * 1.2);
    const patient = P.needsEdge && rivalStronger && k.turn < P.edgeFallback;
    if (stock >= P.minMissiles && !patient) sheet.declareWar = true;
  }
  return sheet;
}

// ───────────────────────── battle turns ─────────────────────────

function battleSheet({ P, view }) {
  const k = knowledge(view);
  const { assets } = view;
  if (!k.enemies.length) return {};

  // Who has been shooting at me (home fire, or fire from a minor they control).
  const owners = view.battleResult?.controllers ?? {};
  const known = new Set(view.public.players.map((p) => p.country));
  const revenge = {};
  for (const f of view.battleResult?.fired ?? []) {
    if (f.to !== assets.country) continue;
    const owner = known.has(f.from) ? f.from : owners[f.from];
    if (owner) revenge[owner] = (revenge[owner] ?? 0) + f.n;
  }

  // What it would take to eliminate each rival: its population plus the ABMs that will absorb missiles.
  const targets = k.enemies.map((e) => {
    const spied = k.intel[e.country];
    return {
      country: e.country,
      cost: e.population + (spied?.abms ?? 10 + Math.floor(k.turn / 2)) + 1,
      threat: spied?.missiles ?? 20 + 9 * k.turn,
      revenge: revenge[e.country] ?? 0,
    };
  });

  // Firing sources: home first (a war declarer must fire at least one missile from home), then controlled minors.
  const pool = [{ id: 'HOME', left: assets.missiles }, ...(view.controlled ?? []).map((m) => ({ id: m.id, left: m.missiles }))];
  const total = pool.reduce((s, p) => s + p.left, 0);
  if (total <= 0) return {};

  const killable = targets.filter((t) => t.cost <= total)
    .sort((a, b) => b.threat - a.threat || b.revenge - a.revenge || a.cost - b.cost || a.country.localeCompare(b.country));
  let budget = killable.length ? total : Math.max(1, Math.floor(total * P.fireShare));

  const fire = {};
  const shoot = (target, n) => {
    let want = Math.min(n, budget);
    for (const src of pool) {
      if (want <= 0) break;
      const take = Math.min(src.left, want);
      if (take <= 0) continue;
      src.left -= take; want -= take; budget -= take;
      fire[src.id] ??= {};
      fire[src.id][target] = (fire[src.id][target] ?? 0) + take;
    }
  };

  const hit = new Set();
  for (const t of killable) {                     // finish off everyone it can, most dangerous first
    if (budget >= t.cost) { shoot(t.country, t.cost); hit.add(t.country); }
  }
  if (budget > 0) {                               // spend the rest where it hurts most
    const rest = targets.filter((t) => !hit.has(t.country))
      .sort((a, b) => a.cost - b.cost || b.revenge - a.revenge || a.country.localeCompare(b.country));
    shoot((rest[0] ?? killable[0] ?? targets[0]).country, budget);
  }
  return Object.keys(fire).length ? { fire } : {};
}
