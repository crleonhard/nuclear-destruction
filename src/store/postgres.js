// PostgreSQL implementation of the store contract, matching migrations 001-008.
// Takes any pg-compatible pool (`pool.connect()` -> client with `query`, `release`).
// Verified against PostgreSQL 16 by the store contract suite and the schema tests (npm run test:db:docker).

const n = (v) => (v == null ? null : Number(v)); // pg returns bigint as string

const mapGame = (r) => ({
  id: n(r.id), creatorId: n(r.creator_id), status: r.status, seed: n(r.seed),
  turnDeadlineHours: r.turn_deadline_hours, forfeitAfterN: r.forfeit_after_n, warDeclared: r.war_declared,
  firstBattleDone: r.first_battle_done, replenishCursor: r.replenish_cursor, turnNumber: r.turn_number,
  outcome: r.outcome, winnerPlayerId: n(r.winner_player_id), startedAt: r.started_at, endedAt: r.ended_at,
});
const mapPlayer = (r) => ({
  id: n(r.id), gameId: n(r.game_id), userId: n(r.user_id), country: r.country, startPopulation: r.start_population,
  population: r.population, cash: r.cash, thirds: r.thirds, missiles: r.missiles, abms: r.abms,
  bonusMissiles: r.bonus_missiles, alive: r.alive, forfeited: r.forfeited, isDeclarer: r.is_declarer,
  missedStreak: r.missed_streak, joinedAt: r.joined_at,
});
const mapMinor = (r) => ({
  id: n(r.id), gameId: n(r.game_id), baseName: r.base_name, generation: r.generation, population: r.population,
  thirds: r.thirds, missiles: r.missiles, cash: r.cash, destroyed: r.destroyed,
});
const mapTurn = (r) => ({
  id: n(r.id), gameId: n(r.game_id), number: r.number, type: r.type, status: r.status, opensAt: r.opens_at,
  deadlineAt: r.deadline_at, resolvedAt: r.resolved_at, rngSeed: n(r.rng_seed),
});
const json = (x) => JSON.stringify(x ?? null);

class PgTx {
  constructor(client) { this.c = client; }
  async q(text, params = []) { return (await this.c.query(text, params)).rows; }

  async lockGame(gameId) {
    const [r] = await this.q('SELECT * FROM games WHERE id = $1 FOR UPDATE', [gameId]);
    return r ? mapGame(r) : null;
  }

  async loadSnapshot(gameId) {
    const [g] = await this.q('SELECT * FROM games WHERE id = $1', [gameId]);
    if (!g) return { game: null, players: [], minors: [], minorIndex: [], spySlots: [], turn: null, sheets: [] };
    const game = mapGame(g);
    const players = (await this.q('SELECT * FROM players WHERE game_id = $1 ORDER BY joined_at, id', [gameId])).map(mapPlayer);
    const minors = (await this.q('SELECT * FROM minors WHERE game_id = $1 ORDER BY id', [gameId])).map(mapMinor);
    const minorIndex = (await this.q('SELECT minor_id, player_id, value FROM minor_index WHERE game_id = $1', [gameId]))
      .map((r) => ({ gameId, minorId: n(r.minor_id), playerId: n(r.player_id), value: r.value }));
    const spySlots = (await this.q(
      `SELECT s.* FROM spy_slots s JOIN players p ON p.id = s.player_id WHERE p.game_id = $1 ORDER BY s.player_id, s.slot`, [gameId]))
      .map((r) => ({ playerId: n(r.player_id), slot: r.slot, kind: r.last_target_kind, targetId: n(r.last_target_id) }));
    let turn = null;
    let sheets = [];
    if (game.turnNumber != null) {
      const [t] = await this.q('SELECT * FROM turns WHERE game_id = $1 AND number = $2', [gameId, game.turnNumber]);
      if (t) {
        turn = mapTurn(t);
        sheets = (await this.q('SELECT * FROM sheets WHERE turn_id = $1', [turn.id])).map((r) => ({
          id: n(r.id), turnId: n(r.turn_id), gameId, playerId: n(r.player_id), payload: r.payload,
          isFinal: r.is_final, source: r.source, version: r.version,
        }));
      }
    }
    return { game, players, minors, minorIndex, spySlots, turn, sheets };
  }

  async loadPrevious({ gameId, playerId, turnNumber }) {
    const [t] = await this.q('SELECT id FROM turns WHERE game_id = $1 AND number = $2', [gameId, turnNumber]);
    if (!t) return { reports: [], messages: [], news: [], battleResult: null };
    const reports = (await this.q('SELECT kind, payload FROM reports WHERE turn_id = $1 AND player_id = $2 ORDER BY id', [t.id, playerId]))
      .map((r) => ({ kind: r.kind, payload: r.payload }));
    const messages = (await this.q('SELECT from_player_id, text, anonymous FROM messages WHERE turn_id = $1 AND to_player_id = $2 ORDER BY id', [t.id, playerId]))
      .map((r) => ({ fromPlayerId: n(r.from_player_id), text: r.text, anonymous: r.anonymous }));
    const news = (await this.q('SELECT from_player_id, text, anonymous FROM world_news WHERE turn_id = $1 ORDER BY id', [t.id]))
      .map((r) => ({ fromPlayerId: n(r.from_player_id), text: r.text, anonymous: r.anonymous }));
    const [b] = await this.q('SELECT payload FROM battle_results WHERE turn_id = $1', [t.id]);
    return { reports, messages, news, battleResult: b?.payload ?? null };
  }

  async saveSheet({ turnId, gameId, playerId, payload, isFinal }) {
    await this.q(
      `INSERT INTO sheets (turn_id, game_id, player_id, payload, is_final, source)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'PLAYER')
       ON CONFLICT (turn_id, player_id)
       DO UPDATE SET payload = EXCLUDED.payload, is_final = EXCLUDED.is_final, source = 'PLAYER'`,
      [turnId, gameId, playerId, json(payload), isFinal]);
  }

  async insertEvents(gameId, turnId, events = []) {
    if (!events.length) return;
    const [{ next }] = await this.q('SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE game_id = $1', [gameId]);
    let seq = Number(next);
    for (const e of events) {
      await this.q('INSERT INTO events (game_id, turn_id, seq, type, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [gameId, turnId, seq++, e.type, json(e.payload ?? {})]);
    }
  }

  async insertTurn(gameId, t) {
    const [r] = await this.q(
      `INSERT INTO turns (game_id, number, type, status, opens_at, deadline_at, rng_seed, state_before)
       VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, $7::jsonb) RETURNING id`,
      [gameId, t.number, t.type, t.opensAt, t.deadlineAt, t.rngSeed, json(t.stateBefore)]);
    return n(r.id);
  }

  async insertMinor(gameId, m) {
    const [r] = await this.q(
      `INSERT INTO minors (game_id, base_name, generation, population, thirds, missiles, cash, destroyed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [gameId, m.baseName, m.generation, m.population, m.thirds, m.missiles, m.cash, m.destroyed]);
    const minorId = n(r.id);
    for (const [playerId, value] of Object.entries(m.index)) {
      await this.q('INSERT INTO minor_index (game_id, minor_id, player_id, value) VALUES ($1, $2, $3, $4)',
        [gameId, minorId, Number(playerId), value]);
    }
    return minorId;
  }

  async saveStart(plan) {
    const { gameId } = plan;
    for (const p of plan.players) {
      await this.q(
        `UPDATE players SET country = $2, start_population = $3, population = $4, cash = $5, thirds = $6,
                missiles = $7, abms = $8 WHERE id = $1`,
        [p.id, p.country, p.startPopulation, p.population, p.cash, p.thirds, p.missiles, p.abms]);
    }
    for (const m of plan.minors) await this.insertMinor(gameId, m);
    for (const s of plan.spySlots) {
      await this.q('INSERT INTO spy_slots (player_id, slot, last_target_kind, last_target_id) VALUES ($1, $2, $3, $4)',
        [s.playerId, s.slot, s.kind, s.targetId]);
    }
    const turnId = await this.insertTurn(gameId, plan.turn);
    await this.q('UPDATE games SET status = $2, turn_number = $3, started_at = $4 WHERE id = $1',
      [gameId, plan.gamePatch.status, plan.gamePatch.turnNumber, plan.gamePatch.startedAt]);
    for (const r of plan.reports) {
      await this.q('INSERT INTO reports (game_id, turn_id, player_id, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [gameId, turnId, r.playerId, r.kind, json(r.payload)]);
    }
    await this.insertEvents(gameId, turnId, plan.events);
  }

  async saveResolution(plan) {
    const { gameId, turnId } = plan;
    // Order matters: default sheets while the turn is still OPEN, close it, then open the next
    // (a partial unique index allows only one OPEN turn per game).
    for (const s of plan.defaultSheets) {
      await this.q(
        `INSERT INTO sheets (turn_id, game_id, player_id, payload, is_final, source)
         VALUES ($1, $2, $3, $4::jsonb, true, 'SERVER_DEFAULT')`,
        [turnId, gameId, s.playerId, json(s.payload)]);
    }
    for (const p of plan.playerWrites) {
      await this.q(
        `UPDATE players SET population = $2, cash = $3, thirds = $4, missiles = $5, abms = $6, bonus_missiles = $7,
                alive = $8, forfeited = $9, missed_streak = $10, is_declarer = $11 WHERE id = $1`,
        [p.id, p.population, p.cash, p.thirds, p.missiles, p.abms, p.bonusMissiles, p.alive, p.forfeited, p.missedStreak, p.isDeclarer]);
    }
    for (const m of plan.minorWrites) {
      await this.q('UPDATE minors SET population = $2, thirds = $3, missiles = $4, cash = $5, destroyed = $6 WHERE id = $1',
        [m.id, m.population, m.thirds, m.missiles, m.cash, m.destroyed]);
    }
    for (const m of plan.newMinors) await this.insertMinor(gameId, m);
    for (const w of plan.indexWrites) {
      await this.q('UPDATE minor_index SET value = $3 WHERE minor_id = $1 AND player_id = $2', [w.minorId, w.playerId, w.value]);
    }
    for (const w of plan.spyWrites) {
      await this.q('UPDATE spy_slots SET last_target_kind = $3, last_target_id = $4 WHERE player_id = $1 AND slot = $2',
        [w.playerId, w.slot, w.kind, w.targetId]);
    }
    await this.insertEvents(gameId, turnId, plan.events);
    for (const m of plan.messages) {
      await this.q('INSERT INTO messages (game_id, turn_id, from_player_id, to_player_id, text, anonymous) VALUES ($1, $2, $3, $4, $5, $6)',
        [gameId, turnId, m.fromPlayerId, m.toPlayerId, m.text, m.anonymous]);
    }
    for (const w of plan.news) {
      await this.q('INSERT INTO world_news (game_id, turn_id, from_player_id, text, anonymous) VALUES ($1, $2, $3, $4, $5)',
        [gameId, turnId, w.fromPlayerId, w.text, w.anonymous]);
    }
    for (const r of plan.reports) {
      await this.q('INSERT INTO reports (game_id, turn_id, player_id, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [gameId, turnId, r.playerId, r.kind, json(r.payload)]);
    }
    if (plan.battleResult) {
      await this.q('INSERT INTO battle_results (turn_id, game_id, payload) VALUES ($1, $2, $3::jsonb)',
        [turnId, gameId, json(plan.battleResult)]);
    }
    await this.q(`UPDATE turns SET status = 'CLOSED', resolved_at = $2, state_after = $3::jsonb WHERE id = $1`,
      [turnId, plan.closeTurn.resolvedAt, json(plan.closeTurn.stateAfter)]);
    if (plan.nextTurn) await this.insertTurn(gameId, plan.nextTurn);

    const g = plan.gamePatch;
    await this.q(
      `UPDATE games SET war_declared = $2, first_battle_done = $3, replenish_cursor = $4, turn_number = $5,
              status = COALESCE($6::game_status, status), outcome = COALESCE($7::outcome_kind, outcome),
              winner_player_id = COALESCE($8, winner_player_id), ended_at = COALESCE($9, ended_at)
       WHERE id = $1`,
      [gameId, g.warDeclared, g.firstBattleDone, g.replenishCursor, g.turnNumber,
        g.status ?? null, g.outcome ?? null, g.winnerPlayerId ?? null, g.endedAt ?? null]);
  }

  // ── users and lobby ──
  async createUser(displayName, { aiPersona = null } = {}) {
    const [r] = await this.q('INSERT INTO users (display_name, ai_persona) VALUES ($1, $2) RETURNING id, display_name', [displayName, aiPersona]);
    return { id: n(r.id), displayName: r.display_name };
  }

  // ── email sign-in links (migration 007) ──
  async findOrCreateUserByEmail(email, displayName) {
    // The no-op UPDATE makes RETURNING work on conflict; xmax = 0 only for a row this statement inserted.
    const [r] = await this.q(
      `INSERT INTO users (display_name, email) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, display_name, (xmax = 0) AS created`, [displayName, email]);
    return { user: { id: n(r.id), displayName: r.display_name }, created: r.created };
  }

  async findUserByEmail(email) {
    const [r] = await this.q('SELECT id, display_name FROM users WHERE email = $1', [email]);
    return r ? { id: n(r.id), displayName: r.display_name } : null;
  }

  async insertLoginLink({ tokenHash, email, createdAt, expiresAt }) {
    await this.q(
      `INSERT INTO login_links (token_hash, email, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [tokenHash, email, createdAt, expiresAt]);
  }

  async countLoginLinksSince(email, since) {
    const [r] = await this.q('SELECT count(*)::int AS c FROM login_links WHERE email = $1 AND created_at >= $2', [email, since]);
    return r.c;
  }

  /** Atomically marks a live link used and returns what it was for; null if unknown, used or expired. */
  async consumeLoginLink(tokenHash, now) {
    const [r] = await this.q(
      `UPDATE login_links SET consumed_at = $2
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
       RETURNING email`, [tokenHash, now]);
    return r ? { email: r.email } : null;
  }

  async deleteLoginLinksExpiredBefore(cutoff) {
    const rows = await this.q('DELETE FROM login_links WHERE expires_at <= $1 RETURNING id', [cutoff]);
    return rows.length;
  }

  async getUsers(ids) {
    if (!ids.length) return {};
    const rows = await this.q('SELECT id, display_name FROM users WHERE id = ANY($1::bigint[])', [ids]);
    return Object.fromEntries(rows.map((r) => [n(r.id), r.display_name]));
  }

  // ── AI players (migration 008) ──
  /** { [userId]: persona } for those of `ids` that are AI players; people are left out. */
  async getAiPersonas(ids) {
    if (!ids.length) return {};
    const rows = await this.q('SELECT id, ai_persona FROM users WHERE id = ANY($1::bigint[]) AND ai_persona IS NOT NULL', [ids]);
    return Object.fromEntries(rows.map((r) => [n(r.id), r.ai_persona]));
  }

  /** Removes an AI player's account (never a person's). Call after its seat is deleted. */
  async deleteAiUser(userId) {
    const rows = await this.q('DELETE FROM users WHERE id = $1 AND ai_persona IS NOT NULL RETURNING id', [userId]);
    return rows.length;
  }

  /** A player's own sheets from turns before `beforeTurn`, oldest first: [{ turnNumber, payload }]. */
  async listOwnSheets({ gameId, playerId, beforeTurn }) {
    const rows = await this.q(
      `SELECT t.number, s.payload FROM sheets s JOIN turns t ON t.id = s.turn_id
       WHERE s.game_id = $1 AND s.player_id = $2 AND t.number < $3 ORDER BY t.number`, [gameId, playerId, beforeTurn]);
    return rows.map((r) => ({ turnNumber: r.number, payload: r.payload }));
  }

  /** Games with an open turn in which a living AI player has not yet submitted a sheet. */
  async listGamesAwaitingAi() {
    const rows = await this.q(
      `SELECT DISTINCT g.id FROM games g
         JOIN turns t ON t.game_id = g.id AND t.number = g.turn_number AND t.status = 'OPEN'
         JOIN players p ON p.game_id = g.id AND p.alive
         JOIN users u ON u.id = p.user_id AND u.ai_persona IS NOT NULL
       WHERE g.status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM sheets s WHERE s.turn_id = t.id AND s.player_id = p.id)
       ORDER BY g.id`);
    return rows.map((r) => n(r.id));
  }

  async insertGame({ creatorId, seed, turnDeadlineHours, forfeitAfterN }) {
    const [r] = await this.q(
      `INSERT INTO games (creator_id, seed, turn_deadline_hours, forfeit_after_n) VALUES ($1, $2, $3, $4) RETURNING id`,
      [creatorId, seed, turnDeadlineHours, forfeitAfterN]);
    return n(r.id);
  }

  async insertPlayer({ gameId, userId }) {
    const [r] = await this.q('INSERT INTO players (game_id, user_id) VALUES ($1, $2) RETURNING id', [gameId, userId]);
    return n(r.id);
  }

  async updateLobbyPlayer(playerId, { country, startPopulation }) {
    if (country !== undefined) await this.q('UPDATE players SET country = $2 WHERE id = $1', [playerId, country]);
    if (startPopulation !== undefined) await this.q('UPDATE players SET start_population = $2 WHERE id = $1', [playerId, startPopulation]);
  }

  async deletePlayer(playerId) {
    await this.q('DELETE FROM players WHERE id = $1', [playerId]);
  }

  async listGamesForUser(userId) {
    return (await this.q(
      `SELECT g.* FROM games g JOIN players p ON p.game_id = g.id WHERE p.user_id = $1 ORDER BY g.id DESC`, [userId])).map(mapGame);
  }

  async loadHistory(gameId) {
    const turns = await this.q(`SELECT id, number, type FROM turns WHERE game_id = $1 AND status = 'CLOSED' ORDER BY number`, [gameId]);
    const out = [];
    for (const t of turns) {
      const [b] = await this.q('SELECT payload FROM battle_results WHERE turn_id = $1', [t.id]);
      const news = (await this.q('SELECT from_player_id, text, anonymous FROM world_news WHERE turn_id = $1 ORDER BY id', [t.id]))
        .map((r) => ({ fromPlayerId: n(r.from_player_id), text: r.text, anonymous: r.anonymous }));
      out.push({ number: t.number, type: t.type, battleResult: b?.payload ?? null, news });
    }
    return out;
  }

  async loadReplay(gameId) {
    const turns = (await this.q('SELECT number, type, rng_seed FROM turns WHERE game_id = $1 ORDER BY number', [gameId]))
      .map((t) => ({ number: t.number, type: t.type, rngSeed: n(t.rng_seed) }));
    const events = (await this.q('SELECT turn_id, seq, type, payload FROM events WHERE game_id = $1 ORDER BY seq', [gameId]))
      .map((e) => ({ turnId: n(e.turn_id), seq: e.seq, type: e.type, payload: e.payload }));
    const sheets = (await this.q(
      `SELECT s.player_id, s.payload, s.source, t.number FROM sheets s JOIN turns t ON t.id = s.turn_id
       WHERE s.game_id = $1 ORDER BY t.number, s.player_id`, [gameId]))
      .map((r) => ({ playerId: n(r.player_id), payload: r.payload, source: r.source, turnNumber: r.number }));
    return { turns, events, sheets };
  }

  async listDueTurns(now) {
    return (await this.q(
      `SELECT t.game_id, t.number FROM turns t JOIN games g ON g.id = t.game_id
       WHERE t.status = 'OPEN' AND t.deadline_at <= $1 AND g.status = 'ACTIVE' ORDER BY t.deadline_at`, [now]))
      .map((r) => ({ gameId: n(r.game_id), number: r.number }));
  }
}

export function createPgStore(pool) {
  return {
    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(new PgTx(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
