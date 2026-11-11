"""Email sign-in, the AI lobby, the turn-email checkbox and the account page, driven through the real UI.

    python account-flows.py BASE_URL CONTROL_URL [--shots DIR]

CONTROL_URL is the small control server from account-fixture.js: it lists the emails the app "sent" and runs a worker pass.
Needs: pip install playwright && playwright install chromium
"""
import argparse, os, re, sys, json, time, urllib.request
from playwright.sync_api import sync_playwright, expect

_ap = argparse.ArgumentParser()
_ap.add_argument("base"); _ap.add_argument("control"); _ap.add_argument("--shots", default=None)
_args = _ap.parse_args()
BASE, CONTROL, SHOTS = _args.base.rstrip("/"), _args.control.rstrip("/"), _args.shots
if SHOTS: os.makedirs(SHOTS, exist_ok=True)
problems = []     # console errors, page errors, failed requests (including CSP violations)
http_errors = []  # every HTTP response with status >= 400: (who, status, method, path)

def watch(page, who):
    page.on("console", lambda m: problems.append(f"[{who}] console.{m.type}: {m.text}") if m.type in ("error", "warning") and "Failed to load resource" not in m.text else None)
    page.on("response", lambda r: http_errors.append((who, r.status, r.request.method, re.sub(r"^https?://[^/]+", "", r.url))) if r.status >= 400 else None)
    page.on("pageerror", lambda e: problems.append(f"[{who}] pageerror: {e}"))
    page.on("requestfailed", lambda r: problems.append(f"[{who}] requestfailed: {r.url} {r.failure}") if "/stream" not in r.url else None)

def shot(page, name):
    if SHOTS: page.screenshot(path=os.path.join(SHOTS, f"{name}.png"), full_page=True)

# ── the control server: emails the app sent, and worker passes ──
def mails():
    with urllib.request.urlopen(CONTROL + "/mails") as r: return json.load(r)

def tick():
    with urllib.request.urlopen(urllib.request.Request(CONTROL + "/tick", method="POST")) as r: r.read()

def wait_mail(to, marker, start, timeout=10):
    """The first email to `to` containing `marker` that arrived after the first `start` emails. Returns its text."""
    end = time.time() + timeout
    while time.time() < end:
        for m in mails()[start:]:
            if m["to"] == to and marker in m["text"]: return m
        time.sleep(0.1)
    raise AssertionError(f"no email to {to} containing {marker!r} within {timeout}s; got {[(m['to'], m['subject']) for m in mails()[start:]]}")

def link_of(mail, kind):
    """The in-app address of the #/verify/ or #/unsubscribe/ link in an email, on the server under test."""
    m = re.search(rf"#/{kind}/(\S+)", mail["text"])
    assert m, f"no {kind} link in: {mail['text']}"
    return f"{BASE}/#/{kind}/{m.group(1)}"

def request_link(page, email):
    """Asks for a sign-in link on the login screen. Returns the number of emails sent before, to find the new one."""
    before = len(mails())
    page.goto(BASE)
    page.get_by_label("Your email address").fill(email)
    page.get_by_role("button", name="Email me a sign-in link").click()
    expect(page.get_by_role("heading", name="Check your email")).to_be_visible()
    return before

def sign_in(page, email, name=None):
    """The whole real sign-in: ask for a link, read it from the 'sent' mail, open it, press the button."""
    before = request_link(page, email)
    page.goto(link_of(wait_mail(email, "#/verify/", before), "verify"))
    expect(page.get_by_role("heading", name="Finish signing in")).to_be_visible()
    if name: page.get_by_label("Your name (new players only)").fill(name)
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("heading", name=re.compile(r"^Welcome, "))).to_be_visible()

def flash(page): return page.locator("#flash")

def check_page_quality(page, what):
    """Every form control has a name a screen reader can announce, and the page does not scroll sideways on a phone."""
    unnamed = page.evaluate("""() => [...document.querySelectorAll('input, select, textarea')]
        .filter(el => !(el.labels && el.labels.length) && !el.getAttribute('aria-label')).map(el => el.outerHTML.slice(0, 80))""")
    assert not unnamed, f"{what}: controls without an accessible name: {unnamed[:3]}"
    page.set_viewport_size({"width": 390, "height": 844})
    overflow = page.evaluate("() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth")
    assert overflow <= 1, f"{what}: scrolls sideways on a phone by {overflow}px"
    page.set_viewport_size({"width": 1280, "height": 900})

def fresh_home(page):
    """The home page, loaded from scratch, so what it shows is what the server has."""
    page.goto(f"{BASE}/#/"); page.reload()

with sync_playwright() as p:
    browser = p.chromium.launch()
    def new_page(who, **kw):
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, **kw)
        pg = ctx.new_page(); watch(pg, who); return pg

    # ═══════════════ 1. email sign-in ═══════════════
    A = new_page("Ada")
    A.goto(BASE); shot(A, "20-login")
    expect(A.get_by_role("heading", name="Nuclear Destruction")).to_be_visible()
    expect(A.get_by_label("Your email address")).to_be_visible()
    expect(A.get_by_label("Your name", exact=True)).to_have_count(0)            # this server has no name sign-up
    expect(A.get_by_role("link", name="Privacy")).to_be_visible()               # the footer, before signing in

    # a malformed address is stopped by the browser itself: nothing is sent
    A.get_by_label("Your email address").fill("not-an-email")
    A.get_by_role("button", name="Email me a sign-in link").click()
    expect(A.get_by_role("heading", name="Check your email")).to_have_count(0)
    assert len(mails()) == 0, "an invalid address must not send mail"

    A.get_by_label("Your email address").fill("ada@example.org")
    n = len(mails())
    A.get_by_role("button", name="Email me a sign-in link").click()
    expect(A.get_by_role("heading", name="Check your email")).to_be_visible()
    expect(A.get_by_text("ada@example.org")).to_be_visible()
    expect(A.get_by_role("button", name="Send another link")).to_be_disabled()   # a cool-down against hammering the button
    shot(A, "21-check-your-email")
    link = link_of(wait_mail("ada@example.org", "#/verify/", n), "verify")

    # a mail scanner (or a curious second device) that only OPENS the link must not use it up
    S = new_page("Scanner")
    S.goto(link)
    expect(S.get_by_role("heading", name="Finish signing in")).to_be_visible()
    A.goto(link)
    expect(A.get_by_role("heading", name="Finish signing in")).to_be_visible()
    shot(A, "22-finish-signing-in")
    check_page_quality(A, "finish-signing-in page")
    A.get_by_role("button", name="Sign in").click()                              # a new address must choose a name
    expect(flash(A)).to_contain_text("name")
    expect(A.get_by_role("heading", name="Finish signing in")).to_be_visible()   # and the link was not used up by that
    A.get_by_label("Your name (new players only)").fill("Ada")
    A.get_by_role("button", name="Sign in").click()
    expect(A.get_by_role("heading", name="Welcome, Ada")).to_be_visible()
    expect(A.get_by_role("link", name="Ada")).to_be_visible()                    # the name in the header leads to the account page
    shot(A, "23-home")

    S.get_by_role("button", name="Sign in").click()                              # the link works once
    expect(S.get_by_role("heading", name="This link cannot be used")).to_be_visible()
    S.goto(f"{BASE}/#/verify/not-a-real-link")
    expect(S.get_by_text("That is not a sign-in link from this site")).to_be_visible()

    # signed out, the game's pages send you to sign-in; the privacy page stays readable
    S.goto(f"{BASE}/#/account")
    expect(S.get_by_label("Your email address")).to_be_visible()
    S.goto(f"{BASE}/#/privacy")
    expect(S.get_by_role("heading", name="Privacy")).to_be_visible()
    expect(S.get_by_text("No cookies, no tracking and no advertising")).to_be_visible()
    shot(S, "24-privacy")
    check_page_quality(S, "privacy page")

    # sign out, then sign in again: an existing account is not asked for a name
    A.get_by_role("button", name="Sign out").click()
    expect(A.get_by_label("Your email address")).to_be_visible()
    sign_in(A, "ada@example.org")
    expect(A.get_by_role("heading", name="Welcome, Ada")).to_be_visible()

    # ═══════════════ 2. the AI lobby, and the limit on unfinished games ═══════════════
    A.goto(f"{BASE}/#/")
    A.get_by_label("AI players (0 to 8)").fill("2")
    A.get_by_role("button", name="Create game").click()
    expect(A.get_by_role("heading", name=re.compile(r"^Game #\d+$"))).to_be_visible()
    gid = re.search(r"/games/(\d+)", A.url).group(1)
    expect(A.get_by_role("heading", name="Players (3 of 9)")).to_be_visible()
    expect(A.get_by_text(re.compile(r"^AI · "))).to_have_count(2)
    expect(A.get_by_role("button", name="Start game")).to_be_enabled()           # two AIs and Ada are enough players
    shot(A, "25-ai-lobby")

    hawks = A.get_by_text("AI · Hawk").count()                                   # the first two got random styles, so one may already be a Hawk
    A.get_by_label("Play style").select_option(label="Hawk")
    A.get_by_role("button", name="Add AI player").click()
    expect(A.get_by_role("heading", name="Players (4 of 9)")).to_be_visible()
    expect(A.get_by_text("AI · Hawk")).to_have_count(hawks + 1)
    A.get_by_role("button", name=re.compile(r"^Remove ")).first.click()
    expect(A.get_by_role("heading", name="Players (3 of 9)")).to_be_visible()
    expect(A.get_by_role("button", name=re.compile(r"^Remove "))).to_have_count(2)

    # the AI players move by themselves: Ada alone submits, and the turn resolves
    A.get_by_role("button", name="Start game").click()
    expect(A.get_by_role("heading", name="Your orders for this turn")).to_be_visible()
    expect(A.get_by_text("Turn 1").first).to_be_visible()
    A.get_by_role("button", name="Submit final sheet").click()
    expect(A.get_by_text("Turn 2").first).to_be_visible(timeout=10000)           # nobody else was waited for
    shot(A, "26-ai-game-turn2")

    # at most three unfinished games per person: the running one plus two lobbies, then a fourth is refused
    for i in range(2):
        A.goto(f"{BASE}/#/")
        A.get_by_role("button", name="Create game").click()
        expect(A.get_by_role("heading", name=re.compile(r"^Game #\d+$"))).to_be_visible()
    A.goto(f"{BASE}/#/")
    A.get_by_role("button", name="Create game").click()
    expect(flash(A)).to_contain_text("already have 3 games")
    expect(A.get_by_role("heading", name="Welcome, Ada")).to_be_visible()        # and she stays on the home page
    shot(A, "27-game-limit")
    # cancelling a lobby (two clicks, so it cannot happen by accident) frees a place
    A.get_by_role("row").filter(has_text="Waiting for players").first.get_by_role("link", name="Open").click()
    expect(A.get_by_role("heading", name=re.compile(r"^Game #\d+$"))).to_be_visible()
    A.get_by_role("button", name="Cancel game").click()
    expect(A.get_by_text("It cannot be undone.")).to_be_visible()
    A.get_by_role("button", name="Keep it").click()
    expect(A.get_by_role("button", name="Cancel game")).to_be_visible()          # backing out changes nothing
    A.get_by_role("button", name="Cancel game").click()
    A.get_by_role("button", name="Yes, cancel the game").click()
    expect(A.get_by_role("heading", name="Welcome, Ada")).to_be_visible()
    A.get_by_role("button", name="Create game").click()
    expect(A.get_by_role("heading", name=re.compile(r"^Game #\d+$"))).to_be_visible()   # a place was free again

    # ═══════════════ 3. the turn-email checkbox, and the stop link ═══════════════
    C = new_page("Cy")
    sign_in(C, "cy@example.org", "Cy")
    box = C.get_by_role("checkbox", name=re.compile("Email me when a turn opens"))
    expect(C.get_by_role("heading", name="Email notifications")).to_be_visible()
    expect(box).not_to_be_checked()                                              # off until the person turns it on
    expect(C.get_by_text("Off unless you turn it on")).to_be_visible()
    shot(C, "30-email-card")
    check_page_quality(C, "home page with the email card")
    box.check()
    expect(flash(C)).to_contain_text("Turn emails are on.")
    expect(box).to_be_checked()
    C.reload()                                                                   # saved on the server, not just on the page
    expect(C.get_by_role("checkbox", name=re.compile("Email me when a turn opens"))).to_be_checked()
    box = C.get_by_role("checkbox", name=re.compile("Email me when a turn opens"))
    box.uncheck()
    expect(flash(C)).to_contain_text("Turn emails are off.")
    C.reload()
    box = C.get_by_role("checkbox", name=re.compile("Email me when a turn opens"))
    expect(box).not_to_be_checked()
    box.check()
    expect(box).to_be_checked()

    # a game starts: Cy (who opted in) is emailed that turn 1 is open; Ada (who did not) is not
    C.get_by_label("AI players (0 to 8)").fill("2")
    C.get_by_role("button", name="Create game").click()
    expect(C.get_by_role("heading", name=re.compile(r"^Game #\d+$"))).to_be_visible()
    C.get_by_role("button", name="Start game").click()
    expect(C.get_by_role("heading", name="Your orders for this turn")).to_be_visible()
    n = len(mails())
    tick()
    turn_mail = wait_mail("cy@example.org", "#/unsubscribe/", n)
    assert re.search(r"turn 1 is open", turn_mail["subject"]), turn_mail["subject"]
    assert "You are playing" in turn_mail["text"] and "Deadline:" in turn_mail["text"], turn_mail["text"]
    assert not [m for m in mails() if m["to"] == "ada@example.org" and "is open" in m["subject"]], "Ada never opted in"
    n = len(mails()); tick(); tick()
    assert len(mails()) == n, "another pass sends nothing new"

    # the stop link works without signing in, and only after one click
    U = new_page("Stopper")
    U.goto(link_of(turn_mail, "unsubscribe"))
    expect(U.get_by_role("heading", name="Stop turn emails?")).to_be_visible()
    shot(U, "31-stop-link")
    fresh_home(C)
    expect(C.get_by_role("checkbox", name=re.compile("Email me when a turn opens"))).to_be_checked()   # opening the link changed nothing
    U.get_by_role("button", name="Stop turn emails").click()
    expect(U.get_by_role("heading", name="Turn emails are off")).to_be_visible()
    fresh_home(C)
    expect(C.get_by_role("checkbox", name=re.compile("Email me when a turn opens"))).not_to_be_checked()
    U.goto(f"{BASE}/#/unsubscribe/garbage")
    expect(U.get_by_role("heading", name="This link cannot be used")).to_be_visible()

    # ═══════════════ 4. the account page ═══════════════
    A.goto(f"{BASE}/#/")
    A.get_by_role("link", name="Ada").click()
    expect(A.get_by_role("heading", name="Your account")).to_be_visible()
    expect(A.get_by_label("The name other players see")).to_have_value("Ada")
    expect(A.get_by_text("ada@example.org")).to_be_visible()
    shot(A, "32-account")
    check_page_quality(A, "account page")

    A.get_by_label("The name other players see").evaluate("el => { el.value = 'x'.repeat(61); }")   # past the field's own limit (typing cannot do this): the server refuses, and the page says so
    A.get_by_role("button", name="Save name").click()
    expect(flash(A)).to_contain_text("1 to 60 characters")
    expect(A.get_by_role("link", name="Ada")).to_be_visible()
    A.get_by_label("The name other players see").fill("  Anna  ")
    A.get_by_role("button", name="Save name").click()
    expect(flash(A)).to_contain_text("Name changed")
    expect(A.get_by_role("link", name="Anna")).to_be_visible()                   # the header changed without a reload
    expect(A.get_by_label("The name other players see")).to_have_value("Anna")   # the field shows the trimmed name
    A.goto(f"{BASE}/#/")
    expect(A.get_by_role("heading", name="Welcome, Anna")).to_be_visible()

    # sign out everywhere: the other device is signed out, this one stays signed in
    P = new_page("Ada-phone")
    sign_in(P, "ada@example.org")
    expect(P.get_by_role("heading", name="Welcome, Anna")).to_be_visible()
    A.get_by_role("link", name="Anna").click()
    A.get_by_role("button", name="Sign out on every device").click()
    expect(flash(A)).to_contain_text("Signed out on every other device")
    P.reload()
    expect(P.get_by_label("Your email address")).to_be_visible()                 # its token no longer works
    A.reload()
    expect(A.get_by_role("link", name="Anna")).to_be_visible()                   # this device carried on with the fresh token
    shot(A, "33-after-sign-out-everywhere")

    # a second player (Ben) and a running game that Ada is in, so deleting has something to hand over
    B = new_page("Ben")
    sign_in(B, "ben@example.org", "Ben")
    B.get_by_label("AI players (0 to 8)").fill("1")
    B.get_by_role("button", name="Create game").click()
    expect(B.get_by_role("heading", name=re.compile(r"^Game #\d+$"))).to_be_visible()
    ben_game = B.url
    A.goto(f"{BASE}/#/")
    A.get_by_label("Join a game").fill(ben_game)
    A.get_by_role("button", name="Go").click()
    A.get_by_role("button", name="Join game").click()
    expect(A.get_by_role("heading", name="Choose your country")).to_be_visible()
    expect(B.get_by_role("heading", name="Players (3 of 9)")).to_be_visible()    # Ben saw her arrive, live
    B.get_by_role("button", name="Start game").click()
    for pg in (A, B):
        expect(pg.get_by_role("heading", name="Your orders for this turn")).to_be_visible()
    expect(B.get_by_text(re.compile(r"^AI · "))).to_have_count(1)                # Ben's one AI player: the players table shows countries, with a badge on the AIs

    # deleting needs the exact word
    A.get_by_role("link", name="Anna").click()
    expect(A.get_by_role("heading", name="Delete account")).to_be_visible()
    delete = A.get_by_role("button", name="Delete my account")
    expect(delete).to_be_disabled()
    A.get_by_label("Type DELETE to confirm").fill("delete")
    expect(delete).to_be_disabled()
    A.get_by_label("Type DELETE to confirm").fill("DELETE")
    expect(delete).to_be_enabled()
    shot(A, "34-delete-confirm")
    delete.click()
    expect(A.get_by_role("heading", name="Account deleted")).to_be_visible()
    expect(A.get_by_text(re.compile(r"2 games that were running will carry on with an AI player in your seat"))).to_be_visible()
    shot(A, "35-account-deleted")
    A.reload()
    expect(A.get_by_label("Your email address")).to_be_visible()                 # signed out for good

    # Ben's game goes on without waiting for Ada: her seat is an AI player now
    B.reload()
    expect(B.get_by_role("heading", name="Your orders for this turn")).to_be_visible()
    expect(B.get_by_text(re.compile(r"^AI · "))).to_have_count(2)                # Ada's seat now has the badge too
    B.get_by_role("button", name="Submit final sheet").click()
    expect(B.get_by_text("Turn 2").first).to_be_visible(timeout=10000)          # Ben alone ended the turn
    shot(B, "36-game-after-deletion")

    # the address is free again: signing in with it makes a brand new account, with none of the old games
    before = request_link(A, "ada@example.org")
    A.goto(link_of(wait_mail("ada@example.org", "#/verify/", before), "verify"))
    A.get_by_role("button", name="Sign in").click()
    expect(flash(A)).to_contain_text("name")                                     # a new account must choose a name
    A.get_by_label("Your name (new players only)").fill("Ada Two")
    A.get_by_role("button", name="Sign in").click()
    expect(A.get_by_role("heading", name="Welcome, Ada Two")).to_be_visible()
    expect(A.get_by_text("You are not in any games yet.")).to_be_visible()
    expect(A.get_by_role("checkbox", name=re.compile("Email me when a turn opens"))).not_to_be_checked()
    browser.close()

def shape(e):
    who, status, method, path = e
    return (who, status, method, re.sub(r"/\d+", "/N", path))
seen = [shape(e) for e in http_errors]
expected = [   # the deliberate refusals: each is something a test above provoked on purpose
    ("Ada", 422, "POST", "/api/v1/auth/verify"),           # a new address must choose a name
    ("Scanner", 400, "POST", "/api/v1/auth/verify"),       # a sign-in link works once
    ("Ada", 409, "POST", "/api/v1/games"),                 # the limit of three unfinished games
    ("Ada", 422, "PUT", "/api/v1/me"),                     # a name that is too long
    ("Ada", 422, "POST", "/api/v1/auth/verify"),           # the new account after deletion must choose a name
]
allowed = expected + [("Ada-phone", 401, m, path) for m in ("GET", "POST", "PUT") for path in (
    "/api/v1/me", "/api/v1/games", "/api/v1/me/notifications", "/api/v1/games/N/stream")]     # the signed-out device's first requests
unexpected = [e for e in seen if e not in allowed]
missing = [e for e in set(expected) if e not in seen] + ([] if any(e[0] == "Ada-phone" and e[1] == 401 for e in seen) else [("Ada-phone", 401, "?", "?")])
print("HTTP errors seen:", seen)
print("CONSOLE/NETWORK PROBLEMS:", json.dumps(problems, indent=1) if problems else "none")
print("UNEXPECTED HTTP ERRORS:", unexpected or "none", "| EXPECTED BUT MISSING:", missing or "none")
sys.exit(1 if (problems or unexpected or missing) else 0)
