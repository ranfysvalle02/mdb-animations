"""Demo production data: a small show with assets, shots, linked placements, and unlinked look-alikes.

``python -m backend.seed_demo`` creates it through the running API (billable Voyage and Gemini calls).
``backend.smoke_test`` reuses the same builders under a throwaway project name.
"""

import json
import os
from datetime import datetime, timezone
import math
import time
import urllib.error
import urllib.request

BASE = f"http://127.0.0.1:{os.environ.get('PORT', '8000')}"
W, H = 1000, 650
HEADERS: dict[str, str] = {}  # who these scripts act as (see act_as / sign_in)


def act_as(owner: str) -> None:
    """Act as a named library from inside the container (loopback + the server-derived service key)."""
    from backend.auth import service_key
    HEADERS.clear()
    HEADERS.update({"X-Inkling-Service": service_key(), "X-Inkling-Owner": owner})


def sign_in(name: str = "inkling-smoke") -> str:
    """A real m-stash member, exactly like the browser: log in, or sign up the first time.

    The password is derived from a server-side secret, so the account is stable and nothing is committed.
    """
    import hashlib
    api, key = os.environ.get("MSTASH_API", "https://m-stash.onrender.com"), os.environ["MSTASH_APP_KEY"]
    email = f"{name}@example.com"
    password = hashlib.sha256(f"{name}:{os.environ['VOYAGE_API_KEY']}".encode()).hexdigest()[:32]

    def post(path: str, body: dict) -> tuple[int, dict]:
        req = urllib.request.Request(api + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"X-M-Stash-App": key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, {}

    status, body = post("/v1/auth/login", {"email": email, "password": password})
    if status == 401:
        status, body = post("/v1/auth/signup", {"email": email, "password": password, "username": name})
    if status not in (200, 201) or not body.get("token"):
        raise RuntimeError(f"m-stash sign-in for {email} failed with {status}.")
    HEADERS.clear()
    HEADERS["Authorization"] = f"Bearer {body['token']}"
    return email


def call(method: str, path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {**HEADERS, **({"Content-Type": "application/json"} if data is not None else {})}
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return json.load(response) if response.status != 204 else {}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{method} {path} failed with {exc.code}: {exc.read()[:300]!r}") from None


def stroke(color: str, points: list[tuple[float, float]], width: float = 6, fill: str | None = None) -> dict:
    return {"color": color, "width": width, "erase": False, "fill": fill,
            "points": [{"x": x, "y": y, "pressure": 0.75} for x, y in points]}


def circle(cx: float, cy: float, r: float, n: int = 36) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * W / H * math.sin(2 * math.pi * i / n))
            for i in range(n + 1)]


def rocket(color: str = "#dc2626", flame: str = "#f97316", window: str = "#38bdf8", skinny: float = 1.0) -> list[dict]:
    w = 0.08 * skinny
    return [
        stroke(color, [(0.5 - w, 0.75), (0.5 - w, 0.35), (0.5, 0.12), (0.5 + w, 0.35), (0.5 + w, 0.75), (0.5 - w, 0.75)], 6, color),
        stroke(color, [(0.5 - w, 0.62), (0.5 - w - 0.06, 0.8), (0.5 - w, 0.75)], 6, color),
        stroke(color, [(0.5 + w, 0.62), (0.5 + w + 0.06, 0.8), (0.5 + w, 0.75)], 6, color),
        stroke("#1e293b", circle(0.5, 0.42, 0.035), 4, window),
        stroke(flame, [(0.47, 0.77), (0.5, 0.93), (0.53, 0.77)], 8),
    ]


def pine(color: str = "#166534") -> list[dict]:
    return [
        stroke("#78350f", [(0.5, 0.92), (0.5, 0.7)], 16),
        stroke(color, [(0.5, 0.1), (0.3, 0.42), (0.7, 0.42), (0.5, 0.1)], 5, "#22c55e"),
        stroke(color, [(0.5, 0.3), (0.25, 0.72), (0.75, 0.72), (0.5, 0.3)], 5, "#16a34a"),
    ]


def hills() -> list[dict]:
    return [stroke("#15803d", [(0, 0.85), (0.2, 0.7), (0.45, 0.82), (0.7, 0.68), (1, 0.8), (1, 1), (0, 1), (0, 0.85)], 4, "#86efac"),
            stroke("#eab308", circle(0.85, 0.15, 0.06), 4, "#fde047")]


def city() -> list[dict]:
    outline = [(0, 1), (0, 0.6), (0.1, 0.6), (0.1, 0.45), (0.2, 0.45), (0.2, 0.7), (0.32, 0.7), (0.32, 0.5), (0.42, 0.5),
               (0.42, 0.8), (0.55, 0.8), (0.55, 0.55), (0.7, 0.55), (0.7, 0.75), (1, 0.75), (1, 1), (0, 1)]
    return [stroke("#334155", outline, 4, "#94a3b8")]


def house() -> list[dict]:
    return [stroke("#7f1d1d", [(0.55, 0.9), (0.55, 0.6), (0.7, 0.45), (0.85, 0.6), (0.85, 0.9), (0.55, 0.9)], 5, "#fca5a5")]


def place(strokes: list[dict], x: float, y: float, w: float, h: float) -> list[dict]:
    """Fit strokes into a normalized box, like the studio's Place tool."""
    xs = [p["x"] for s in strokes for p in s["points"]]
    ys = [p["y"] for s in strokes for p in s["points"]]
    x0, y0 = min(xs), min(ys)
    sw, sh = (max(xs) - x0) * W, (max(ys) - y0) * H
    k = min(w * W / sw, h * H / sh)
    ox, oy = x * W + (w * W - sw * k) / 2, y * H + (h * H - sh * k) / 2
    return [{**s, "width": max(1, min(40, s["width"] * k)), "points": [
        {"x": (ox + (p["x"] - x0) * W * k) / W, "y": (oy + (p["y"] - y0) * H * k) / H, "pressure": p["pressure"]}
        for p in s["points"]]} for s in strokes]


def link(asset: dict) -> dict:
    return {"asset_id": asset["id"], "version": asset["version"]}


def build(project: str, tags: list[str]) -> dict:
    """Creates two assets and five shots in ``project``. Returns everything by name."""
    rocket_asset = call("POST", "/api/assets", {
        "name": "Red Rocket", "type": "prop", "tags": ["rocket", "prop", *tags],
        "description": "The hero's rocket: red body, round blue window, orange flame.",
        "layers": [{"name": "Rocket", "strokes": rocket()}]})
    pine_asset = call("POST", "/api/assets", {
        "name": "Pine Tree", "type": "environment", "tags": ["tree", "environment", *tags],
        "description": "Two-tier pine used across the forest sequences.",
        "layers": [{"name": "Pine", "strokes": pine()}]})
    shot_specs = {
        "launch": {"code": "SQ010_0010", "sequence": "SQ010", "status": "in_progress", "assignee": "maya",
                   "description": "Wide: the rocket waits on the hill at dawn.",
                   "layers": [{"name": "BG hills", "strokes": hills()},
                              {"name": "Red Rocket", "asset": link(rocket_asset), "strokes": place(rocket(), 0.12, 0.08, 0.2, 0.45)},
                              {"name": "Pine Tree", "asset": link(pine_asset), "strokes": place(pine(), 0.6, 0.35, 0.15, 0.4)}]},
        "city_flyby": {"code": "SQ010_0020", "sequence": "SQ010", "status": "todo", "assignee": "sam",
                       "description": "Animator's quick sketch of the rocket over the city (not linked).",
                       "layers": [{"name": "BG city", "strokes": city()},
                                  {"name": "rocket sketch", "strokes": place(rocket("#2563eb", "#facc15", "#ffffff", 0.8), 0.6, 0.05, 0.25, 0.5)}]},
        "forest": {"code": "SQ020_0010", "sequence": "SQ020", "status": "review", "assignee": "maya",
                   "description": "The house at the edge of the forest. No rocket here.",
                   "layers": [{"name": "BG hills", "strokes": hills()},
                              {"name": "Pine Tree", "asset": link(pine_asset), "strokes": place(pine(), 0.1, 0.3, 0.25, 0.6)},
                              {"name": "House", "strokes": house()}]},
        "night_city": {"code": "SQ020_0020", "sequence": "SQ020", "status": "approved", "assignee": "lee",
                       "description": "Approved: the rocket painted straight into the city plate.",
                       "layers": [{"name": "everything", "strokes": city() + place(rocket(), 0.75, 0.1, 0.12, 0.25)}]},
        "landing": {"code": "SQ030_0010", "sequence": "SQ030", "status": "todo", "assignee": "",
                    "description": "The rocket lands; placed before the redesign.",
                    "layers": [{"name": "BG hills", "strokes": hills()},
                               {"name": "Red Rocket", "asset": link(rocket_asset), "strokes": place(rocket(), 0.4, 0.2, 0.2, 0.55)}]},
    }
    shots = {name: call("POST", "/api/shots", {**spec, "project": project, "tags": ["demo shot", *tags]})
             for name, spec in shot_specs.items()}
    return {"rocket": rocket_asset, "pine": pine_asset, "shots": shots}


def redesign_rocket(asset: dict) -> dict:
    """Version 2 of the rocket: a taller nose. Shots that placed v1 become outdated."""
    strokes = rocket(skinny=0.9)
    strokes[0]["points"][2]["y"] = 0.06
    return call("PUT", f"/api/assets/{asset['id']}", {
        "name": asset["name"], "type": asset["type"], "tags": asset["tags"],
        "description": "The hero's rocket, v2: taller nose cone after the design review.",
        "layers": [{"name": "Rocket", "strokes": strokes}]})


def wait_for_similar(asset_id: str, project: str, shot_id: str, timeout: float = 90) -> dict:
    """Vector indexing is eventually consistent; poll until a known look-alike is searchable."""
    deadline = time.monotonic() + timeout
    while True:
        result = call("GET", f"/api/assets/{asset_id}/where-used?project={project}")
        if any(entry["shot_id"] == shot_id for entry in result["similar"]):
            return result
        if time.monotonic() > deadline:
            raise RuntimeError("The redrawn rocket never appeared in 'where used'.")
        time.sleep(3)


def remove(made: dict) -> None:
    """Deletes what ``build`` created (shots first, so the assets are no longer in use)."""
    for shot in made["shots"].values():
        call("DELETE", f"/api/shots/{shot['id']}")
    for name in ("rocket", "pine"):
        call("DELETE", f"/api/assets/{made[name]['id']}")


def liftoff(project: str, rocket_asset: dict, pine_asset: dict, code: str = "SQ040_0020", frames: int = 6) -> dict:
    """A short flipbook: the same linked rocket rises frame by frame past a linked pine (cut-out animation)."""
    def frame(i: int) -> list[dict]:
        return [{"name": "BG hills", "strokes": hills()},
                {"name": "Pine Tree", "asset": link(pine_asset), "strokes": place(pine(), 0.08, 0.38, 0.16, 0.5)},
                {"name": "Red Rocket", "asset": link(rocket_asset),
                 "strokes": place(rocket(), 0.45, 0.42 - 0.075 * i, 0.12, 0.45)}]
    stamp = datetime.now(timezone.utc).isoformat()
    history = [{"at": stamp, "by": "artist", "action": "Placed", "detail": f"{pine_asset['name']} v{pine_asset['version']}"},
               {"at": stamp, "by": "artist", "action": "Placed", "detail": f"{rocket_asset['name']} v{rocket_asset['version']}"},
               *({"at": stamp, "by": "artist", "action": "Added frame", "detail": f"frame {i + 1}, rocket moved up"}
                 for i in range(1, frames))]
    return call("POST", "/api/shots", {
        "code": code, "project": project, "sequence": "SQ040", "status": "in_progress", "assignee": "lee",
        "description": "Animatic: the rocket lifts off past the pine, 6 frames at 8 fps.", "tags": ["animatic", "liftoff"],
        "layers": frame(0), "frames": [{"layers": frame(i)} for i in range(1, frames)], "fps": 8, "history": history})


def fox_versions() -> list[list[dict]]:
    """A doodle with low potential grows up: rough pencil (v1), clean line (v2), color and finishing (v3).

    Every stroke carries its place in the drawing order (seq) and how long it took (ms), so the studio can
    replay the process; two whiskers in v3 are accepted AI strokes, marked as such.
    """
    seq = iter(range(1, 1000))

    def mark(item: dict, ms: int, **extra) -> dict:
        return {**item, "seq": next(seq), "ms": ms, **extra}

    def oval(cx: float, cy: float, rx: float, ry: float, wobble: float = 0.0) -> list[tuple[float, float]]:
        return [(cx + rx * (1 + wobble * math.sin(5 * t)) * math.cos(t), cy + ry * W / H * (1 + wobble * math.cos(3 * t)) * math.sin(t))
                for t in (2 * math.pi * i / 40 for i in range(41))]

    ears = ([(0.43, 0.27), (0.42, 0.1), (0.48, 0.22), (0.43, 0.27)], [(0.57, 0.27), (0.58, 0.1), (0.52, 0.22), (0.57, 0.27)])
    tail = [(0.58, 0.8), (0.7, 0.78), (0.78, 0.62), (0.74, 0.45), (0.7, 0.58), (0.64, 0.7), (0.58, 0.8)]
    pencil = "#64748b"
    rough = [mark(stroke(pencil, oval(0.5, 0.33, 0.095, 0.08, 0.08), 3), 2100), mark(stroke(pencil, ears[0], 3), 900),
             mark(stroke(pencil, ears[1], 3), 800), mark(stroke(pencil, oval(0.5, 0.62, 0.12, 0.14, 0.06), 3), 2600)]
    v1 = [{"name": "Rough", "strokes": rough}]

    line = "#9a3412"
    clean = [mark(stroke(line, oval(0.5, 0.62, 0.11, 0.14), 5), 2400), mark(stroke(line, tail, 5), 1900),
             mark(stroke(line, oval(0.5, 0.33, 0.09, 0.075), 5), 2200), mark(stroke(line, ears[0], 5), 1100),
             mark(stroke(line, ears[1], 5), 1000), mark(stroke("#1c1917", [(0.465, 0.32)], 9), 150),
             mark(stroke("#1c1917", [(0.535, 0.32)], 9), 140), mark(stroke("#1c1917", [(0.5, 0.37)], 8), 120),
             mark(stroke(line, [(0.48, 0.39), (0.5, 0.4), (0.52, 0.39)], 3), 400)]
    v2 = [{"name": "Rough", "visible": False, "opacity": 0.4, "strokes": rough}, {"name": "Line", "strokes": clean}]

    orange, cream = "#fb923c", "#fff7ed"
    color = [mark(stroke(line, oval(0.5, 0.62, 0.11, 0.14), 2, orange), 1500), mark(stroke(line, tail, 2, orange), 1300),
             mark(stroke(line, [(0.7, 0.58), (0.74, 0.45), (0.78, 0.62), (0.72, 0.6), (0.7, 0.58)], 2, cream), 700),
             mark(stroke(cream, oval(0.5, 0.66, 0.06, 0.085), 2, cream), 900),
             mark(stroke(line, oval(0.5, 0.33, 0.09, 0.075), 2, orange), 1400),
             mark(stroke(line, ears[0], 2, orange), 600), mark(stroke(line, ears[1], 2, orange), 550),
             mark(stroke(cream, oval(0.5, 0.355, 0.045, 0.03), 2, cream), 500)]
    whiskers = [mark(stroke("#44403c", [(0.475, 0.37), (0.41, 0.355)], 2), 0, ai=True),
                mark(stroke("#44403c", [(0.525, 0.37), (0.59, 0.355)], 2), 0, ai=True)]
    v3 = [{"name": "Rough", "visible": False, "opacity": 0.4, "strokes": rough}, {"name": "Color", "strokes": color},
          {"name": "Line", "strokes": clean + whiskers}]
    return [v1, v2, v3]


def seed_fox(name: str = "Little Fox") -> dict:
    """Saves the fox three times, so its Evolution, replay, and art math have a story to tell."""
    stamp = datetime.now(timezone.utc).isoformat()
    v1, v2, v3 = fox_versions()
    base = {"name": name, "type": "character", "tags": ["fox", "character", "animal"],
            "description": "Started as a four-stroke doodle; cleaned up, then colored."}
    asset = call("POST", "/api/assets", {**base, "layers": v1, "history": [
        {"at": stamp, "by": "artist", "action": "Drew", "detail": "4 strokes and shapes by hand"}]})
    call("PUT", f"/api/assets/{asset['id']}", {**base, "layers": v2, "history": [
        {"at": stamp, "by": "artist", "action": "Drew", "detail": "9 strokes and shapes by hand (clean line over the rough)"}]})
    return call("PUT", f"/api/assets/{asset['id']}", {**base, "layers": v3, "history": [
        {"at": stamp, "by": "artist", "action": "Drew", "detail": "8 color fills by hand"},
        {"at": stamp, "by": "ai", "action": "Fix a spot", "detail": '"add whiskers": 2 strokes on "Line"'}]})
