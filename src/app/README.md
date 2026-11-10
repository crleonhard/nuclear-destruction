# Turn pipeline

`pipeline.js` is the only module that touches both the database and the game rules (`src/game/`).

| Function | Purpose |
|---|---|
| `startGame(store, {gameId, userId}, now)` | Creator starts the game: assigns leftover countries and populations from the seed, creates the 18 minors, opens turn 1 |
| `submitSheet(store, {gameId, userId, payload, final}, now)` | Validates and saves a sheet; resolves early once every living player is final |
| `resolveTurn(store, gameId, {now, expectTurnNumber})` | Resolves the open turn in ONE transaction; no-op if the turn is not open or is stale |
| `resolveDueTurns(store, now)` | Deadline worker: resolves every open turn past its deadline, isolating failures per game |
| `getPackage(store, {gameId, userId})` | The caller's start-of-turn view; other players' private data is never included. `packageFor(tx, snap, me)` builds it inside a transaction; AI players get exactly the same |
| `playAiTurns(store, gameId, now)` (`ai.js`) | Submits a final sheet for every living AI player that has not moved this turn. Runs after a game starts and after each resolution; the worker repeats it for any game still waiting |

Turn emails live in `notifications.js`: `createNotifications({store, mailer, secret, appUrl, ...})` returns `preferences`, `setTurnEmails`, `unsubscribe` and
`tick`. `planNotifications` (pure) decides what is due from `store.listTurnNotificationCandidates()`; `tick` claims each mail in `turn_notifications`
before sending it (at most once per person, game, turn and kind), honours the daily and per-pass caps, and never throws. The worker calls `tick` at the end of every pass.

## Guarantees

- **Atomic:** a start or resolution is a single transaction. Any error rolls back every write.
- **Idempotent:** resolving a turn that is not OPEN, or whose number differs from `expectTurnNumber`, does nothing, so the deadline worker and early resolution can race safely. `lockGame` takes a row lock first.
- **Start-of-turn state in the database:** after resolving, the pipeline applies `beginNormalTurn` (free third, $5M) or `beginBattleTurn` (war bonus) before saving, so the rows always show what players start the turn with.
- **Missed turns:** a player with no saved sheet gets a `SERVER_DEFAULT` sheet row and the resolver counts the miss. A saved draft counts as submitted at the deadline.
- **Game limits:** `createGame` takes `maxOpenGames` (the HTTP layer passes the configured value) and refuses with 409 `TOO_MANY_GAMES` when the creator already has that many unfinished games; the Postgres store locks the creator's row so concurrent requests cannot exceed it. `cancelGame` removes a lobby (creator only).
- **AI players** are seats whose accounts are bots. `startGame` and `resolveTurn` call `playAiTurns` after they commit; both take `{ playAi: false }` for tests. When no living person is left, `playAiTurns` plays the rest of the game out at once (a flat loop, capped at 1,000 turns per call), and `resolveTurn` reports how it ended (`over`, `outcome`) so callers can notify clients.
- **Reports** belong to the turn that produced them and are shown at the start of the next turn.
- **Sheet payloads use resolver ids** (`"FRANCE"`, `"CUBA#1"`), not database ids. The HTTP layer should accept and return those.

## Stores

`../store/memory.js` is a copy-on-write in-memory store (used by the tests). `../store/postgres.js` implements the same
contract in SQL against migrations 001-008; pass it any pool with `connect()`. It passes the same contract suite
as the in-memory store when run against PostgreSQL (`npm run test:db:docker`).

```js
import { Pool } from 'pg';
import { createPgStore } from './src/store/postgres.js';
import { resolveDueTurns } from './src/app/pipeline.js';

const store = createPgStore(new Pool({ connectionString: process.env.DATABASE_URL }));
setInterval(() => resolveDueTurns(store, new Date()).catch(console.error), 60_000);
```
