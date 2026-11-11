// The deadline worker. Resolves turns whose deadline has passed and tells connected clients, and does the other background
// jobs (AI safety net, abandoned lobbies, opt-in turn emails).
//
// It does NOT poll on a fixed beat. After every pass it works out when something will next need doing and sleeps until then:
//   * the earliest deadline of an open turn (so a turn is resolved when its deadline arrives, not up to a minute later),
//   * the next turn-email reminder falling due, or a retry if mail is waiting under a cap or the mail server refused one,
//   * the next hourly look for abandoned lobbies,
//   * a short retry if something failed (a turn that would not resolve, an AI that could not move),
//   * and never longer than `intervalMs` (the "longest sleep"): a safety net that also keeps a database that sleeps when idle
//     awake, and that catches changes made by anything that does not call poke().
// poke() asks for a pass soon. The app calls it when something happens that can move the next wake-up earlier: a game starts, a
// turn resolves, someone opts in to turn emails. The server also pokes once at startup, so turns that came due while it was
// down are resolved at once instead of after the first sleep.
import { resolveDueTurns } from './app/pipeline.js';
import { playPendingAiTurns } from './app/ai.js';
import { removeAbandonedLobbies } from './app/cleanup.js';

const MAX_TIMER_MS = 2_147_483_647;   // the longest delay setTimeout accepts (about 24.8 days); anything more fires at once

export function startWorker({
  store, notify, notifier = null, now = () => new Date(), logger = console,
  intervalMs = 300_000,            // the longest the worker ever sleeps
  abandonedLobbyDays = 0,          // lobbies idle this long are removed; 0 = never (see app/cleanup.js)
  cleanupEveryMs = 3_600_000,      // how often to look for them: once an hour is plenty
  retryMs = 60_000,                // how soon to try again after a failure
  pokeDelayMs = 50,                // poke() waits this long, so a burst of events costs one pass
  slackMs = 25,                    // wake this much after a deadline, never just before it
  timers = { setTimeout, clearTimeout },   // replaceable, so tests can run time by hand
}) {
  let current = null;          // the pass that is running right now, if any
  let timer = null;            // the pending wake-up
  let armedFor = Infinity;     // when it is due (ms since the epoch), to let poke() move it only earlier
  let stopped = false;
  let pokedDuringPass = false;
  let lastCleanup = null;

  const arm = (delayMs) => {
    if (stopped) return;
    timers.clearTimeout(timer);
    const delay = Math.min(Math.max(Math.ceil(delayMs), 1), MAX_TIMER_MS);
    armedFor = now().getTime() + delay;
    timer = timers.setTimeout(() => { timer = null; armedFor = Infinity; tick(); }, delay);
    timer?.unref?.();
  };

  const cleanLobbies = async () => {
    if (!(abandonedLobbyDays > 0)) return;
    const at = now();
    if (lastCleanup !== null && at - lastCleanup < cleanupEveryMs) return;
    lastCleanup = at;
    try {
      const { removed } = await removeAbandonedLobbies(store, { now: at, maxAgeDays: abandonedLobbyDays });
      for (const id of removed) notify(id, { type: 'game_cancelled' });
      if (removed.length) logger.log?.(`[worker] removed ${removed.length} abandoned ${removed.length === 1 ? 'lobby' : 'lobbies'} (idle for ${abandonedLobbyDays}+ days)`);
    } catch (err) { logger.error(`[worker] lobby cleanup failed: ${err.message}`); }
  };

  /** How long to sleep after a pass that started at `startedAt`. */
  const delayUntilNextWork = async (startedAt, { notifierAt, retry }) => {
    const t = now().getTime();
    let wake = t + intervalMs;
    const consider = (ms) => { if (Number.isFinite(ms)) wake = Math.min(wake, ms); };
    try {
      const deadline = await store.withTransaction((tx) => tx.nextTurnDeadline());
      // A deadline that was already due when the pass began and is still open means resolving it failed: retry, do not spin.
      if (deadline) consider(deadline.getTime() <= startedAt.getTime() ? t + retryMs : deadline.getTime() + slackMs);
    } catch (err) {
      logger.error(`[worker] could not look up the next deadline: ${err.message}`);
      consider(t + retryMs);
    }
    if (notifierAt != null) consider(notifierAt);
    if (retry) consider(t + retryMs);
    if (abandonedLobbyDays > 0 && lastCleanup !== null) consider(lastCleanup.getTime() + cleanupEveryMs);
    if (pokedDuringPass) { pokedDuringPass = false; consider(t + pokeDelayMs); }
    return Math.max(wake - t, slackMs);
  };

  const run = async () => {
    const startedAt = now();
    const hints = { notifierAt: null, retry: false };
    let results;
    try {
      results = await resolveDueTurns(store, startedAt);
      for (const r of results) {
        if (r.resolved) {
          notify(r.gameId, { type: 'turn_resolved', turnNumber: r.turnNumber });
          if (r.over) notify(r.gameId, { type: 'game_finished', outcome: r.outcome?.reason ?? null });
        } else if (r.reason === 'ERROR') {
          logger.error(`[worker] game ${r.gameId}: ${r.error}`);
          hints.retry = true;
        }
      }
      // Safety net: any game still waiting on an AI player (for example after a crash) gets its AI moves now.
      for (const a of await playPendingAiTurns(store, now())) {
        if (a.error) { logger.error(`[worker] AI in game ${a.gameId}: ${a.error}`); hints.retry = true; }
        for (const f of a.fallbacks ?? []) logger.error(`[worker] AI in game ${a.gameId} used the default sheet: ${JSON.stringify(f.errors)}`);
        if (a.resolved) {
          notify(a.gameId, { type: 'turn_resolved', turnNumber: a.resolved.turnNumber });
          if (a.resolved.over) notify(a.gameId, { type: 'game_finished', outcome: a.resolved.outcome?.reason ?? null });
        } else if (a.submitted > 0 && a.last) {
          notify(a.gameId, { type: 'player_submitted', finalCount: a.last.finalCount, activeCount: a.last.activeCount });
        }
      }
      await cleanLobbies();
      // Opt-in turn emails go last and never block or break the work above; the notifier catches its own errors.
      if (notifier) hints.notifierAt = (await notifier.tick(now()))?.nextAt ?? null;
    } catch (err) {
      logger.error('[worker] tick failed', err);
      hints.retry = true;
    }
    if (!stopped) arm(await delayUntilNextWork(startedAt, hints));
    return results;
  };

  const tick = async () => {
    if (current) { pokedDuringPass = true; return undefined; }   // never overlap passes; the running one will look again
    current = run();
    try { return await current; } finally { current = null; }
  };

  /** Asks for a pass soon (and only ever sooner than one already planned). */
  const poke = () => {
    if (stopped) return;
    if (current) { pokedDuringPass = true; return; }
    if (armedFor <= now().getTime() + pokeDelayMs) return;
    arm(pokeDelayMs);
  };

  arm(intervalMs);   // until the first pass has run there is nothing to plan from, so the first wake-up is the longest sleep
  // stop() resolves once any pass already in flight has finished, so shutdown never closes the database under it.
  return { tick, poke, stop: async () => { stopped = true; timers.clearTimeout(timer); timer = null; await current; } };
}
