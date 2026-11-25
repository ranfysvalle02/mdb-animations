import time

from pymongo.errors import OperationFailure

from backend.auth import DEMO_OWNER
from backend.library import Library
from backend.production import Production


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


def main() -> None:
    library = Library()
    try:
        for collection in [library.drawings, *Production(library).collections]:
            ensure(collection)
        # Work saved before accounts existed becomes the shared demo library members can copy;
        # loose ideas from that era are kept, but out of everyone's way.
        moved = Production(library).claim_unowned(DEMO_OWNER, ideas_owner="legacy")
        if any(moved.values()):
            print(f"Accounts: assigned pre-account work an owner {moved}.", flush=True)
    finally:
        library.close()


if __name__ == "__main__":
    main()
