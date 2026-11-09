// In-memory implementation of the store contract. Used by the tests and handy for local
// experiments. Transactions are copy-on-write: a thrown error discards every change.
// It also mirrors the database guards that matter to the pipeline (turn must be OPEN to
// write sheets or to be resolved).

const emptyData = () => ({
  nextId: 1,
  users: [], loginLinks: [],
  games: [], players: [], minors: [], minorIndex: [], spySlots: [], turns: [], sheets: [],
  messages: [], news: [], reports: [], battleResults: [], events: [],
});

const clone = (x) => structuredClone(x);

class MemTx {
  constructor(d, hooks) { this.d = d; this.hooks = hooks; }

  id() { return this.d.nextId++; }
  game(id) { return this.d.games.find((g) => g.id === id); }

  async lockGame(gameId) { const g = this.game(gameId); return g ? clone(g) : null; }

  async loadSnapshot(gameId) {
    const d = this.d;
    const game = this.game(gameId);
    if (!game) return { game: null, players: [], minors: [], minorIndex: [], spySlots: [], turn: null, sheets: [] };
    const players = d.players.filter((p) => p.gameId === gameId);
    const ids = new Set(players.map((p) => p.id));
    const turn = game.turnNumber ? d.turns.find((t) => t.gameId === gameId && t.number === game.turnNumber) : null;
    return clone({
      game,
      players,
      minors: d.minors.filter((m) => m.gameId === gameId),
      minorIndex: d.minorIndex.filter((r) => r.gameId === gameId),
      spySlots: d.spySlots.filter((s) => ids.has(s.playerId)),
      turn: turn ?? null,
      sheets: turn ? d.sheets.filter((s) => s.turnId === turn.id) : [],
    });
  }

  async loadPrevious({ gameId, playerId, turnNumber }) {
    const d = this.d;
    const t = d.turns.find((x) => x.gameId === gameId && x.number === turnNumber);
    if (!t) return { reports: [], messages: [], news: [], battleResult: null };
    return clone({
      reports: d.reports.filter((r) => r.turnId === t.id && r.playerId === playerId),
      messages: d.messages.filter((m) => m.turnId === t.id && m.toPlayerId === playerId),
      news: d.news.filter((n) => n.turnId === t.id),
      battleResult: d.battleResults.find((b) => b.turnId === t.id)?.payload ?? null,
    });
  }

  async saveSheet({ turnId, gameId, playerId, payload, isFinal }) {
    const t = this.d.turns.find((x) => x.id === turnId);
    if (!t || t.status !== 'OPEN') throw new Error('turn is not accepting player sheets');
    const existing = this.d.sheets.find((s) => s.turnId === turnId && s.playerId === playerId);
    if (existing) {
      Object.assign(existing, { payload: clone(payload), isFinal, source: 'PLAYER', version: existing.version + 1 });
    } else {
      this.d.sheets.push({ id: this.id(), turnId, gameId, playerId, payload: clone(payload), isFinal, source: 'PLAYER', version: 1 });
    }
  }

  insertEvents(gameId, turnId, events = []) {
    let seq = Math.max(-1, ...this.d.events.filter((e) => e.gameId === gameId).map((e) => e.seq)) + 1;
    for (const e of events) this.d.events.push({ id: this.id(), gameId, turnId, seq: seq++, type: e.type, payload: clone(e.payload ?? {}) });
  }

  insertTurn(gameId, t) {
    const row = {
      id: this.id(), gameId, number: t.number, type: t.type, status: 'OPEN', opensAt: t.opensAt,
      deadlineAt: t.deadlineAt, resolvedAt: null, rngSeed: t.rngSeed, stateBefore: clone(t.stateBefore), stateAfter: null,
    };
    if (this.d.turns.some((x) => x.gameId === gameId && x.status === 'OPEN')) throw new Error('an open turn already exists');
    this.d.turns.push(row);
    return row;
  }

  async saveStart(plan) {
    const d = this.d;
    for (const p of plan.players) Object.assign(d.players.find((x) => x.id === p.id), p);
    for (const m of plan.minors) {
      const { index, ...fields } = m;
      const row = { id: this.id(), gameId: plan.gameId, ...fields };
      d.minors.push(row);
      for (const [playerId, value] of Object.entries(index)) {
        d.minorIndex.push({ gameId: plan.gameId, minorId: row.id, playerId: Number(playerId), value });
      }
    }
    d.spySlots.push(...plan.spySlots.map(clone));
    const turn = this.insertTurn(plan.gameId, plan.turn);
    Object.assign(this.game(plan.gameId), plan.gamePatch);
    for (const r of plan.reports) d.reports.push({ id: this.id(), gameId: plan.gameId, turnId: turn.id, ...clone(r) });
    this.insertEvents(plan.gameId, turn.id, plan.events);
  }

  async saveResolution(plan) {
    const d = this.d;
    const turn = d.turns.find((t) => t.id === plan.turnId);
    if (!turn || turn.status !== 'OPEN') throw new Error('turn is not open');

    for (const s of plan.defaultSheets) {
      d.sheets.push({ id: this.id(), turnId: turn.id, gameId: plan.gameId, playerId: s.playerId,
        payload: clone(s.payload), isFinal: true, source: 'SERVER_DEFAULT', version: 1 });
    }
    for (const p of plan.playerWrites) Object.assign(d.players.find((x) => x.id === p.id), p);
    if (this.hooks.failDuringSave) throw new Error('simulated failure');

    for (const m of plan.minorWrites) Object.assign(d.minors.find((x) => x.id === m.id), m);
    for (const m of plan.newMinors) {
      const { index, key, ...fields } = m; // eslint-disable-line no-unused-vars
      const row = { id: this.id(), gameId: plan.gameId, ...fields };
      d.minors.push(row);
      for (const [playerId, value] of Object.entries(index)) {
        d.minorIndex.push({ gameId: plan.gameId, minorId: row.id, playerId: Number(playerId), value });
      }
    }
    for (const w of plan.indexWrites) {
      const r = d.minorIndex.find((x) => x.minorId === w.minorId && x.playerId === w.playerId);
      if (w.value < r.value) throw new Error('minor_index may never decrease');
      r.value = w.value;
    }
    for (const w of plan.spyWrites) {
      const r = d.spySlots.find((x) => x.playerId === w.playerId && x.slot === w.slot);
      r.kind = w.kind; r.targetId = w.targetId;
    }

    this.insertEvents(plan.gameId, turn.id, plan.events);
    for (const m of plan.messages) d.messages.push({ id: this.id(), gameId: plan.gameId, turnId: turn.id, ...m });
    for (const n of plan.news) d.news.push({ id: this.id(), gameId: plan.gameId, turnId: turn.id, ...n });
    for (const r of plan.reports) d.reports.push({ id: this.id(), gameId: plan.gameId, turnId: turn.id, ...clone(r) });
    if (plan.battleResult) d.battleResults.push({ turnId: turn.id, gameId: plan.gameId, payload: clone(plan.battleResult) });

    turn.status = 'CLOSED';
    turn.resolvedAt = plan.closeTurn.resolvedAt;
    turn.stateAfter = clone(plan.closeTurn.stateAfter);
    if (plan.nextTurn) this.insertTurn(plan.gameId, plan.nextTurn);
    Object.assign(this.game(plan.gameId), plan.gamePatch);
  }

  // ── users and lobby ──
  async createUser(displayName, { aiPersona = null } = {}) {
    const u = { id: this.id(), displayName, ...(aiPersona ? { aiPersona } : {}) };
    this.d.users.push(u);
    return clone(u);
  }

  // ── email sign-in links (mirrors migration 007) ──
  async findOrCreateUserByEmail(email, displayName) {
    const found = this.d.users.find((u) => u.email === email);
    if (found) return { user: { id: found.id, displayName: found.displayName }, created: false };
    const u = { id: this.id(), displayName, email };
    this.d.users.push(u);
    return { user: { id: u.id, displayName: u.displayName }, created: true };
  }

  async findUserByEmail(email) {
    const u = this.d.users.find((x) => x.email === email);
    return u ? { id: u.id, displayName: u.displayName } : null;
  }

  async insertLoginLink({ tokenHash, email, createdAt, expiresAt }) {
    if (this.d.loginLinks.some((l) => l.tokenHash === tokenHash)) throw new Error('duplicate login link');
    this.d.loginLinks.push({ id: this.id(), tokenHash, email, createdAt, expiresAt, consumedAt: null });
  }

  async countLoginLinksSince(email, since) {
    return this.d.loginLinks.filter((l) => l.email === email && l.createdAt >= since).length;
  }

  /** Atomically marks a live link used and returns what it was for; null if unknown, used or expired. */
  async consumeLoginLink(tokenHash, now) {
    const l = this.d.loginLinks.find((x) => x.tokenHash === tokenHash);
    if (!l || l.consumedAt || l.expiresAt <= now) return null;
    l.consumedAt = now;
    return { email: l.email };
  }

  async deleteLoginLinksExpiredBefore(cutoff) {
    const before = this.d.loginLinks.length;
    this.d.loginLinks = this.d.loginLinks.filter((l) => l.expiresAt > cutoff);
    return before - this.d.loginLinks.length;
  }

  async getUsers(ids) {
    return Object.fromEntries(this.d.users.filter((u) => ids.includes(u.id)).map((u) => [u.id, u.displayName]));
  }

  // ── AI players (mirrors migration 008) ──
  /** { [userId]: persona } for those of `ids` that are AI players; people are left out. */
  async getAiPersonas(ids) {
    return Object.fromEntries(this.d.users.filter((u) => u.aiPersona && ids.includes(u.id)).map((u) => [u.id, u.aiPersona]));
  }

  /** Removes an AI player's account (never a person's). Call after its seat is deleted. */
  async deleteAiUser(userId) {
    const before = this.d.users.length;
    this.d.users = this.d.users.filter((u) => !(u.id === userId && u.aiPersona));
    return before - this.d.users.length;
  }

  /** A player's own sheets from turns before `beforeTurn`, oldest first: [{ turnNumber, payload }]. */
  async listOwnSheets({ gameId, playerId, beforeTurn }) {
    return clone(this.d.sheets
      .filter((s) => s.gameId === gameId && s.playerId === playerId)
      .map((s) => ({ turnNumber: this.d.turns.find((t) => t.id === s.turnId)?.number, payload: s.payload }))
      .filter((s) => s.turnNumber != null && s.turnNumber < beforeTurn)
      .sort((a, b) => a.turnNumber - b.turnNumber));
  }

  /** Games with an open turn in which a living AI player has not yet submitted a sheet. */
  async listGamesAwaitingAi() {
    const out = [];
    for (const g of this.d.games) {
      if (g.status !== 'ACTIVE') continue;
      const turn = this.d.turns.find((t) => t.gameId === g.id && t.number === g.turnNumber && t.status === 'OPEN');
      if (!turn) continue;
      const pending = this.d.players.some((p) => p.gameId === g.id && p.alive
        && this.d.users.some((u) => u.id === p.userId && u.aiPersona)
        && !this.d.sheets.some((s) => s.turnId === turn.id && s.playerId === p.id));
      if (pending) out.push(g.id);
    }
    return out;
  }

  async insertGame({ creatorId, seed, turnDeadlineHours, forfeitAfterN }) {
    const g = {
      id: this.id(), creatorId, status: 'LOBBY', seed, turnDeadlineHours, forfeitAfterN,
      warDeclared: false, firstBattleDone: false, replenishCursor: 0, turnNumber: null,
      outcome: null, winnerPlayerId: null, startedAt: null, endedAt: null,
    };
    this.d.games.push(g);
    return g.id;
  }

  async insertPlayer({ gameId, userId }) {
    const id = this.id();
    this.d.players.push({
      id, gameId, userId, country: null, startPopulation: null, population: 0, cash: 0, thirds: 0, missiles: 0,
      abms: 0, bonusMissiles: 0, alive: true, forfeited: false, isDeclarer: false, missedStreak: 0,
      joinedAt: new Date(1700000000000 + id * 1000),
    });
    return id;
  }

  async updateLobbyPlayer(playerId, { country, startPopulation }) {
    const p = this.d.players.find((x) => x.id === playerId);
    if (country !== undefined) {
      if (country && this.d.players.some((x) => x.gameId === p.gameId && x.id !== playerId && x.country === country)) {
        throw new Error('duplicate country');
      }
      p.country = country;
    }
    if (startPopulation !== undefined) p.startPopulation = startPopulation;
  }

  /** How many unfinished (lobby or running) games this person created. The Postgres version also serializes per person. */
  async countOpenGamesCreatedBy(userId) {
    return this.d.games.filter((g) => g.creatorId === userId && (g.status === 'LOBBY' || g.status === 'ACTIVE')).length;
  }

  /** Removes a game that is still in its lobby, with its seats. Returns 1 if removed, 0 if it was missing or had started. */
  async deleteLobbyGame(gameId) {
    const g = this.game(gameId);
    if (!g || g.status !== 'LOBBY') return 0;
    const ids = new Set(this.d.players.filter((p) => p.gameId === gameId).map((p) => p.id));
    this.d.spySlots = this.d.spySlots.filter((x) => !ids.has(x.playerId));
    this.d.players = this.d.players.filter((p) => p.gameId !== gameId);
    this.d.games = this.d.games.filter((x) => x.id !== gameId);
    return 1;
  }

  async deletePlayer(playerId) {
    this.d.players = this.d.players.filter((p) => p.id !== playerId);
  }

  async listGamesForUser(userId) {
    const ids = new Set(this.d.players.filter((p) => p.userId === userId).map((p) => p.gameId));
    return clone(this.d.games.filter((g) => ids.has(g.id)).sort((a, b) => b.id - a.id));
  }

  async loadHistory(gameId) {
    const d = this.d;
    return clone(d.turns
      .filter((t) => t.gameId === gameId && t.status === 'CLOSED')
      .sort((a, b) => a.number - b.number)
      .map((t) => ({
        number: t.number,
        type: t.type,
        battleResult: d.battleResults.find((b) => b.turnId === t.id)?.payload ?? null,
        news: d.news.filter((n) => n.turnId === t.id).map((n) => ({ fromPlayerId: n.fromPlayerId, text: n.text, anonymous: n.anonymous })),
      })));
  }

  async loadReplay(gameId) {
    const d = this.d;
    const turns = d.turns.filter((t) => t.gameId === gameId).sort((a, b) => a.number - b.number);
    const numberById = new Map(turns.map((t) => [t.id, t.number]));
    return clone({
      turns: turns.map((t) => ({ number: t.number, type: t.type, rngSeed: t.rngSeed })),
      events: d.events.filter((e) => e.gameId === gameId).sort((a, b) => a.seq - b.seq),
      sheets: d.sheets.filter((s) => s.gameId === gameId).map((s) => ({ ...s, turnNumber: numberById.get(s.turnId) })),
    });
  }

  async listDueTurns(now) {
    return this.d.turns
      .filter((t) => t.status === 'OPEN' && t.deadlineAt <= now && this.game(t.gameId)?.status === 'ACTIVE')
      .sort((a, b) => a.deadlineAt - b.deadlineAt)
      .map((t) => ({ gameId: t.gameId, number: t.number }));
  }
}

export function createMemoryStore() {
  let data = emptyData();
  const hooks = { failDuringSave: false };
  const store = {
    hooks,
    get data() { return data; },
    async withTransaction(fn) {
      const copy = clone(data);
      const result = await fn(new MemTx(copy, hooks));
      data = copy; // commit; a throw above leaves `data` untouched
      return result;
    },
    // Lobby helpers (the real app does these through the lobby endpoints).
    createGame({ creatorId, seed, turnDeadlineHours = 24, forfeitAfterN = 5 }) {
      const g = {
        id: data.nextId++, creatorId, status: 'LOBBY', seed, turnDeadlineHours, forfeitAfterN,
        warDeclared: false, firstBattleDone: false, replenishCursor: 0, turnNumber: null,
        outcome: null, winnerPlayerId: null, startedAt: null, endedAt: null,
      };
      data.games.push(g);
      return g.id;
    },
    addPlayer({ gameId, userId, country = null, startPopulation = null }) {
      const id = data.nextId++;
      data.players.push({
        id, gameId, userId, country, startPopulation, population: 0, cash: 0, thirds: 0, missiles: 0, abms: 0,
        bonusMissiles: 0, alive: true, forfeited: false, isDeclarer: false, missedStreak: 0,
        joinedAt: new Date(1700000000000 + id * 1000),
      });
      return id;
    },
  };
  return store;
}
