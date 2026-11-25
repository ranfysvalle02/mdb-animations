"""Seed the shared demo library (billable Voyage calls): python -m backend.seed_demo

It's written as the ``demo`` owner; members copy it into their own library with one tap.
"""

from backend.backfill import main as backfill
from backend.auth import DEMO_OWNER
from backend.demo import act_as, build, call, liftoff, redesign_rocket, rocket, seed_fox, wait_for_similar

TWIN = "Rocket Ship"


def seed_twin() -> None:
    """A second artist's rocket, saved as its own asset: what "Similar assets" exists to catch."""
    if any(item["name"] == TWIN for item in call("GET", "/api/assets")["items"]):
        return
    call("POST", "/api/assets", {
        "name": TWIN, "type": "prop", "tags": ["rocket", "prop"],
        "description": "Sam's rocket for the city scenes (drawn before anyone checked the library).",
        "layers": [{"name": "Rocket", "strokes": rocket("#b91c1c", "#fb923c", "#7dd3fc", 1.08)}]})
    print(f"Asset '{TWIN}': a near-duplicate of Red Rocket. 'Where used?' lists it under Similar assets.")


def seed_animatic() -> None:
    """A 6-frame flipbook scene made from linked assets: what Breakdown dissects frame by frame."""
    if any(item["code"] == "SQ040_0020" for item in call("GET", "/api/shots?project=demo")["items"]):
        return
    assets = {item["name"]: item for item in call("GET", "/api/assets")["items"]}
    if "Red Rocket" not in assets or "Pine Tree" not in assets:
        return
    liftoff("demo", assets["Red Rocket"], assets["Pine Tree"])
    print("Scene SQ040_0020: a 6-frame liftoff animatic. Open Scenes > SQ040_0020 > Breakdown.")


def main() -> None:
    act_as(DEMO_OWNER)
    existing = call("GET", "/api/shots?project=demo")["items"]
    if existing:
        print(f"Project 'demo' already has {len(existing)} shots.")
    else:
        made = build("demo", [])
        print("Assets: Red Rocket, Pine Tree. Shots:", ", ".join(s["code"] for s in made["shots"].values()))
        wait_for_similar(made["rocket"]["id"], "demo", made["shots"]["city_flyby"]["id"])
        redesign_rocket(made["rocket"])
        print("Red Rocket is now v2: SQ010_0010 and SQ030_0010 placed v1 and show as outdated in 'Where used'.")
    seed_twin()
    seed_animatic()
    if not any(item["name"] == "Little Fox" for item in call("GET", "/api/assets")["items"]):
        seed_fox()
        print("Asset 'Little Fox': 3 versions from doodle to finished. Breakdown > Evolution and 'Watch it being made'.")
    backfill()
    print("Demo library ready: open the studio, sign up, and tap 'Start with the demo library'.")


if __name__ == "__main__":
    main()
