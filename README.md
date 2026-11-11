# Nuclear Destruction

An asynchronous multiplayer turn-based strategy game for 3 to 9 players, played over HTTP. Each turn every
player submits a sheet (build, spy, give, offer, declare war, or fire); the server resolves all sheets
together. Once war is declared, normal and battle turns alternate until one player is left.

The rules and every decision made about them are in [`docs/rules.md`](docs/rules.md). The HTTP API is in
[`docs/api/openapi.yaml`](docs/api/openapi.yaml) (also served at `GET /openapi.json`).

## Layout

```
src/
  game/        the rules: pure functions, no I/O, no clocks (state in, state out)
  app/         use cases: start a game, submit a sheet, resolve a turn, lobby, AI players' turns; talks to a store
  ai/          AI players: play styles and the decision code (see src/ai/README.md)
  store/       where state lives: memory.js (tests, local) and postgres.js
  http/        the web layer: routes, tokens, email-link sign-in, OpenAPI description, and serving the client
                (turn emails live in app/notifications.js)
  mail/        sending email: a small SMTP client and the mailers (smtp, console, memory)
  client/      the browser client: plain HTML, CSS and JavaScript (see src/client/README.md)
  worker.js    resolves turns whose deadline has passed
  server.js    wires the pieces together; the only file that knows them all
db/            migrations (SQL) and the migration runner
docs/          rules.md, and the generated API spec in docs/api/
scripts/       build-openapi.js, run-db-tests.js, dev.js
tests/         game, HTTP, API contract, and the store contract suite (one suite, run against every store)
```

**Dependencies point inward only:** `game` <- `ai` <- `app` <- (`store`, `http`) <- `server`. The rules never import
anything; the stores and the HTTP layer never import each other.

## Commands

```
npm test                 all tests that need no database (the database ones are skipped)
npm run test:db:docker   everything, including PostgreSQL (store, migrations, HTTP and API tests), in a disposable container
npm run test:db -- --url postgres://...   the same against a server you already have
npm run build:openapi    regenerate docs/api/* (a test fails if they drift from src/http/openapi.js)
npm run migrate -- up    apply migrations (needs DATABASE_URL)
npm run dev              the whole game at http://localhost:3000 with throwaway in-memory data; sign-in links are printed in the terminal
npm run dev -- --name-signup   same, but sign up by typing a name (quick way to be several players)
npm run e2e              play a full game, the end-of-game screens, and email sign-in / AI lobby / turn emails / account page in a real browser (needs Python + Playwright; see tests/e2e/README.md)
npm start                the production server (needs DATABASE_URL, AUTH_SECRET and mail settings; see "Signing in" below and src/http/README.md)
```

## How testing works

- `tests/game.test.js` checks the rules directly.
- `tests/store-contract/contract.js` is one behaviour suite written against the public store API. It runs on
  the in-memory store in `npm test` and on PostgreSQL in `npm run test:db`, so the two cannot quietly differ.
- `tests/openapi.test.js` plays a whole game over real HTTP and checks every response against the spec.
  `tests/http.test.js` and this file run on the in-memory store in `npm test`, and on PostgreSQL in `npm run test:db`.
- `tests/ai-decide.test.js`, `tests/ai-play.test.js` and `tests/client-ai.test.js` check AI players: the decisions (hand-built situations and a fuzz of 4,000 random
  game states, every sheet validated by the real rules), the lobby, AI turns inside real games, fairness, and full self-played games.
- `tests/game-limit.test.js` and `tests/client-cancel.test.js` check the limit on open games (per person, finished games stop counting, simultaneous requests on PostgreSQL)
  and cancelling a game from its lobby.
- `tests/login.test.js`, `tests/mail.test.js` and `tests/client-login.test.js` check email sign-in: the flow over real HTTP (single use, expiry,
  rate limits, no account discovery), the SMTP client against a scripted mail server over real TLS and STARTTLS, and the sign-in screens.
  `tests/server-process.test.js` also signs in through a real server process that delivers the email over SMTP.
- `tests/account.test.js` and `tests/client-account.test.js` check account basics: names, tokens that die when you sign out everywhere, and deleting an
  account (what is erased, and what happens to lobbies, running games and finished games), plus the account and privacy pages.
- `tests/notifications.test.js` and `tests/client-notifications.test.js` check turn emails: who may opt in, who gets which mail and when, that nothing
  is sent twice (including two workers at once, on PostgreSQL), the daily cap, a failing mail server, and the one-click stop link and its page.
- `tests/client-logic.test.js` and `tests/client.test.js` check the browser client without a browser: its pure logic, how the
  server delivers it (security headers, path traversal), that it never uses unsafe DOM calls, and that every API call it makes is in the spec.
  `npm run e2e` then drives it in a real browser.
- `tests/server.test.js` and `tests/server-process.test.js` check startup, configuration errors, and clean shutdown,
  the second by launching the real `node src/server.js` as its own process.
- `tests/schema-postgres.test.js` checks the migrations (constraints, triggers, SQL functions) against a real
  database, and only runs under `test:db`.

## Status

Verified on PostgreSQL 16 via `npm run test:db:docker`: the store, the first six migrations (including rolling every one
back and re-applying), the database constraints, triggers and SQL functions, the HTTP layer, every response in a
full game checked against the API spec, and the real entry point (`node src/server.js`) booting on PostgreSQL,
surviving a restart, shutting down cleanly, and failing clearly when the database is unreachable.

The browser client is verified in a real browser by `npm run e2e` (a full three-player game, the end-of-game screens, email sign-in, the AI lobby, turn emails, the account page,
phone width, dark mode, accessibility names, no console or CSP errors). It has been run on Linux only; the PostgreSQL
database tests above have been run on Windows.

Email sign-in, AI players, the game limit, turn emails and account basics are covered by the tests listed above. Migration 009 (turn emails) has run green
on PostgreSQL in CI. Migration 010 and the PostgreSQL versions of the account store methods have so far only been run through the in-memory store (there
was no PostgreSQL where they were written), so your CI's `database` job is their first real run: check its result for `tests/account.test.js`
and the schema test, or run `npm run test:db:docker`.

## Game limits

A person may have at most **3 unfinished games they created** at once (set `MAX_OPEN_GAMES_PER_USER`; `0` means no limit). Both lobby and running
games count; finished games do not, and games a person only joined do not. Past the limit, creating a game answers 409 `TOO_MANY_GAMES`.
The creator can **cancel** a game that is still in its lobby (a "Cancel game" button, two clicks): it removes the game, everyone's seats and
any AI players, and frees a place. This protects a small database from being filled with abandoned games and AI accounts.

## Turn emails (opt-in)

Players can ask for two kinds of email, from a checkbox on their home page (**off until they turn it on**; only accounts that signed in with an
email address can):

- **"Turn N of game #G is open"**: once per turn, only for turns that open after they opted in (switching it on never triggers a burst about turns already running).
- **"Turn N closes in about H hours"**: once per turn, `NOTIFY_REMINDER_HOURS` (default 4) before the deadline, and only if they have not submitted final
  orders. In a short turn the reminder waits for the last third, so it never lands right behind the "open" mail. A saved draft is not "final", so
  someone who only saved a draft is still reminded.

How it behaves:

- **Each mail goes out at most once** per person, game, turn and kind (`turn_notifications`, migration 009). The server records the mail *before* handing it to
  the mail provider, so two workers can never both send it. If the provider refuses, the record is removed and the next pass (about a minute later) tries
  again; a crash in the instant between record and send loses that one mail rather than sending it twice.
- **Never** sent to someone who did not opt in, for a turn whose deadline has passed, to someone who already submitted, to an eliminated or forfeited
  player, or to an AI player.
- **Caps for a free mail plan:** at most `NOTIFY_DAILY_LIMIT` mails (default 150) in any rolling 24 hours and 40 per worker pass. Mailjet's free plan allows
  200 a day *in total*, shared with sign-in links, so the default leaves room for about 50 of those. Mail over the cap just waits; it is worked out again from
  the game state on the next pass and is dropped by itself once its turn has been resolved. Reminders go before "open" mails when mail is short.
- **Every mail has a stop link** (`/#/unsubscribe/<token>`). The token is the user number plus an HMAC made from `AUTH_SECRET` with its own key, so it is
  not a login token and can only switch the emails off. It needs no sign-in and does not expire. The page asks for one click first, like the sign-in
  page, so mail scanners that open links do not switch it off. Changing `AUTH_SECRET` also makes old stop links stop working (people can still switch
  the emails off on their home page).
- **Nothing secret is in a mail**: the game number, the turn, your own country and the deadline (in UTC), plus a link to the game.
- **Spam:** without your own domain these come from a free-mail address and may land in spam, like the sign-in links; the checkbox says so. A domain with
  SPF/DKIM fixes both.
- **Worker:** emails are sent at the end of each worker pass (`src/worker.js`), after turns are resolved and AI players have moved, so a new turn's mail goes
  out in the same pass that opens it. A mail problem is logged and never stops turn resolution. On Render's free plan the worker sleeps when the service
  does, so keep the uptime monitor pinging `/healthz`.

## Accounts and privacy

The account page (`#/account`, reached by clicking your name in the header) and the privacy page (`#/privacy`, linked in the footer, readable before signing in):

- **Change name.** `PUT /api/v1/me`. Names are 1 to 60 characters, trimmed, no control characters, and need not be unique (as before). The change shows everywhere at once,
  including in running games, because names are looked up when a page is drawn.
- **Sign out on every device.** `POST /api/v1/auth/sign-out-everywhere`. Every token carries the `session_version` it was issued under (`users.session_version`,
  migration 010) and is accepted only while that equals the account's current number; signing out everywhere adds one. The caller gets a fresh token so
  the device that asked stays signed in, every other device gets a 401 on its next request, and the person's open event streams are closed by the
  server. Tokens issued before the upgrade carry no number and count as 0, so nobody was signed out by deploying it. The check is one small query per
  request. A token for the right account but a version the account has not reached is refused too.
- **Delete account.** `POST /api/v1/me/delete` with `{"confirm": "DELETE"}` (a POST because DELETE requests carry no body in this API). The account row stays, because
  finished games refer to it, but it is anonymized in one transaction: email, turn-email setting, pending sign-in links for the address and sent-mail records are erased,
  the name becomes "Deleted player", and all tokens stop at once. The address is free again, so signing in with it later makes a brand new account with none of the old history.
  What happens to games:
  - a lobby the person **created** is cancelled, with its AI seats (anyone who had joined it loses it, exactly as with "Cancel game");
  - a lobby they only **joined**: they leave it;
  - a game that is **running**: an AI player takes over the seat (persona picked at random, named "Former player"), so nobody waits for someone who is gone.
    AI players never forfeit and send no messages; if no person is left the server plays the game out. The new AI player moves straight away;
  - a **finished** game is untouched except that the name shown is "Deleted player".
  Orders, messages and news the person already sent stay part of those games, without a name or an address. The deletion takes the same per-person row lock as game
  creation, so a game cannot be created for an account at the moment it is deleted; a person who has just been deleted gets a 404 if they try.
- **Privacy note.** The privacy page says, in plain words, what is stored (address, name, game actions, sign-in link fingerprints for about a day, a record of sent turn
  emails), what other players see, that there are no cookies or tracking (the browser keeps one sign-in token), and how to delete. It describes this software; whoever
  runs a site should add anything specific to their setup (who to contact, which mail provider and host they use) to `src/client/js/views/privacy.js`.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, in three jobs:

- **Tests:** the whole suite on Node 20 and 22, with in-memory data.
- **PostgreSQL:** the same code against a real PostgreSQL 16 (`npm run test:db`): the store, migrations up, all the way down and up again,
  constraints, email sign-in, AI players, the HTTP layer and the API contract.
- **Browser:** plays a full game, the end-of-game screens and the sign-in / AI lobby / turn-email / account flows through the real UI in Chromium (`npm run e2e`); screenshots are kept as a downloadable artifact for 7 days.

To make Render wait for green checks, set the service's Auto-Deploy to "After CI checks pass" (Settings > Build & Deploy). Do that once CI
has been green for a few runs, so a check you have not seen pass yet cannot block a deploy.

## Deploying (Aiven database + Render web service)

1. **Database (Aiven).** Create a PostgreSQL 16 service. From its Overview page copy the *Service URI* and download `ca.pem`.
2. **Code.** Save Aiven's `ca.pem` as `certs/aiven-ca.pem` (it is a public certificate, safe to commit), then put the project in a Git
   repository on GitHub or GitLab (`node_modules` is already ignored).
3. **Web service (Render, free plan).** Dashboard > New > Web Service > pick the repository, then:
   - Language **Node**, Instance type **Free**, Region: the one closest to your Aiven service.
   - Build Command `npm install && npm run migrate -- up` (this also brings the database schema up to date on every deploy).
   - Start Command `npm start`. Health Check Path `/healthz` (under Advanced).
   - Environment variables: `NODE_ENV=production`, `AUTH_SECRET` (random; make one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), `DATABASE_URL` (the Aiven URI),
     `NODE_EXTRA_CA_CERTS=certs/aiven-ca.pem`, `CLIENT_IP_HEADER=cf-connecting-ip`, `APP_URL` (the service's own address,
     `https://<service-name>.onrender.com`), `SMTP_URL` and `MAIL_FROM` (see "Signing in").
   If Render gives the service a different name than you expected, correct `APP_URL` and it redeploys.
   (`render.yaml` describes the same service as a Blueprint, but Render may require a payment method for Blueprints even on the free plan.)
4. A failed migration fails the deploy, so a bad schema never goes live.

Things specific to this setup:

- **Free instances sleep after 15 idle minutes,** and the timer that closes turns at their deadline sleeps with them: deadlines pass late
  and the first visitor after a pause waits about a minute. A free uptime monitor (UptimeRobot, cron-job.org) requesting `/healthz`
  every 5 to 10 minutes keeps it awake (see "Keeping a free instance awake" below); Render does not support this officially. One always-on free service fits in the 750 free hours a month;
  a second one would not. Use a paid instance (`plan: starter` in `render.yaml`) for something dependable.
- **Keeping a free instance awake.** Create a free account at UptimeRobot (50 monitors, 5-minute checks, non-commercial use) or Better Stack
  (10 monitors, 3-minute checks), add one HTTP monitor for `https://<service-name>.onrender.com/healthz`, and set its interval to the
  shortest the free plan allows (anything under 15 minutes works). `/healthz` answers both GET and HEAD. Do not point it at a page that
  needs signing in. Turn on email alerts: a monitor that reports "down" often is also telling you the database is off.
- **Free instances cannot send mail on ports 25, 465 or 587.** Use a provider on port 2525 (see "Signing in").
- **`CLIENT_IP_HEADER=cf-connecting-ip`:** Render sits behind Cloudflare, so the sign-in rate limits need the visitor's real address from
  that header (the last `X-Forwarded-For` entry is a Cloudflare server). Do not use `TRUST_PROXY` on Render.
- **Aiven's free database can power off when idle.** The app's once-a-minute check should count as activity, but if the game ever shows
  errors after a quiet spell, check the service in the Aiven console and power it on.
- **Locally against Aiven:** set `DATABASE_URL` and `NODE_EXTRA_CA_CERTS=certs/aiven-ca.pem` before `npm run migrate -- up`.
  Do not run `npm run test:db` against a real service: it creates and drops databases.

## AI players

When creating a game you can seat 0 to 8 AI players (the creator takes the other seat), and in the lobby the creator can add
more, choose a play style for each, remove them, and set their starting populations. AI players count towards the 3 to 9
needed, get a random free country like anyone who has not chosen one, and send in their orders by themselves the moment a turn
opens. They see only what a person in their seat would see, and are marked "AI" in the lobby and the players table. See
`src/ai/README.md` for how they play, and `docs/rules.md` for the rulings.

## Signing in

Players sign in with their email address and no password: they type the address, we email a one-time link, they open it.
A first-time address also picks the name other players see, on the page the link opens.

To turn it on, set `MAIL_TRANSPORT=smtp` (or just `SMTP_URL`), `SMTP_URL`, `MAIL_FROM` and `APP_URL`. Example:

```
APP_URL=https://game.example.com
SMTP_URL=smtps://apikey:SECRET@smtp.your-provider.com:465      # or smtp://...:587 (STARTTLS)
MAIL_FROM="Nuclear Destruction <game@example.com>"
```

Things worth knowing:

- **Use an email provider** (Postmark, SendGrid, Amazon SES, Mailgun, Fastmail, your own server...) and verify your sending
  domain with them (SPF and DKIM records). Without that, many inboxes will put the sign-in emails in spam. Some hosts block
  outgoing SMTP ports; if yours does, use your provider's port 587 or 2525 option, or ask the host.
- **Hosts that block the usual mail ports** (Render's free tier blocks 25, 465 and 587) can still send through a provider that
  accepts SMTP on port **2525**, for example `SMTP_URL=smtp://API_KEY:SECRET_KEY@in-v3.mailjet.com:2525` (Mailjet). Port 2525 uses the
  same STARTTLS rules as 587, so nothing else changes.
- **Choose a provider that does not rewrite links.** The sign-in link keeps its secret after a `#` so it never reaches logs. Providers that
  wrap every link in their own click-tracking redirect store that secret and show players a foreign address. Brevo does this for
  transactional email and, as of this writing, cannot switch it off below its Enterprise plan. Mailjet and most others let you turn
  click tracking off; do that in the provider's settings.
- **Without your own domain,** you can still send by verifying a single sender address with the provider, but the email then comes
  "from" that address (often a free-mail one) and many inboxes put such mail in spam. The sign-in screen already tells players to look
  in their spam folder. Owning a domain and setting up its SPF/DKIM records with the provider fixes this.
- **`APP_URL` is the address in every link.** It is never taken from a request, so nobody can make the site email a link to a
  look-alike address. Use `https://` in production (the server refuses anything else when `NODE_ENV=production`).
- **Links work once and expire after 15 minutes** (`LOGIN_LINK_MINUTES`, 1 to 60). Only a hash of each link's secret is stored.
- **Limits:** an address gets at most 5 links an hour (beyond that nothing is sent and nothing says so, so the limit cannot be used to
  find out who plays), and each client address is limited on the two sign-in endpoints. Behind a reverse proxy you control, set
  `TRUST_PROXY=true` so the limit sees the real visitor and not the proxy (on Render use `CLIENT_IP_HEADER` instead, see "Deploying").
- **Errors are visible:** if the mail server cannot be reached the person is told to try again, and the server logs the reason
  (never the address or the link).
- **Sessions:** signing in gives the usual login token, valid 30 days. "Sign out" forgets it on that browser; "Sign out on every device" on the
  account page cancels every token at once (see "Accounts and privacy"). Changing `AUTH_SECRET` still signs everyone out.
- **Development:** `npm run dev` prints each "email" in the terminal. `MAIL_TRANSPORT=console` does the same anywhere but the server
  refuses it when `NODE_ENV=production`, because anyone who could read the log could sign in as anybody.
