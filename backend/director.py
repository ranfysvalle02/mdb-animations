"""Turn a drawing into editable motion, with an optional artist's direction."""

import time
from collections.abc import Iterator

from backend.models import AnimateRequest, DirectRequest, MotionRequest


def step(key: str, detail: str, started: float) -> dict:
    return {"type": "step", "id": key, "detail": detail,
            "ms": round((time.perf_counter() - started) * 1000)}


def run(sparks, request: AnimateRequest) -> Iterator[dict]:
    if request.prompt:
        idea = {"title": request.title or "Your direction", "logline": "", "prompt": request.prompt,
                "movers": [subject.id for subject in request.subjects]}
    else:
        started = time.perf_counter()
        pitch = DirectRequest(seconds=request.seconds, backdrop=request.backdrop, subjects=request.subjects,
                              layers=request.layers)
        idea = sparks.direct(pitch)["ideas"][0]
        yield step("pitch", "Imagining a scene", started)

    started = time.perf_counter()
    movers = [subject for subject in request.subjects if subject.id in set(idea["movers"])][:4] or request.subjects[:1]
    motion = sparks.motion(MotionRequest(prompt=idea["prompt"][:300], seconds=request.seconds, subjects=movers,
                                         layers=request.layers, previous=request.previous))
    yield step("choreograph", "Making your drawing move", started)
    yield {"type": "result", "idea": idea, "motion": motion}
