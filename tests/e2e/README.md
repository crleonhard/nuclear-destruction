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
| `finished-game.py` | The end-of-game screens, using `finished-fixture.js` to seed games that are already finished: win and draw banners, the forfeited player's view, the home list, and the replay (seed, default sheets, event log). |

`finished-fixture.js` is needed because a real game cannot reach those screens inside a test (turns last hours).
It is checked without a browser by `tests/e2e-fixture.test.js`, which runs in `npm test`.
