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
npm run e2e              play a full game through the real UI in a browser (needs Python + Playwright; see tests/e2e/README.md)
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
- `tests/login.test.js`, `tests/mail.test.js` and `tests/client-login.test.js` check email sign-in: the flow over real HTTP (single use, expiry,
  rate limits, no account discovery), the SMTP client against a scripted mail server over real TLS and STARTTLS, and the sign-in screens.
  `tests/server-process.test.js` also signs in through a real server process that delivers the email over SMTP.
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

The browser client is verified in a real browser by `npm run e2e` (a full three-player game, the end-of-game screens,
phone width, dark mode, accessibility names, no console or CSP errors). It has been run on Linux only; the PostgreSQL
database tests above have been run on Windows.

Email sign-in and AI players are built and covered by the tests listed above, which pass on the in-memory store. Their PostgreSQL
parts (migrations 007 and 008, the new store methods, the schema test) have not yet been run on PostgreSQL: run
`npm run test:db:docker`.

## Deploying (Aiven database + Render web service)

1. **Database (Aiven).** Create a PostgreSQL 16 service. From its Overview page copy the *Service URI* and download `ca.pem`.
2. **Code.** Put this project in a Git repository on GitHub or GitLab (`node_modules` is already ignored).
3. **Web service (Render).** New > Blueprint, pick the repository: Render reads `render.yaml`. When asked, fill in:
   `DATABASE_URL` (the Aiven URI), `APP_URL` (this service's own address, e.g. `https://nuclear-destruction.onrender.com`),
   `SMTP_URL` and `MAIL_FROM` (see "Signing in"). Then open the service > Environment > Secret Files, add a file named
   `aiven-ca.pem` and paste the contents of Aiven's `ca.pem` (Aiven signs with its own CA; without this Node refuses the connection).
   If `APP_URL` was not known before the first deploy, set it afterwards and redeploy.
4. Every deploy runs `npm run migrate -- up` first, so the schema is always current. A failed migration fails the deploy.

Things specific to this setup:

- **Use a paid instance** (the blueprint says `starter`). A free Render instance sleeps after 15 idle minutes, and the timer that
  closes turns at their deadline sleeps with it: deadlines would pass late, and the first visitor after a pause waits about a minute.
  Run one instance only.
- **`CLIENT_IP_HEADER=cf-connecting-ip`** is set by the blueprint. Render sits behind Cloudflare, so the sign-in rate limits need
  the visitor's real address from that header (the last `X-Forwarded-For` entry is a Cloudflare server, and without any setting
  every visitor would share one limit). Do not use `TRUST_PROXY` on Render.
- **Locally against Aiven:** set `DATABASE_URL` and `NODE_EXTRA_CA_CERTS` (path to `ca.pem`) before `npm run migrate -- up`.
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
- **Sessions:** signing in gives the usual login token, valid 30 days. Tokens are stateless, so "Sign out" ends the session on that
  browser only; there is no "sign out everywhere" yet. Changing `AUTH_SECRET` signs everyone out.
- **Development:** `npm run dev` prints each "email" in the terminal. `MAIL_TRANSPORT=console` does the same anywhere but the server
  refuses it when `NODE_ENV=production`, because anyone who could read the log could sign in as anybody.
