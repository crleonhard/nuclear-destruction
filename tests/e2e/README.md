# Browser tests

These drive the real interface in a real browser (Chromium via Playwright). They are separate from `npm test`
because they need Python and a browser:

```
pip install playwright
playwright install chromium
npm run e2e                        # screenshots go to a temp folder; the path is printed
npm run e2e -- --shots ./shots     # or choose the folder
```

`npm run e2e` starts its own throwaway servers (in-memory data, free ports), so it needs no database.

| Script | What it checks |
|---|---|
| `play-through.py` | Three browsers play a full game: sign-up, an invite link, the lobby updating live, the game starting for everyone at once, live validation, drafts and final submission, live "N of M submitted", automatic resolution, anonymous messages, **hostile text shown as plain text**, declaring war, a battle turn with fire orders, history. Also: phone width (no sideways scroll), dark mode, every control has an accessible name, the Submit bar and budget stay in view, and **no console errors or Content-Security-Policy violations**. The only HTTP error allowed is the one deliberate refusal. |
| `account-flows.py` | **Email sign-in** (the real login screen: a malformed address sends nothing; the emailed link is opened in a second browser first and must not be used up by merely opening it; a new address must choose a name without losing the link; a link works once; a garbage link is explained; signing out and in again), **the AI lobby** (two AIs added at creation, a chosen style added and one removed, the game started, and the turn resolving with only the human's orders; the limit of three unfinished games; the two-click cancel), **the turn-email checkbox** (off by default, saved on the server, a turn email arriving when a game starts, nothing sent to someone who did not opt in, the stop link needing one click and no sign-in), and **the account page** (rename, with a refusal shown and the header updating; sign out on every device: the other browser is signed out, this one is not; deleting with the exact word, an AI player taking the seat in another player's running game so the game goes on without waiting, and the address starting a brand new account afterwards). Also: accessible names and no sideways scrolling on a phone for each new page, and no console errors or CSP violations. Only the deliberate refusals may appear as HTTP errors, and each must appear. |
| `finished-game.py` | The end-of-game screens, using `finished-fixture.js` to seed games that are already finished: win and draw banners, the forfeited player's view, the home list, and the replay (seed, default sheets, event log). |

`account-fixture.js` starts that server with email sign-in only (no name sign-up) and a mailer that keeps every message. The browser test reads the emails, and asks for a
worker pass when it wants turn emails sent, through a tiny control server on a second port (`GET /mails`, `POST /tick`). The worker is parked otherwise, so emails appear exactly when
expected and the in-memory store is never written by two things at once. `tests/e2e-fixture.test.js` checks this fixture without a browser.

`finished-fixture.js` is needed because a real game cannot reach those screens inside a test (turns last hours).
It is checked without a browser by `tests/e2e-fixture.test.js`, which runs in `npm test`.
