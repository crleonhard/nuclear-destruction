# HTTP layer

Zero dependencies (`node:http` only). `createApp({ store, auth })` returns `{ handle, listen, notify, hub }`.
All errors look like `{ "errors": [{ "code", "field", "message" }] }`. Authenticate with
`Authorization: Bearer <token>` (the SSE stream also accepts `?token=` because `EventSource` cannot set headers).

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | no auth |
| POST | `/api/v1/users` | `{displayName}` -> `{user, token}`; only when `allowSignup` is on |
| GET | `/api/v1/me` | |
| GET | `/api/v1/games` | the caller's games |
| POST | `/api/v1/games` | `{turnDeadlineHours?, forfeitAfterN?}`; creator joins automatically |
| GET | `/api/v1/games/:id/lobby` | seats and countries; never includes the seed |
| POST | `/api/v1/games/:id/join` | 409 `GAME_FULL` at 9 players |
| PUT | `/api/v1/games/:id/country` | `{country}` or `{country: null}`; 409 `COUNTRY_TAKEN` |
| DELETE | `/api/v1/games/:id/membership` | lobby only; the creator cannot leave |
| PUT | `/api/v1/games/:id/population` | creator only: `{userId, population}` (25-99, or null = random) |
| POST | `/api/v1/games/:id/start` | creator only; 3-9 players |
| GET | `/api/v1/games/:id/state` | the caller's start-of-turn package |
| GET | `/api/v1/games/:id/turn` | number, type, deadline, submitted **count** |
| GET | `/api/v1/games/:id/sheet` | saved sheet, spy defaults, live limits |
| POST | `/api/v1/games/:id/sheet/validate` | dry run: `{valid, errors, derived}`, saves nothing |
| PUT | `/api/v1/games/:id/sheet` | save a draft (rejected with 422 if invalid) |
| POST | `/api/v1/games/:id/sheet/submit` | final; resolves early when everyone is final |
| GET | `/api/v1/games/:id/history` | public battle results and news |
| GET | `/api/v1/games/:id/replay` | 403 `GAME_NOT_FINISHED` until the game ends; then sheets, events and seed |
| GET | `/api/v1/games/:id/stream` | SSE: `ready`, `lobby_changed`, `game_started`, `player_submitted`, `turn_resolved`, `game_finished` |

Sheet bodies are the resolver's JSON (see `src/game/`), using country names and minor ids like `"CUBA#1"`.

## The browser client

The server also serves the client in `src/client/` at `/` (GET and HEAD only, only these file types, nothing outside that folder).
Every file is sent with a strict Content-Security-Policy (scripts and styles from this origin only, no framing). The client asks `GET /api/v1/auth/config` which sign-in
method to show: email links when mail is configured, or (development only) a display name when `ALLOW_SIGNUP=true`.

## Behaviour worth knowing

- **Secrets:** the game seed (it determines country draws and auction tie-breaks) is only revealed by the replay.
- **SSE carries no private data.** Events contain counts and turn numbers; clients refetch `/state`.
- **Writes are rate limited** per user (default 60 per minute). Bodies over 256 KB get 413.
- **Resolution** happens in two places: early (last final sheet) and the deadline worker (`worker.js`). The pipeline makes this safe to race.
- **Auth is deliberately replaceable.** `auth.js` mints and checks signed tokens; whatever proves who someone is sits in front of it.
  `login.js` is the email-link sign-in: `POST /api/v1/auth/email-link` mails a one-time link, `POST /api/v1/auth/verify` exchanges its secret for a
  token. The secret travels after a `#` (never sent to servers or logs) and is posted by the page, so mail scanners that fetch links cannot use them up.
  `allowSignup` is a development convenience.
- **Email sign-in never reveals who has an account:** asking for a link answers 202 for every well-formed address. See the README's "Signing in".

## Running

```
npm run dev      # local: in-memory data (lost on exit), sign-in links printed in the terminal, port 3000, no database
npm install pg   # production
DATABASE_URL=postgres://... AUTH_SECRET=<16+ random chars> APP_URL=https://... SMTP_URL=smtps://... MAIL_FROM=... npm start
```

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | | PostgreSQL connection string. Run `npm run migrate -- up` first; the server refuses to start on an empty database |
| `AUTH_SECRET` | | 16+ characters; signs login tokens. Never printed |
| `PORT` / `HOST` | 3000 / 0.0.0.0 | `PORT=0` picks a free port |
| `ALLOW_SIGNUP` | off | only the exact word `true` lets `POST /api/v1/users` create accounts (development) |
| `MAIL_TRANSPORT` | `smtp` if `SMTP_URL` is set | `smtp` or `console`. Setting either turns on email sign-in. `console` prints links to the log and is refused when `NODE_ENV=production` |
| `APP_URL` | | public address of the site, used in every email link. Required with email sign-in; `https://` in production |
| `SMTP_URL` | | `smtps://user:pass@host:465` or `smtp://user:pass@host:587` (STARTTLS required; credentials are never sent unencrypted). Percent-encode special characters in the password |
| `MAIL_FROM` | | sender, `game@example.com` or `Name <game@example.com>` |
| `LOGIN_LINK_MINUTES` | 15 | how long an emailed link works (1 to 60) |
| `TRUST_PROXY` | off | `true` only behind a reverse proxy you control: client addresses for rate limits come from `X-Forwarded-For` |
| `NODE_ENV` | | `production` makes the server refuse the console mail transport and a non-https `APP_URL` |
| `CORS_ORIGIN` | none | one allowed browser origin |
| `WORKER_INTERVAL_MS` | 60000 | how often overdue turns are resolved |
| `SHUTDOWN_GRACE_MS` | 5000 | how long open connections (such as event streams) get before being cut on shutdown |
| `STORE=memory` | postgres | throwaway in-memory server; prints a warning. Development only |

Exit codes: 0 clean shutdown, 1 failed to start (for example the database is unreachable), 2 bad configuration.

Clean shutdown is triggered by Ctrl+C (SIGINT), SIGTERM on Linux and macOS, Ctrl+Break on Windows, or, for a parent process
that started the server with an IPC channel, the message `"shutdown"`. On Windows, stopping the process with `taskkill` or a
service manager terminates it immediately, without the clean shutdown; use Ctrl+C in a console. Bad configuration lists every problem at once and starts nothing.
