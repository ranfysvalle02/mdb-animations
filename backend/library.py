import base64
import copy
import io
import os
from datetime import datetime, timezone
from uuid import uuid4

from cinematlas.core import Atlas, Image, Text
from PIL import Image as PILImage, ImageDraw
from pymongo import MongoClient

from backend.models import Drawing, Layer

CANVAS_WIDTH = 1000
CANVAS_HEIGHT = 650


class LibraryError(Exception):
    pass


def render_sheet(layers: list[Layer]) -> PILImage.Image:
    """Composite visible layers bottom-up onto a transparent sheet, matching the browser renderer."""
    canvas = PILImage.new("RGBA", (CANVAS_WIDTH, CANVAS_HEIGHT), (0, 0, 0, 0))
    for layer in layers:
        if not layer.visible or not layer.strokes:
            continue
        sheet = PILImage.new("RGBA", (CANVAS_WIDTH, CANVAS_HEIGHT), (0, 0, 0, 0))
        pen = ImageDraw.Draw(sheet)
        for stroke in layer.strokes:
            # ImageDraw replaces pixels, so transparent ink erases within this layer only.
            color = (0, 0, 0, 0) if stroke.erase else stroke.color
            pixels = [(point.x * CANVAS_WIDTH, point.y * CANVAS_HEIGHT) for point in stroke.points]
            if stroke.fill and len(pixels) > 2:
                pen.polygon(pixels, fill=stroke.fill)
            previous = None
            for point, (x, y) in zip(stroke.points, pixels):
                width = max(1, round(stroke.width * (0.25 + point.pressure)))
                if previous is not None:
                    pen.line([previous, (x, y)], fill=color, width=width)
                radius = width / 2
                pen.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
                previous = (x, y)
        if layer.opacity < 1:
            opacity = layer.opacity
            sheet.putalpha(sheet.getchannel("A").point(lambda value: round(value * opacity)))
        canvas.alpha_composite(sheet)
    return canvas


def on_paper(sheet: PILImage.Image) -> PILImage.Image:
    paper = PILImage.new("RGBA", sheet.size, "white")
    paper.alpha_composite(sheet)
    return paper.convert("RGB")


def render_image(layers: list[Layer]) -> PILImage.Image:
    return on_paper(render_sheet(layers))


def ink_crop(layers: list[Layer], *, pad: float = 0.08, min_side: int = 24) -> tuple[PILImage.Image, dict] | None:
    """The visible ink of ``layers``, tightly cropped on white, plus its normalized bounding box.

    Assets and shot elements are cropped the same way so a placed (or redrawn) asset compares
    like with like, independent of where it sits on the canvas or how big it was drawn.
    """
    sheet = render_sheet(layers)
    bbox = sheet.getchannel("A").getbbox()
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    margin = round(pad * max(right - left, bottom - top))
    grow_x = max(margin, (min_side - (right - left)) // 2 + 1)
    grow_y = max(margin, (min_side - (bottom - top)) // 2 + 1)
    left, top = max(0, left - grow_x), max(0, top - grow_y)
    right, bottom = min(CANVAS_WIDTH, right + grow_x), min(CANVAS_HEIGHT, bottom + grow_y)
    box = {"x": left / CANVAS_WIDTH, "y": top / CANVAS_HEIGHT,
           "w": (right - left) / CANVAS_WIDTH, "h": (bottom - top) / CANVAS_HEIGHT}
    return on_paper(sheet.crop((left, top, right, bottom))), box


def png_bytes(image: PILImage.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def render_png(drawing: Drawing) -> bytes:
    return png_bytes(render_image(drawing.layers))


def summary(record: dict) -> dict:
    return {
        "id": record["id"],
        "title": record["title"],
        "description": record["description"],
        "created_at": record["created_at"],
        "tags": record.get("tags", []),
        "image_url": f"/api/drawings/{record['id']}/image",
    }


class Scoped:
    """One owner's view of shared collections. Every read, write, and vector search carries ``owner``.

    The app object is unscoped and refuses data access; each request gets a cheap scoped copy.
    """

    owner: str | None = None

    def scoped(self, owner: str):
        if not owner:
            raise LibraryError("An owner is required.")
        view = copy.copy(self)
        view.owner = owner
        return view

    def q(self, where: dict | None = None) -> dict:
        if not self.owner:
            raise LibraryError("Unscoped data access refused: sign in first.")
        return {**(where or {}), "owner": self.owner}


class Library(Scoped):
    def __init__(self) -> None:
        uri = os.environ.get("MONGODB_URI")
        key = os.environ.get("VOYAGE_API_KEY")
        if not uri or not key:
            raise LibraryError("Set MONGODB_URI and VOYAGE_API_KEY before starting the API.")
        database = os.environ.get("MONGODB_DB", "animation_studio")
        if "://" in database:  # an easy paste to make, and a confusing one to debug
            raise LibraryError("MONGODB_DB is a database name. Put the connection string in MONGODB_URI.")
        self.client = MongoClient(
            uri, appname="animation-studio", serverSelectionTimeoutMS=10000,
            connectTimeoutMS=10000, socketTimeoutMS=60000,
        )
        self.atlas = Atlas(
            mongo_client=self.client, voyage_api_key=key,
            db=database,
            model="voyage-multimodal-3.5", rerank_model=None,
        )
        self.drawings = self.atlas.collection(
            "drawings",
            embed=Text("title") + Text("description") + Text("tags", label="Tags") + Image("image"),
            key="id", filters=["owner", "tags"],
        )

    def close(self) -> None:
        self.client.close()

    def ready(self) -> bool:
        self.client.admin.command("ping")
        return any(
            index.get("queryable") is True
            for index in self.drawings.mongo.list_search_indexes(self.drawings.index_name)
        )

    def save(self, drawing: Drawing, *, drawing_id: str | None = None,
             created_at: str | None = None) -> dict:
        image = render_png(drawing)
        record = {
            **drawing.model_dump(),
            "id": drawing_id or str(uuid4()),
            "owner": self.q()["owner"],
            "created_at": created_at or datetime.now(timezone.utc).isoformat(),
            "image": image,
            # Cinematlas embeds bytes but intentionally excludes them from stored documents.
            "png": base64.b64encode(image).decode("ascii"),
        }
        result = self.drawings.add([record], retries=1)
        if result.added != 1 or result.failed or result.skipped:
            raise LibraryError("Drawing embedding failed; no save was confirmed.")
        return summary(record)

    def recent(self, tag: str | None = None) -> list[dict]:
        records = self.drawings.mongo.find(
            self.q({"tags": tag} if tag else {}),
            {"id": 1, "title": 1, "description": 1, "created_at": 1, "tags": 1},
        ).sort("created_at", -1).limit(30)
        return [summary(record) for record in records]

    def tag_counts(self) -> list[dict]:
        pipeline = [
            {"$match": self.q()},
            {"$unwind": "$tags"},
            {"$group": {"_id": "$tags", "count": {"$sum": 1}}},
            {"$sort": {"count": -1, "_id": 1}},
            {"$limit": 40},
        ]
        return [{"tag": row["_id"], "count": row["count"]}
                for row in self.drawings.mongo.aggregate(pipeline)]

    def untagged(self) -> list[dict]:
        return list(self.drawings.mongo.find(
            self.q({"tags": {"$exists": False}}), {"_id": 0, "embedding": 0}
        ))

    def get(self, drawing_id: str) -> dict | None:
        return self.drawings.mongo.find_one(
            self.q({"id": drawing_id}), {"_id": 0, "embedding": 0}
        )

    def search(self, query, tag: str | None = None) -> list[dict]:
        """Words or a picture (a PIL image): Voyage embeds both into the same space."""
        search = self.drawings.search(query).rerank(False).limit(12).where(**self.q({"tags": tag} if tag else {}))
        return [{**summary(hit), "score": float(hit.score)} for hit in search]
