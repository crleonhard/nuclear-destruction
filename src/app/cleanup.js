// Housekeeping: removes lobbies nobody is using any more.
//
// A lobby is ABANDONED when nothing has happened in it for `maxAgeDays`: no one has joined and no AI has been added since
// the game was created or last gained a seat. (Picking a country or changing a population does not count: a creator who
// only fiddles with their own lobby for two weeks has still not got a game going.) Only lobbies are touched. A game that
// has started, however long since anyone moved, is never removed.
//
// Removing one is exactly what "Cancel game" does (its seats and AI accounts go, and the creator gets the place back
// under the limit on unfinished games). The age is checked again under the game's lock, so a person who joins at the
// moment the cleanup looks at the lobby keeps it.
import { removeLobby } from './lobby.js';

const DAY = 24 * 3600 * 1000;

/**
 * Removes up to `batch` abandoned lobbies. Returns { removed: [gameId, ...] }: tell connected clients (game_cancelled).
 * `maxAgeDays` of 0 (or less) switches the cleanup off.
 */
export async function removeAbandonedLobbies(store, { now = new Date(), maxAgeDays, batch = 50 }) {
  if (!(maxAgeDays > 0)) return { removed: [] };
  const cutoff = new Date(now.getTime() - maxAgeDays * DAY);
  const candidates = await store.withTransaction((tx) => tx.listIdleLobbies(cutoff, batch));
  const removed = [];
  for (const gameId of candidates) {
    const gone = await store.withTransaction(async (tx) => {
      const game = await tx.lockGame(gameId);
      if (!game || game.status !== 'LOBBY') return false;
      const last = await tx.lobbyLastActivity(gameId);
      if (!last || last >= cutoff) return false;           // someone joined while we were looking
      return removeLobby(tx, gameId);
    });
    if (gone) removed.push(gameId);
  }
  return { removed };
}
