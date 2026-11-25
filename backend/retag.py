"""Auto-tag drawings saved before tagging existed, then re-embed them (billable Gemini + Voyage calls)."""

from backend.ai import Sparks
from backend.library import Library
from backend.models import Drawing, TagRequest


def main() -> None:
    library, ai = Library(), Sparks()
    try:
        records = list(library.drawings.mongo.find(
            {"tags": {"$exists": False}, "owner": {"$exists": True}}, {"_id": 0, "embedding": 0}))
        for record in records:
            drawing = Drawing.model_validate(
                {key: record[key] for key in ("title", "description", "strokes", "layers") if key in record})
            tags = ai.suggest_tags(TagRequest(
                title=drawing.title, description=drawing.description, layers=drawing.layers))
            library.scoped(record["owner"]).save(drawing.model_copy(update={"tags": tags}),
                         drawing_id=record["id"], created_at=record["created_at"])
            print(f"Tagged {drawing.title!r}: {', '.join(tags)}", flush=True)
        print(f"Done: {len(records)} drawing(s) tagged and re-embedded.")
    finally:
        library.close()


if __name__ == "__main__":
    main()
