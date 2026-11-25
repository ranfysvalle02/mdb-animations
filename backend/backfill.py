"""Bring saved work up to date (safe to re-run): python -m backend.backfill

- Scenes: index every frame (billable Voyage calls only for frames not indexed yet; hashed).
- Assets: compute art math (stroke counts, hand share, ink, colors) and snapshot the current version.
  No re-embedding: these are metadata updates.
"""

from backend.art import art_stats
from backend.library import Library
from backend.models import Layer
from backend.production import Production


def main() -> None:
    library = Library()
    try:
        production = Production(library)
        rows = list(production.shots.mongo.find({"owner": {"$exists": True}}, {"_id": 0, "id": 1, "owner": 1}))
        embedded = 0
        for row in rows:  # each scene is rebuilt inside its owner's library
            mine = production.scoped(row["owner"])
            shot = mine._shot_model(row["id"])
            embedded += mine.index_frames(row["id"], shot, mine._links(shot))
        print(f"Frames: {len(rows)} scenes checked, {embedded} frame(s) embedded.", flush=True)
        updated = 0
        for record in production.assets.mongo.find({"owner": {"$exists": True}}, {"_id": 0, "embedding": 0}):
            mine = production.scoped(record["owner"])
            stats = art_stats([Layer.model_validate(layer) for layer in record["layers"]])
            production.assets.mongo.update_one(mine.q({"id": record["id"]}), {"$set": {
                "stats": stats, "hand_share": stats["hand_share"], "colors": stats["colors"]}})
            if not production.versions.count_documents(mine.q({"asset_id": record["id"], "version": record["version"]})):
                mine.snapshot_version({**record, "stats": stats})
            updated += 1
        print(f"Assets: art math and version snapshots for {updated} asset(s).", flush=True)
    finally:
        library.close()


if __name__ == "__main__":
    main()
