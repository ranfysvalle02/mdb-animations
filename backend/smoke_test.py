"""Opt-in live demo check: signs in through m-stash, creates sample artwork, and makes billable Voyage and Gemini calls."""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = f"http://127.0.0.1:{os.environ.get('PORT', '8000')}"


def request(path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    from backend.demo import HEADERS
    headers = {**HEADERS, **({"Content-Type": "application/json"} if data is not None else {})}
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.load(response)


def stroke(color: str, points: list[tuple[float, float]]) -> dict:
    return {
        "color": color, "width": 10,
        "points": [{"x": x, "y": y, "pressure": 0.6} for x, y in points],
    }


def plain(strokes: list[dict]) -> list[dict]:
    return [{key: value for key, value in s.items() if key in ("color", "width", "points")} for s in strokes]


def check_layers() -> None:
    sky = [{"x": x, "y": y, "pressure": 0.75} for x, y in ((0, 0), (1, 0), (1, 0.5), (0, 0.5), (0, 0))]
    layered = {
        "title": "Sunset over a calm sea",
        "description": "A layered test: translucent sky, a sun, an erased gap, and a hidden sketch layer.",
        "tags": ["smoke test"],
        "layers": [
            {"name": "Sky", "visible": True, "opacity": 0.6, "strokes": [
                {"color": "#f97316", "width": 2, "erase": False, "fill": "#fdba74", "points": sky}]},
            {"name": "Sun", "visible": True, "opacity": 1.0, "strokes": [
                {"color": "#dc2626", "width": 12, "erase": False, "fill": None,
                 "points": [{"x": 0.4, "y": 0.4, "pressure": 0.5}, {"x": 0.6, "y": 0.4, "pressure": 0.5}]},
                {"color": "#000000", "width": 10, "erase": True, "fill": None,
                 "points": [{"x": 0.5, "y": 0.4, "pressure": 0.5}]}]},
            {"name": "Sketch", "visible": False, "opacity": 0.3, "strokes": [
                {"color": "#000000", "width": 3, "erase": False, "fill": None,
                 "points": [{"x": 0.1, "y": 0.9, "pressure": 0.5}]}]},
        ],
    }
    item = request("/api/drawings", layered)
    restored = request(f"/api/drawings/{item['id']}")
    if restored["layers"] != layered["layers"]:
        raise RuntimeError("Layers did not round-trip.")
    print("Layers round-tripped: Sky (60%, filled shape), Sun (with eraser), Sketch (hidden).", flush=True)


def check_production() -> None:
    """Assets, shots, exact + visual "where used", metadata-only status changes, and asset versions."""
    from backend.demo import build, call, remove

    project = f"smoke{int(time.time())}"
    made = build(project, ["smoke test"])
    try:
        verify_production(project, made)
    finally:
        if "variant" in made:
            call("DELETE", f"/api/assets/{made['variant']['id']}")
        remove(made)
    print("Cleaned up the smoke-test shots and assets.", flush=True)


def verify_production(project: str, made: dict) -> None:
    from backend.demo import call, redesign_rocket, wait_for_similar

    rocket, shots = made["rocket"], made["shots"]
    if shots["launch"]["elements"] != 3 or shots["night_city"]["elements"] != 1:
        raise RuntimeError("Shot elements were not indexed one per visible layer.")
    used = wait_for_similar(rocket["id"], project, shots["city_flyby"]["id"])
    linked = {entry["code"] for entry in used["linked"]}
    if linked != {"SQ010_0010", "SQ030_0010"}:
        raise RuntimeError(f"Exact links wrong: {linked}")
    similar = [entry["code"] for entry in used["similar"]]
    if similar[0] != "SQ010_0020" or "SQ020_0010" in similar:
        raise RuntimeError(f"Visual matches wrong (redrawn rocket first, forest excluded): {used['similar']}")
    print(f"Where used: linked {sorted(linked)}; look-alikes {[(e['code'], e['score']) for e in used['similar']]}", flush=True)

    open_only = call("GET", f"/api/assets/{rocket['id']}/where-used?project={project}&status=open")
    if any(entry["status"] == "approved" for entry in open_only["linked"] + open_only["similar"]):
        raise RuntimeError("status=open returned an approved shot.")
    call("PATCH", f"/api/shots/{shots['landing']['id']}", {"status": "approved", "assignee": "lee"})
    after = call("GET", f"/api/assets/{rocket['id']}/where-used?project={project}&status=open")
    if "SQ030_0010" in {entry["code"] for entry in after["linked"]}:
        raise RuntimeError("Approving a shot did not update its elements' status.")
    print("Status change: SQ030_0010 approved and dropped out of 'not approved' (no re-embedding).", flush=True)

    launch = call("GET", f"/api/shots/{shots['launch']['id']}")
    for layer in launch["layers"]:
        layer["visible"] = layer["name"] != "Red Rocket"
    body = {key: launch[key] for key in ("code", "project", "sequence", "status", "assignee", "description", "tags", "layers")}
    call("PUT", f"/api/shots/{launch['id']}", body)
    hidden = call("GET", f"/api/assets/{rocket['id']}/where-used?project={project}")
    entry = next((e for e in hidden["linked"] if e["code"] == "SQ010_0010"), None)
    if entry is None or entry["box"] is not None:
        raise RuntimeError("A hidden placement must still count as a link (without a box).")
    try:
        call("DELETE", f"/api/assets/{rocket['id']}")
        raise RuntimeError("Deleting an asset that is placed (even hidden) must be refused.")
    except RuntimeError as exc:
        if "422" not in str(exc):
            raise
    print("Hidden placement: still linked, and the asset can't be deleted out from under it.", flush=True)

    v2 = redesign_rocket(rocket)
    flagged = call("GET", f"/api/assets/{rocket['id']}/where-used?project={project}")
    outdated = {entry["code"] for entry in flagged["linked"] if entry["outdated"]}
    if v2["version"] != 2 or outdated != {"SQ010_0010", "SQ030_0010"}:
        raise RuntimeError(f"Version 2 should flag both placements as outdated: {outdated}")
    print("Asset v2: both shots that placed v1 are flagged as outdated.", flush=True)

    synced = call("POST", f"/api/shots/{shots['landing']['id']}/sync/{rocket['id']}")
    landing = call("GET", f"/api/shots/{shots['landing']['id']}")
    names = [layer["name"] for layer in landing["layers"]]
    if synced["updated"] != 1 or "Red Rocket (v1 backup)" not in names:
        raise RuntimeError(f"Update to latest should swap v2 in and keep a hidden v1 backup: {names}")
    sketch = next(e for e in flagged["similar"] if e["code"] == "SQ010_0020")
    call("POST", f"/api/shots/{shots['city_flyby']['id']}/link", {"asset_id": rocket["id"], "layer_index": sketch["layer_index"]})
    after = call("GET", f"/api/assets/{rocket['id']}/where-used?project={project}")
    states = {e["code"]: e["outdated"] for e in after["linked"]}
    if states.get("SQ030_0010") is not False or "SQ010_0020" not in states:
        raise RuntimeError(f"Sync and confirm should leave SQ030 current and SQ010_0020 linked: {states}")
    print("One-click fixes: SQ030_0010 updated to v2 (v1 kept hidden); the redrawn rocket confirmed as a linked use.", flush=True)
    check_similar_assets(made)
    check_animation_and_lineage(made, project)


def check_animation_and_lineage(made: dict, project: str) -> None:
    """Frames keep links in every frame; an AI variation keeps the artist's strokes and records its parent."""
    from backend.demo import call, liftoff

    rocket, pine = call("GET", f"/api/assets/{made['rocket']['id']}"), made["pine"]
    shot = liftoff(project, rocket, pine, code="SQ090_0010")
    made["shots"]["liftoff"] = shot
    record = call("GET", f"/api/shots/{shot['id']}")
    if shot["frames"] != 6 or len(record["frames"]) != 5 or record["fps"] != 8:
        raise RuntimeError(f"Frames did not round-trip: {shot['frames']} frames, fps {record['fps']}.")
    if [e["action"] for e in record["history"]][-1] != "Saved" or len(record["history"]) != 8:
        raise RuntimeError(f"The audit trail should hold the artist's 7 events plus the save: {record['history']}")
    used = call("GET", f"/api/assets/{rocket['id']}/where-used?project={project}")
    if "SQ090_0010" not in {e["code"] for e in used["linked"]}:
        raise RuntimeError("A rocket placed in every frame should be a linked use.")
    print(f"Animation: SQ090_0010 saved with 6 frames at 8 fps; links and an {len(record['history'])}-event trail kept.", flush=True)

    from backend.demo import pine as pine_strokes, place, rocket as rocket_strokes
    with_pine = call("GET", f"/api/frames?project={project}&asset_id={pine['id']}")["items"]
    if sorted(f["frame"] for f in with_pine if f["code"] == "SQ090_0010") != [1, 2, 3, 4, 5, 6]:
        raise RuntimeError(f"Every liftoff frame places the pine: {with_pine}")
    doodle = {"scope": "frame", "layers": [{"strokes": place(pine_strokes(), 0.08, 0.38, 0.16, 0.5)
                                                       + place(rocket_strokes(), 0.45, 0.05, 0.12, 0.4)}]}
    for _ in range(30):
        found = [(f["code"], f["frame"]) for f in call("POST", "/api/search/sketch", doodle)["items"]]
        if any(code == "SQ090_0010" for code, _ in found):
            break
        time.sleep(2)
    else:
        raise RuntimeError(f"A sketch of the liftoff should find its frames: {found}")
    print(f"Find: frames filtered by asset (6/6), and a sketch found {[f for f in found if f[0] == 'SQ090_0010'][:3]}.", flush=True)

    plan = call("POST", f"/api/assets/{rocket['id']}/variations/plan", {"goal": "a fleet: different markings", "count": 2})["items"]
    variation = call("POST", f"/api/assets/{rocket['id']}/variations", {"brief": plan[0]["brief"]})
    if not variation["kept"] or not any(s.get("ai") for s in variation["strokes"]):
        raise RuntimeError(f"A variation should keep the artist's strokes and mark its own: kept {variation['kept']}.")
    kept = call("POST", "/api/assets", {
        "name": plan[0]["name"], "type": "prop", "tags": ["rocket"], "layers": [{"name": "Rocket", "strokes": variation["strokes"]}],
        "origin": {"asset_id": rocket["id"], "version": rocket["version"], "brief": plan[0]["brief"],
                   "kept": variation["kept"], "added": variation["added"]}})
    made["variant"] = kept
    family = call("GET", f"/api/assets/{rocket['id']}/where-used")["family"]
    child = call("GET", f"/api/assets/{kept['id']}")
    if kept["id"] not in {v["id"] for v in family["variants"]} or child["origin"]["name"] != rocket["name"]:
        raise RuntimeError("The kept variation should be in the original's family, and know its parent.")
    if child["history"][0]["by"] != "ai" or "kept" not in child["history"][0]["detail"]:
        raise RuntimeError(f"The variation's history should open with the AI step: {child['history']}")
    versions = call("GET", f"/api/assets/{rocket['id']}/versions")["items"]
    if [v["version"] for v in versions] != [1, 2] or versions[0]["stats"]["ink_px"] == versions[1]["stats"]["ink_px"]:
        raise RuntimeError(f"Both rocket versions should be snapshotted with art math: {versions}")
    if child["stats"]["ai"] != variation["added"] or child["stats"]["hand_share"] >= 1:
        raise RuntimeError(f"The kept variation's art math should count the AI strokes: {child['stats']}")
    hand_only = {a["id"] for a in call("GET", "/api/assets?hand_min=0.99")["items"]}
    if kept["id"] in hand_only or rocket["id"] not in hand_only:
        raise RuntimeError("'Mostly by hand' should keep the hand-drawn rocket and drop the AI-assisted variation.")
    print(f"Process: rocket v1 -> v2 snapshotted (ink {versions[0]['stats']['ink_px']} -> {versions[1]['stats']['ink_px']} px); the variation is {round(child['stats']['hand_share'] * 100)}% hand and "
          f"filtered out of 'mostly by hand'.", flush=True)
    print(f"Variations: planned {[item['name'] for item in plan]}; drew one keeping {variation['kept']} of "
          f"{variation['source_strokes']} artist strokes, adding {variation['added']}; kept it with its lineage.", flush=True)


def check_similar_assets(made: dict) -> None:
    """A slightly redrawn rocket is flagged as "you already have this" before save; the pine never is."""
    from backend.demo import call, rocket

    rocket_id, pine_id = made["rocket"]["id"], made["pine"]["id"]
    redrawn = {"layers": [{"name": "Rocket", "strokes": rocket(skinny=1.1)}]}
    for _ in range(30):
        found = {item["id"]: item["score"] for item in call("POST", "/api/assets/similar", redrawn)["items"]}
        if rocket_id in found:
            break
        time.sleep(2)
    else:
        raise RuntimeError(f"Duplicate check missed the existing rocket: {found}")
    if pine_id in found:
        raise RuntimeError(f"Duplicate check flagged the pine as a rocket: {found}")
    twins = call("GET", f"/api/assets/{pine_id}/where-used")["similar_assets"]
    if rocket_id in {item["id"] for item in twins} or pine_id in {item["id"] for item in twins}:
        raise RuntimeError(f"Similar assets for the pine should exclude itself and the rocket: {twins}")
    print(f"Duplicate check: redrawn rocket matches the saved one ({found[rocket_id]:.3f}); the pine stays separate.", flush=True)


def check_accounts() -> str:
    """No anonymous access; a real m-stash member gets their own library; nobody else can open it."""
    from backend.demo import HEADERS, act_as, call, sign_in
    try:
        request("/api/assets")
        raise RuntimeError("The API answered without a session.")
    except urllib.error.HTTPError as exc:
        if exc.code != 401:
            raise
    email = sign_in()
    me = request("/api/session")
    if me["user"]["email"] != email:
        raise RuntimeError("The session belongs to someone else.")
    probe = call("POST", "/api/assets", {"name": "Private Doodle", "type": "prop", "tags": ["smoke test"],
                                         "layers": [{"name": "Ink", "strokes": [stroke("#0f766e", [(0.3, 0.3), (0.7, 0.7)])]}]})
    member = dict(HEADERS)
    act_as("isolation-probe")
    try:
        call("GET", f"/api/assets/{probe['id']}")
        raise RuntimeError("Another library could open this member's asset.")
    except RuntimeError as exc:
        if "failed with 404" not in str(exc):
            raise
    finally:
        HEADERS.clear()
        HEADERS.update(member)
    call("DELETE", f"/api/assets/{probe['id']}")
    print(f"Accounts: no session = 401; signed in as {email} via m-stash; another library gets 404 for this member's asset.", flush=True)
    return email


def main() -> None:
    request("/api/ready")
    check_accounts()
    drawings = [
        {
            "title": "Crimson rocket heading to the moon",
            "description": "A red spaceship with orange flames launching into outer space.",
            "strokes": [
                stroke("#dc2626", [(0.4, 0.7), (0.4, 0.35), (0.5, 0.1), (0.6, 0.35), (0.6, 0.7), (0.4, 0.7)]),
                stroke("#f97316", [(0.43, 0.73), (0.5, 0.95), (0.57, 0.73)]),
            ],
        },
        {
            "title": "Green tree in a quiet forest",
            "description": "A leafy evergreen pine tree with a brown trunk.",
            "strokes": [
                stroke("#16a34a", [(0.5, 0.1), (0.25, 0.7), (0.75, 0.7), (0.5, 0.1)]),
                stroke("#854d0e", [(0.5, 0.7), (0.5, 0.92)]),
            ],
        },
        {
            "title": "Blue sailboat on the ocean",
            "description": "A sailing boat with a triangular blue sail floating on the sea.",
            "strokes": [
                stroke("#2563eb", [(0.5, 0.15), (0.5, 0.65), (0.75, 0.65), (0.5, 0.15)]),
                stroke("#0891b2", [(0.2, 0.7), (0.35, 0.85), (0.65, 0.85), (0.8, 0.7), (0.2, 0.7)]),
            ],
        },
    ]
    saved = []
    for drawing in drawings:
        item = request("/api/drawings", drawing)
        restored = request(f"/api/drawings/{item['id']}")
        (layer,) = restored["layers"]  # a legacy flat stroke list becomes one layer
        if plain(layer["strokes"]) != drawing["strokes"]:
            raise RuntimeError("Saved strokes did not round-trip.")
        from backend.demo import HEADERS
        with urllib.request.urlopen(urllib.request.Request(f"{BASE}{item['image_url']}", headers=HEADERS), timeout=15) as response:
            if response.headers.get_content_type() != "image/png" or not response.read().startswith(b"\x89PNG\r\n\x1a\n"):
                raise RuntimeError("Saved preview is not a PNG.")
        saved.append(item)
        print(f"Saved and restored: {item['title']}", flush=True)

    deadline = time.monotonic() + 90
    while True:
        hits = request("/api/search?q=red%20spaceship%20launching%20into%20space")["items"]
        # An earlier smoke run may have created an equally relevant rocket copy.
        if hits and hits[0]["title"] == drawings[0]["title"] and any(hit["id"] == saved[0]["id"] for hit in hits):
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Rocket did not rank first within 90 seconds of indexing.")
        print("Waiting for vector indexing...", flush=True)
        time.sleep(5)

    if not all(item["tags"] for item in saved):
        raise RuntimeError("Drawings were not auto-tagged.")
    print("Auto-tags:", "; ".join(", ".join(item["tags"]) for item in saved), flush=True)
    rocket_tag = saved[0]["tags"][0]
    tagged = request(f"/api/drawings?tag={urllib.parse.quote(rocket_tag)}")["items"]
    if saved[0]["id"] not in {item["id"] for item in tagged}:
        raise RuntimeError("Tag filter did not return the tagged drawing.")
    hits = request(f"/api/search?q=spaceship&tag={urllib.parse.quote(rocket_tag)}")["items"]
    if any(rocket_tag not in hit["tags"] for hit in hits):
        raise RuntimeError("Tag-filtered vector search returned an untagged drawing.")

    spark = {"region": {"x": 0.3, "y": 0.0, "w": 0.4, "h": 0.5}, "title": drawings[0]["title"],
             "prompt": "add a small round window", "strokes": drawings[0]["strokes"]}
    strokes = request("/api/sparks/strokes", spark)
    if not strokes["strokes"]:
        raise RuntimeError("Stroke spark returned nothing.")
    guide = request("/api/sparks/guide", spark)
    if not guide["image"].startswith("data:image/png;base64,"):
        raise RuntimeError("Guide spark did not return a PNG.")
    sketch = request("/api/sparks/sketch", {"prompt": "a small house with a chimney", "title": "", "layers": []})
    if not sketch["strokes"] or any(item["color"] != "#4f8fe6" for item in sketch["strokes"]):
        raise RuntimeError("AI sketch should return blue-pencil strokes.")
    print(f"Sparks: {len(strokes['strokes'])} ghost stroke(s) ({strokes['note']}), a trace guide, "
          f"and a {len(sketch['strokes'])}-stroke AI sketch layer.")
    check_layers()
    check_production()
    print("PASS: m-stash accounts and private libraries, Voyage embeddings, Atlas persistence, layers, auto-tags, tag-filtered search, Gemini sparks, "
          "AI sketch layers, assets/scenes/where-used/similar assets, frames and frame search, variations, and the audit trail.")


if __name__ == "__main__":
    main()
