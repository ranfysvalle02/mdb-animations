"""Gemini-powered sparks (minimal, opt-in drawing assists) and auto-tagging."""

import base64
import binascii
import io
import json
import math
import os
import re
from collections import Counter

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from PIL import Image as PILImage, ImageDraw
from pydantic import BaseModel

from backend.library import CANVAS_HEIGHT, CANVAS_WIDTH, png_bytes, render_image
from backend.models import (
    MAX_MOTION_KEYS, MAX_POINTS, MAX_STROKES, DirectRequest, Layer, MotionRequest, RefineIdeasRequest, RefineRequest, Region, SketchRequest,
    SparkRequest, Stroke, TagRequest, VariationPlanRequest,
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


def clip_brief(prompt: str, starring: str = "", backdrop: str = "") -> str:
    """The exact words sent with the drawing for a new AI video (shown to the artist afterwards)."""
    story = prompt or ("Surprise me: a short, playful story with a fun beginning, a twist in the middle, "
                       "and a satisfying ending.")
    cast = f"The star is {starring}. " if starring else ""
    place = f"The setting is {backdrop}. " if backdrop else ""
    return ("This image is an artist's hand-drawn doodle. Bring it to life as an animated short. "
            f"{cast}{place}Keep the hand-drawn look: the same characters, line style, and colors, "
            f"so the artist recognizes their own drawing. Story: {story}")


class Sparks:
    def __init__(self) -> None:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise AIError("Set GEMINI_API_KEY to enable sparks and auto-tags.")
        self.client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=90_000))
        self.text_model = os.environ.get("GEMINI_TEXT_MODEL", "gemini-3.5-flash")
        self.image_model = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image")
        self.video_model = os.environ.get("GEMINI_VIDEO_MODEL", "gemini-omni-1.2-flash")

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

    def clip(self, layers: list[Layer], prompt: str, previous: str | None = None, *,
             starring: str = "", backdrop: str = "") -> tuple[str, bytes]:
        """Generate a video, or edit the owner's previous Gemini interaction."""
        if previous:
            contents = prompt
        else:
            contents = [
                {"type": "image", "data": base64.b64encode(png_bytes(render_image(layers))).decode("ascii"),
                 "mime_type": "image/png"},
                {"type": "text", "text": clip_brief(prompt, starring, backdrop)},
            ]
        try:
            result = self.client.interactions.create(
                model=self.video_model, input=contents, previous_interaction_id=previous,
                response_format={"type": "video", "duration": "8s", "resolution": "720p"},
                timeout=300,
            )
        except genai_errors.APIError:
            raise
        except Exception as exc:
            raise AIUnavailable("Gemini video is unreachable. Please try again.") from exc
        video = result.output_video
        if result.status != "completed" or not result.id or not video or not video.data:
            raise AIError("Gemini did not return a finished video. Try a different direction.")
        if video.mime_type and video.mime_type != "video/mp4":
            raise AIError("Gemini returned an unsupported video format.")
        try:
            data = base64.b64decode(video.data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise AIError("Gemini returned an invalid video.") from exc
        if len(data) < 12 or data[4:8] != b"ftyp" or len(data) > 40 * 1024 * 1024:
            raise AIError("Gemini returned an invalid or oversized video.")
        return result.id, data

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
        """One layer, refined by EDITING the artist's strokes (kept verbatim) and adding only what's needed."""
        strokes = request.layers[request.target].strokes
        result = self._json([
            "Image: the artist's whole canvas (1000x650).",
            types.Part.from_bytes(data=png_bytes(render_image(request.layers)), mime_type="image/png"),
            f"The strokes of the layer to refine, in drawing order (pixel coordinates; (0,0) is top-left):\n"
            f"{encode_strokes(strokes)}\n\n"
            f"You help an artist refine their drawing{f' {request.title!r}' if request.title else ''} by EDITING "
            f"their line art, never redrawing it from scratch. Refinement: {request.prompt}\n"
            "Return `keep`: the numbers of every stroke to keep exactly as is (keep as many as possible). Return "
            "`strokes`: only the new or changed strokes this needs (a changed stroke is left out of keep and "
            "redrawn here). Match the artist's colors, widths, and style; keep the same size and position. Each "
            "stroke: color #rrggbb, width in pixels, fill (#rrggbb for a closed filled shape, or empty), and points "
            f"as a polyline in pen order, pixel coordinates within 0-1000 x 0-650, at most {MAX_VARIATION_POINTS} "
            "points. Also return a note (at most 12 words) saying what you changed.",
        ], _Variation)
        out, kept, added = apply_variation(strokes, result)
        keep = {i for i in result.keep if 0 <= i < len(strokes)}
        source = sum(1 for stroke in strokes if not stroke.erase)
        if not added and kept == source:
            raise AIError("Gemini left it unchanged. Try a more specific refinement.")
        if not any(not stroke.get("erase") for stroke in out):
            raise AIError("Gemini's refinement came back empty. Try again or reword it.")
        return {"kind": "refine", "note": result.note.strip()[:120], "prompt": request.prompt, "target": request.target,
                "strokes": out, "kept": kept, "added": added, "source_strokes": source,
                # out = these source strokes, verbatim and in order, then the AI's: the studio keeps its originals.
                "keep_indices": [i for i, stroke in enumerate(strokes) if stroke.erase or i in keep]}

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
