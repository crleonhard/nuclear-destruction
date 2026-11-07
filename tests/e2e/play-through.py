"""Plays a complete game through the real UI with three browsers (sign-up, lobby, three turns, a war, a battle),
checking live updates, validation, hostile text, phone width, dark mode, accessibility and the browser console.

    python play-through.py BASE_URL [--shots DIR]

Needs: pip install playwright && playwright install chromium
"""
import argparse, os, re, sys, json
from playwright.sync_api import sync_playwright, expect

_ap = argparse.ArgumentParser()
_ap.add_argument("base"); _ap.add_argument("--shots", default=None)
_args = _ap.parse_args()
BASE = _args.base.rstrip("/")
SHOTS = _args.shots
if SHOTS: os.makedirs(SHOTS, exist_ok=True)
problems = []   # console errors, page errors, failed requests (including CSP violations)
http_errors = []  # every HTTP response with status >= 400: (who, status, method, path)

def watch(page, who):
    page.on("console", lambda m: problems.append(f"[{who}] console.{m.type}: {m.text}") if m.type in ("error", "warning") and "Failed to load resource" not in m.text else None)
    page.on("response", lambda r: http_errors.append((who, r.status, r.request.method, re.sub(r"^https?://[^/]+", "", r.url))) if r.status >= 400 else None)
    page.on("pageerror", lambda e: problems.append(f"[{who}] pageerror: {e}"))
    page.on("requestfailed", lambda r: problems.append(f"[{who}] requestfailed: {r.url} {r.failure}") if "/stream" not in r.url else None)

def shot(page, name):
    if SHOTS: page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=True)

def sign_up(page, name):
    page.goto(BASE)
    expect(page.get_by_role("heading", name="Nuclear Destruction")).to_be_visible()
    page.get_by_label("Your name").fill(name)
    page.get_by_role("button", name="Start playing").click()
    expect(page.get_by_role("heading", name=f"Welcome, {name}")).to_be_visible()

def pick(page, country):
    page.get_by_role("button", name=re.compile(rf"^{country}")).click()
    expect(page.get_by_role("button", name=re.compile(rf"^{country}"))).to_have_attribute("aria-pressed", "true")

with sync_playwright() as p:
    browser = p.chromium.launch()
    pages = {}
    for who in ("Ada", "Ben", "Cy"):
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        pg = ctx.new_page(); watch(pg, who); pages[who] = pg
    A, B, C = pages["Ada"], pages["Ben"], pages["Cy"]

    # ── sign in, create, join ──
    A.goto(BASE); shot(A, "01-login")
    sign_up(A, "Ada"); shot(A, "02-home")
    A.get_by_role("button", name="Create game").click()
    expect(A.get_by_role("heading", name=re.compile(r"^Game #\d+$"))).to_be_visible()
    game_url = A.url; gid = re.search(r"/games/(\d+)", game_url).group(1)
    print("game", gid)

    for who in ("Ben", "Cy"):
        sign_up(pages[who], who)
        pages[who].get_by_label("Join a game").fill(game_url)      # a pasted invite link works
        pages[who].get_by_role("button", name="Go").click()
        pages[who].get_by_role("button", name="Join game").click()
        expect(pages[who].get_by_role("heading", name="Choose your country")).to_be_visible()

    # live updates: Ada's lobby shows the others without reloading
    expect(A.get_by_text("Ben", exact=True)).to_be_visible(); expect(A.get_by_text("Cy", exact=True)).to_be_visible()
    pick(A, "France"); pick(B, "India"); pick(C, "Japan")
    expect(C.get_by_text("Taken by Ada")).to_be_visible()               # Cy sees Ada's pick live
    expect(A.get_by_role("button", name="Start game")).to_be_enabled()
    shot(A, "03-lobby-ready")
    # a taken country cannot be chosen
    expect(B.get_by_role("button", name=re.compile(r"^France"))).to_be_disabled()
    A.get_by_role("button", name="Start game").click()
    for pg in (A, B, C):
        expect(pg.get_by_role("heading", name="Your orders for this turn")).to_be_visible()   # all three switched by themselves
    expect(A.get_by_text("Turn 1")).to_be_visible()
    shot(A, "04-turn1-empty")

    # ── accessibility: every form control has a name a screen reader can announce ──
    unnamed = A.evaluate("""() => [...document.querySelectorAll('input, select, textarea')]
        .filter(el => !(el.labels && el.labels.length) && !el.getAttribute('aria-label')).map(el => el.outerHTML.slice(0, 80))""")
    assert not unnamed, f"controls without an accessible name: {unnamed[:3]}"

    # ── narrow screens and dark mode ──
    A.set_viewport_size({"width": 390, "height": 844})
    overflow = A.evaluate("() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth")
    if overflow > 1:
        wide = A.evaluate("""() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1)
            .slice(0, 8).map(e => e.tagName.toLowerCase() + '.' + e.className + ' right=' + Math.round(e.getBoundingClientRect().right))""")
        raise AssertionError(f"the page scrolls sideways on a phone by {overflow}px; elements past the edge: {wide}")
    shot(A, "04b-turn1-phone")
    A.emulate_media(color_scheme="dark"); shot(A, "04c-turn1-dark"); A.emulate_media(color_scheme="light")
    A.set_viewport_size({"width": 1280, "height": 900})
    # the budget and the submit bar stay in view while scrolling a long sheet
    A.mouse.wheel(0, 1400)
    expect(A.get_by_role("button", name="Submit final sheet")).to_be_in_viewport()
    expect(A.locator(".budget")).to_be_in_viewport()
    A.mouse.wheel(0, -3000)

    # ── turn 1: fill Ada's sheet, watch live validation ──
    A.get_by_label("ABM factories").fill("6")                           # over the cap of 5
    expect(A.get_by_role("alert")).to_contain_text("ABM", timeout=5000)
    expect(A.get_by_role("button", name="Submit final sheet")).to_be_disabled()
    shot(A, "05-validation-error")
    A.get_by_label("ABM factories").fill("3")
    A.get_by_label("New-factory builds").fill("2")
    expect(A.get_by_role("alert")).to_be_hidden(timeout=5000)
    expect(A.get_by_role("button", name="Submit final sheet")).to_be_enabled()
    A.get_by_label("Spy 1 target type").select_option("MINOR")
    A.get_by_label("Spy 1 target", exact=True).select_option(label="Cuba")
    A.get_by_label("Cash to Cuba", exact=True).fill("6")
    A.get_by_text("Messages and world news").click()
    A.get_by_label("Message to India").fill("secret <b>bold</b>")
    A.locator("div.card", has_text="To India").get_by_label("Send anonymously").check()
    A.get_by_label("World news").fill("peace <img src=x onerror=alert(1)>")
    shot(A, "06-turn1-filled")
    A.get_by_role("button", name="Save draft").click()
    expect(A.get_by_text("Draft saved. It is not final yet.")).to_be_visible()
    A.get_by_role("button", name="Submit final sheet").click()
    expect(A.get_by_text("Final sheet submitted.").first).to_be_visible()
    # the submitted count is live on another player's screen, and shows no names
    expect(B.get_by_text("1 of 3 players have submitted")).to_be_visible()
    B.get_by_role("button", name="Submit final sheet").click()
    expect(C.get_by_text("2 of 3 players have submitted")).to_be_visible()
    C.get_by_role("button", name="Submit final sheet").click()

    # ── the turn resolves; everyone moves to turn 2 on their own ──
    for pg in (A, B, C):
        expect(pg.get_by_text("Turn 2").first).to_be_visible(timeout=8000)
    expect(A.get_by_role("heading", name="Intelligence")).to_be_visible()
    expect(A.get_by_text("Popularity in Cuba")).to_be_visible()
    expect(A.get_by_role("row", name=re.compile(r"^France 6$"))).to_be_visible()   # her $6 gift is her popularity in Cuba
    expect(A.get_by_role("row", name=re.compile(r"^India 0$"))).to_be_visible()
    shot(A, "07-turn2-intel")
    expect(B.locator("section.card", has_text="Messages received").get_by_text("Anonymous", exact=True)).to_be_visible()   # sender stays hidden
    expect(B.get_by_text("secret <b>bold</b>")).to_be_visible()             # shown as literal text, not markup
    expect(B.get_by_text("peace <img src=x onerror=alert(1)>")).to_be_visible()
    assert B.locator("img").count() == 0 and B.locator("b").count() == 0, "player text was turned into elements"
    shot(B, "08-turn2-inbox")
    expect(A.get_by_text("Cash ($M)").first).to_be_visible()

    # ── turn 2: Ada declares war ──
    A.get_by_label("Declare nuclear war").check()
    A.get_by_role("button", name="Submit final sheet").click()
    expect(A.get_by_text("Final sheet submitted.").first).to_be_visible()
    B.get_by_role("button", name="Submit final sheet").click()
    C.get_by_role("button", name="Submit final sheet").click()
    for pg in (A, B, C):
        expect(pg.get_by_text("Battle turn").first).to_be_visible(timeout=8000)
        expect(pg.get_by_text("Nuclear war has begun")).to_be_visible()
    expect(A.get_by_role("heading", name="Your orders for this battle")).to_be_visible()
    expect(A.get_by_role("heading", name=re.compile(r"Cuba.*you control it"))).to_be_visible()   # Ada controls Cuba
    expect(B.get_by_role("heading", name=re.compile("you control it"))).to_have_count(0)
    shot(A, "09-battle-editor")

    # ── battle turn: fire from home and from Cuba, with a stock check ──
    A.get_by_label("Your home country: target 1").select_option(label="India")
    A.get_by_label("Your home country: missiles at target 1").fill("12")
    A.get_by_label(re.compile(r"Cuba.*target 1$")).first.select_option(label="Japan")
    A.get_by_label(re.compile(r"Cuba.*missiles at target 1")).fill("3")
    A.get_by_label("Your home country: missiles at target 1").fill("999")
    expect(A.get_by_role("alert")).to_contain_text("Fire from your home country", timeout=5000)   # more than you hold
    A.get_by_label("Your home country: missiles at target 1").fill("12")
    expect(A.get_by_role("alert")).to_be_hidden(timeout=5000)
    shot(A, "10-battle-filled")
    A.get_by_role("button", name="Submit final sheet").click()
    B.get_by_role("button", name="Submit final sheet").click()
    C.get_by_role("button", name="Submit final sheet").click()
    for pg in (A, B, C):
        expect(pg.get_by_role("heading", name="Last battle")).to_be_visible(timeout=8000)
    expect(B.get_by_text("Damage", exact=True)).to_be_visible()
    shot(B, "11-after-battle")
    expect(B.get_by_text("Turn 4").first).to_be_visible()

    # ── history, finished-game views, sign out ──
    B.get_by_role("link", name="History").click()
    expect(B.get_by_role("heading", name=re.compile("history"))).to_be_visible()
    expect(B.get_by_role("heading", name=re.compile(r"Turn 3 · Battle turn"))).to_be_visible()
    shot(B, "12-history")
    B.goto(f"{BASE}/#/games/{gid}/replay")
    expect(B.get_by_text("The replay is released when the game ends")).to_be_visible()
    B.goto(f"{BASE}/#/")
    expect(B.get_by_role("link", name="Open")).to_be_visible()
    B.get_by_role("button", name="Sign out").click()
    expect(B.get_by_role("heading", name="Nuclear Destruction")).to_be_visible()
    B.goto(f"{BASE}/#/games/{gid}")                                          # signed out: sent back to sign-in
    expect(B.get_by_label("Your name")).to_be_visible()
    browser.close()

expected = [("Ben", 403, "GET", f"/api/v1/games/{gid}/replay")]
unexpected = [e for e in http_errors if e not in expected]
missing = [e for e in expected if e not in http_errors]
print("HTTP errors seen:", http_errors)
print("CONSOLE/NETWORK PROBLEMS:", json.dumps(problems, indent=1) if problems else "none")
print("UNEXPECTED HTTP ERRORS:", unexpected or "none", "| EXPECTED BUT MISSING:", missing or "none")
sys.exit(1 if (problems or unexpected or missing) else 0)
