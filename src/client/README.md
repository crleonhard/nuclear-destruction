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

## Signing in

`js/auth.js` is the only place that knows how people get an account. The login screen asks the server which method it offers:
email links (`login.js` asks for an address; `verify.js` is the page the emailed link opens) or, on a development server run
with `ALLOW_SIGNUP=true`, a display name. The link is `/#/verify/<secret>`. The secret is after the `#`, so it never reaches
any server log, and the page waits for a click before using it, so a mail scanner that opens links cannot use it up.
Afterwards the rest of the client only sees a token.

## Tests

- `tests/client-logic.test.js`: the pure modules, run in Node with small fakes.
- `tests/client-login.test.js`: the login and verify screens, run against a small fake DOM.
- `tests/client.test.js`: how the server delivers the client (types, security headers, path traversal), that every
  import resolves, the unsafe-pattern ban, and that every API call matches the spec.
- `npm run e2e`: plays a whole game through the real UI in a browser (see `tests/e2e/README.md`).
