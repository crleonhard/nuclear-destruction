// Account basics: the name other players see, "sign out everywhere", and deleting an account.
//
// Deleting an account never deletes the account's row (finished games and their history refer to it). It erases what
// identifies the person (email, turn-email setting, pending sign-in links, sent-mail records) and renames the row, and
// it stops every token at once. What happens to the person's games:
//
//   * a lobby they CREATED is cancelled (the same as pressing "Cancel game"; anyone who had joined it loses the lobby),
//   * a lobby they only JOINED: they leave it,
//   * a game that is RUNNING: their seat is taken over by an AI player ("Former player", with a persona picked at
//     random), exactly as if the host had added one. The game goes on under the usual rules for AI players: they never
//     forfeit and send no messages, so nobody waits for a person who is gone,
//   * a FINISHED game: nothing changes, except that the name shown is now "Deleted player".
//
// Orders, messages and news the person already sent in running or finished games stay (they are part of the game
// everyone else is playing or reading), but they no longer point to a name or an address.

import crypto from 'node:crypto';
import { fail } from './errors.js';
import { AI_PERSONAS } from '../ai/personas.js';
import { removeLobby } from './lobby.js';

export const DELETED_NAME = 'Deleted player';
export const FORMER_PLAYER_NAME = 'Former player';
export const DELETE_CONFIRMATION = 'DELETE';

/** { ok: true, name } with the name trimmed, or { ok: false, message }. Names are 1 to 60 characters with no control characters. */
export function cleanDisplayName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { ok: false, message: 'Choose the name other players will see.' };
  if (name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, message: 'Names are 1 to 60 characters with no line breaks.' };
  return { ok: true, name };
}

export async function renameAccount(store, { userId, displayName }) {
  const clean = cleanDisplayName(displayName);
  if (!clean.ok) return fail(422, 'NAME_REQUIRED', clean.message, 'displayName');
  return store.withTransaction(async (tx) => {
    if (!(await tx.renameUser(userId, clean.name))) return fail(404, 'NOT_FOUND', 'No such account');
    return { ok: true, user: { id: userId, displayName: clean.name } };
  });
}

/** Cancels every token issued so far. Returns { ok, sessionVersion }: tokens from now on must carry that number. */
export async function signOutEverywhere(store, { userId }) {
  return store.withTransaction(async (tx) => {
    const sessionVersion = await tx.bumpSessionVersion(userId);
    if (sessionVersion == null) return fail(404, 'NOT_FOUND', 'No such account');
    return { ok: true, sessionVersion };
  });
}

/**
 * Deletes the account (see the top of this file). `confirm` must be exactly "DELETE". `persona` picks the AI that takes
 * over running games (random when null). Returns { ok, affected: { cancelled, left, handed } }, each a list of game ids,
 * so the caller can tell the other players' screens and let the new AI player move.
 */
export async function deleteAccount(store, { userId, confirm, now = new Date(), persona = null }) {
  if (confirm !== DELETE_CONFIRMATION) return fail(422, 'CONFIRMATION_REQUIRED', `Type ${DELETE_CONFIRMATION} to confirm that you want to delete your account.`, 'confirm');
  return store.withTransaction(async (tx) => {
    if (!(await tx.lockUser(userId))) return fail(404, 'NOT_FOUND', 'No such account');
    const account = await tx.getAccount(userId);
    if (!account || account.aiPersona) return fail(404, 'NOT_FOUND', 'No such account');       // AI players are the server's, not anyone's to delete
    const affected = { cancelled: [], left: [], handed: [] };
    const games = (await tx.listGamesForUser(userId)).filter((g) => g.status !== 'FINISHED').sort((a, b) => a.id - b.id);   // one fixed order, so two deletions never wait on each other
    for (const listed of games) {
      const game = await tx.lockGame(listed.id);
      if (!game || game.status === 'FINISHED') continue;
      if (game.status === 'LOBBY') {
        if (game.creatorId === userId) {
          if (await removeLobby(tx, game.id)) affected.cancelled.push(game.id);
        } else {
          const { players } = await tx.loadSnapshot(game.id);
          const seat = players.find((p) => p.userId === userId);
          if (seat) { await tx.deletePlayer(seat.id); affected.left.push(game.id); }
        }
      } else {
        affected.handed.push(game.id);
      }
    }
    const handOver = affected.handed.length > 0;
    const aiPersona = handOver ? (persona ?? AI_PERSONAS[crypto.randomInt(0, AI_PERSONAS.length)]) : null;
    await tx.anonymizeUser(userId, { displayName: handOver ? FORMER_PLAYER_NAME : DELETED_NAME, aiPersona, at: now });
    return { ok: true, affected };
  });
}
