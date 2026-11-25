"""Assets, shots, and "where is this asset used?": operational metadata next to multimodal vectors.

Three Atlas collections, all embedded with Voyage through Cinematlas:

- ``assets``: reusable drawings (character, prop, environment...), versioned in place.
- ``shots``: layered artwork plus production metadata (project, sequence, status, assignee).
  One joint vector per shot answers scene-level questions ("a night chase on a rooftop").
- ``shot_elements``: one record per visible layer of a shot, cropped to its ink, with the shot's
  metadata copied in as vector-index filters. A small prop in a busy shot gets its own vector,
  so it isn't drowned out by the rest of the scene.
- ``shot_frames``: one record per frame of a scene (a flipbook), with the assets placed in that frame.
  "Find the moment the rocket clears the trees" searches frames, by words or by sketch. Frames are
  hashed, so a save only re-embeds the frames that actually changed.
Every collection shares one Voyage multimodal space, so a single query vector searches them all.

"Where used" combines exact links (layers placed from the asset) with visual similarity (the asset's
picture against every element, filtered by status/project/sequence *before* ranking). Changing a
shot's status or assignee only updates metadata: nothing is re-embedded.
"""

import base64
import hashlib
import json
import secrets
import time
from datetime import datetime, timezone
from uuid import uuid4

from gridfs import GridFSBucket
from bson.binary import Binary
from cinematlas.core import Image, Text
from cinematlas.core.collection import VECTOR_PATH

from pydantic import ValidationError

from backend.art import COLOR_FAMILIES, art_stats
from backend.library import CANVAS_HEIGHT, CANVAS_WIDTH, Library, LibraryError, Scoped, ink_crop, png_bytes, render_image
from backend.models import STATUS_LABELS, MAX_LAYERS, Asset, AssetLink, Frame, Layer, Shot, ShotUpdate, Stroke

ELEMENT_FIELDS = ("code", "project", "sequence", "status", "assignee")
SIMILAR_LIMIT = 24
SIMILAR_ASSETS = 6
MAX_TRAIL = 300  # stored audit-trail events per asset or shot (oldest dropped first)
# Search keeps hits close to the best one: measured relevant frames ~0.78 vs unrelated <= 0.69 for words,
# so a fixed top-k would pad results with noise.
SEARCH_SPREAD = 0.06
# A 10-second shot has 80 frames; neighbours look alike, so a sample keeps frame search sharp and cheap.
FRAME_VECTORS = 16


def sampled_frames(count: int) -> list[int]:
    """Which frames (0-based) get a vector: all of a short flipbook, an even spread of a long shot."""
    if count <= FRAME_VECTORS:
        return list(range(count))
    return sorted({round(i * (count - 1) / (FRAME_VECTORS - 1)) for i in range(FRAME_VECTORS)})


def close_to_best(hits: list, spread: float = SEARCH_SPREAD) -> list:
    hits = list(hits)
    if not hits:
        return hits
    floor = float(hits[0].score) - spread
    return [hit for hit in hits if float(hit.score) >= floor]


class ProductionError(ValueError):
    """The request is valid JSON but refers to something that doesn't exist or doesn't fit."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def event(by: str, action: str, detail: str = "") -> dict:
    return {"at": now(), "by": by, "action": action, "detail": detail[:240]}


def trail(previous: dict | None, *batches: list[dict]) -> list[dict]:
    """The stored audit trail plus this save's events, newest last, capped."""
    events = list((previous or {}).get("history", []))
    for batch in batches:
        events += batch
    return events[-MAX_TRAIL:]


def asset_summary(record: dict, uses: int | None = None) -> dict:
    origin = record.get("origin")
    return {
        "id": record["id"], "name": record["name"], "type": record["type"],
        "description": record.get("description", ""), "tags": record.get("tags", []),
        "version": record["version"], "updated_at": record["updated_at"],
        "image_url": f"/api/assets/{record['id']}/image?v={record['version']}",
        **({"uses": uses} if uses is not None else {}),
        **({"origin": {key: origin.get(key) for key in ("asset_id", "name", "version", "brief")}} if origin else {}),
        **({"stats": {key: record["stats"].get(key) for key in ("strokes", "hand_share", "draw_ms", "ink_px", "colors", "palette")}}
           if record.get("stats") else {}),
    }


def shot_summary(record: dict) -> dict:
    return {
        "id": record["id"], **{field: record.get(field, "") for field in ELEMENT_FIELDS},
        "description": record.get("description", ""), "tags": record.get("tags", []),
        "assets": record.get("assets", []), "updated_at": record["updated_at"],
        "frames": frame_count(record), "fps": record.get("fps", 12),
        "image_url": f"/api/shots/{record['id']}/image?t={record['updated_at']}",
    }


def remap_ids(value, ids: dict[str, str]):
    """A copy of a record with every old id swapped for its new one, wherever it appears."""
    if isinstance(value, str):
        if value in ids:
            return ids[value]
        head, sep, tail = value.partition(":")  # element ("{shot}:{layer}") and frame ("{shot}:f{n}") ids
        return f"{ids[head]}:{tail}" if sep and head in ids else value
    if isinstance(value, list):
        return value if value and isinstance(value[0], float) else [remap_ids(item, ids) for item in value]
    if isinstance(value, dict):
        return {key: remap_ids(item, ids) for key, item in value.items()}
    return value


def clip_summary(record: dict) -> dict:
    return {
        "id": record["id"], "name": record["name"], "prompt": record["prompt"], "brief": record.get("brief", ""),
        "revision": bool(record.get("previous_id")),
        "asset_ids": record.get("asset_ids", []), "updated_at": record["updated_at"],
        "image_url": f"/api/clips/{record['id']}/image",
        "video_url": f"/api/clips/{record['id']}/video",
    }


def metadata_filter(project: str | None, sequence: str | None, status: str | None) -> dict:
    """Atlas filters (vector-index filter fields and plain MQL alike). ``open`` = not approved."""
    where: dict = {}
    if project:
        where["project"] = project
    if sequence:
        where["sequence"] = sequence
    if status == "open":
        where["status"] = {"$ne": "approved"}
    elif status:
        where["status"] = status
    return where


def shot_story(shot: Shot, cast: list[str]) -> str:
    """What happens in a scene, in words: its direction, its beats, its cast, and its layers."""
    parts = []
    if shot.motion:
        parts.append(shot.motion.prompt or shot.motion.note)
        beats = dict.fromkeys(key.label for track in shot.motion.tracks for key in track.keys if key.label and key.label != "start")
        if beats:
            parts.append("Beats: " + ", ".join(beats))
        parts.append(f"{len(shot.frames) + 1} frames, {(len(shot.frames) + 1) / shot.fps:.0f} seconds of animation")
    if shot.sketch:
        parts.append(f"Generative code sketch: {shot.sketch.title}. {shot.sketch.prompt}")
        parts.append(f"{len(shot.frames) + 1} frames baked from code")
    if cast:
        parts.append("Cast: " + ", ".join(cast))
    names = dict.fromkeys(layer.name for layer in shot.layers if layer.visible and layer.strokes)
    if names:
        parts.append("Layers: " + ", ".join(names))
    return ". ".join(part.strip().rstrip(".") for part in parts if part and part.strip())


def frame_hash(layers: list[Layer]) -> str:
    return hashlib.sha256(json.dumps([layer.model_dump(mode="json") for layer in layers], sort_keys=True).encode()).hexdigest()


def frame_summary(record: dict) -> dict:
    return {
        "id": record["id"], "shot_id": record["shot_id"], "frame": record["frame"], "frames": record.get("frames", 1),
        **{field: record.get(field, "") for field in ELEMENT_FIELDS}, "assets": record.get("assets", []),
        "image_url": f"/api/shots/{record['shot_id']}/frames/{record['frame']}/image?h={record.get('hash', '')[:10]}",
        **({"score": round(float(record["score"]), 4)} if record.get("score") is not None else {}),
    }


def frame_count(record: dict) -> int:
    return 1 + len(record.get("frames", []))


def element_records(shot_id: str, shot: Shot, links: dict[str, dict]) -> list[dict]:
    """One record per visible layer with ink, cropped to that ink, carrying the shot's metadata."""
    records = []
    for index, layer in enumerate(shot.layers):
        if not layer.visible:
            continue
        crop = ink_crop([layer.model_copy(update={"opacity": 1.0})])
        if crop is None:
            continue
        image, box = crop
        link = layer.asset
        records.append({
            "id": f"{shot_id}:{index}", "shot_id": shot_id, "layer_index": index, "layer_name": layer.name,
            "asset_id": link.asset_id if link else None,
            "asset_name": links[link.asset_id]["name"] if link else None,
            "asset_version": link.version if link else None,
            "box": box, **{field: getattr(shot, field) for field in ELEMENT_FIELDS},
            "image": png_bytes(image),
        })
    return records


def stroke_bounds(strokes: list[Stroke]) -> tuple[float, float, float, float] | None:
    """Pixel bounds of the ink (half the line width included), like the studio's inkBounds."""
    xs, ys = [], []
    for stroke in strokes:
        if stroke.erase:
            continue
        pad = stroke.width / 2
        for point in stroke.points:
            x, y = point.x * CANVAS_WIDTH, point.y * CANVAS_HEIGHT
            xs += [x - pad, x + pad]
            ys += [y - pad, y + pad]
    if not xs:
        return None
    return min(xs), min(ys), max(max(xs) - min(xs), 1), max(max(ys) - min(ys), 1)


def fit_strokes(strokes: list[Stroke], target: tuple[float, float, float, float]) -> list[Stroke]:
    """Fits strokes into a pixel box (aspect kept, centered), like the studio's Place tool."""
    source = stroke_bounds(strokes)
    if source is None:
        return []
    sx, sy, sw, sh = source
    tx, ty, tw, th = target
    k = min(tw / sw, th / sh)
    ox, oy = tx + (tw - sw * k) / 2, ty + (th - sh * k) / 2
    clamp = lambda v: min(1.0, max(0.0, v))  # noqa: E731
    return [stroke.model_copy(update={
        "width": min(40.0, max(1.0, stroke.width * k)),
        "points": [point.model_copy(update={
            "x": clamp((ox + (point.x * CANVAS_WIDTH - sx) * k) / CANVAS_WIDTH),
            "y": clamp((oy + (point.y * CANVAS_HEIGHT - sy) * k) / CANVAS_HEIGHT)}) for point in stroke.points],
    }) for stroke in strokes]


def group_where_used(asset: dict, linked: list[dict], similar: list[dict], min_score: float) -> dict:
    """Exact links first (with outdated-version flags), then visually similar shots, one entry per shot."""
    def entry(row: dict, match: str, score: float | None = None) -> dict:
        placed = row.get("asset_version")
        return {
            "shot_id": row["shot_id"], **{field: row.get(field, "") for field in ELEMENT_FIELDS},
            "layer_name": row.get("layer_name"), "layer_index": row.get("layer_index"), "box": row.get("box"), "match": match,
            "score": score, "placed_version": placed,
            "outdated": match == "linked" and placed is not None and placed < asset["version"],
            "image_url": f"/api/shots/{row['shot_id']}/image",
        }

    linked_shots: dict[str, dict] = {}
    for row in linked:
        linked_shots.setdefault(row["shot_id"], entry(row, "linked"))
    similar_shots: dict[str, dict] = {}
    for row in similar:
        score = float(row.get("score") or 0)
        shot_id = row["shot_id"]
        if shot_id in linked_shots or row.get("asset_id") == asset["id"] or score < min_score:
            continue
        if shot_id not in similar_shots or score > similar_shots[shot_id]["score"]:
            similar_shots[shot_id] = entry(row, "similar", round(score, 4))
    return {
        "asset": asset_summary(asset),
        "linked": sorted(linked_shots.values(), key=lambda e: e["code"]),
        "similar": sorted(similar_shots.values(), key=lambda e: -e["score"]),
        "min_score": min_score,
    }


class Production(Scoped):
    def __init__(self, library: Library, *, min_score: float = 0.0, asset_min_score: float = 0.0) -> None:
        self.library = library
        self.min_score = min_score
        self.asset_min_score = asset_min_score
        atlas = library.atlas
        self.assets = atlas.collection(
            "assets",
            embed=Text("name") + Text("type", label="Type") + Text("description")
            + Text("tags", label="Tags") + Image("image"),
            key="id", filters=["owner", "type", "tags", "hand_share", "colors"],
        )
        # Every saved version, kept as it was: the path from first doodle to finished asset.
        self.versions = self.assets.mongo.database["asset_versions"]
        self.shots = atlas.collection(
            "shots",
            # "Story" is what happens in it (the direction, the beats, the cast), so scenes are found by
            # what they're about as well as by how they look: "the fox hops on the beach".
            embed=Text("code") + Text("description") + Text("tags", label="Tags") + Text("story", label="Story") + Image("image"),
            key="id", filters=["owner", "project", "sequence", "status", "asset_ids"],
        )
        self.elements = atlas.collection(
            "shot_elements", embed=Image("image"), key="id",
            filters=["owner", "project", "sequence", "status", "asset_id", "shot_id"],
        )
        self.frames = atlas.collection(
            "shot_frames", embed=Image("image"), key="id",
            filters=["owner", "project", "sequence", "status", "shot_id", "asset_ids", "frames"],
        )
        self.clips = atlas.collection(
            "clips", embed=Text("name") + Text("story", label="Direction") + Image("image"),
            key="id", filters=["owner", "asset_ids"],
        )
        self.clip_media = GridFSBucket(self.assets.mongo.database, bucket_name="clip_media")
        # Public snapshots of scenes (a GIF and its explanation), found only by their unguessable token.
        self.shares = self.assets.mongo.database["shares"]

    def scoped(self, owner: str) -> "Production":
        view = super().scoped(owner)
        view.library = self.library.scoped(owner)
        return view

    @property
    def collections(self) -> list:
        return [self.assets, self.shots, self.elements, self.frames, self.clips]

    def _add(self, collection, records: list[dict], what: str) -> None:
        if not records:
            return
        result = collection.add(records, retries=1)
        if result.added != len(records) or result.failed or result.skipped:
            raise LibraryError(f"{what} embedding failed; no save was confirmed.")

    def get_clip(self, clip_id: str) -> dict | None:
        return self.clips.mongo.find_one(self.q({"id": clip_id}), {"_id": 0, "embedding": 0})

    def validate_clip_layers(self, layers: list[Layer]) -> None:
        links = [layer.asset for layer in layers if layer.asset]
        for link in links:
            if not self.assets.mongo.find_one(self.q({"id": link.asset_id}), {"_id": 1}):
                raise ProductionError("An asset in this scene is no longer available.")

    def save_clip(self, layers: list[Layer], prompt: str, interaction_id: str, video: bytes,
                  previous: dict | None = None, *, brief: str = "") -> dict:
        self.validate_clip_layers(layers)
        links = [layer.asset for layer in layers if layer.asset]
        name = (previous or {}).get("name") or next(
            (layer.name for layer in layers if layer.asset), "My scene")
        story = "\n".join(filter(None, [(previous or {}).get("story", ""), prompt]))[-2000:]
        image = png_bytes(render_image(layers))
        media_id = self.clip_media.upload_from_stream("scene.mp4", video)
        record = {
            "id": str(uuid4()), "owner": self.q()["owner"], "name": name, "prompt": prompt,
            "story": story, "brief": brief[:2000], "layers": [layer.model_dump() for layer in layers],
            "asset_ids": list(dict.fromkeys(link.asset_id for link in links)),
            "interaction_id": interaction_id, "media_id": media_id,
            "image": image, "png": base64.b64encode(image).decode("ascii"),
            "updated_at": now(), "previous_id": (previous or {}).get("id"),
        }
        try:
            self._add(self.clips, [record], "Scene")
        except Exception:
            self.clip_media.delete(media_id)
            raise
        return clip_summary(record)

    def list_clips(self, query: str = "") -> list[dict]:
        if query:
            return [clip_summary(hit) for hit in close_to_best(
                self.clips.search(query).rerank(False).limit(24).where(**self.q()))]
        rows = self.clips.mongo.find(self.q(), {"_id": 0, "embedding": 0, "png": 0, "image": 0,
                                                "layers": 0}).sort("updated_at", -1).limit(24)
        return [clip_summary(row) for row in rows]

    def search_clips(self, picture) -> list[dict]:
        return [clip_summary(hit) for hit in close_to_best(
            self.clips.search(picture).rerank(False).limit(24).where(**self.q()))]

    # ------------------------------------------------------------------ assets
    def save_asset(self, asset: Asset, asset_id: str | None = None) -> dict:
        previous = self.get_asset(asset_id) if asset_id else None
        if asset_id and previous is None:
            raise ProductionError("Asset not found.")
        new_id = asset_id or str(uuid4())
        origin = self._origin(asset, new_id) or (previous or {}).get("origin")
        version = previous["version"] + 1 if previous else 1
        server = [event("studio", "Saved", f"v{version}")]
        if asset.origin and not (previous and previous.get("origin")):
            server.insert(0, event("ai", "Variation", (
                f"of {origin['name']} v{origin['version']}: {origin['brief']} "
                f"(kept {origin['kept']} of the artist's strokes, added {origin['added']})")))
        image = png_bytes(render_image(asset.layers))
        stamp = now()
        stats = art_stats(asset.layers)
        record = {
            **asset.model_dump(), "id": new_id, "owner": self.q()["owner"], "stats": stats,
            "hand_share": stats["hand_share"], "colors": stats["colors"],
            # Saving over an asset makes a new version; shots that placed an older one get flagged.
            "version": version, "origin": origin,
            "history": trail(previous, [e.model_dump() for e in asset.history], server),
            "created_at": previous["created_at"] if previous else stamp, "updated_at": stamp,
            "image": image, "png": base64.b64encode(image).decode("ascii"),
        }
        self._add(self.assets, [record], "Asset")
        self.snapshot_version(record)
        return asset_summary(record)

    def snapshot_version(self, record: dict) -> None:
        self.versions.replace_one(self.q({"asset_id": record["id"], "version": record["version"]}), {
            "asset_id": record["id"], "owner": self.q()["owner"], "version": record["version"], "name": record["name"], "layers": record["layers"],
            "stats": record.get("stats") or art_stats([Layer.model_validate(layer) for layer in record["layers"]]),
            "png": record["png"], "saved_at": record["updated_at"],
        }, upsert=True)

    def asset_versions(self, asset_id: str) -> list[dict]:
        rows = self.versions.find(self.q({"asset_id": asset_id}), {"_id": 0, "png": 0, "layers": 0, "owner": 0}).sort("version", 1)
        return [{**row, "image_url": f"/api/assets/{asset_id}/versions/{row['version']}/image"} for row in rows]

    def version_png(self, asset_id: str, version: int) -> str | None:
        row = self.versions.find_one(self.q({"asset_id": asset_id, "version": version}), {"_id": 0, "png": 1})
        return row["png"] if row else None

    def _origin(self, asset: Asset, asset_id: str) -> dict | None:
        if asset.origin is None:
            return None
        parent = self.get_asset(asset.origin.asset_id)
        if parent is None or parent["id"] == asset_id:
            raise ProductionError("The asset this is a variation of no longer exists.")
        if asset.origin.version > parent["version"]:
            raise ProductionError(f"Asset {parent['name']!r} has no version {asset.origin.version}.")
        return {**asset.origin.model_dump(), "name": parent["name"]}

    def family(self, asset: dict) -> dict:
        """Lineage, exactly: the asset it was varied from, and the variations made from it."""
        origin = asset.get("origin") or {}
        parent = self.get_asset(origin["asset_id"]) if origin.get("asset_id") else None
        light = {"_id": 0, "embedding": 0, "png": 0, "layers": 0, "image": 0, "history": 0}
        variants = list(self.assets.mongo.find(self.q({"origin.asset_id": asset["id"]}), light).sort("updated_at", -1).limit(60))
        siblings = list(self.assets.mongo.find(
            self.q({"origin.asset_id": parent["id"], "id": {"$ne": asset["id"]}}), light).sort("updated_at", -1).limit(60)) if parent else []
        return {
            "parent": {**asset_summary(parent), "from_version": origin.get("version"), "brief": origin.get("brief", "")}
            if parent else None,
            "variants": [asset_summary(variant) for variant in variants],
            "siblings": [asset_summary(sibling) for sibling in siblings],
        }

    def get_asset(self, asset_id: str) -> dict | None:
        return self.assets.mongo.find_one(self.q({"id": asset_id}), {"_id": 0, "embedding": 0})

    def usage_counts(self, asset_ids: list[str]) -> dict[str, int]:
        # The shot's own links are the source of truth: a hidden or fully erased placement has no
        # element (nothing to embed) but still uses the asset.
        pipeline = [
            {"$match": self.q({"asset_ids": {"$in": asset_ids}})},
            {"$unwind": "$asset_ids"},
            {"$match": {"asset_ids": {"$in": asset_ids}}},
            {"$group": {"_id": "$asset_ids", "shots": {"$sum": 1}}},
        ]
        return {row["_id"]: row["shots"] for row in self.shots.mongo.aggregate(pipeline)}

    def list_assets(self, query: str = "", asset_type: str | None = None, *, hand_min: float | None = None,
                    color: str | None = None) -> list[dict]:
        """Assets by words (vector search) or latest first, filtered by type and by how they were made."""
        where: dict = self.q()
        if asset_type:
            where["type"] = asset_type
        if hand_min is not None:
            where["hand_share"] = {"$gte": hand_min}
        if color:
            if color not in COLOR_FAMILIES:
                raise ProductionError(f"color must be one of {', '.join(COLOR_FAMILIES)}.")
            where["colors"] = color
        if query:
            records = list(self.assets.search(query).rerank(False).limit(24).where(**where))
        else:
            records = list(self.assets.mongo.find(
                where, {"_id": 0, "embedding": 0, "png": 0, "layers": 0},
            ).sort("updated_at", -1).limit(60))
        uses = self.usage_counts([record["id"] for record in records])
        return [asset_summary(record, uses.get(record["id"], 0)) for record in records]

    # ------------------------------------------------------------------ shots
    def _links(self, shot: Shot) -> dict[str, dict]:
        wanted: dict[str, int] = {}  # highest placed version per asset, across every frame
        for layer in (layer for frame in shot.all_frames() for layer in frame):
            if layer.asset:
                wanted[layer.asset.asset_id] = max(layer.asset.version, wanted.get(layer.asset.asset_id, 0))
        if not wanted:
            return {}
        found = {record["id"]: record for record in self.assets.mongo.find(
            self.q({"id": {"$in": list(wanted)}}), {"_id": 0, "id": 1, "name": 1, "version": 1})}
        for asset_id, version in wanted.items():
            if asset_id not in found:
                raise ProductionError("A placed asset no longer exists. Remove that layer or re-place it.")
            if version > found[asset_id]["version"]:
                raise ProductionError(f"Asset {found[asset_id]['name']!r} has no version {version}.")
        return found

    def save_shot(self, shot: Shot, shot_id: str | None = None, events: list[dict] | None = None) -> dict:
        # The full previous document (embedding included) so a failed update can be undone exactly.
        previous = self.shots.mongo.find_one(self.q({"id": shot_id}), {"_id": 0}) if shot_id else None
        if shot_id and previous is None:
            raise ProductionError("Shot not found.")
        links = self._links(shot)
        new_id = shot_id or str(uuid4())
        image = png_bytes(render_image(shot.layers))
        stamp = now()
        placed: dict[str, int] = {}
        for layer in (layer for frame in shot.all_frames() for layer in frame):
            if layer.asset:  # the oldest placement (in any frame) decides whether the shot is outdated
                placed[layer.asset.asset_id] = min(layer.asset.version, placed.get(layer.asset.asset_id, layer.asset.version))
        frames = 1 + len(shot.frames)
        server = events if events is not None else [event("studio", "Saved", (
            f"{frames} frame{'s' if frames != 1 else ''} at {shot.fps} fps, " if frames > 1 else "")
            + f"{len(shot.layers)} layer{'s' if len(shot.layers) != 1 else ''}" + (" in frame 1" if frames > 1 else ""))]
        record = {
            **shot.model_dump(), "id": new_id, "owner": self.q()["owner"],
            "history": trail(previous, [e.model_dump() for e in shot.history], server),
            "asset_ids": list(placed),
            "assets": [{"id": asset_id, "name": links[asset_id]["name"], "version": version}
                       for asset_id, version in placed.items()],
            "created_at": previous["created_at"] if previous else stamp, "updated_at": stamp,
            "image": image, "png": base64.b64encode(image).decode("ascii"),
            "story": shot_story(shot, [links[asset_id]["name"] for asset_id in placed]),
        }
        elements = [{**element, "owner": record["owner"]} for element in element_records(new_id, shot, links)]
        self._add(self.shots, [record], "Shot")
        try:
            self._add(self.elements, elements, "Shot element")
            self.index_frames(new_id, shot, links)
        except Exception:
            # Never leave a shot whose elements disagree with it (links, status, boxes).
            if previous is None:
                self.shots.mongo.delete_one(self.q({"id": new_id}))
            else:
                self.shots.mongo.replace_one(self.q({"id": new_id}), previous)
            raise
        # Upserts replaced same-index elements; drop layers that no longer exist or lost their ink.
        self.elements.mongo.delete_many(self.q({"shot_id": new_id, "id": {"$nin": [e["id"] for e in elements]}}))
        return {**shot_summary(record), "elements": len(elements)}

    def index_frames(self, shot_id: str, shot: Shot, links: dict[str, dict]) -> int:
        """One vector per frame. Unchanged frames (same hash) only get their metadata refreshed. Returns embeds."""
        stacks = shot.all_frames()
        stored = {row["id"]: row.get("hash") for row in self.frames.mongo.find(
            self.q({"shot_id": shot_id}), {"_id": 0, "id": 1, "hash": 1})}
        fresh, keep = [], []
        for index in sampled_frames(len(stacks)):
            number, layers = index + 1, stacks[index]
            frame_id, digest = f"{shot_id}:f{number}", frame_hash(layers)
            placed = list(dict.fromkeys(layer.asset.asset_id for layer in layers if layer.asset))
            meta = {
                "shot_id": shot_id, "owner": self.q()["owner"], "frame": number, "frames": len(stacks), "hash": digest, "asset_ids": placed,
                "assets": [{"id": a, "name": links[a]["name"]} for a in placed], "updated_at": now(),
                **{field: getattr(shot, field) for field in ELEMENT_FIELDS},
            }
            if stored.get(frame_id) == digest:
                self.frames.mongo.update_one(self.q({"id": frame_id}), {"$set": meta})
                keep.append(frame_id)
                continue
            image = png_bytes(render_image(layers))
            fresh.append({"id": frame_id, **meta, "image": image, "png": base64.b64encode(image).decode("ascii")})
            keep.append(frame_id)
        self._add(self.frames, fresh, "Frame")
        self.frames.mongo.delete_many(self.q({"shot_id": shot_id, "id": {"$nin": keep}}))
        return len(fresh)

    def find_frames(self, query=None, *, asset_id: str | None = None, project: str | None = None,
                    sequence: str | None = None, status: str | None = None, limit: int = 24,
                    animated: bool = False) -> list[dict]:
        """Frames by words or by picture (vector search), by placed asset (exact), or the latest ones."""
        where = self.q(metadata_filter(project, sequence, status))
        if animated:
            where["frames"] = {"$gte": 2}
        if asset_id:
            where["asset_ids"] = asset_id
        if query is not None:
            search = self.frames.search(query).rerank(False).limit(limit).where(**where)
            return [frame_summary({**dict(hit), "score": hit.score}) for hit in close_to_best(search)]
        rows = self.frames.mongo.find(where, {"_id": 0, "embedding": 0, "png": 0, "image": 0}).sort(
            [("updated_at", -1), ("shot_id", 1), ("frame", 1)]).limit(60)
        return [frame_summary(row) for row in rows]

    def frame_png(self, shot_id: str, frame: int) -> str | None:
        row = self.frames.mongo.find_one(self.q({"id": f"{shot_id}:f{frame}"}), {"_id": 0, "png": 1})
        return row["png"] if row else None

    def search_assets(self, picture, limit: int = 24, *, asset_type: str | None = None) -> list[dict]:
        where = self.q({"type": asset_type} if asset_type else {})
        hits = close_to_best(self.assets.search(picture).rerank(False).limit(limit).where(**where), 0.1)
        uses = self.usage_counts([hit["id"] for hit in hits])
        return [{**asset_summary(hit, uses.get(hit["id"], 0)), "score": round(float(hit.score), 4)} for hit in hits]

    def search_shots(self, picture, limit: int = 24) -> list[dict]:
        return [{**shot_summary(hit), "score": round(float(hit.score), 4)}
                for hit in close_to_best(self.shots.search(picture).rerank(False).limit(limit).where(**self.q()))]

    # ------------------------------------------------------------------ one vector, every collection
    # Cinematlas' search embeds the query per collection; these reuse a single vector instead (private
    # helpers of the pinned cinematlas version: _query_vector, _vector_search, _embed, _document, _write).
    def _nearest(self, collection, vector, k: int, where: dict, spread: float | None = None) -> list[dict]:
        rows = collection._vector_search(VECTOR_PATH, vector, k, where)
        if rows and spread is not None:
            floor = float(rows[0]["score"]) - spread
            rows = [row for row in rows if float(row["score"]) >= floor]
        return rows

    def _found(self, assets: list[dict], scenes: list[dict], frames: list[dict]) -> dict:
        uses = self.usage_counts([row["id"] for row in assets])
        score = lambda row: {"score": round(float(row["score"]), 4)}  # noqa: E731
        return {"assets": [{**asset_summary(row, uses.get(row["id"], 0)), **score(row)} for row in assets],
                "scenes": [{**shot_summary(row), **score(row)} for row in scenes],
                "frames": [frame_summary(row) for row in frames]}

    def find_everywhere(self, query: str) -> dict:
        """Words become one Voyage vector; Atlas Vector Search runs it on drawings, animations, and frames."""
        started = time.perf_counter()
        vector = self.assets._query_vector([query])
        embedded = time.perf_counter()
        found = self._found(self._nearest(self.assets, vector, 12, self.q(), SEARCH_SPREAD),
                            self._nearest(self.shots, vector, 8, self.q(), SEARCH_SPREAD),
                            self._nearest(self.frames, vector, 24, self.q(), SEARCH_SPREAD))
        clips = [clip_summary(row) for row in self._nearest(self.clips, vector, 8, self.q(), SEARCH_SPREAD)]
        return {**found, "clips": clips, "timing": {"embed_ms": round((embedded - started) * 1000),
                                    "search_ms": round((time.perf_counter() - embedded) * 1000), "embeddings": 1}}

    def similar_everywhere(self, asset_id: str) -> dict:
        """Look-alikes with zero new embeddings: the asset's own vector, already in Atlas, is the query."""
        doc = self.assets.mongo.find_one(self.q({"id": asset_id}), {"_id": 0, "id": 1, "name": 1, VECTOR_PATH: 1})
        if doc is None:
            raise ProductionError("Asset not found.")
        vector = doc.get(VECTOR_PATH)
        if isinstance(vector, Binary):
            vector = vector.as_vector().data
        if not vector:
            raise ProductionError("This asset has no vector yet. Save it again.")
        started = time.perf_counter()
        assets = [row for row in self._nearest(self.assets, list(vector), 9, self.q()) if row["id"] != asset_id][:8]
        linked = list(self.frames.mongo.aggregate([
            {"$match": self.q({"asset_ids": asset_id, "frames": {"$gte": 2}})},
            {"$sort": {"updated_at": -1, "frame": 1}},
            {"$group": {"_id": "$shot_id", "frame": {"$first": "$$ROOT"}}},
            {"$replaceRoot": {"newRoot": "$frame"}},
            {"$sort": {"updated_at": -1}},
            {"$limit": 12},
            {"$project": {"_id": 0, "embedding": 0, "png": 0, "image": 0}},
        ]))
        matches = self._nearest(self.frames, list(vector), 12, self.q({"frames": {"$gte": 2}}), 0.12)
        seen = {row["id"] for row in linked}
        found = self._found(assets, [], linked + [row for row in matches if row["id"] not in seen])
        clips = self.clips.mongo.find(self.q({"asset_ids": asset_id}), {"_id": 0}).sort("updated_at", -1).limit(12)
        return {**found, "clips": [clip_summary(row) for row in clips], "of": {"id": doc["id"], "name": doc["name"]},
                "timing": {"embed_ms": 0, "search_ms": round((time.perf_counter() - started) * 1000), "embeddings": 0}}

    def _shot_model(self, shot_id: str) -> Shot:
        record = self.get_shot(shot_id)
        if record is None:
            raise ProductionError("Shot not found.")
        fields = ("code", "project", "sequence", "status", "assignee", "description", "tags", "layers", "frames", "fps", "motion", "sketch")
        return Shot.model_validate({field: record[field] for field in fields if field in record})

    def sync_asset(self, shot_id: str, asset_id: str) -> dict:
        """Swap the latest version of an asset into every older placement in a shot (every frame), at the same spot.

        Each replaced placement is kept as a hidden, unlinked "backup" layer when there's room,
        so nothing the artist drew is ever lost.
        """
        asset = self.get_asset(asset_id)
        if asset is None:
            raise ProductionError("Asset not found.")
        shot = self._shot_model(shot_id)
        latest = [stroke for layer in (Layer.model_validate(raw) for raw in asset["layers"]) if layer.visible
                  for stroke in layer.strokes]

        def swap(frame: list[Layer], keep_backups: bool, moved: dict[int, int] | None = None, bumped: frozenset = frozenset()):
            """Older placements get the latest art in the same spot (a hidden backup keeps the old art).

            Layers that reference frame 1 need no new art (they pose frame 1's, which was just updated):
            they're re-pointed past any inserted backups and re-versioned. Returns the new layers, counts,
            where each input layer landed, and which inputs were updated.
            """
            layers, updated, backups, positions, swapped = [], 0, 0, {}, set()
            room = MAX_LAYERS - len(frame) if keep_backups else 0
            for index, layer in enumerate(frame):
                link = layer.asset
                outdated = bool(link and link.asset_id == asset_id and link.version < asset["version"])
                if layer.ref is not None:
                    follows = outdated and layer.ref in bumped
                    layers.append(layer.model_copy(update={"ref": moved[layer.ref], **(
                        {"asset": AssetLink(asset_id=asset_id, version=asset["version"])} if follows else {})}))
                    updated += follows
                    continue
                target = stroke_bounds(layer.strokes) if outdated else None
                if target is None:
                    positions[index] = len(layers)
                    layers.append(layer)
                    continue
                if backups < room:
                    layers.append(layer.model_copy(update={
                        "name": f"{layer.name[:28]} (v{link.version} backup)", "visible": False, "asset": None}))
                    backups += 1
                positions[index] = len(layers)
                swapped.add(index)
                layers.append(layer.model_copy(update={
                    "strokes": fit_strokes(latest, target), "asset": AssetLink(asset_id=asset_id, version=asset["version"])}))
                updated += 1
            return layers, updated, backups, positions, frozenset(swapped)

        def rebuild(keep_backups: bool) -> tuple[Shot, int, int]:
            first, updated, backups, moved, bumped = swap(shot.layers, keep_backups)
            rest = []
            for frame in shot.frames:
                layers, u, b, _, _ = swap(frame.layers, keep_backups, moved, bumped)
                rest.append(layers)
                updated, backups = updated + u, backups + b
            new_shot = Shot.model_validate({
                **shot.model_dump(), "history": [], "layers": [layer.model_dump() for layer in first],
                "frames": [Frame(layers=layers).model_dump() for layers in rest]})
            return new_shot, updated, backups

        try:
            new_shot, updated, backups = rebuild(True)
        except ValidationError:  # backups pushed it past the stroke/point limits: update without them
            new_shot, updated, backups = rebuild(False)
        if not updated:
            raise ProductionError(f"This shot already uses the latest version of {asset['name']!r}.")
        frames = len(shot.all_frames())
        saved = self.save_shot(new_shot, shot_id, [event("studio", "Updated asset", (
            f"{asset['name']} to v{asset['version']} in {updated} placement{'s' if updated != 1 else ''}"
            + (f" across {frames} frames" if frames > 1 else "") + (" (old art kept as hidden backups)" if backups else "")))])
        return {**saved, "updated": updated, "backups": backups, "version": asset["version"]}

    def link_layer(self, shot_id: str, layer_index: int, asset_id: str) -> dict:
        """The artist confirms a look-alike *is* this asset: the layer becomes a linked use (art unchanged)."""
        asset = self.get_asset(asset_id)
        if asset is None:
            raise ProductionError("Asset not found.")
        shot = self._shot_model(shot_id)
        if not 0 <= layer_index < len(shot.layers):
            raise ProductionError("That layer no longer exists in the shot. Search again.")
        layer = shot.layers[layer_index]
        if layer.asset and layer.asset.asset_id != asset_id:
            raise ProductionError("That layer is already linked to a different asset.")
        layers = list(shot.layers)
        layers[layer_index] = layer.model_copy(update={"asset": AssetLink(asset_id=asset_id, version=asset["version"])})
        new_shot = shot.model_copy(update={"layers": layers})
        return self.save_shot(new_shot, shot_id, [event(
            "artist", "Confirmed look-alike", f"layer {layer.name!r} is {asset['name']} (now linked to v{asset['version']})")])

    def update_shot(self, shot_id: str, update: ShotUpdate) -> dict:
        changes = update.model_dump(exclude_none=True)
        stamp = now()
        notes = [f"status {STATUS_LABELS[update.status]}"] if update.status else []
        if update.assignee is not None:
            notes.append(f"artist {update.assignee or 'unassigned'}")
        result = self.shots.mongo.update_one(self.q({"id": shot_id}), {
            "$set": {**changes, "updated_at": stamp},
            "$push": {"history": {"$each": [event("artist", "Changed", ", ".join(notes))], "$slice": -MAX_TRAIL}}})
        if result.matched_count == 0:
            raise ProductionError("Shot not found.")
        self.elements.mongo.update_many(self.q({"shot_id": shot_id}), {"$set": changes})
        self.frames.mongo.update_many(self.q({"shot_id": shot_id}), {"$set": changes})
        return shot_summary(self.get_shot(shot_id))

    def delete_shot(self, shot_id: str) -> None:
        if self.shots.mongo.delete_one(self.q({"id": shot_id})).deleted_count == 0:
            raise ProductionError("Shot not found.")
        self.elements.mongo.delete_many(self.q({"shot_id": shot_id}))
        self.frames.mongo.delete_many(self.q({"shot_id": shot_id}))
        self.shares.delete_many(self.q({"shot_id": shot_id}))

    # ------------------------------------------------------------------ sharing
    def share_shot(self, shot_id: str) -> dict:
        """Snapshot a scene for a public link: a looping GIF plus what's needed to explain it. Re-sharing
        refreshes the snapshot and keeps the link."""
        from backend.share import render_clip

        record = self.get_shot(shot_id)
        if record is None:
            raise ProductionError("Shot not found.")
        shot = self._shot_model(shot_id)
        stacks = shot.all_frames()
        clip, poster = render_clip(stacks, shot.fps)
        existing = self.shares.find_one(self.q({"shot_id": shot_id}), {"token": 1})
        token = existing["token"] if existing else secrets.token_urlsafe(12)
        stamp = now()
        self.shares.update_one(self.q({"shot_id": shot_id}), {"$set": {
            "token": token, "code": shot.code, "description": shot.description[:200], "fps": shot.fps, "frames": len(stacks),
            "motion": shot.motion.model_dump() if shot.motion else None, "cast": [a["name"] for a in record.get("assets", [])],
            "gif": clip, "poster": poster, "updated_at": stamp}, "$setOnInsert": {"created_at": stamp}}, upsert=True)
        return {"token": token, "frames": len(stacks), "bytes": len(clip)}

    def share_of(self, shot_id: str) -> str | None:
        found = self.shares.find_one(self.q({"shot_id": shot_id}), {"token": 1})
        return found["token"] if found else None

    def unshare(self, shot_id: str) -> None:
        self.shares.delete_many(self.q({"shot_id": shot_id}))

    def shared(self, token: str, *fields: str) -> dict | None:
        """A public snapshot by its token. Deliberately not owner-scoped: the token is the permission."""
        projection = {"_id": 0, **{field: 1 for field in fields}} if fields else {"_id": 0, "owner": 0}
        return self.shares.find_one({"token": token}, projection)

    def delete_asset(self, asset_id: str) -> None:
        uses = self.usage_counts([asset_id]).get(asset_id, 0)
        if uses:
            raise ProductionError(f"This asset is placed in {uses} shot{'s' if uses != 1 else ''}; remove those layers first.")
        if self.assets.mongo.delete_one(self.q({"id": asset_id})).deleted_count == 0:
            raise ProductionError("Asset not found.")
        self.versions.delete_many(self.q({"asset_id": asset_id}))

    def get_shot(self, shot_id: str) -> dict | None:
        return self.shots.mongo.find_one(self.q({"id": shot_id}), {"_id": 0, "embedding": 0})

    def list_shots(self, query: str = "", project: str | None = None, sequence: str | None = None,
                   status: str | None = None) -> list[dict]:
        where = self.q(metadata_filter(project, sequence, status))
        if query:
            records = list(self.shots.search(query).rerank(False).limit(24).where(**where))
        else:
            records = list(self.shots.mongo.find(
                where, {"_id": 0, "embedding": 0, "png": 0, "layers": 0}).sort([("sequence", 1), ("code", 1)]).limit(200))
        return [shot_summary(record) for record in records]

    # ------------------------------------------------------------------ where used
    def where_used(self, asset_id: str, *, project: str | None = None, sequence: str | None = None,
                   status: str | None = None) -> dict:
        asset = self.get_asset(asset_id)
        if asset is None:
            raise ProductionError("Asset not found.")
        where = self.q(metadata_filter(project, sequence, status))
        linked = self._linked(asset_id, where)
        crop = ink_crop([Layer.model_validate(layer) for layer in asset["layers"]])
        similar = []
        if crop is not None:
            # Placed copies score highest and are dropped afterwards, so fetch past them.
            placed = self.elements.mongo.count_documents({"asset_id": asset_id, **where})
            search = self.elements.search(crop[0]).rerank(False).limit(min(500, SIMILAR_LIMIT * 2 + placed)).where(**where)
            similar = [dict(hit) for hit in search]
        result = group_where_used(asset, linked, similar, self.min_score)
        family = self.family(asset)
        kin = {relative["id"] for relative in family["variants"] + family["siblings"]} | (
            {family["parent"]["id"]} if family["parent"] else set())
        result["similar_assets"] = [a for a in self.similar_assets(asset, crop[0] if crop else None) if a["id"] not in kin]
        result["family"] = family
        return result

    def similar_assets(self, asset: dict, picture) -> list[dict]:
        """Other assets that look like this one: catch near-duplicates before the library forks."""
        if picture is None:
            return []
        hits = self.assets.search(picture).rerank(False).limit(SIMILAR_ASSETS + 1).where(**self.q())
        return [{**asset_summary(hit), "score": round(float(hit.score), 4)} for hit in hits
                if hit["id"] != asset["id"] and float(hit.score) >= self.asset_min_score][:SIMILAR_ASSETS]

    def similar_to(self, layers: list[Layer]) -> list[dict]:
        """Assets that look like an unsaved drawing: "you may already have this" before saving a new one."""
        crop = ink_crop([layer for layer in layers if layer.visible])
        return self.similar_assets({"id": None}, crop[0] if crop else None)

    def _linked(self, asset_id: str, where: dict) -> list[dict]:
        """One row per shot that placed the asset, boxed by its element when that layer is visible."""
        fields = {"_id": 0, "id": 1, "assets": 1, **{field: 1 for field in ELEMENT_FIELDS}}
        shots = list(self.shots.mongo.find({"asset_ids": asset_id, **where}, fields))
        elements = {row["shot_id"]: row for row in self.elements.mongo.find(
            self.q({"shot_id": {"$in": [shot["id"] for shot in shots]}, "asset_id": asset_id}),
            {"_id": 0, "shot_id": 1, "layer_name": 1, "box": 1})}
        rows = []
        for shot in shots:
            element = elements.get(shot["id"], {})
            version = next((a["version"] for a in shot.get("assets", []) if a["id"] == asset_id), None)
            rows.append({"shot_id": shot["id"], **{field: shot.get(field, "") for field in ELEMENT_FIELDS},
                         "layer_name": element.get("layer_name"), "box": element.get("box"), "asset_version": version})
        return rows

    # ------------------------------------------------------------------ whole libraries
    @property
    def stores(self) -> list:
        """Every owner-scoped Mongo collection, ideas included, in dependency order."""
        return [self.library.drawings.mongo, self.assets.mongo, self.versions, self.shots.mongo,
                self.elements.mongo, self.frames.mongo, self.clips.mongo]

    def counts(self) -> dict:
        return {"assets": self.assets.mongo.count_documents(self.q()), "scenes": (
                    self.shots.mongo.count_documents(self.q()) + self.clips.mongo.count_documents(self.q())),
                "ideas": self.library.drawings.mongo.count_documents(self.q())}

    def copy_library(self, source: str) -> dict:
        """Copy another owner's whole library into this one under fresh ids (vectors included: nothing is re-embedded).

        Ids are remapped everywhere they appear (links, lineage, element and frame ids), so the copy is a
        self-contained twin: editing it never touches the source.
        """
        if source == self.q()["owner"]:
            raise ProductionError("That library is already yours.")
        ids = {row["id"]: str(uuid4()) for store in (self.library.drawings.mongo, self.assets.mongo, self.shots.mongo, self.clips.mongo)
               for row in store.find({"owner": source}, {"_id": 0, "id": 1})}

        copied = {}
        for store in self.stores:
            docs = []
            for doc in store.find({"owner": source}):
                doc.pop("_id", None)
                docs.append({**remap_ids(doc, ids), "owner": self.q()["owner"]})
            if docs:
                store.insert_many(docs)
            copied[store.name] = len(docs)
        return copied

    def add_starter(self, source: str) -> dict:
        """The starter pack: copy the shared ready-made assets this library doesn't have yet, with their versions
        and search vectors (nothing is re-embedded). Each copy remembers its starter, so it's never added twice."""
        owner = self.q()["owner"]
        if source == owner:
            raise ProductionError("That library is already yours.")
        have = {doc["starter"]: doc["id"] for doc in self.assets.mongo.find({"owner": owner}, {"_id": 0, "id": 1, "starter": 1})
                if doc.get("starter")}
        wanted = [doc for doc in self.assets.mongo.find({"owner": source}) if doc["id"] not in have]
        # Lineage to a starter already in the library points at the artist's copy of it.
        ids = {**have, **{doc["id"]: str(uuid4()) for doc in wanted}}
        assets = []
        for doc in wanted:
            doc.pop("_id", None)
            assets.append({**remap_ids(doc, ids), "owner": owner, "starter": doc["id"]})
        versions = []
        for doc in self.versions.find({"owner": source}):
            if doc.get("asset_id") in ids and doc["asset_id"] not in have:
                doc.pop("_id", None)
                versions.append({**remap_ids(doc, ids), "owner": owner})
        if assets:
            self.assets.mongo.insert_many(assets)
        if versions:
            self.versions.insert_many(versions)
        return {"assets": len(assets), "asset_versions": len(versions)}

    def claim_unowned(self, owner: str, *, ideas_owner: str | None = None) -> dict:
        """One-time migration: work saved before accounts existed gets an owner (ideas may go elsewhere)."""
        moved = {}
        for store in self.stores:
            target = ideas_owner if ideas_owner and store is self.library.drawings.mongo else owner
            moved[store.name] = store.update_many({"owner": {"$exists": False}}, {"$set": {"owner": target}}).modified_count
        return moved

    def ready(self) -> bool:
        return all(
            any(index.get("queryable") is True for index in collection.mongo.list_search_indexes(collection.index_name))
            for collection in self.collections
        )
