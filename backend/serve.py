"""Container entrypoint: the API on $PORT right away; index setup and the demo seed in the background.

Hosts like Render assign $PORT and expect it bound within moments, while building vector indexes on a fresh
Atlas cluster takes minutes. So the server starts first, then a background thread:

1. creates the collections and vector indexes (idempotent: existing data and indexes are kept);
2. seeds the shared demo library once, when it doesn't exist yet (billable Voyage calls, first time only).

/api/ready reports each phase. Opt out with INKLING_SETUP_ON_START=0 or INKLING_SEED_DEMO=0
(Docker Compose runs setup as its own job, so it can skip step 1).
"""

import logging
import os
import threading
import time
import traceback
import urllib.request

import uvicorn

from backend import boot

PORT = int(os.environ.get("PORT", "8000"))
log = logging.getLogger("inkling.boot")


def flag(name: str, default: bool = True) -> bool:
    value = os.environ.get(name, "").strip().lower()
    return default if not value else value in ("1", "true", "yes", "on")


def wait_for_api(deadline_s: float = 120) -> bool:
    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=5):
                return True
        except OSError:
            time.sleep(1)
    return False


def seed_demo() -> None:
    from backend.auth import DEMO_OWNER
    from backend.library import Library
    from backend.production import Production

    library = Library()
    try:
        if Production(library).scoped(DEMO_OWNER).counts()["assets"]:
            print("Demo library already seeded.", flush=True)
            return
    finally:
        library.close()
    from backend.seed_demo import main as seed

    seed()


def background() -> None:
    if flag("INKLING_SETUP_ON_START"):
        boot.set_phase("indexing", "Building search indexes. On a new Atlas cluster this takes 1-3 minutes.")
        try:
            from backend.setup import main as setup

            setup()
        except Exception as exc:  # keep serving: /api/ready explains what to fix
            boot.set_phase("failed", boot.describe_failure(exc))
            print(f"Index setup failed: {boot.phase()['detail']}", flush=True)
            traceback.print_exc(limit=2)
            return
    if flag("INKLING_SEED_DEMO") and wait_for_api():
        boot.set_phase("seeding", "Preparing the demo library (first boot only).")
        try:
            seed_demo()
        except Exception as exc:  # the studio works without it; members can start fresh
            print(f"Demo seed failed ({type(exc).__name__}); members can still start fresh.", flush=True)
    boot.set_phase("ready")


def main() -> None:
    threading.Thread(target=background, name="inkling-boot", daemon=True).start()
    uvicorn.run("backend.main:app", host="0.0.0.0", port=PORT, workers=1, timeout_keep_alive=30)


if __name__ == "__main__":
    main()
