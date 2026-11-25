"""What the server is doing right after it starts, so /api/ready can say "building indexes", not just 503."""

import threading

_lock = threading.Lock()
_state = {"phase": "starting", "detail": ""}


def set_phase(phase: str, detail: str = "") -> None:
    with _lock:
        _state.update(phase=phase, detail=detail[:300])


def phase() -> dict:
    with _lock:
        return dict(_state)


def describe_failure(exc: Exception) -> str:
    """A safe, useful reason: Atlas server messages are actionable (e.g. index limits); others may carry URIs."""
    from pymongo.errors import OperationFailure

    if isinstance(exc, OperationFailure):
        return f"Atlas refused the index setup: {str(exc).split(', full error')[0]}"
    names = {"ServerSelectionTimeoutError": "Can't reach MongoDB Atlas. Check MONGODB_URI and Atlas Network Access.",
             "ConfigurationError": "MONGODB_URI is malformed.", "LibraryError": str(exc)}
    return names.get(type(exc).__name__, f"Index setup failed ({type(exc).__name__}). See the server logs.")
