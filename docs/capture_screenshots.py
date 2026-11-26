"""Regenerate the screenshots in docs/screenshots from a running Inkling.

    pip install playwright && python -m playwright install chromium
    python docs/capture_screenshots.py                     # against http://127.0.0.1:8000
    python docs/capture_screenshots.py --with-ai           # also the Ask AI and director shots (billable Gemini calls)

It signs up a fresh m-stash member, copies the demo library (run the demo seed first), and walks the
product like a person would: desktop at 1280x800, phone at 390x844, both at 2x.
"""

import argparse
import re
import secrets
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

OUT = Path(__file__).resolve().parent / "screenshots"
DESKTOP = {"viewport": {"width": 1280, "height": 800}, "device_scale_factor": 2}
PHONE = {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True}


# Tooltips follow the (invisible) mouse; they'd only clutter the shots.
QUIET = """document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = '#tooltip { display: none !important; }';
  document.head.append(style);
});"""


def shot(page: Page, name: str) -> None:
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / name), animations="disabled")
    print(f"  {name}", flush=True)


def studio_shot(page: Page, name: str) -> None:
    """The whole drawing card (tools, canvas, Ask AI, frames) plus the save card, header out of the way."""
    page.evaluate("document.querySelector('.topbar').style.position = 'static'")
    page.wait_for_timeout(1200)  # let the layer list finish sliding in
    page.locator("section.studio").screenshot(path=str(OUT / name), animations="disabled")
    page.evaluate("document.querySelector('.topbar').style.position = ''")
    print(f"  {name}", flush=True)


def hide_starters(page: Page) -> None:
    """The strip floats over an empty canvas until dismissed (then it's inert for the session)."""
    if page.locator("#starter-strip:not([inert]) #starter-skip").count():
        page.click("#starter-skip")


def card(page: Page, title: str):
    return page.locator(".card", has=page.locator("strong", has_text=re.compile(f"^{re.escape(title)}$"))).first


def doodle(page: Page, strokes: list[list[tuple[float, float]]]) -> None:
    """Draw with the mouse, in canvas fractions."""
    box = page.locator("#drawing").bounding_box()
    for stroke in strokes:
        x, y = stroke[0]
        page.mouse.move(box["x"] + x * box["width"], box["y"] + y * box["height"])
        page.mouse.down()
        for x, y in stroke[1:]:
            page.mouse.move(box["x"] + x * box["width"], box["y"] + y * box["height"], steps=8)
        page.mouse.up()


def wait_closed(page: Page, selector: str) -> None:
    page.wait_for_function(f"!document.querySelector('{selector}').open", timeout=90_000)


def top(page: Page, selector: str, offset: int = 64) -> None:
    """Scroll so an element sits just under the sticky header."""
    page.evaluate("([s, o]) => { const el = document.querySelector(s); window.scrollTo(0, el.getBoundingClientRect().top + scrollY - o); }",
                  [selector, offset])
    page.wait_for_timeout(500)


def open_asset(page: Page, asset: str) -> None:
    """An asset's page: tap its picture in Your assets."""
    top(page, "#library-heading", 70)
    card(page, asset).locator(".thumb-button").click()
    page.wait_for_selector("#where-used[open]")
    page.wait_for_function("document.querySelector('#wu-linked .wu-card, #wu-linked .wu-empty')", timeout=30_000)


def drag(page: Page, points: list[tuple[float, float]]) -> None:
    """A finger path, in canvas fractions."""
    doodle(page, [points])


def open_breakdown(page: Page, asset: str) -> None:
    open_asset(page, asset)
    page.click("#wu-breakdown")
    page.wait_for_selector("#breakdown[open]")
    page.wait_for_timeout(1200)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--with-ai", action="store_true", help="include the Ask AI sketch shot (billable)")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    email = f"ada-{secrets.token_hex(3)}@example.com"
    password = "draw it once, animate it anywhere"

    with sync_playwright() as p:
        browser = p.chromium.launch()

        print("Phone, signed out:", flush=True)
        phone = browser.new_context(**PHONE)
        phone.add_init_script(QUIET)
        page = phone.new_page()
        page.goto(args.base)
        page.wait_for_selector("#gate[open]")
        page.wait_for_timeout(3800)  # let the ink line draw itself
        shot(page, "01-sign-in-phone.png")
        phone.close()

        print("Desktop:", flush=True)
        desk = browser.new_context(**DESKTOP)
        desk.add_init_script(QUIET)
        page = desk.new_page()
        page.on("dialog", lambda dialog: dialog.accept())  # "unsaved changes?" while hopping between scenes
        page.goto(args.base)
        page.wait_for_selector("#gate[open]")
        page.wait_for_timeout(3800)
        shot(page, "01-sign-in.png")
        page.fill("#gate-email", email)
        page.fill("#gate-password", password)
        page.click("#gate-submit")
        page.wait_for_selector("#welcome[open]", timeout=90_000)
        page.wait_for_timeout(700)
        shot(page, "02-welcome.png")
        page.click("#welcome-demo")
        wait_closed(page, "#welcome")
        page.wait_for_timeout(4000)  # vector indexes pick up the copy within a couple of seconds

        page.evaluate("window.scrollTo(0, 0)")
        page.locator("#starter-list button", has_text="Beach").click()
        page.wait_for_timeout(900)
        studio_shot(page, "03-starter-beach.png")

        if args.with_ai:
            page.click("#clear")
            page.wait_for_timeout(600)
            hide_starters(page)
            page.click('[data-mode="sketch"]')
            page.fill("#ai-prompt", "a lighthouse on a rocky cliff")
            page.click("#ai-go")
            page.wait_for_selector("text=Use sketch", timeout=90_000)
            page.wait_for_timeout(2500)  # the strokes draw themselves in
            studio_shot(page, "04-ask-ai-sketch.png")
            page.keyboard.press("Escape")

        top(page, "#library-heading", 70)
        page.wait_for_timeout(800)
        shot(page, "05-library.png")

        open_asset(page, "Red Rocket")
        page.wait_for_timeout(1500)
        shot(page, "06-where-used.png")
        page.fill("#wu-q", "the rocket flying high above the trees")
        page.press("#wu-q", "Enter")
        page.wait_for_function("document.querySelector('#wu-status-line').textContent.includes('most similar')", timeout=30_000)
        page.wait_for_timeout(1500)
        shot(page, "07-asset-shot-search.png")
        page.click("#wu-close")

        # Search with a drawing: a rough rocket finds the rocket assets.
        page.click("#clear")
        page.wait_for_timeout(500)
        hide_starters(page)
        top(page, "#canvas-frame", 140)
        doodle(page, [
            [(0.45, 0.75), (0.5, 0.2), (0.55, 0.75), (0.45, 0.75)],  # a rocket body
            [(0.48, 0.78), (0.5, 0.9), (0.52, 0.78)],                 # flame
        ])
        page.click("#search-sketch")
        page.wait_for_function("document.querySelector('#library-status').textContent.includes('Your drawing was the search')", timeout=30_000)
        page.wait_for_timeout(1200)
        top(page, "#library-heading", 70)
        shot(page, "08-search-by-drawing.png")

        # Move it: Little Fox on the beach, dragged along a path with a finger, then kept and shared.
        page.click("#clear")
        page.wait_for_timeout(500)
        page.select_option("#scene-backdrop", "starter:beach")
        top(page, "#library-heading", 70)
        card(page, "Little Fox").get_by_role("button", name="Animate it").click()
        page.wait_for_timeout(1800)
        top(page, "#canvas-frame", 140)
        drag(page, [(0.5, 0.56), (0.6, 0.42), (0.7, 0.6), (0.8, 0.45), (0.88, 0.58)])
        page.wait_for_timeout(1700)
        studio_shot(page, "09c-motion-preview.png")
        page.locator("#drawing-status button", has_text="How it moves").click()
        page.wait_for_selector("#explain-sheet[open]")
        page.wait_for_timeout(900)
        shot(page, "09d-how-it-moves.png")
        page.click("#explain-close")
        page.wait_for_timeout(300)
        page.locator("#spark-tray button", has_text="Keep").click()
        page.wait_for_timeout(1200)
        page.evaluate("document.getElementById('advanced-tools').open = true")  # the frame strip
        page.click("#frame-play")  # stop the auto-play on frame 1
        page.locator('#frame-list [data-frame="12"]').click()
        page.wait_for_timeout(800)
        studio_shot(page, "09-flipbook.png")
        page.click("#share-open")
        page.wait_for_selector("#share-ready:not([hidden])", timeout=180_000)
        page.wait_for_timeout(1500)
        shot(page, "09e-share.png")
        shared_url = page.input_value("#share-url")
        page.click("#share-close")

        open_breakdown(page, "Little Fox")
        page.click(".bd-behind summary")
        page.click("#bd-replay")
        page.wait_for_timeout(800)  # mid-replay (a 19-stroke replay runs 2.5 s)
        shot(page, "10-watch-it-being-made.png")
        page.wait_for_timeout(3000)
        page.locator("#bd-evolution-group").scroll_into_view_if_needed()
        page.wait_for_timeout(800)
        shot(page, "11-evolution.png")
        storage = desk.storage_state()
        desk.close()

        print("Phone, signed in:", flush=True)
        phone = browser.new_context(**PHONE, storage_state=storage)
        phone.add_init_script(QUIET)
        page = phone.new_page()
        page.on("dialog", lambda dialog: dialog.accept())
        page.goto(args.base)
        page.wait_for_selector(".card", timeout=30_000)
        page.wait_for_timeout(1500)
        shot(page, "12-studio-phone.png")
        phone.close()

        print("Phone, anyone with the link:", flush=True)
        guest = browser.new_context(**PHONE)
        page = guest.new_page()
        page.goto(shared_url)
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUT / "13-shared-scene-phone.png"), full_page=True, animations="disabled")
        print("  13-shared-scene-phone.png", flush=True)
        guest.close()
        browser.close()
    print(f"Done: {OUT} (account {email})", flush=True)


if __name__ == "__main__":
    started = time.monotonic()
    main()
    print(f"{time.monotonic() - started:.0f}s", flush=True)
