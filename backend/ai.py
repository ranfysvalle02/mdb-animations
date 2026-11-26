"""Gemini-powered sparks (minimal, opt-in drawing assists) and auto-tagging."""

import base64
import io
import json
import math
import os
import re
from collections import Counter
from typing import get_args

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from PIL import Image as PILImage, ImageDraw
from pydantic import BaseModel

from backend.library import CANVAS_HEIGHT, CANVAS_WIDTH, png_bytes, render_image
from backend.models import (
    MAX_MOTION_KEYS, MAX_POINTS, MAX_SKETCH_CODE, MAX_STROKES, CodeRequest, DirectRequest, Layer, MotionRequest, PictureRequest,
    RefineIdeasRequest, RefineRequest, Region, Rig, RigPart, SketchRequest, SparkRequest, Stroke, TagRequest, VariationPlanRequest,
    VariationRequest, clean_tags,
)

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_SPARK_STROKES = 8
MAX_SKETCH_STROKES = 40
# Animators rough out in light blue pencil, then ink over it: the AI draft reads as scaffolding, not art.
BLUE_PENCIL = "#4f8fe6"
MAX_MODEL_POINTS = 80
STEP_PX = 3.0
MAX_STROKE_POINTS = 600
GUIDE_SIZE = 1024
VARIATION_SOURCE_POINTS = 1600  # what the model reads: the artist's strokes, simplified just enough to fit
MAX_VARIATION_STROKES = 80
MAX_VARIATION_POINTS = 160


class AIError(Exception):
    """Gemini answered, but without a usable suggestion."""


class AIUnavailable(AIError):
    """Gemini could not be reached (timeout, DNS, dropped connection)."""


class _Point(BaseModel):
    x: float
    y: float


class _Stroke(BaseModel):
    color: str
    width: float
    points: list[_Point]


class _Key(BaseModel):
    t: float
    x: float
    y: float
    sx: float
    sy: float
    r: float
    label: str = ""


class _Track(BaseModel):
    subject: int
    keys: list[_Key]


class _Motion(BaseModel):
    note: str
    tracks: list[_Track]


class _Idea(BaseModel):
    title: str
    logline: str
    prompt: str
    movers: list[int]


class _Ideas(BaseModel):
    ideas: list[_Idea]


IDENTITY_KEY = {"t": 0.0, "x": 0.0, "y": 0.0, "sx": 1.0, "sy": 1.0, "r": 0.0, "label": "start"}


def clean_track(keys: list[_Key]) -> list[dict]:
    """Keyframes the studio can trust: sorted, de-duplicated, bounded, starting from the pose as drawn."""
    clamp = lambda v, lo, hi: max(lo, min(hi, float(v))) if math.isfinite(v) else lo  # noqa: E731
    by_t: dict[float, dict] = {}
    for key in keys:
        t = round(clamp(key.t, 0, 1), 4)
        by_t[t] = {"t": t, "x": round(clamp(key.x, -1.5, 1.5), 4), "y": round(clamp(key.y, -1.5, 1.5), 4),
                   "sx": round(clamp(key.sx, 0.05, 4), 3), "sy": round(clamp(key.sy, 0.05, 4), 3),
                   "r": round(clamp(key.r, -1080, 1080), 1), "label": " ".join(key.label.lower().split())[:24]}
    track = [by_t[t] for t in sorted(by_t)][:MAX_MOTION_KEYS]
    if not track or track[0]["t"] > 0:
        track.insert(0, dict(IDENTITY_KEY))
    track[0] = dict(IDENTITY_KEY)  # the clip starts exactly where the artist put things
    if track[-1]["t"] < 1:
        track.append({**track[-1], "t": 1.0, "label": "hold"})
    return track


# Bounds are enforced after generation: nested schema limits exceed Gemini's constraint budget.
class _StrokeSpark(BaseModel):
    note: str
    strokes: list[_Stroke]


class _Tags(BaseModel):
    tags: list[str]


# Words about the medium, not the subject: "Fox Sketch" is a fox.
MEDIUM_WORDS = {"sketch", "sketches", "drawing", "doodle", "doodles", "illustration", "lineart", "scribble"}


class _Bone(BaseModel):
    part: str
    strokes: list[int]
    joint_x: float
    joint_y: float


class _Rig(BaseModel):
    kind: str
    bones: list[_Bone]


RIG_TABLE_STROKES = 300  # the model reads at most this many strokes; the rest stay with the body


class _Described(BaseModel):
    name: str
    description: str
    tags: list[str]


class _Suggestions(BaseModel):
    ideas: list[str]


class _PlanItem(BaseModel):
    name: str
    brief: str


class _Plan(BaseModel):
    items: list[_PlanItem]


class _VarStroke(BaseModel):
    color: str
    width: float
    fill: str
    points: list[_Point]


class _Variation(BaseModel):
    note: str
    keep: list[int]
    strokes: list[_VarStroke]


class _Edit(BaseModel):
    op: str
    strokes: list[int]
    scale: float
    rotate: float
    dx: float
    dy: float


class _RefinePlan(BaseModel):
    note: str
    edits: list[_Edit]
    add: list[_VarStroke]


# Refine is a plan of edits the studio's code applies exactly (studio.js applyEdits): the model decides *what*
# each stroke should become, never draws coordinates for a stroke the artist already drew.
REFINE_OPS = ("smooth", "line", "curve", "circle", "ellipse", "close", "delete", "transform")
MAX_REFINE_EDITS = 40
MAX_REFINE_ADDS = 12


class _CodeSketch(BaseModel):
    code: str
    note: str


# The contract a Lab sketch is written against (the runner in lab/inkling-lab.js implements it).
LAB_API = """\
Write a p5.js 1.11 sketch in GLOBAL mode (define function setup() and function draw()). It runs in a sandbox
with no network and no DOM beyond its canvas. Use these globals, provided by Inkling:
- W = 1000, H = 650: the paper size. Call createCanvas(W, H). Inkling assets are 2D: never use WEBGL or 3D.
- strokes: the artist's drawing (frame 1), in drawing order. Each stroke is
  { points: [{x, y, pressure}], color: '#rrggbb', width, layer: 'name', order: 0..n-1 }, x in 0..W, y in 0..H.
- frames: every flipbook frame, each an array of strokes in the same shape (frames[0] is strokes).
- layers: [{ name, visible, strokes }] for frame 1 (hidden layers included, flagged).
- LOOP: how many frames will be baked (24 to 80). loopT() returns 0..1, the progress through that loop.
  Make the motion a seamless loop over LOOP frames, driven by loopT() (not millis()).
- ink(points, style): draws a stroke AND records it, so it can be baked into editable frames. points is an
  array of {x, y, z?} (or [x, y, z?]); style is { color, width, fill, layer } (color as '#rrggbb' or [r, g, b];
  layer names which of the artist's layers it bakes into, so the scene keeps its layers).
  Everything you want baked must be drawn with ink(); other p5 drawing is preview-only.
- inkStroke(stroke, map?): ink one of the artist's strokes, optionally mapping each point with
  map(p, i, stroke) => {x, y, z}. Keeps the stroke's color, width, and layer.
- KEEP_DRAWING (optional): set to true if the artist's original drawing should stay visible under the baked
  code layer; leave it out if your sketch redraws their strokes itself.
Rules: only move, transform, repeat, or recombine the artist's own strokes; never invent new figures or text.
Call background() every frame. Use random() and noise() (they are seeded, so baking is repeatable). Keep it
under ~900 ink() calls and ~15,000 points per frame. Always use braces on loops. Keep the code short,
readable, and commented for an artist learning to code.
"""


def clean_sketch(code: str) -> str:
    """Model output as runnable source: no Markdown fences, bounded, and actually a sketch."""
    code = re.sub(r"^\s*```[a-zA-Z]*\s*\n|\n?```\s*$", "", code.strip()).strip()
    if len(code) > MAX_SKETCH_CODE:
        raise AIError("Gemini wrote more code than a sketch should have. Try a simpler idea.")
    if not re.search(r"function\s+draw\s*\(", code) or not re.search(r"function\s+setup\s*\(", code):
        raise AIError("Gemini didn't write a complete sketch (setup and draw). Try again.")
    return code


def simplify(points: list[tuple[float, float]], epsilon: float) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker: drop points that sit within ``epsilon`` px of the line through their neighbors."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        (ax, ay), (bx, by) = points[start], points[end]
        length = math.hypot(bx - ax, by - ay)
        best, index = 0.0, None
        for i in range(start + 1, end):
            px, py = points[i]
            distance = (abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length if length
                        else math.hypot(px - ax, py - ay))
            if distance > best:
                best, index = distance, i
        if index is not None and best > epsilon:
            keep[index] = True
            stack += [(start, index), (index, end)]
    return [point for point, kept in zip(points, keep) if kept]


def source_strokes(layers: list[Layer]) -> list[Stroke]:
    """An asset's visible strokes, bottom layer first: what a variation starts from (like placing it)."""
    return [stroke for layer in layers if layer.visible for stroke in layer.strokes]


def encode_strokes(strokes: list[Stroke]) -> str:
    """The artist's ink as numbered polylines in canvas pixels, compact enough for the model to read whole."""
    epsilon = 1.0
    while True:
        lines, total = [], 0
        for index, stroke in enumerate(strokes):
            if stroke.erase:
                continue
            pixels = [(p.x * CANVAS_WIDTH, p.y * CANVAS_HEIGHT) for p in stroke.points]
            pixels = simplify(pixels, epsilon)
            total += len(pixels)
            pressure = sum(p.pressure for p in stroke.points) / len(stroke.points)
            width = round(stroke.width * (0.25 + pressure), 1)  # the width as rendered
            fill = f" fill {stroke.fill}" if stroke.fill else ""
            coords = " ".join(f"{round(x)},{round(y)}" for x, y in pixels)
            lines.append(f"S{index} color {stroke.color.lower()} width {width}{fill} points {coords}")
        if total <= VARIATION_SOURCE_POINTS or epsilon > 12:
            return "\n".join(lines)
        epsilon *= 1.6


def apply_variation(strokes: list[Stroke], result: "_Variation") -> tuple[list[dict], int, int]:
    """Kept source strokes stay byte-for-byte the artist's (in their original order, erasers always kept);
    the model's new strokes follow, marked as AI. Returns (strokes, kept, added)."""
    keep = {i for i in result.keep if 0 <= i < len(strokes)}
    out = [stroke.model_dump() for i, stroke in enumerate(strokes) if stroke.erase or i in keep]
    kept = sum(1 for i in keep if not strokes[i].erase)
    budget_strokes = MAX_STROKES - len(out)
    seq = max((stroke.seq or 0 for stroke in strokes), default=0)  # AI additions replay after the artist's strokes
    budget_points = MAX_POINTS - sum(len(stroke["points"]) for stroke in out)
    added = 0
    for item in result.strokes[:min(MAX_VARIATION_STROKES, budget_strokes)]:
        points = [{"x": min(1.0, max(0.0, p.x / CANVAS_WIDTH)), "y": min(1.0, max(0.0, p.y / CANVAS_HEIGHT)),
                   "pressure": 0.75}
                  for p in item.points[:MAX_VARIATION_POINTS] if math.isfinite(p.x) and math.isfinite(p.y)]
        if not points or len(points) > budget_points:
            continue
        width = item.width if math.isfinite(item.width) else 4
        out.append(Stroke(
            color=(item.color if HEX.match(item.color or "") else "#1f2937").lower(),
            width=min(40, max(1, width)), points=points,
            fill=item.fill.lower() if HEX.match(item.fill or "") else None, ai=True, seq=seq + added + 1,
        ).model_dump())
        budget_points -= len(points)
        added += 1
    return out, kept, added


def crop_box(region: Region) -> tuple[int, int, int, int]:
    left = min(CANVAS_WIDTH - 1, round(region.x * CANVAS_WIDTH))
    top = min(CANVAS_HEIGHT - 1, round(region.y * CANVAS_HEIGHT))
    right = max(left + 1, min(CANVAS_WIDTH, round((region.x + region.w) * CANVAS_WIDTH)))
    bottom = max(top + 1, min(CANVAS_HEIGHT, round((region.y + region.h) * CANVAS_HEIGHT)))
    return left, top, right, bottom


def palette(layers: list[Layer], box: tuple[int, int, int, int]) -> list[tuple[str, int]]:
    """Most common (color, width) pairs of visible ink inside the region, to keep the artist's style."""
    strokes = [s for layer in layers if layer.visible for s in layer.strokes if not s.erase]
    left, top, right, bottom = box
    counts: Counter[tuple[str, int]] = Counter()
    for stroke in strokes:
        for point in stroke.points:
            if left <= point.x * CANVAS_WIDTH <= right and top <= point.y * CANVAS_HEIGHT <= bottom:
                counts[(stroke.color.lower(), round(stroke.width))] += 1
    if not counts:
        for stroke in strokes:
            counts[(stroke.color.lower(), round(stroke.width))] += len(stroke.points)
    return [pair for pair, _ in counts.most_common(4)]


def smooth(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Catmull-Rom through the model's sparse points, sampled about every 3 px."""
    if len(points) < 2:
        return points
    padded = [points[0], *points, points[-1]]
    out = [points[0]]
    for i in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[i - 1], padded[i], padded[i + 1], padded[i + 2]
        steps = max(1, math.ceil(math.dist(p1, p2) / STEP_PX))
        for step in range(1, steps + 1):
            t = step / steps
            t2, t3 = t * t, t * t * t
            out.append(tuple(
                0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
                       + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
                for k in (0, 1)
            ))
    if len(out) > MAX_STROKE_POINTS:
        stride = math.ceil(len(out) / MAX_STROKE_POINTS)
        out = out[::stride] + [out[-1]]
    return out


def to_canvas_strokes(raw: list[_Stroke], box: tuple[int, int, int, int],
                      fallback: tuple[str, int], *, max_strokes: int = MAX_SPARK_STROKES,
                      color: str | None = None) -> list[dict]:
    """Map crop-local model output onto the canvas, smoothed and validated."""
    left, top, right, bottom = box
    strokes = []
    for item in raw[:max_strokes]:
        pixels = [
            (left + min(1, max(0, p.x)) * (right - left), top + min(1, max(0, p.y)) * (bottom - top))
            for p in item.points[:MAX_MODEL_POINTS]
            if math.isfinite(p.x) and math.isfinite(p.y)
        ]
        if not pixels:
            continue
        ink = color or (item.color if HEX.match(item.color or "") else fallback[0])
        width = item.width if math.isfinite(item.width) else fallback[1]
        stroke = Stroke(
            color=ink.lower(),
            width=min(40, max(1, width)),
            # pressure 0.75 renders at exactly the stated width (width * (0.25 + pressure)).
            # The spline can overshoot sharp turns; keep every point inside the selection.
            points=[{"x": min(right, max(left, x)) / CANVAS_WIDTH, "y": min(bottom, max(top, y)) / CANVAS_HEIGHT,
                     "pressure": 0.75} for x, y in smooth(pixels)],
            ai=True,
        )
        strokes.append(stroke.model_dump())
    return strokes


def ink_to_alpha(image: PILImage.Image) -> PILImage.Image:
    """White paper becomes transparent so the guide can sit under the artist's ink."""
    rgb = image.convert("RGB")
    darkness = PILImage.eval(rgb.convert("L"), lambda v: 0 if v > 235 else min(255, round((255 - v) * 1.4)))
    rgba = rgb.convert("RGBA")
    rgba.putalpha(darkness)
    return rgba


class Sparks:
    def __init__(self) -> None:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise AIError("Set GEMINI_API_KEY to enable sparks and auto-tags.")
        self.client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=90_000))
        self.text_model = os.environ.get("GEMINI_TEXT_MODEL", "gemini-3.5-flash")
        self.image_model = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image")

    def _generate(self, **kwargs):
        try:
            return self.client.models.generate_content(**kwargs)
        except genai_errors.APIError:
            raise
        except Exception as exc:
            # The SDK does not wrap transport errors (httpx, httpx2, or aiohttp, depending on install).
            raise AIUnavailable("Gemini is unreachable right now. Check your connection and try again.") from exc

    def _json(self, contents: list, schema: type[BaseModel]) -> BaseModel:
        response = self._generate(
            model=self.text_model, contents=contents,
            config=types.GenerateContentConfig(
                response_mime_type="application/json", response_schema=schema,
                thinking_config=types.ThinkingConfig(thinking_level="low"),
            ),
        )
        if not isinstance(response.parsed, schema):
            raise AIError("Gemini returned no suggestion. Try a different area or wording.")
        return response.parsed

    def suggest_tags(self, request: TagRequest) -> list[str]:
        image = png_bytes(render_image(request.layers))
        context = "; ".join(filter(None, [
            f'title "{request.title}"' if request.title else "",
            f'description "{request.description}"' if request.description else "",
        ]))
        result = self._json([
            types.Part.from_bytes(data=image, mime_type="image/png"),
            "Tag this hand-drawn sketch so the artist can find it later. Return 3-8 short lowercase "
            "tags (1-2 words each) naming what is drawn: subjects, body parts, objects, animals, "
            "scene, mood (e.g. face, eye, hand, smile, rocket, ocean). Tag only what is visible. Skip "
            "generic medium words that fit every sketch (drawing, sketch, line art, doodle, illustration, "
            "minimalist, simple) unless the artist used them."
            + (f" The artist gave it {context}." if context else ""),
        ], _Tags)
        tags = clean_tags(result.tags)
        if not tags:
            raise AIError("Gemini could not tag this drawing.")
        return tags

    def describe(self, request: TagRequest, context: str = "") -> dict:
        """One call, two search handles: a plain-words description and tags, written from the picture itself."""
        image = png_bytes(render_image(request.layers))
        given = "; ".join(filter(None, [
            f'title "{request.title}"' if request.title else "",
            f'notes "{request.description}"' if request.description else "",
        ]))
        result = self._json([
            types.Part.from_bytes(data=image, mime_type="image/png"),
            "Describe this hand-drawn 2D artwork so the artist can find it later by searching in plain words. "
            "name: a short, specific name for what it is, 1-3 words in title case (e.g. 'Little Fox', 'Red Rocket', "
            "'Beach Sunset'); never words about the medium (sketch, drawing, doodle, line art). "
            "description: one or two short sentences (under 200 characters) saying what is drawn and how it "
            "looks: subject, pose or action, notable colors, setting, mood. If it is an animated scene, say what "
            "happens in it (who moves, and how). Concrete and visual. Never mention the medium, the paper, a white "
            "or plain background, or that it is a drawing; no praise. tags: 3-8 short lowercase tags (1-2 words "
            "each) naming what is visible or happens: subjects, objects, animals, actions, scene, mood. Skip generic "
            "medium words (drawing, sketch, line art, doodle, illustration, minimalist, simple) unless the artist used them."
            + (f" The artist gave it {given}." if given else "")
            + (f" The image is only its first frame. What the studio knows about it: {context}. Lead the "
               "description with what happens (who moves, and how), then how it looks." if context else ""),
        ], _Described)
        description = " ".join(result.description.split())[:300]
        tags = clean_tags(result.tags)
        if not description and not tags:
            raise AIError("Gemini could not describe this drawing.")
        words = re.sub(r"[^\w' -]", "", re.sub(r"<[^>]*>", "", result.name)).split()
        name = " ".join(w for w in words if w.lower() not in MEDIUM_WORDS)[:40] or " ".join(words)[:40]
        return {"name": name, "description": description, "tags": tags}

    def rig(self, layers: list[Layer]) -> dict:
        """Which strokes make which part (legs, arms, tail, wings, head) and the joint each turns on, so a gait can
        swing limbs instead of sliding a sticker. Stroke order is the asset's visible layers, flattened."""
        strokes = [stroke for layer in layers if layer.visible for stroke in layer.strokes]
        ink = [p for stroke in strokes if not stroke.erase for p in stroke.points]
        if not ink:
            raise AIError("Nothing to rig: the asset has no visible ink.")
        x0, x1 = min(p.x for p in ink), max(p.x for p in ink)
        y0, y1 = min(p.y for p in ink), max(p.y for p in ink)
        w, h = max(x1 - x0, 1e-6), max(y1 - y0, 1e-6)
        rel = lambda x, y: (round(100 * (x - x0) / w), round(100 * (y - y0) / h))  # noqa: E731
        rows = []
        for i, stroke in enumerate(strokes[:RIG_TABLE_STROKES]):
            if stroke.erase:
                continue
            xs, ys = [p.x for p in stroke.points], [p.y for p in stroke.points]
            (a, b), (c, d) = rel(min(xs), min(ys)), rel(max(xs), max(ys))
            rows.append(f"{i}: {stroke.color}{' filled' if stroke.fill else ''}, box {a},{b} to {c},{d}")
        picture = render_image(layers).crop((round(x0 * CANVAS_WIDTH) - 8, round(y0 * CANVAS_HEIGHT) - 8,
                                             round(x1 * CANVAS_WIDTH) + 8, round(y1 * CANVAS_HEIGHT) + 8))
        result = self._json([
            types.Part.from_bytes(data=png_bytes(picture), mime_type="image/png"),
            "Rig this 2D drawing for simple cut-out animation. Coordinates are 0-100 across the drawing's box (x right, "
            "y down). Its strokes, by index (box = the stroke's extent):\n" + "\n".join(rows) + "\n\n"
            "kind: biped, quadruped, bird, fish, or object (anything without limbs). bones: group the strokes into the "
            "parts that move on their own: head, leg_front, leg_back, arm_front, arm_back, tail, wing_front, wing_back. "
            "Put everything else (torso, belly, details that ride along, any stroke outlining most of the figure) in "
            "body. For each bone, joint_x/joint_y is where it attaches and turns: a leg at the hip, an arm at the shoulder, a tail where it meets the body, a wing at its "
            "root, the head at the neck. A quadruped's near legs are leg_front, the far ones leg_back. Use each stroke "
            "index at most once. An object has no bones, or one body bone.",
        ], _Rig)
        parts = set(get_args(RigPart))
        used: set[int] = set()

        def outline(stroke) -> bool:  # spans most of the figure both ways: the body's outline, never a limb
            xs, ys = [p.x for p in stroke.points], [p.y for p in stroke.points]
            return max(xs) - min(xs) > 0.6 * w and max(ys) - min(ys) > 0.6 * h

        bones = []
        for bone in result.bones:
            if bone.part not in parts or bone.part in ("body", "other"):
                continue
            picked = [i for i in dict.fromkeys(bone.strokes)
                      if 0 <= i < len(strokes) and not strokes[i].erase and i not in used and not outline(strokes[i])]
            if not picked:
                continue
            used.update(picked)
            bones.append({"part": bone.part, "strokes": picked,
                          "px": min(1, max(0, bone.joint_x / 100)), "py": min(1, max(0, bone.joint_y / 100))})
        kind = result.kind if result.kind in ("biped", "quadruped", "bird", "fish", "object") else "object"
        return Rig.model_validate({"kind": kind, "strokes": len(strokes), "bones": bones[:12]}).model_dump()

    def picture(self, request: PictureRequest) -> dict:
        """A new asset from words: clean 2D line art the studio traces into editable strokes (in the browser)."""
        response = self._generate(
            model=self.image_model,
            contents=[f"Draw {request.prompt} as a single 2D character or prop for a hand-drawn cartoon: clean, bold, "
                      "even black outlines on a pure white background, flat and simple, a few flat fill colors at most. "
                      "Side view, the whole thing visible and centered, facing right. No background scene, no shading, "
                      "no texture, no text, no border."],
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE"], image_config=types.ImageConfig(aspect_ratio="1:1"),
            ),
        )
        data = next((part.inline_data.data for candidate in response.candidates or []
                     for part in (candidate.content.parts if candidate.content else []) or []
                     if part.inline_data and part.inline_data.data), None)
        if data is None:
            raise AIError("Gemini returned no picture. Try other words.")
        picture = PILImage.open(io.BytesIO(data)).convert("RGB")
        picture.thumbnail((768, 768), PILImage.LANCZOS)
        return {"note": f"Drawn by AI: {request.prompt}", "image": f"data:image/png;base64,{base64.b64encode(png_bytes(picture)).decode('ascii')}"}

    def strokes(self, request: SparkRequest) -> dict:
        box = crop_box(request.region)
        canvas = render_image(request.layers)
        crop = canvas.crop(box)
        scale = 768 / max(crop.size)
        if scale > 1:
            crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), PILImage.LANCZOS)
        marked = canvas.copy()
        ImageDraw.Draw(marked).rectangle(box, outline="#ff2d55", width=4)
        inks = palette(request.layers, box) or [("#1f2937", 6)]
        about = f' titled "{request.title}"' if request.title else ""
        ask = request.prompt or "Fix or complete whatever looks unfinished or awkward in this area."
        result = self._json([
            "Image 1: the artist's whole canvas; the red box marks where they want help.",
            types.Part.from_bytes(data=png_bytes(marked), mime_type="image/png"),
            "Image 2: close-up of the red-box area.",
            types.Part.from_bytes(data=png_bytes(crop), mime_type="image/png"),
            f"You are a gentle drawing assistant inside a sketching app. The artist is mid-flow on a "
            f"drawing{about} and wants a minimal assist inside the red box. Request: {ask}\n"
            f"Propose only the few strokes needed (1-{MAX_SPARK_STROKES}) as additions on top of the "
            f"existing ink; never redraw parts that are already fine. Match the existing line style, "
            f"weight, and colors. Coordinates are normalized to Image 2: (0,0) is its top-left and "
            f"(1,1) its bottom-right. Each stroke is a polyline of 2-60 points in pen order. Colors are "
            f"#RRGGBB. Width is in pixels of the 1000x650 canvas. The artist's ink here (color, width): "
            f"{inks}. Also return a short note (at most 12 words) describing what you added.",
        ], _StrokeSpark)
        strokes = to_canvas_strokes(result.strokes, box, inks[0])
        if not strokes:
            raise AIError("Gemini had no strokes to add here. Try describing what you want.")
        return {"kind": "strokes", "note": result.note.strip()[:120], "strokes": strokes}

    def sketch(self, request: SketchRequest) -> dict:
        """A whole-canvas blue-pencil draft: simple, editable strokes the artist draws over (never final art)."""
        canvas = render_image(request.layers)
        context = ("The canvas already has the artist's drawing (shown). Compose around it; don't redraw it."
                   if any(layer.visible and layer.strokes for layer in request.layers) else "The canvas is empty.")
        result = self._json([
            types.Part.from_bytes(data=png_bytes(canvas), mime_type="image/png"),
            f"You are an animator's assistant roughing out a starting point, like a light blue-pencil "
            f"construction sketch an artist will draw over and finish by hand. Sketch: {request.prompt}\n"
            f"{context} Use 8-{MAX_SKETCH_STROKES} simple strokes: big shapes, outlines, and placement lines, "
            f"no shading, hatching, or text. Each stroke is a polyline of 2-60 points in pen order, with "
            f"coordinates normalized to the image ((0,0) top-left, (1,1) bottom-right). Use width 3. "
            f"Also return a note (at most 10 words) naming what you sketched.",
        ], _StrokeSpark)
        strokes = to_canvas_strokes(result.strokes, (0, 0, CANVAS_WIDTH, CANVAS_HEIGHT), (BLUE_PENCIL, 3),
                                    max_strokes=MAX_SKETCH_STROKES, color=BLUE_PENCIL)
        if not strokes:
            raise AIError("Gemini couldn't sketch that. Try simpler words, like \"a house on a hill\".")
        return {"kind": "sketch", "note": result.note.strip()[:80], "prompt": request.prompt, "strokes": strokes}

    def motion(self, request: MotionRequest) -> dict:
        """Choreography, not drawing: keyframes that move, scale, squash, and turn the artist's own layers."""
        frames = round(request.seconds * 8)
        keys = "3-8" if request.seconds <= 3 else "6-16" if request.seconds <= 6 else "8-22"
        subjects = "\n".join(
            f"- subject {s.id}: {s.name!r}, center ({s.box.x + s.box.w / 2:.2f}, {s.box.y + s.box.h / 2:.2f}), "
            f"size {s.box.w:.2f} x {s.box.h:.2f}" for s in request.subjects)
        previous = ""
        if request.previous:
            previous = (
                f"\nThis is a revision of an existing animation. Original direction: {request.previous.prompt}\n"
                f"Existing choreography: {json.dumps([track.model_dump() for track in request.previous.tracks])}\n"
                "Apply the new direction as a change to this choreography. Keep the unmentioned beats, "
                "subjects, and timing wherever possible; return the complete revised tracks."
            )
        result = self._json([
            types.Part.from_bytes(data=png_bytes(render_image(request.layers)), mime_type="image/png"),
            f"You are a 2D animator's assistant. The image is the first frame of a {request.seconds:g}-second clip "
            f"({frames} frames). Animate ONLY these subjects (canvas fractions: (0,0) top-left, (1,1) bottom-right):\n"
            f"{subjects}\nDirection: {request.prompt}{previous}\n"
            "For each subject return keyframes. t is the time from 0 to 1. x and y are the offset of the subject's "
            "center from where it is now, in canvas fractions (x right, y down; y=-0.3 moves it up by 30% of the "
            "canvas height). sx and sy scale it (1 = as drawn; squash = sx 1.2, sy 0.8). r rotates it clockwise in "
            f"degrees. The first key must be t=0, x=0, y=0, sx=1, sy=1, r=0. Plan the clip as 2-5 beats with clear "
            f"timing, and use {keys} keys per subject, placed where the motion changes. Label every key with the beat "
            "or principle it shows, in 1-2 lowercase words (e.g. start, anticipation, squash, stretch, takeoff, arc, "
            "slow in, slow out, overshoot, settle, hold, turn, look). Use the principles of animation: anticipation, "
            "slow in and slow out, squash and stretch, arcs, overshoot and settle, holds that let a pose read. Keep "
            "subjects mostly on the canvas unless told to leave. Ground things that walk or bounce on what's below them "
            "in the picture. Also return a note (at most 14 words) describing the motion.",
        ], _Motion)
        ids = {subject.id for subject in request.subjects}
        tracks = [{"subject": track.subject, "keys": clean_track(track.keys)}
                  for track in result.tracks if track.subject in ids and track.keys]
        tracks = list({track["subject"]: track for track in tracks}.values())
        if not any(len(track["keys"]) > 2 or track["keys"][-1] != {**IDENTITY_KEY, "t": 1.0} for track in tracks):
            raise AIError("Gemini couldn't choreograph that. Try a clearer move, like \"hops to the right twice\".")
        return {"kind": "motion", "note": result.note.strip()[:90], "prompt": request.prompt,
                "seconds": request.seconds, "tracks": tracks}

    def direct(self, request: DirectRequest) -> dict:
        """Pitch three short shots that show off these drawings."""
        subjects = "\n".join(
            f"- subject {s.id}: {s.name!r} at center ({s.box.x + s.box.w / 2:.2f}, {s.box.y + s.box.h / 2:.2f}), "
            f"size {s.box.w:.2f} x {s.box.h:.2f}" for s in request.subjects)
        result = self._json([
            types.Part.from_bytes(data=png_bytes(render_image(request.layers)), mime_type="image/png"),
            f"You are a storyboard artist and animation director. The image is the first frame of a "
            f"{request.seconds:g}-second shot{f' set on a {request.backdrop} backdrop' if request.backdrop else ''}. "
            f"These are the artist's drawings that can move (canvas fractions, (0,0) top-left):\n{subjects}\n"
            "Pitch 3 genuinely different little stories with a setup, a surprise, and a satisfying ending. "
            "Use what you can actually see in the picture and the setting; make the drawing's personality come "
            "through its motion. Avoid generic takeoffs, repetitive bouncing, and immediately exiting the screen. "
            "If a drawing is a rocket, it need not launch: it might explore, dance, get lost, or meet something. "
            "Motion can only "
            "move, scale, squash and stretch, and turn the existing drawings: no new drawing, no morphing, no camera "
            "cuts. For each, return: a title (2-4 words, Title Case); a logline (at most 18 words: what happens and "
            "why it's fun); a prompt (at most 45 words: plain, vivid words a 10-year-old could read and edit, as 2-4 "
            "beats in order, e.g. 'First..., then..., at the end...'; say where things go in everyday words (left, "
            "up, off the top, to the middle); call drawings by their names; never mention subject ids, coordinates, "
            "or 't='); and movers (the subject ids that move, at most 4).",
        ], _Ideas)
        ids = {subject.id for subject in request.subjects}
        ideas = []
        for idea in result.ideas[:3]:
            movers = list(dict.fromkeys(mover for mover in idea.movers if mover in ids))[:4]
            title, logline, prompt = (" ".join(text.split()) for text in (idea.title, idea.logline, idea.prompt))
            if movers and title and len(prompt) >= 10:
                ideas.append({"title": title[:40], "logline": logline[:160], "prompt": prompt[:300], "movers": movers})
        if not ideas:
            raise AIError("Gemini couldn't pitch a shot for this. Try describing one yourself.")
        return {"ideas": ideas}

    def code_sketch(self, request: CodeRequest) -> dict:
        """A Lab sketch: readable p5.js that moves the artist's own strokes. Gemini writes code, never art."""
        drawn = [stroke for layer in request.layers if layer.visible for stroke in layer.strokes if not stroke.erase]
        summary = (f"The drawing has {len(drawn)} strokes on layers: "
                   + ", ".join(dict.fromkeys(layer.name for layer in request.layers if layer.visible and layer.strokes))
                   if drawn else "The drawing is empty: write a sketch that works with any strokes.")
        revise = (f"Revise this sketch (keep what the request doesn't mention):\n```js\n{request.code}\n```\n"
                  if request.code.strip() else "")
        result = self._json([
            types.Part.from_bytes(data=png_bytes(render_image(request.layers)), mime_type="image/png"),
            f"You are a creative-coding mentor helping an artist bring their drawing to life with code.\n{LAB_API}\n"
            f"The image is their drawing. {summary}.\n{revise}Request: {request.prompt}\n"
            "Return the complete sketch as code, and a note (at most 14 words) saying what it does.",
        ], _CodeSketch)
        return {"kind": "code", "code": clean_sketch(result.code), "note": result.note.strip()[:120]}

    def refine_ideas(self, request: RefineIdeasRequest) -> list[str]:
        """What this drawing could use next: short prompts the artist can tap, or edit before running."""
        about = f' titled "{request.title}"' if request.title else ""
        result = self._json([
            types.Part.from_bytes(data=png_bytes(render_image(request.layers)), mime_type="image/png"),
            f"An artist drew this{about} and wants AI to refine it by editing their own line art. Suggest 4 "
            "different, concrete refinements that would make it more finished, expressive, or fun to animate "
            "(e.g. a detail, an expression, an accessory, cleaner shapes, motion-ready parts). Each is an "
            "imperative prompt of 3-8 plain words, naming what is drawn (e.g. 'give the fox a curious smile', "
            "'add flames under the rocket'). Only things you can draw with a few lines; no shading, text, or "
            "backgrounds.",
        ], _Suggestions)
        ideas = list(dict.fromkeys(" ".join(idea.split()).rstrip(".")[:80] for idea in result.ideas))
        ideas = [idea[0].lower() + idea[1:] for idea in ideas if len(idea) >= 6][:4]
        if not ideas:
            raise AIError("Gemini had no ideas for this one. Say what you'd like to change.")
        return ideas

    def refine(self, request: RefineRequest) -> dict:
        """One layer refined as a plan of edits (smooth this, make that a circle, scale those), which the studio
        applies with exact geometry to every frame. New strokes only when the request asks for something new."""
        strokes = request.layers[request.target].strokes
        live = [i for i, stroke in enumerate(strokes) if not stroke.erase]
        picture = render_image(request.layers)
        pen = ImageDraw.Draw(picture)
        rows = []
        for i in live:
            pts = [(p.x * CANVAS_WIDTH, p.y * CANVAS_HEIGHT) for p in strokes[i].points]
            xs, ys = [x for x, _ in pts], [y for _, y in pts]
            length = sum(math.dist(pts[k - 1], pts[k]) for k in range(1, len(pts)))
            gap = math.dist(pts[0], pts[-1])
            closed = len(pts) > 3 and gap < max(6.0, 0.12 * length)
            rows.append(f"S{i}: {strokes[i].color.lower()}{' filled' if strokes[i].fill else ''}, {len(pts)} points, "
                        f"{'closed' if closed else 'open'}, box {round(min(xs))},{round(min(ys))} to {round(max(xs))},{round(max(ys))}, "
                        f"length {round(length)}px, ends {round(gap)}px apart")
            x, y = pts[len(pts) // 2]
            pen.rectangle((x - 2, y - 7, x + 7 * len(str(i)) + 2, y + 7), fill="#6d28d9")
            pen.text((x, y - 6), str(i), fill="#ffffff")
        result = self._json([
            "Image: the artist's canvas (1000x650). Each stroke of the layer to refine has its number on it (violet tag).",
            types.Part.from_bytes(data=png_bytes(picture), mime_type="image/png"),
            "The strokes of that layer:\n" + "\n".join(rows) + "\n\nTheir points (pixels):\n" + encode_strokes(strokes) + "\n\n"
            f"Refine this drawing{f' {request.title!r}' if request.title else ''}: {request.prompt}\n"
            "You do NOT redraw strokes. You return `edits`: operations that code applies exactly to the artist's own "
            "strokes. Each edit: op, strokes (the S numbers it applies to), scale, rotate, dx, dy. Ops:\n"
            "- smooth: steady a wobbly or jittery line, keeping its shape.\n"
            "- line: it is meant to be one straight line.\n"
            "- curve: it is meant to be one smooth arc (a smile, a brow, a tail curve).\n"
            "- circle: it is meant to be a circle (a head, an eye, a wheel).\n"
            "- ellipse: it is meant to be an oval (a body, an egg).\n"
            "- close: a shape left open by a small gap that should be closed.\n"
            "- delete: a stray speck, scribble, or duplicate stroke laid over another.\n"
            "- transform: move, scale, or turn a group of strokes together about their center: scale (1 = same, "
            "0.5 to 2), rotate (degrees, -60 to 60, clockwise), dx and dy (pixels). Use it for 'bigger ears', 'tilt "
            "the head', 'move the eyes closer'. For every other op set scale 1, rotate 0, dx 0, dy 0.\n"
            "Only edit what the request needs; leave everything else out (unlisted strokes stay exactly as drawn). "
            "Never use circle or ellipse on a stroke that is not round in the picture. `add`: new strokes ONLY if the "
            "request asks for something new (\"add clouds\"); otherwise empty. Each added stroke: color #rrggbb, "
            "width in pixels, fill (#rrggbb or empty), points in pixels (0-1000 x 0-650), at most "
            f"{MAX_VARIATION_POINTS} points, in the artist's style. note: at most 12 words saying what changed.",
        ], _RefinePlan)
        allowed = set(live)
        edits = []
        for edit in result.edits[:MAX_REFINE_EDITS]:
            op = (edit.op or "").strip().lower()
            picked = [i for i in dict.fromkeys(edit.strokes) if i in allowed]
            if op not in REFINE_OPS or not picked:
                continue
            num = lambda v, lo, hi, d: min(hi, max(lo, v)) if isinstance(v, (int, float)) and math.isfinite(v) else d  # noqa: E731
            item = {"op": op, "strokes": picked, "scale": 1.0, "rotate": 0.0, "dx": 0.0, "dy": 0.0}
            if op == "transform":
                item.update(scale=round(num(edit.scale, 0.5, 2.0, 1.0), 3), rotate=round(num(edit.rotate, -60, 60, 0.0), 2),
                            dx=round(num(edit.dx, -300, 300, 0.0), 1), dy=round(num(edit.dy, -300, 300, 0.0), 1))
                if abs(item["scale"] - 1) < 0.01 and abs(item["rotate"]) < 0.5 and abs(item["dx"]) < 1 and abs(item["dy"]) < 1:
                    continue
            edits.append(item)
        doomed = {i for edit in edits if edit["op"] == "delete" for i in edit["strokes"]}
        if doomed and len(doomed) >= max(1, len(live) * 0.6):  # a cleanup never deletes the drawing
            edits = [edit for edit in edits if edit["op"] != "delete"]
        out, _, added = apply_variation(strokes, _Variation(note="", keep=list(range(len(strokes))), strokes=result.add[:MAX_REFINE_ADDS]))
        add = out[len(strokes):]
        if not edits and not add:
            raise AIError("Nothing to change there. Say how: \u201csmoother lines\u201d, \u201ca rounder head\u201d, \u201cbigger ears\u201d.")
        return {"kind": "refine", "note": result.note.strip()[:120], "prompt": request.prompt, "target": request.target,
                "edits": edits, "add": add, "source_strokes": len(live)}

    def plan_variations(self, asset: dict, request: VariationPlanRequest) -> list[dict]:
        """A short, editable plan: one brief per variation. The artist edits it before anything is drawn."""
        layers = [Layer.model_validate(layer) for layer in asset["layers"]]
        result = self._json([
            types.Part.from_bytes(data=png_bytes(render_image(layers)), mime_type="image/png"),
            f"This is {asset['name']!r}, a {asset['type']} an animator drew"
            + (f" ({asset['description']})" if asset.get("description") else "") + ". "
            f"They need {request.count} variations of it for: {request.goal}\n"
            f"Plan exactly {request.count} distinct variations. Each must stay recognizably the same family, "
            f"style, palette, and size, and change only 1-3 concrete, drawable things (pose, held item, "
            f"expression, accessory, build, markings, damage...), so it can be made by editing the original "
            f"line art. Make them clearly different from each other. For each, return a name (2-3 words, "
            f"Title Case, no quotes) and a brief (one sentence, at most 16 words, saying exactly what changes).",
        ], _Plan)
        plan = []
        for item in result.items[:request.count]:
            name, brief = " ".join(item.name.split())[:40], " ".join(item.brief.split())[:200]
            if name and len(brief) >= 3:
                plan.append({"name": name, "brief": brief})
        if not plan:
            raise AIError("Gemini couldn't plan variations. Try describing what they're for.")
        return plan

    def variation(self, asset: dict, request: VariationRequest) -> dict:
        """A derivative of the artist's own strokes: keep what the brief doesn't touch, add only what it needs."""
        layers = [Layer.model_validate(layer) for layer in asset["layers"]]
        strokes = source_strokes(layers)
        result = self._json([
            "Image: the artist's original drawing on a 1000x650 canvas.",
            types.Part.from_bytes(data=png_bytes(render_image(layers)), mime_type="image/png"),
            f"Its strokes, in drawing order (pixel coordinates; (0,0) is top-left):\n{encode_strokes(strokes)}\n\n"
            f"You help an animator make a variation of {asset['name']!r} by EDITING their line art, never by "
            f"redrawing it from scratch. Variation: {request.brief}\n"
            f"Return `keep`: the numbers of every original stroke to keep exactly as is (keep as many as "
            f"possible). Return `strokes`: only the new or changed strokes the variation needs (a changed "
            f"stroke is left out of keep and redrawn here). Match the artist's colors, widths, and style; "
            f"keep the same overall size and position on the canvas. Each stroke: color #rrggbb, width in "
            f"pixels, fill (#rrggbb for a closed filled shape, or empty), and points as a polyline in pen "
            f"order, pixel coordinates within 0-1000 x 0-650, at most {MAX_VARIATION_POINTS} points. "
            f"Also return a note (at most 12 words) saying what you changed.",
        ], _Variation)
        out, kept, added = apply_variation(strokes, result)
        if not added and kept == sum(1 for stroke in strokes if not stroke.erase):
            raise AIError("Gemini returned the drawing unchanged. Try a more specific brief.")
        if not any(not stroke.get("erase") for stroke in out):
            raise AIError("Gemini's variation came back empty. Try again or reword the brief.")
        return {"brief": request.brief, "note": result.note.strip()[:120], "strokes": out, "kept": kept,
                "added": added, "source_strokes": sum(1 for stroke in strokes if not stroke.erase),
                "source": {"asset_id": asset["id"], "version": asset["version"], "name": asset["name"]}}

    def guide(self, request: SparkRequest) -> dict:
        box = crop_box(request.region)
        # Show the model surrounding context (so a lone eye is drawn as the face's other eye),
        # then keep only the selected region of its answer.
        margin = round(0.75 * max(box[2] - box[0], box[3] - box[1]))
        context = (max(0, box[0] - margin), max(0, box[1] - margin),
                   min(CANVAS_WIDTH, box[2] + margin), min(CANVAS_HEIGHT, box[3] + margin))
        crop = render_image(request.layers).crop(context)
        side = max(crop.size)
        square = PILImage.new("RGB", (side, side), "white")
        offset = ((side - crop.width) // 2, (side - crop.height) // 2)
        square.paste(crop, offset)
        target = (offset[0] + box[0] - context[0], offset[1] + box[1] - context[1],
                  offset[0] + box[2] - context[0], offset[1] + box[3] - context[1])
        span = ", ".join(f"{round(100 * value / side)}%" for value in target)
        about = f' from a drawing titled "{request.title}"' if request.title else ""
        ask = request.prompt or "Refine whatever looks unfinished or awkward."
        response = self._generate(
            model=self.image_model,
            contents=[
                types.Part.from_bytes(data=png_bytes(square.resize((GUIDE_SIZE, GUIDE_SIZE))),
                                      mime_type="image/png"),
                f"Minimal edit of this hand-drawn sketch close-up{about}. Edit only the focus area "
                f"(left, top, right, bottom as % of the image: {span}); everything else is context "
                f"and must stay unchanged. In the focus area: {ask} Keep the exact same framing, "
                f"scale, line weights, and colors. Clean line art on a pure white background. "
                f"No shading, text, boxes, or border.",
            ],
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE"], image_config=types.ImageConfig(aspect_ratio="1:1"),
            ),
        )
        data = next((part.inline_data.data for candidate in response.candidates or []
                     for part in (candidate.content.parts if candidate.content else []) or []
                     if part.inline_data and part.inline_data.data), None)
        if data is None:
            raise AIError("Gemini returned no guide. Try a different area or wording.")
        result = PILImage.open(io.BytesIO(data)).convert("RGB").resize((side, side), PILImage.LANCZOS)
        result = result.crop(target)
        image = base64.b64encode(png_bytes(ink_to_alpha(result))).decode("ascii")
        return {"kind": "guide", "note": "Trace guide ready", "region": request.region.model_dump(),
                "image": f"data:image/png;base64,{image}"}
