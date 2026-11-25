import time

from pymongo.errors import OperationFailure
from pymongo.operations import SearchIndexModel

from backend.auth import DEMO_OWNER
from backend.library import Library
from backend.production import CODE_INDEX, Production, code_index_definition


def recreate_index(collection) -> None:
    """Atlas Local rejects in-place vector index updates; documents are untouched by this."""
    mongo, name = collection.mongo, collection.index_name
    mongo.drop_search_index(name)
    deadline = time.monotonic() + 300
    while list(mongo.list_search_indexes(name)):
        if time.monotonic() > deadline:
            raise TimeoutError(f"Search index {name!r} was not dropped within 5 minutes.")
        time.sleep(2)


def ensure(collection) -> None:
    try:
        collection.setup(timeout_s=600)
    except OperationFailure as exc:
        if "mappings" not in str(exc):
            raise
        print(f"{collection.mongo.name}: index definition changed; recreating it (data is kept).", flush=True)
        recreate_index(collection)
        collection.setup(timeout_s=600)
    print(f"{collection.mongo.name}: collection and Voyage vector index are ready.", flush=True)


def ensure_code_index(shots) -> None:
    """Atlas Automated Embedding on scene code: Atlas embeds sketch.code with a Voyage code model, on every save.

    Clusters without autoEmbed keep working: code search falls back to the scenes' multimodal vectors.
    """
    wanted = code_index_definition()
    shape = lambda fields: sorted((f.get("type"), f.get("path"), f.get("model")) for f in fields)  # noqa: E731
    current = next(iter(shots.list_search_indexes(CODE_INDEX)), None)
    if current and shape((current.get("latestDefinition") or {}).get("fields", [])) == shape(wanted["fields"]):
        print(f"{shots.name}: Atlas Automated Embedding on scene code is set up ({wanted['fields'][0]['model']}).", flush=True)
        return
    try:
        if current:
            shots.drop_search_index(CODE_INDEX)
            deadline = time.monotonic() + 300
            while list(shots.list_search_indexes(CODE_INDEX)) and time.monotonic() < deadline:
                time.sleep(2)
        shots.create_search_index(SearchIndexModel(name=CODE_INDEX, type="vectorSearch", definition=wanted))
        print(f"{shots.name}: Atlas Automated Embedding on scene code ({wanted['fields'][0]['model']}); "
              "Atlas embeds every saved sketch.", flush=True)
    except OperationFailure as exc:
        print(f"{shots.name}: Atlas Automated Embedding isn't available on this cluster ({exc.details.get('errmsg', exc) if exc.details else exc}); "
              "code search uses the scenes' Voyage multimodal vectors instead.", flush=True)


def drop_ai_video(database) -> None:
    """AI video is gone: its scenes, vector index, and stored media go too. Accounts live in m-stash; untouched."""
    names = set(database.list_collection_names())
    if "clips" in names:
        for index in database["clips"].list_search_indexes():
            database["clips"].drop_search_index(index["name"])
        database.drop_collection("clips")
        print("AI video: dropped the clips collection and its vector index.", flush=True)
    for bucket in ("clip_media.files", "clip_media.chunks"):
        if bucket in names:
            database.drop_collection(bucket)


def main() -> None:
    library = Library()
    try:
        drop_ai_video(library.drawings.mongo.database)
        production = Production(library)
        for collection in [library.drawings, *production.collections]:
            ensure(collection)
        ensure_code_index(production.shots.mongo)
        production.shares.create_index("token", unique=True)
        production.shares.create_index([("owner", 1), ("shot_id", 1)])
        # Work saved before accounts existed becomes the shared demo library members can copy;
        # loose ideas from that era are kept, but out of everyone's way.
        moved = production.claim_unowned(DEMO_OWNER, ideas_owner="legacy")
        if any(moved.values()):
            print(f"Accounts: assigned pre-account work an owner {moved}.", flush=True)
    finally:
        library.close()


if __name__ == "__main__":
    main()
