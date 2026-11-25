"""Container entrypoint: optional setup, optional demo seed, then the API on $PORT.

Render (and most hosts) assign the port through $PORT. With hosted Atlas there's no separate setup job, so:

- ``INKLING_SETUP_ON_START=1`` creates the collections and vector indexes first (idempotent, keeps data).
- ``INKLING_SEED_DEMO=1`` seeds the shared demo library once, in the background, after the API is ready
  (skipped when it already exists; billable Voyage calls the first time only).
"""

import os
import threading
import time
import urllib.request

import uvicorn

PORT = int(os.environ.get("PORT", "8000"))


def flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def seed_when_ready() -> None:
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/ready", timeout=15):
                break
        except OSError:
            time.sleep(3)
    else:
        print("Demo seed skipped: the API never became ready.", flush=True)
        return
    try:
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
    except Exception as exc:  # the studio keeps serving; members can still start fresh
        print(f"Demo seed failed ({type(exc).__name__}); members can still start fresh.", flush=True)


def main() -> None:
    if flag("INKLING_SETUP_ON_START"):
        from backend.setup import main as setup

        setup()
    if flag("INKLING_SEED_DEMO"):
        threading.Thread(target=seed_when_ready, name="seed-demo", daemon=True).start()
    uvicorn.run("backend.main:app", host="0.0.0.0", port=PORT, workers=1, timeout_keep_alive=30)


if __name__ == "__main__":
    main()
