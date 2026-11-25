import math
import re
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator

Unit = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
MAX_POINTS = 20000
MAX_STROKES = 1000
MAX_LAYERS = 12
MAX_TAGS = 12
MAX_FRAMES = 80  # 10 seconds at 8 frames a second: short scenes, on purpose
MAX_MOTION_KEYS = 24
# The studio canvas, in pixels (backend.library renders at this size too).
POSE_W, POSE_H = 1000, 650
MAX_EVENTS = 60
FPS_CHOICES = (4, 6, 8, 12, 24)
HEX_COLOR = r"^#[0-9a-fA-F]{6}$"
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
CODE_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$"
ASSET_TYPES = ("character", "prop", "environment", "fx", "other")
SHOT_STATUSES = ("todo", "in_progress", "review", "approved")
AssetType = Literal["character", "prop", "environment", "fx", "other"]
ShotStatus = Literal["todo", "in_progress", "review", "approved"]
STATUS_LABELS = {"todo": "To do", "in_progress": "In progress", "review": "In review", "approved": "Approved"}
Code = Annotated[str, Field(pattern=CODE_PATTERN)]
TAG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9 -]{0,29}$")


def normalize_tag(value: str) -> str:
    tag = " ".join(value.lower().split())
    if not TAG_PATTERN.match(tag):
        raise ValueError("Tags are 1-30 letters, numbers, spaces, or hyphens.")
    return tag


def clean_tags(values: list[str]) -> list[str]:
    """Normalize, drop invalid entries, and dedupe (for model-generated tags)."""
    tags: list[str] = []
    for value in values:
        try:
            tag = normalize_tag(value)
        except ValueError:
            continue
        if tag not in tags:
            tags.append(tag)
    return tags[:MAX_TAGS]


Tag = Annotated[str, AfterValidator(normalize_tag)]


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: Unit
    y: Unit
    pressure: Unit = 0.5


class Stroke(BaseModel):
    """Freehand ink, a shape outline (optionally filled), or an eraser pass within its layer."""
    model_config = ConfigDict(extra="forbid")
    color: str = Field(pattern=HEX_COLOR)
    width: float = Field(ge=1, le=40, allow_inf_nan=False)
    points: list[Point] = Field(min_length=1, max_length=MAX_POINTS)
    erase: bool = False
    fill: str | None = Field(default=None, pattern=HEX_COLOR)
    # Provenance: AI-made strokes stay marked after the artist accepts them, so a breakdown can
    # always say how much of a drawing is the artist's hand. Hand strokes carry no flag at all.
    ai: bool = Field(default=False, exclude_if=lambda value: not value)
    kit: bool = Field(default=False, exclude_if=lambda value: not value)  # came with a starter kit
    # Process: drawing order across layers (for replay) and how long the stroke took to draw.
    seq: int | None = Field(default=None, ge=0, le=10_000_000, exclude_if=lambda value: value is None)
    ms: int | None = Field(default=None, ge=0, le=3_600_000, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def erasers_do_not_fill(self) -> "Stroke":
        if self.erase and self.fill:
            raise ValueError("An eraser stroke cannot have a fill.")
        return self


class AssetLink(BaseModel):
    """A layer placed from a library asset: which asset, and which version was placed."""
    model_config = ConfigDict(extra="forbid")
    asset_id: str = Field(pattern=UUID_PATTERN)
    version: int = Field(ge=1, le=100_000)


class Transform(BaseModel):
    """How a frame poses frame 1's layer: an offset, squash and stretch, and a turn around a pivot.

    Offsets and the pivot are canvas fractions; ``r`` is degrees clockwise. It's the whole idea of
    in-betweens: the artist's strokes, moved, never redrawn.
    """
    model_config = ConfigDict(extra="forbid")
    x: float = Field(default=0, ge=-2, le=2, allow_inf_nan=False)
    y: float = Field(default=0, ge=-2, le=2, allow_inf_nan=False)
    sx: float = Field(default=1, ge=0.03, le=4, allow_inf_nan=False)
    sy: float = Field(default=1, ge=0.03, le=4, allow_inf_nan=False)
    r: float = Field(default=0, ge=-1080, le=1080, allow_inf_nan=False)
    px: float = Field(default=0.5, ge=-1, le=2, allow_inf_nan=False)
    py: float = Field(default=0.5, ge=-1, le=2, allow_inf_nan=False)


class Layer(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(default="Layer 1", min_length=1, max_length=40)
    visible: bool = True
    opacity: Unit = 1.0
    strokes: list[Stroke] = Field(default_factory=list, max_length=MAX_STROKES)
    # Only placed layers carry a link; plain layers stay exactly as they were before assets existed.
    asset: AssetLink | None = Field(default=None, exclude_if=lambda value: value is None)
    backdrop: str | None = Field(default=None, max_length=40, exclude_if=lambda value: value is None)
    # In frames 2..N of a scene: "frame 1's layer number `ref`, posed by `xf`" instead of a copy of its
    # strokes. A 10-second shot stays small, and a new asset version flows into every frame.
    ref: int | None = Field(default=None, ge=0, lt=MAX_LAYERS, exclude_if=lambda value: value is None)
    xf: Transform | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def reference_or_strokes(self) -> "Layer":
        if self.xf is not None and self.ref is None:
            raise ValueError("A pose (xf) needs the frame 1 layer it poses (ref).")
        if self.ref is not None and self.strokes:
            raise ValueError("A layer that references frame 1 carries no strokes of its own.")
        return self


def pose_strokes(strokes: list[Stroke], xf: Transform) -> list[Stroke]:
    """Frame 1's strokes in a frame's pose. Mirrors poseXf in studio.js (cull off-canvas, pin the rest)."""
    cos, sin = math.cos(math.radians(xf.r)), math.sin(math.radians(xf.r))
    cx, cy = xf.px * POSE_W, xf.py * POSE_H
    ox, oy = cx + xf.x * POSE_W, cy + xf.y * POSE_H
    posed = []
    for stroke in strokes:
        points = []
        for p in stroke.points:
            dx, dy = (p.x * POSE_W - cx) * xf.sx, (p.y * POSE_H - cy) * xf.sy
            points.append(((ox + dx * cos - dy * sin) / POSE_W, (oy + dx * sin + dy * cos) / POSE_H, p.pressure))
        if all(x < -0.02 or x > 1.02 or y < -0.02 or y > 1.02 for x, y, _ in points):
            continue
        posed.append(stroke.model_copy(update={
            "width": min(40.0, max(1.0, stroke.width * math.sqrt(xf.sx * xf.sy))),
            "points": [Point(x=min(1.0, max(0.0, x)), y=min(1.0, max(0.0, y)), pressure=pressure) for x, y, pressure in points],
        }))
    return posed


def expand_frame(first: list[Layer], layers: list[Layer]) -> list[Layer]:
    """A frame's layers with every reference to frame 1 resolved into strokes."""
    out = []
    for layer in layers:
        if layer.ref is None:
            out.append(layer)
            continue
        base = first[layer.ref].strokes
        out.append(layer.model_copy(update={"strokes": pose_strokes(base, layer.xf) if layer.xf else list(base), "ref": None, "xf": None}))
    return out


def upgrade_legacy(data: object) -> object:
    """Drawings saved before layers had a flat ``strokes`` list: that becomes one layer."""
    if isinstance(data, dict) and "strokes" in data and "layers" not in data:
        data = dict(data)
        data["layers"] = [{"name": "Layer 1", "strokes": data.pop("strokes")}]
    return data


def check_layers(layers: list[Layer], *, require_ink: bool, allow_refs: bool = False) -> None:
    if not allow_refs and any(layer.ref is not None for layer in layers):
        raise ValueError("Only frames 2 and later of a scene can reference frame 1.")
    strokes = [stroke for layer in layers for stroke in layer.strokes]
    if len(strokes) > MAX_STROKES:
        raise ValueError("A drawing may contain at most 1,000 strokes and shapes.")
    if sum(len(stroke.points) for stroke in strokes) > MAX_POINTS:
        raise ValueError("A drawing may contain at most 20,000 points.")
    if require_ink and not any(layer.visible and any(not s.erase for s in layer.strokes) for layer in layers):
        raise ValueError("Draw something on a visible layer first.")


class HistoryEvent(BaseModel):
    """One line of the audit trail: who did what (the artist, the AI at the artist's request, or the studio)."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    at: str = Field(min_length=10, max_length=40)
    by: Literal["artist", "ai", "studio"]
    action: str = Field(min_length=1, max_length=40)
    detail: str = Field(default="", max_length=240)


History = Annotated[list[HistoryEvent], Field(default_factory=list, max_length=MAX_EVENTS)]


class Origin(BaseModel):
    """Where an asset came from when it isn't drawn from scratch: an AI variation of another asset."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    kind: Literal["variation"] = "variation"
    asset_id: str = Field(pattern=UUID_PATTERN)
    version: int = Field(ge=1, le=100_000)
    brief: str = Field(default="", max_length=200)
    kept: int = Field(default=0, ge=0, le=MAX_STROKES)
    added: int = Field(default=0, ge=0, le=MAX_STROKES)


class Frame(BaseModel):
    model_config = ConfigDict(extra="forbid")
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)


class Drawing(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)
    tags: list[Tag] = Field(default_factory=list, max_length=MAX_TAGS)

    _legacy = model_validator(mode="before")(upgrade_legacy)

    @model_validator(mode="after")
    def limits(self) -> "Drawing":
        check_layers(self.layers, require_ink=True)
        self.tags = list(dict.fromkeys(self.tags))
        return self


class Asset(BaseModel):
    """A reusable character, prop, or environment drawing."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80)
    type: AssetType = "prop"
    description: str = Field(default="", max_length=2000)
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)
    tags: list[Tag] = Field(default_factory=list, max_length=MAX_TAGS)
    origin: Origin | None = None
    history: History  # new events since the last save; the server appends them to the stored trail

    @model_validator(mode="after")
    def limits(self) -> "Asset":
        check_layers(self.layers, require_ink=True)
        if any(layer.asset for layer in self.layers):
            raise ValueError("Assets can't contain placed assets yet; flatten it into a drawing first.")
        self.tags = list(dict.fromkeys(self.tags))
        return self


class Shot(BaseModel):
    """A shot: production metadata next to the layered artwork (placed assets are linked layers)."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    code: Code
    project: Code
    sequence: Code
    status: ShotStatus = "todo"
    assignee: str = Field(default="", max_length=60)
    description: str = Field(default="", max_length=2000)
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)  # frame 1: thumbnail, vectors, elements
    # Frames 2..N of a flipbook animation; each frame has its own layer stack.
    frames: list[Frame] = Field(default_factory=list, max_length=MAX_FRAMES - 1)
    fps: Literal[4, 6, 8, 12, 24] = 12
    tags: list[Tag] = Field(default_factory=list, max_length=MAX_TAGS)
    history: History
    # How it moves, kept for the audit trail and for explaining it: who directed it, and the keyframes.
    motion: "MotionRecord | None" = Field(default=None, exclude_if=lambda value: value is None)

    def all_frames(self) -> list[list[Layer]]:
        """Every frame as plain layers (references to frame 1 resolved), for rendering, links, and search."""
        return [self.layers, *(expand_frame(self.layers, frame.layers) for frame in self.frames)]

    @model_validator(mode="after")
    def limits(self) -> "Shot":
        check_layers(self.layers, require_ink=True)
        for frame in self.frames:
            check_layers(frame.layers, require_ink=False, allow_refs=True)
            if any(layer.ref is not None and layer.ref >= len(self.layers) for layer in frame.layers):
                raise ValueError("A frame references a layer that frame 1 doesn't have.")
        self.tags = list(dict.fromkeys(self.tags))
        return self


class ShotUpdate(BaseModel):
    """Operational changes only: no artwork, so no re-embedding."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    status: ShotStatus | None = None
    assignee: str | None = Field(default=None, max_length=60)

    @model_validator(mode="after")
    def something(self) -> "ShotUpdate":
        if self.status is None and self.assignee is None:
            raise ValueError("Send a status or an assignee.")
        return self


class Region(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: Unit
    y: Unit
    w: float = Field(ge=0.02, le=1, allow_inf_nan=False)
    h: float = Field(ge=0.02, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def inside_canvas(self) -> "Region":
        if self.x + self.w > 1.0001 or self.y + self.h > 1.0001:
            raise ValueError("The spark region must lie inside the canvas.")
        return self


class SparkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    region: Region
    prompt: str = Field(default="", max_length=300)
    title: str = Field(default="", max_length=120)
    layers: list[Layer] = Field(default_factory=list, max_length=MAX_LAYERS)

    _legacy = model_validator(mode="before")(upgrade_legacy)

    @model_validator(mode="after")
    def limits(self) -> "SparkRequest":
        check_layers(self.layers, require_ink=False)
        return self


class MotionKey(BaseModel):
    """A keyframe: when (t, 0-1 of the clip), where (offset), squash and stretch, turn, and why (label)."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    t: Unit
    x: float = Field(ge=-1.5, le=1.5, allow_inf_nan=False)
    y: float = Field(ge=-1.5, le=1.5, allow_inf_nan=False)
    sx: float = Field(ge=0.03, le=4, allow_inf_nan=False)
    sy: float = Field(ge=0.03, le=4, allow_inf_nan=False)
    r: float = Field(ge=-1080, le=1080, allow_inf_nan=False)
    label: str = Field(default="", max_length=24)


class MotionTrack(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=40)
    keys: list[MotionKey] = Field(min_length=1, max_length=MAX_MOTION_KEYS)


class MotionRecord(BaseModel):
    """The direction behind a scene's motion: a preset or an AI choreography the artist accepted."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    by: Literal["ai", "preset"]
    prompt: str = Field(default="", max_length=300)
    note: str = Field(default="", max_length=160)
    seconds: float = Field(ge=0.5, le=10, allow_inf_nan=False)
    fps: Literal[4, 6, 8, 12, 24] = 8
    strength: float = Field(default=1, ge=0.2, le=2.5, allow_inf_nan=False)
    tracks: list[MotionTrack] = Field(min_length=1, max_length=4)


def fit_box(value):
    """A subject's ink box, pulled inside the canvas: ink (and its stroke width) can poke past an edge."""
    if not isinstance(value, dict) or not all(isinstance(value.get(k), (int, float)) for k in ("x", "y", "w", "h")):
        return value
    out = {}
    for pos, size in (("x", "w"), ("y", "h")):
        start = min(1.0, max(0.0, float(value[pos])))
        end = min(1.0, max(0.0, float(value[pos]) + float(value[size])))
        length = max(0.02, end - start)
        out[pos], out[size] = min(start, 1.0 - length), length
    return out


class MotionSubject(BaseModel):
    """A layer that should move: its index in the stack, its name, and where its ink sits (canvas fractions)."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: int = Field(ge=0, lt=MAX_LAYERS)
    name: str = Field(min_length=1, max_length=40)
    box: Region

    _fit = field_validator("box", mode="before")(fit_box)


class PriorMotionTrack(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject: int = Field(ge=0, lt=MAX_LAYERS)
    keys: list[MotionKey] = Field(min_length=1, max_length=MAX_MOTION_KEYS)


class PriorMotion(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    prompt: str = Field(default="", max_length=300)
    tracks: list[PriorMotionTrack] = Field(min_length=1, max_length=4)


class MotionRequest(BaseModel):
    """Ask AI to choreograph a short clip: keyframes for the artist's own layers, never new drawing."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    prompt: str = Field(min_length=3, max_length=300)
    seconds: float = Field(ge=0.5, le=10, allow_inf_nan=False)
    subjects: list[MotionSubject] = Field(min_length=1, max_length=4)
    layers: list[Layer] = Field(default_factory=list, max_length=MAX_LAYERS)
    previous: PriorMotion | None = None

    @model_validator(mode="after")
    def limits(self) -> "MotionRequest":
        check_layers(self.layers, require_ink=False)
        if len({subject.id for subject in self.subjects}) != len(self.subjects):
            raise ValueError("Each subject may appear once.")
        if self.previous:
            ids = [track.subject for track in self.previous.tracks]
            if len(set(ids)) != len(ids) or any(subject not in {s.id for s in self.subjects} for subject in ids):
                raise ValueError("Previous motion must match the selected drawings.")
        return self


class DirectRequest(BaseModel):
    """Ask AI to pitch a few shots for what's on the canvas: who moves, where, and what they do."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    seconds: float = Field(default=10, ge=1, le=10, allow_inf_nan=False)
    backdrop: str = Field(default="", max_length=40)
    subjects: list[MotionSubject] = Field(min_length=1, max_length=8)
    layers: list[Layer] = Field(default_factory=list, max_length=MAX_LAYERS)

    @model_validator(mode="after")
    def limits(self) -> "DirectRequest":
        check_layers(self.layers, require_ink=False)
        return self


class AnimateRequest(BaseModel):
    """One tap: AI pitches and choreographs, or follows the artist's prompt."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    prompt: str = Field(default="", max_length=300)
    title: str = Field(default="", max_length=60)
    seconds: float = Field(default=10, ge=1, le=10, allow_inf_nan=False)
    backdrop: str = Field(default="", max_length=40)
    subjects: list[MotionSubject] = Field(min_length=1, max_length=8)
    asset_ids: list[Annotated[str, Field(pattern=UUID_PATTERN)]] = Field(default_factory=list, max_length=8)
    layers: list[Layer] = Field(default_factory=list, max_length=MAX_LAYERS)
    previous: PriorMotion | None = None

    @model_validator(mode="after")
    def limits(self) -> "AnimateRequest":
        check_layers(self.layers, require_ink=False)
        if len({subject.id for subject in self.subjects}) != len(self.subjects):
            raise ValueError("Each subject may appear once.")
        if self.prompt and len(self.prompt) < 3:
            raise ValueError("Describe the motion in a few more words.")
        if self.prompt and len(self.subjects) > 4:
            raise ValueError("Pick up to 4 drawings to move.")
        if self.previous and not self.prompt:
            raise ValueError("Describe what to change in the animation.")
        if self.previous and any(track.subject not in {subject.id for subject in self.subjects}
                                 for track in self.previous.tracks):
            raise ValueError("Previous motion must belong to the selected drawings.")
        self.asset_ids = list(dict.fromkeys(self.asset_ids))
        return self


class ClipRequest(BaseModel):
    """Create or revise an AI-generated video inspired by the artist's scene."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    prompt: str = Field(default="", max_length=300)
    layers: list[Layer] = Field(default_factory=list, max_length=MAX_LAYERS)
    previous_id: Annotated[str, Field(pattern=UUID_PATTERN)] | None = None

    @model_validator(mode="after")
    def limits(self) -> "ClipRequest":
        if not self.previous_id:
            check_layers(self.layers, require_ink=True)
        if self.previous_id and len(self.prompt) < 3:
            raise ValueError("Describe what to change in the scene.")
        return self


class RefineIdeasRequest(BaseModel):
    """Ask AI what this drawing could use next: a few short, editable prompts."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(default="", max_length=120)
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)

    @model_validator(mode="after")
    def limits(self) -> "RefineIdeasRequest":
        check_layers(self.layers, require_ink=True)
        return self


class RefineRequest(BaseModel):
    """Refine one layer by editing the artist's strokes: keep what the prompt doesn't touch, add what it needs."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    prompt: str = Field(min_length=3, max_length=200)
    title: str = Field(default="", max_length=120)
    target: int = Field(ge=0, lt=MAX_LAYERS)
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)

    @model_validator(mode="after")
    def limits(self) -> "RefineRequest":
        check_layers(self.layers, require_ink=True)
        if self.target >= len(self.layers):
            raise ValueError("Pick a layer that exists.")
        layer = self.layers[self.target]
        if layer.asset:
            raise ValueError("Placed assets stay linked; refine the asset itself.")
        if not any(not stroke.erase for stroke in layer.strokes):
            raise ValueError("That layer has no ink to refine.")
        return self


class SketchRequest(BaseModel):
    """Ask AI for a blue-pencil starting layer; the artist accepts, edits, and draws over it."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    prompt: str = Field(min_length=3, max_length=200)
    title: str = Field(default="", max_length=120)
    layers: list[Layer] = Field(default_factory=list, max_length=MAX_LAYERS)

    @model_validator(mode="after")
    def limits(self) -> "SketchRequest":
        check_layers(self.layers, require_ink=False)
        return self


class LayersRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)

    @model_validator(mode="after")
    def limits(self) -> "LayersRequest":
        check_layers(self.layers, require_ink=True)
        return self


class VariationPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    goal: str = Field(min_length=3, max_length=200)
    count: int = Field(default=6, ge=1, le=9)


class VariationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    brief: str = Field(min_length=3, max_length=200)


class SketchSearch(BaseModel):
    """Search with a drawing: the visible ink is the query."""
    model_config = ConfigDict(extra="forbid")
    scope: Literal["asset", "shot", "frame", "clip", "idea"] = "frame"
    asset_type: AssetType | None = None
    animated: bool = False
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)

    @model_validator(mode="after")
    def limits(self) -> "SketchSearch":
        check_layers(self.layers, require_ink=True)
        return self


class TagRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=2000)
    layers: list[Layer] = Field(min_length=1, max_length=MAX_LAYERS)

    _legacy = model_validator(mode="before")(upgrade_legacy)

    @model_validator(mode="after")
    def limits(self) -> "TagRequest":
        check_layers(self.layers, require_ink=True)
        return self


Shot.model_rebuild()
