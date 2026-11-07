// Translates between database rows (surrogate ids) and the resolver's state
// (countries and "BASE#generation" minor keys as ids). Pure functions, no I/O.

export const minorKey = (m) => `${m.baseName}#${m.generation}`;

export function buildMaps(snap) {
  return {
    countryById: new Map(snap.players.map((p) => [p.id, p.country])),
    playerIdByCountry: new Map(snap.players.map((p) => [p.country, p.id])),
    minorKeyById: new Map(snap.minors.map((m) => [m.id, minorKey(m)])),
    minorIdByKey: new Map(snap.minors.map((m) => [minorKey(m), m.id])),
  };
}

/**
 * snap: { game, players[], minors[], minorIndex[], spySlots[], turn, sheets[] } (see store.loadSnapshot)
 * Returns the resolver state for the turn that is currently open, plus id maps.
 */
export function snapshotToState(snap) {
  const maps = buildMaps(snap);
  const { game, turn } = snap;
  const state = {
    seed: game.seed,
    forfeitAfterN: game.forfeitAfterN,
    turnNumber: turn.number,
    turnType: turn.type,
    warDeclared: game.warDeclared,
    firstBattleDone: game.firstBattleDone,
    declarers: snap.players.filter((p) => p.isDeclarer).map((p) => p.country),
    replenishCursor: game.replenishCursor,
    over: false,
    outcome: null,
    players: {},
    minors: {},
  };
  for (const p of snap.players) {
    state.players[p.country] = {
      id: p.country, country: p.country, population: p.population, cash: p.cash, thirds: p.thirds,
      missiles: p.missiles, abms: p.abms, bonusMissiles: p.bonusMissiles, alive: p.alive,
      forfeited: p.forfeited, missedStreak: p.missedStreak, spySlots: [null, null, null],
    };
  }
  for (const s of snap.spySlots) {
    if (!s.kind) continue;
    const id = s.kind === 'PLAYER' ? maps.countryById.get(s.targetId) : maps.minorKeyById.get(s.targetId);
    if (id) state.players[maps.countryById.get(s.playerId)].spySlots[s.slot] = { kind: s.kind, id };
  }
  for (const m of snap.minors) {
    state.minors[minorKey(m)] = {
      id: minorKey(m), baseName: m.baseName, generation: m.generation, population: m.population,
      thirds: m.thirds, missiles: m.missiles, cash: m.cash, destroyed: m.destroyed,
      index: Object.fromEntries(snap.players.map((p) => [p.country, 0])),
    };
  }
  for (const r of snap.minorIndex) {
    const m = state.minors[maps.minorKeyById.get(r.minorId)];
    if (m) m.index[maps.countryById.get(r.playerId)] = r.value;
  }
  return { state, maps };
}

/** Everything the store must write so the database matches `state`. Writes all rows; no diffing. */
export function stateToWrites(snap, maps, state) {
  const playerWrites = snap.players.map((p) => {
    const s = state.players[p.country];
    return {
      id: p.id, population: s.population, cash: s.cash, thirds: s.thirds, missiles: s.missiles,
      abms: s.abms, bonusMissiles: s.bonusMissiles, alive: s.alive, forfeited: s.forfeited,
      missedStreak: s.missedStreak, isDeclarer: state.declarers.includes(p.country),
    };
  });
  const minorWrites = [];
  const indexWrites = [];
  const newMinors = [];
  for (const key of Object.keys(state.minors)) {
    const m = state.minors[key];
    const fields = { population: m.population, thirds: m.thirds, missiles: m.missiles, cash: m.cash, destroyed: m.destroyed };
    const id = maps.minorIdByKey.get(key);
    if (id == null) {
      newMinors.push({
        key, baseName: m.baseName, generation: m.generation, ...fields,
        index: Object.fromEntries(snap.players.map((p) => [p.id, m.index[p.country] ?? 0])),
      });
    } else {
      minorWrites.push({ id, ...fields });
      for (const p of snap.players) indexWrites.push({ minorId: id, playerId: p.id, value: m.index[p.country] ?? 0 });
    }
  }
  const spyWrites = [];
  for (const p of snap.players) {
    state.players[p.country].spySlots.forEach((t, slot) => {
      let kind = null;
      let targetId = null;
      if (t) {
        targetId = t.kind === 'PLAYER' ? maps.playerIdByCountry.get(t.id) : maps.minorIdByKey.get(t.id);
        if (targetId != null) kind = t.kind;
      }
      spyWrites.push({ playerId: p.id, slot, kind, targetId: kind ? targetId : null });
    });
  }
  return { playerWrites, minorWrites, newMinors, indexWrites, spyWrites };
}

export const toEventRow = ({ type, turn, ...payload }) => ({ type, payload }); // eslint-disable-line no-unused-vars
