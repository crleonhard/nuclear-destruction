# AI players

An AI player is an ordinary seat in a game. Its account is a server-controlled "bot" (a `users` row with an
`ai_persona` and no email, so nobody can sign in as it). Each turn the server builds the same package a person in that
seat would get, asks `decide.js` what to put on the sheet, checks the sheet with the same validator as a person's, and
submits it as final. Nothing in the rules, the resolver or the database schema knows AI players exist.

| File | What it is |
|---|---|
| `personas.js` | The three play styles as a handful of numbers each: Hawk, Diplomat, Opportunist |
| `decide.js` | Pure function: package in, sheet out. No database, no clock, no hidden state |
| `../app/ai.js` | Connects it to a game: who needs to move, building the package, submitting, the deadline-worker safety net |

## Rules for AI players

- **Same information as a person.** `decideSheet` is given the player package (own assets, last turn's reports, battle
  result, the public table) and the player's own earlier sheets. It never sees the real game state, other players'
  sheets, or the game seed. A test recomputes an AI's sheet from the public API view and checks it matches.
- **Same validation as a person.** If a sheet ever failed validation the AI falls back to the plain default sheet, so it
  never misses a turn and the resolver never rejects it. The tests assert that the fallback is never needed, over
  thousands of random situations and full self-played games.
- **Orders stay hidden** like everyone's: they are only revealed through the results, and in the replay after the game.
- **Moves immediately.** AIs submit as soon as a turn opens. So when the last person submits, the turn resolves at once.
  When no living person is left, the rest of the game is played out at once, turn after turn with no deadline waits,
  until it ends (see `playAiTurns`). It is a flat loop with a cap of 1,000 turns per call as a safety net; past that the
  game waits for the next deadline and carries on. Over 90 simulated games the longest took 82 turns.
- **Self-healing.** The deadline worker also plays any game still waiting on an AI, so a crash between a resolution and
  the AI's move costs nothing.

## What the AI does

*Normal turns.* Early on a share of factories grows the economy; some build ABMs (all the cap allows in wartime); the
rest build missiles. All cash goes to minors, because cash has no other use: it courts a few favourite minors (more as
the game goes on), tops them up to stay ahead of the best rival it has spied on, and never chases a lost cause. Spies:
one on a rival (the weakest in wartime), two on its favourite minors. It declares war once it is the right turn and it
has enough missiles; the careful styles wait while a spied rival looks stronger, but not forever.

*Battle turns.* It eliminates every rival it can (population plus their ABMs), most dangerous first, then spends the rest
on the cheapest remaining target. Revenge breaks ties. It fires from home first, then from minors it controls, and never
at minors or itself.

*Not done:* it sends no messages or news, never gives to other players, never sells factories.

## Tuning

Change numbers in `personas.js`; no other code needs to change. To add a style add an entry and its name to the
CHECK in a new migration and to `AI_STYLES` in `src/client/js/format.js` (a test keeps the two lists identical).
Run the self-play tests (`tests/ai-play.test.js`) after any change: they play full games and fail if an AI
ever needs its fallback sheet. In 90 self-played games with 2 to 8 AIs every game finished (median 48 turns, longest 92),
and wins were spread across all three styles.
