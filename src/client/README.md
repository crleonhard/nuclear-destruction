# Browser client

Plain HTML, CSS and JavaScript (ES modules). No framework, no build step, no dependencies: the server serves this
folder as it is. Start it with `npm run dev` and open http://localhost:3000.

```
index.html          the page shell (no inline script or style, so the strict CSP applies)
css/app.css         styles; follows the system light or dark setting
js/
  main.js           starts everything: API, session, header, router
  api.js            fetch wrapper (errors become ApiError) and the live event stream
  auth.js           the ONLY place that knows how accounts are created and where the token is kept
  router.js         hash router (#/games/12), no server support needed
  dom.js            h(): builds elements; text is always text, never HTML
  format.js         pure helpers: names, countdowns, readable error fields
  sheet-model.js    pure: the turn form <-> the sheet JSON, and running totals
  views/            login, home, lobby, play (+ editor, panels), history, replay
```

## Rules this code keeps

- **Never `innerHTML`.** Player names, messages and news come from other players. Everything goes through `h()`,
  which inserts text only. A test fails if any client file uses `innerHTML`, `eval` and the like, or if the page
  has an inline script, style or event handler.
- **The server is the only authority.** The client never decides what is legal; it shows the server's own validation
  (`POST .../sheet/validate`, the same rules that resolve the turn) while you type, and shows live totals for instant feedback.
- **No private data over the live stream.** Events only say that something changed; the client then refetches.
- **Every API call exists in the OpenAPI spec**, checked by a test.

## AI players

The create form takes a number of AI players; the lobby marks AI seats with their style, and the creator can add (with a style, or random)
and remove them. `format.js` holds the style names and descriptions; a test checks they match `src/ai/personas.js`.

## Signing in

`js/auth.js` is the only place that knows how people get an account. The login screen asks the server which method it offers:
email links (`login.js` asks for an address; `verify.js` is the page the emailed link opens) or, on a development server run
with `ALLOW_SIGNUP=true`, a display name. The link is `/#/verify/<secret>`. The secret is after the `#`, so it never reaches
any server log, and the page waits for a click before using it, so a mail scanner that opens links cannot use it up.
Afterwards the rest of the client only sees a token.

Account: clicking your name in the header opens `#/account` (`views/account.js`): rename, "Sign out on every device" (the server returns a fresh token, which replaces the stored one),
and a delete form whose button stays disabled until `DELETE` is typed exactly. `#/privacy` (`views/privacy.js`) is public.

Turn emails: the home page shows an "Email notifications" card (`views/email-settings.js`) only when the server says it sends email; it is a single checkbox
that saves immediately and goes back to what the server has if the save fails. The "stop these emails" link in each mail opens `#/unsubscribe/<token>`
(`views/unsubscribe.js`), which works signed in or out and, like the sign-in page, waits for a click.

## Tests

- `tests/client-logic.test.js`: the pure modules, run in Node with small fakes.
- `tests/client-login.test.js`: the login and verify screens, run against a small fake DOM.
- `tests/client-notifications.test.js`: the email settings card and the stop-link page, same fake DOM.
- `tests/client-account.test.js`: the account page and the privacy page, same fake DOM.
- `tests/client.test.js`: how the server delivers the client (types, security headers, path traversal), that every
  import resolves, the unsafe-pattern ban, and that every API call matches the spec.
- `npm run e2e`: plays a whole game through the real UI in a browser (see `tests/e2e/README.md`).
