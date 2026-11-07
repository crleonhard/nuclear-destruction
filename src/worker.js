// Deadline worker. Resolves turns whose deadline has passed and tells connected clients.
import { resolveDueTurns } from './app/pipeline.js';
import { playPendingAiTurns } from './app/ai.js';

export function startWorker({ store, notify, intervalMs = 60_000, now = () => new Date(), logger = console }) {
  let current = null; // the tick that is running right now, if any
  const run = async () => {
    try {
      const results = await resolveDueTurns(store, now());
      for (const r of results) {
        if (r.resolved) {
          notify(r.gameId, { type: 'turn_resolved', turnNumber: r.turnNumber });
          if (r.over) notify(r.gameId, { type: 'game_finished', outcome: r.outcome?.reason ?? null });
        } else if (r.reason === 'ERROR') {
          logger.error(`[worker] game ${r.gameId}: ${r.error}`);
        }
      }
      // Safety net: any game still waiting on an AI player (for example after a crash) gets its AI moves now.
      for (const a of await playPendingAiTurns(store, now())) {
        if (a.error) logger.error(`[worker] AI in game ${a.gameId}: ${a.error}`);
        for (const f of a.fallbacks ?? []) logger.error(`[worker] AI in game ${a.gameId} used the default sheet: ${JSON.stringify(f.errors)}`);
        if (a.resolved) {
          notify(a.gameId, { type: 'turn_resolved', turnNumber: a.resolved.turnNumber });
          if (a.resolved.over) notify(a.gameId, { type: 'game_finished', outcome: a.resolved.outcome?.reason ?? null });
        } else if (a.submitted > 0 && a.last) {
          notify(a.gameId, { type: 'player_submitted', finalCount: a.last.finalCount, activeCount: a.last.activeCount });
        }
      }
      return results;
    } catch (err) {
      logger.error('[worker] tick failed', err);
      return undefined;
    }
  };
  const tick = async () => {
    if (current) return undefined; // never overlap runs
    current = run();
    try { return await current; } finally { current = null; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // stop() resolves once any tick already in flight has finished, so shutdown never closes the database under it.
  return { tick, stop: async () => { clearInterval(timer); await current; } };
}
