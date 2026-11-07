# Migrations

PostgreSQL 14+, in [dbmate](https://github.com/amacneil/dbmate) format (`-- migrate:up` / `-- migrate:down`).
Apply with `npm run migrate -- up` (or dbmate). Apply in filename order. Any runner that splits on those markers works (Flyway and golang-migrate need the
markers split into separate `.up.sql` / `.down.sql` files).

| File | Contents |
|---|---|
| 001 | Enum types, `users`, `touch_updated_at()` |
| 002 | `games`, `players` (9-player cap trigger), `spy_slots` |
| 003 | `minors`, `minor_index` (monotonic trigger), `minor_controller()`, `listed_minors()` |
| 004 | `turns` (one active turn per game), `sheets` (write-guard trigger) |
| 005 | `messages`, `world_news`, `reports`, `battle_results`, append-only `events` |
| 006 | Privacy views: public players/minors, inbox, news, replay |
| 007 | `users.email` (unique, lower-case) and `login_links` (hashed, single-use, expiring email sign-in links) |
| 008 | `users.ai_persona`: server-controlled AI players (a persona and no email) |

## Mapping to the resolver

The resolver works on a plain JSON state keyed by country (`FRANCE`) and minor id (`CUBA#1`). The database
uses surrogate keys, so the pipeline maps `players.country` ↔ player id and `base_name#generation` ↔ minor id
when loading and saving. `players.thirds`, `minors.thirds` and every count are stored exactly as the
resolver holds them (integers, factories in thirds).

## Invariants the database enforces

- 3-9 players is enforced at start by the application; the 9-player cap and lobby-only joining are triggers.
- Country names and minor base names are restricted to the fixed lists.
- Index values never decrease; destroyed minors hold nothing; eliminated players hold nothing.
- One message per sender per recipient per turn; messages 1-500 chars, news 1-60 chars.
- Exactly one OPEN/RESOLVING turn per game; no player sheet writes once resolution starts.
- `events` rows cannot be updated or deleted directly.
- Cross-game references are impossible: composite foreign keys carry `game_id`.

## Not enforced here (application logic)

Sheet contents (build limits, gift limits, spy rules), 3-player minimum at start, deadlines, early resolution,
and the resolver's rules. The resolver validates sheets before they are written.
