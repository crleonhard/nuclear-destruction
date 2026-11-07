"""Checks the end-of-game screens in a real browser: win and draw banners, the eliminated view, the home list,
and the replay (seed, default sheets, expandable event log).

    python finished-game.py BASE_URL FIXTURE_JSON_FILE [--shots DIR]

FIXTURE_JSON_FILE holds the JSON printed by finished-fixture.js. Needs: pip install playwright && playwright install chromium
"""
import argparse, json, os, re, sys
from playwright.sync_api import sync_playwright, expect

ap = argparse.ArgumentParser()
ap.add_argument("base"); ap.add_argument("fixture"); ap.add_argument("--shots", default=None)
args = ap.parse_args()
BASE = args.base.rstrip("/")
fx = json.load(open(args.fixture))
WIN, DRAW = fx["games"]["win"], fx["games"]["draw"]
users = {u["name"]: u for u in fx["users"]}
if args.shots: os.makedirs(args.shots, exist_ok=True)
problems, http_errors = [], []

def shot(page, name):
    if args.shots: page.screenshot(path=os.path.join(args.shots, f"{name}.png"), full_page=True)

def player(browser, who):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_init_script(f"localStorage.setItem('nd.token', {json.dumps(users[who]['token'])})")   # already signed in
    page = ctx.new_page()
    page.on("console", lambda m: problems.append(f"[{who}] console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: problems.append(f"[{who}] pageerror: {e}"))
    page.on("response", lambda r: http_errors.append((who, r.status, re.sub(r"^https?://[^/]+", "", r.url))) if r.status >= 400 else None)
    return page

with sync_playwright() as p:
    browser = p.chromium.launch()
    ada, ben = player(browser, "Ada"), player(browser, "Ben")

    # ── the winner ──
    ada.goto(f"{BASE}/#/games/{WIN}")
    expect(ada.get_by_text("You won! You are the last country standing.")).to_be_visible()
    expect(ada.get_by_role("heading", name="The game is over")).to_be_visible()
    expect(ada.get_by_text("Finished", exact=True).first).to_be_visible()
    expect(ada.get_by_role("row", name=re.compile(r"India .* Forfeited"))).to_be_visible()
    expect(ada.get_by_role("row", name=re.compile(r"Japan .* Forfeited"))).to_be_visible()
    expect(ada.get_by_role("heading", name="Your orders for this turn")).to_have_count(0)      # nothing left to edit
    expect(ada.get_by_text("Deadline in")).to_have_count(0)
    shot(ada, "20-finished-winner")

    # ── a forfeited player ──
    ben.goto(f"{BASE}/#/games/{WIN}")
    expect(ben.get_by_text("France won the game.")).to_be_visible()
    expect(ben.get_by_role("heading", name="The game is over")).to_be_visible()
    shot(ben, "21-finished-loser")

    # ── the replay ──
    ada.get_by_role("link", name="Replay").click()
    expect(ada.get_by_text("France won.")).to_be_visible()
    expect(ada.get_by_text("The random seed was")).to_be_visible()
    expect(ada.locator("code")).to_have_text("1111")
    expect(ada.get_by_text("Default (missed the deadline)").first).to_be_visible()
    ada.get_by_text("Submitted", exact=True).click()
    expect(ada.locator("pre.json").first).to_contain_text("Ada was here")
    ada.get_by_text(re.compile(r"Event log \(\d+ events\)")).click()
    expect(ada.get_by_role("cell", name="FORFEITED").first).to_be_visible()
    shot(ada, "22-replay")

    # ── a draw ──
    ada.goto(f"{BASE}/#/games/{DRAW}")
    expect(ada.get_by_text("Everyone left was destroyed on the same turn. Nobody wins.")).to_be_visible()
    ada.get_by_role("link", name="Replay").click()
    expect(ada.get_by_text("Nobody won: everyone was destroyed on the same turn.")).to_be_visible()
    shot(ada, "23-draw-replay")

    # ── home lists both as finished, and the history link works ──
    ada.goto(f"{BASE}/#/")
    expect(ada.get_by_role("row", name=re.compile(rf"#{WIN} .*Finished"))).to_be_visible()
    expect(ada.get_by_role("link", name="View")).to_have_count(2)
    shot(ada, "24-home-finished")
    ada.goto(f"{BASE}/#/games/{WIN}/history")
    expect(ada.get_by_role("heading", name=re.compile("history"))).to_be_visible()
    browser.close()

print("HTTP errors seen:", http_errors or "none")
print("CONSOLE PROBLEMS:", problems or "none")
sys.exit(1 if (problems or http_errors) else 0)
