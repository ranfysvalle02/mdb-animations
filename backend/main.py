import base64
import html
import json
import logging
import os
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import UUID

from cinematlas.exceptions import CinematlasError
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from google.genai.errors import APIError as GeminiError
from pydantic import BaseModel, Field, ValidationError
from pymongo.errors import PyMongoError
from starlette.concurrency import run_in_threadpool
from voyageai.error import VoyageError

from backend import boot, director
from backend.ai import AIError, AIUnavailable, Sparks
from backend.auth import DEMO_OWNER, SESSION_COOKIE, AuthError, AuthUnavailable, Budget, MStash, OpenAuth, Throttle, jwt_claims, service_owner
from backend.library import Library, LibraryError, ink_crop, render_image
from backend.models import (
    ASSET_TYPES, CODE_PATTERN, MAX_LAYERS, SHOT_STATUSES, AnimateRequest, Asset, CodeRequest, CodeSearch, DirectRequest, Drawing, Layer, LayersRequest, MotionRequest, RefineIdeasRequest,
    RefineRequest, Shot, ShotUpdate, SketchRequest, SparkRequest, TagRequest,
    SketchSearch, VariationPlanRequest, VariationRequest,
    normalize_tag,
)
from backend.production import Production, ProductionError
from backend.share import page as share_page

ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 2 * 1024 * 1024
MAX_SHOT_BODY = 8 * 1024 * 1024  # a flipbook scene carries a layer stack per frame
logger = logging.getLogger("animation_studio")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    library = Library()
    app.state.library = library
    app.state.production = Production(
        library, min_score=float(os.environ.get("WHERE_USED_MIN_SCORE", "0.75")),
        asset_min_score=float(os.environ.get("SIMILAR_ASSET_MIN_SCORE", "0.75")))
    app.state.ai = Sparks()
    app.state.auth = MStash.from_env()
    try:
        yield
    finally:
        library.close()


app = FastAPI(title="Inkling", lifespan=lifespan)


async def service_error(request: Request, exc: Exception) -> JSONResponse:
    # Do not log provider messages: signed connection strings can appear in them.
    logger.error("Service failure on %s (%s)", request.url.path, type(exc).__name__)
    return JSONResponse(
        status_code=503,
        content={"detail": "Atlas or Voyage is unavailable. Check credentials, indexes, and service access."},
    )


for error in (LibraryError, CinematlasError, PyMongoError, VoyageError):
    app.add_exception_handler(error, service_error)


@app.exception_handler(GeminiError)
async def gemini_error(request: Request, exc: GeminiError) -> JSONResponse:
    logger.error("Gemini failure on %s (%s %s)", request.url.path, type(exc).__name__, exc.code)
    busy = exc.code == 429
    return JSONResponse(
        status_code=429 if busy else 503,
        content={"detail": "Gemini is busy. Wait a moment and spark again." if busy
                 else "Gemini is unavailable. Check GEMINI_API_KEY and service access."},
    )


# ---------------------------------------------------------------- accounts: every /api call has an owner
PUBLIC = {("GET", "/api/ready"), ("GET", "/api/auth/config"), ("POST", "/api/session"), ("DELETE", "/api/session"),
          ("POST", "/api/auth/signup"), ("POST", "/api/auth/login")}
SIGN_INS = Throttle()
# Behind a TLS-terminating proxy (Render, Fly, a load balancer) the app sees plain http.
# Render sets RENDER=true and always sits behind its TLS proxy, so trust it there unless told otherwise.
TRUST_PROXY = os.environ.get("TRUST_PROXY", "1" if os.environ.get("RENDER") else "").strip().lower() in ("1", "true", "yes", "on")


def client_ip(request: Request) -> str:
    if TRUST_PROXY:
        hops = [hop.strip() for hop in request.headers.get("x-forwarded-for", "").split(",") if hop.strip()]
        if hops:
            return hops[0]
    return request.client.host if request.client else "unknown"


def is_https(request: Request) -> bool:
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or (TRUST_PROXY and forwarded == "https")


# Billable work, metered per member per hour (0 = unlimited). Gemini drafts are the expensive kind;
# Voyage embeds every save and every search by words, by drawing, or for look-alikes.
AI_BUDGET = Budget("ai", "AI drafts", int(os.environ.get("INKLING_AI_PER_HOUR", "60")))
EMBED_BUDGET = Budget("embeds", "saves and searches", int(os.environ.get("INKLING_EMBEDS_PER_HOUR", "600")))
_ID = r"[0-9a-fA-F-]{36}"
METERED = [
    (AI_BUDGET, "POST", re.compile(r"/api/(animate|sparks/(strokes|sketch|guide|motion|direct|refine|refine/ideas|code)|tags/suggest|assets/" + _ID + r"/variations(/plan)?)")),
    (EMBED_BUDGET, "POST", re.compile(r"/api/(drawings|assets|assets/similar|shots|search/sketch|search/code|shots/" + _ID + r"/(sync/" + _ID + r"|link|share))")),
    (EMBED_BUDGET, "PUT", re.compile(r"/api/(assets|shots)/" + _ID)),
    (EMBED_BUDGET, "GET", re.compile(r"/api/(search|assets/" + _ID + r"/where-used)")),
]
QUERY_SEARCH = re.compile(r"/api/(assets|shots|frames|find)")  # vector search only when there's a ?q=


def budget_for(request: Request) -> Budget | None:
    method, path = request.method, request.url.path
    for budget, verb, pattern in METERED:
        if method == verb and pattern.fullmatch(path):
            return budget
    if method == "GET" and QUERY_SEARCH.fullmatch(path) and request.query_params.get("q", "").strip():
        return EMBED_BUDGET
    return None


def wait_text(seconds: int) -> str:
    return f"{max(1, round(seconds / 60))} min" if seconds >= 60 else f"{seconds} s"


def session_token(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get(SESSION_COOKIE, "")


@app.middleware("http")
async def authenticate(request: Request, call_next):
    """No anonymous data access: each /api request is bound to one owner before any endpoint runs."""
    path = request.url.path
    if not path.startswith("/api/") or (request.method, path) in PUBLIC:
        return await call_next(request)
    auth = getattr(request.app.state, "auth", None)
    if auth is None:
        return JSONResponse(status_code=503, content={"detail": "Accounts aren't configured."})
    try:
        owner = service_owner(request.headers, request.client.host if request.client else None)
        if owner is None:
            token = session_token(request)
            if not token and not isinstance(auth, OpenAuth):
                raise AuthError("Sign in to open your studio.")
            user = await run_in_threadpool(auth.verify, token)
            owner, request.state.user = user.id, user
        request.state.owner = owner
    except AuthError as exc:
        return JSONResponse(status_code=401, content={"detail": str(exc)})
    except AuthUnavailable as exc:
        return JSONResponse(status_code=503, content={"detail": str(exc)})
    # Members get an hourly budget for billable calls; in-container scripts (seed, backfill) don't.
    budget = budget_for(request) if getattr(request.state, "user", None) else None
    if budget and budget.exhausted(owner):
        wait = budget.meter.retry_after(owner)
        return JSONResponse(status_code=429, headers={"Retry-After": str(wait)}, content={
            "detail": f"You've used this hour's {budget.limit} {budget.label}. More in {wait_text(wait)}."})
    response = await call_next(request)
    if budget and response.status_code < 400:
        budget.meter.record(owner)
    return response


@app.exception_handler(AuthError)
async def auth_error(request: Request, exc: AuthError) -> JSONResponse:
    return JSONResponse(status_code=401, content={"detail": str(exc)})


@app.exception_handler(AuthUnavailable)
async def auth_unavailable(request: Request, exc: AuthUnavailable) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})


def prod(request: Request) -> Production:
    """This member's view of assets, scenes, and frames."""
    return request.app.state.production.scoped(request.state.owner)


def lib(request: Request) -> Library:
    return request.app.state.library.scoped(request.state.owner)


@app.exception_handler(ProductionError)
async def production_error(request: Request, exc: ProductionError) -> JSONResponse:
    return JSONResponse(status_code=404 if "not found" in str(exc) else 422, content={"detail": str(exc)})


@app.exception_handler(AIError)
async def ai_error(request: Request, exc: AIError) -> JSONResponse:
    if isinstance(exc, AIUnavailable):
        logger.error("Gemini unreachable on %s (%s)", request.url.path, type(exc.__cause__).__name__)
    return JSONResponse(status_code=503 if isinstance(exc, AIUnavailable) else 502, content={"detail": str(exc)})


async def read_json(request: Request, model: type[BaseModel], limit: int = MAX_BODY) -> BaseModel:
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Send application/json.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise HTTPException(413, f"Request exceeds the {limit // (1024 * 1024)} MiB limit.")
    try:
        return model.model_validate_json(body)
    except ValidationError as exc:
        raise RequestValidationError(
            exc.errors(include_url=False, include_context=False, include_input=False)
        ) from exc


def optional_tag(tag: str | None) -> str | None:
    if not tag:
        return None
    try:
        return normalize_tag(tag)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.api_route("/health", methods=["GET", "HEAD"])
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/ready")
def ready(request: Request) -> dict:
    if boot.phase()["phase"] == "failed":  # say what to fix, without waiting on an unreachable cluster again
        raise HTTPException(503, boot.phase()["detail"])
    if not request.app.state.library.ready() or not request.app.state.production.ready():
        state = boot.phase()
        raise HTTPException(503, state["detail"] if state["phase"] in ("indexing", "failed") and state["detail"]
                            else "Search indexes aren't ready yet. They're built automatically on start; give it a minute.")
    return {"status": "ready", "model": "voyage-multimodal-3.5", "phase": boot.phase()["phase"]}


class SessionRequest(BaseModel):
    token: str = Field(min_length=20, max_length=4096)


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=1, max_length=72)


class Prefs(BaseModel):
    model_config = {"extra": "forbid"}
    guide: list[str] = Field(default_factory=list, max_length=12)


def whoami(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    production = prod(request)
    owner = request.state.owner
    return {"user": {"id": owner, "email": user.email if user else ""}, "library": production.counts(),
            "demo": production.scoped(DEMO_OWNER).counts()["assets"] > 0,
            "budget": {budget.name: budget.status(owner) for budget in (AI_BUDGET, EMBED_BUDGET)}}


@app.get("/api/auth/config")
def auth_config(request: Request) -> dict:
    """Where the browser signs up and logs in (the m-stash publishable key is frontend-safe)."""
    return request.app.state.auth.config()


async def open_session(request: Request, token: str, **extra) -> JSONResponse:
    """Verify a token, then keep it only in an HttpOnly cookie, so images and API calls just work."""
    user = await run_in_threadpool(request.app.state.auth.verify, token)
    request.state.owner, request.state.user = user.id, user
    response = JSONResponse({**await run_in_threadpool(whoami, request), **extra})
    lifetime = int(float(jwt_claims(token).get("exp", 0)) - time.time()) if not isinstance(request.app.state.auth, OpenAuth) else 86400
    response.set_cookie(SESSION_COOKIE, token, max_age=max(60, min(lifetime, 7 * 86400)), httponly=True,
                        samesite="strict", secure=is_https(request), path="/")
    return response


async def credentials(request: Request) -> Credentials:
    body = await read_json(request, Credentials)
    # Per address and per account: a spoofed proxy header can't buy unlimited guesses at one password.
    if not SIGN_INS.allow(client_ip(request)) or not SIGN_INS.allow(f"email:{body.email.strip().lower()}"):
        raise HTTPException(429, "Too many sign-in attempts. Wait a few minutes and try again.")
    return body


@app.post("/api/auth/signup")
async def sign_up(request: Request) -> JSONResponse:
    """Create a member through m-stash (server to server; the token never reaches page scripts)."""
    body = await credentials(request)
    if len(body.password) < 12:
        raise HTTPException(422, "Use a password of 12 to 72 characters. A short phrase works well.")
    token, created = await run_in_threadpool(request.app.state.auth.signup, body.email.strip().lower(), body.password)
    return await open_session(request, token, created=created)


@app.post("/api/auth/login")
async def log_in(request: Request) -> JSONResponse:
    body = await credentials(request)
    token = await run_in_threadpool(request.app.state.auth.login, body.email.strip().lower(), body.password)
    return await open_session(request, token, created=False)


@app.post("/api/session")
async def start_session(request: Request) -> JSONResponse:
    """Trade an m-stash token minted elsewhere (e.g. by mstash.js) for an Inkling session."""
    body = await read_json(request, SessionRequest)
    return await open_session(request, body.token)


@app.get("/api/session")
def get_session(request: Request) -> dict:
    return whoami(request)


@app.delete("/api/session", status_code=204)
def end_session() -> Response:
    response = Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE, path="/", samesite="strict", httponly=True)
    return response


@app.get("/api/prefs")
def get_prefs(request: Request) -> dict:
    """Guide progress and studio settings, stored as a private m-stash record of this member's."""
    return request.app.state.auth.get_prefs(session_token(request)) if session_token(request) else {}


@app.put("/api/prefs")
async def put_prefs(request: Request) -> dict:
    prefs = await read_json(request, Prefs)
    if not session_token(request):
        return prefs.model_dump()
    saved = await run_in_threadpool(request.app.state.auth.put_prefs, session_token(request), prefs.model_dump())
    return {"guide": saved.get("guide", [])}


@app.post("/api/library/demo")
async def copy_demo(request: Request) -> dict:
    """Start from the demo library: a private copy (assets, scenes, frames, versions) that's yours to change."""
    production = prod(request)
    have = await run_in_threadpool(production.counts)
    if have["assets"] or have["scenes"]:
        raise HTTPException(409, "Your library already has work in it, so the demo would get mixed in.")
    copied = await run_in_threadpool(production.copy_library, DEMO_OWNER)
    if not copied.get("assets"):
        raise HTTPException(404, "There's no demo library on this server yet. Run the demo seed.")
    return {"copied": copied, "library": await run_in_threadpool(production.counts)}


@app.post("/api/library/starter")
async def add_starter(request: Request) -> dict:
    """The starter pack: ready-made assets copied into your library with their search vectors (no new AI calls)."""
    production = prod(request)
    added = await run_in_threadpool(production.add_starter, DEMO_OWNER)
    return {"added": added, "library": await run_in_threadpool(production.counts)}


@app.post(
    "/api/drawings",
    status_code=201,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": {"type": "object"},
                    "example": {
                        "title": "My first mark",
                        "description": "A green dot on a soft sky",
                        "layers": [
                            {"name": "Sky", "opacity": 0.5, "strokes": [{
                                "color": "#7dd3fc", "width": 2, "fill": "#bae6fd",
                                "points": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 0.4},
                                           {"x": 0, "y": 0.4}, {"x": 0, "y": 0}],
                            }]},
                            {"name": "Dot", "strokes": [{
                                "color": "#086b59", "width": 10,
                                "points": [{"x": 0.5, "y": 0.5, "pressure": 0.5}],
                            }]},
                        ],
                    },
                },
            },
        },
    },
)
async def save_drawing(request: Request) -> dict:
    """Save a layered drawing (2 MiB, 12 layers, 1,000 strokes/shapes, 20,000 points maximum).

    A legacy flat ``strokes`` list is accepted and becomes one layer.

    Without tags, Gemini auto-tags it first. A tagging failure never blocks the save;
    the response then reports ``tags_status: "unavailable"``.
    """
    drawing = await read_json(request, Drawing)
    drawing, status = await auto_tag(request, drawing, drawing.title)
    saved = await run_in_threadpool(lib(request).save, drawing)
    return {**saved, "tags_status": status}


async def auto_tag(request: Request, doc, title: str):
    """Gemini tags untagged work before it's embedded. A tagging failure never blocks the save."""
    if doc.tags:
        return doc, "provided"
    try:
        tags = await run_in_threadpool(
            request.app.state.ai.suggest_tags,
            TagRequest(title=title[:120], description=doc.description, layers=doc.layers),
        )
        return doc.model_copy(update={"tags": tags}), "auto"
    except (GeminiError, AIError) as exc:
        logger.warning("Auto-tagging skipped (%s)", type(exc).__name__)
        return doc, "unavailable"


@app.get("/api/drawings")
def list_drawings(request: Request, tag: str | None = Query(default=None, max_length=30)) -> dict:
    return {"items": lib(request).recent(optional_tag(tag))}


@app.get("/api/tags")
def list_tags(request: Request) -> dict:
    return {"items": lib(request).tag_counts()}


@app.post("/api/tags/suggest")
async def suggest_tags(request: Request) -> dict:
    tag_request = await read_json(request, TagRequest)
    return {"tags": await run_in_threadpool(request.app.state.ai.suggest_tags, tag_request)}


@app.post("/api/sparks/strokes")
async def spark_strokes(request: Request) -> dict:
    """Minimal editable strokes for a region; nothing is applied until the artist accepts."""
    spark = await read_json(request, SparkRequest)
    return await run_in_threadpool(request.app.state.ai.strokes, spark)


@app.post("/api/sparks/sketch")
async def spark_sketch(request: Request) -> dict:
    """AI drafts a whole layer in blue pencil from a few words. Returned as a preview; never auto-applied."""
    sketch = await read_json(request, SketchRequest)
    return await run_in_threadpool(request.app.state.ai.sketch, sketch)


@app.post("/api/sparks/direct")
async def spark_direct(request: Request) -> dict:
    """AI pitches a few short shots for what's on the canvas: who moves, where, and what they do."""
    direct = await read_json(request, DirectRequest)
    return await run_in_threadpool(request.app.state.ai.direct, direct)


@app.post("/api/sparks/motion")
async def spark_motion(request: Request) -> dict:
    """AI choreographs a short clip as keyframes for the artist's own layers. A preview; nothing is applied."""
    motion = await read_json(request, MotionRequest)
    return await run_in_threadpool(request.app.state.ai.motion, motion)


@app.post("/api/sparks/code")
async def spark_code(request: Request) -> dict:
    """AI writes (or revises) a Lab sketch: p5.js over the artist's own strokes. It runs sandboxed, in the browser."""
    code = await read_json(request, CodeRequest)
    return await run_in_threadpool(request.app.state.ai.code_sketch, code)


@app.post("/api/sparks/refine/ideas")
async def spark_refine_ideas(request: Request) -> dict:
    """A few short prompts this drawing could use next: the artist taps one, or edits it first."""
    ideas = await read_json(request, RefineIdeasRequest)
    return {"ideas": await run_in_threadpool(request.app.state.ai.refine_ideas, ideas)}


@app.post("/api/sparks/refine")
async def spark_refine(request: Request) -> dict:
    """One layer refined by editing the artist's strokes (kept verbatim) plus a few AI strokes. A preview."""
    refine = await read_json(request, RefineRequest)
    return await run_in_threadpool(request.app.state.ai.refine, refine)


def failure_text(exc: Exception) -> tuple[int, str]:
    """The same plain answers the exception handlers give, for errors raised mid-stream."""
    if isinstance(exc, GeminiError):
        logger.error("Gemini failure while animating (%s %s)", type(exc).__name__, exc.code)
        return (429, "Gemini is busy. Wait a moment and try again.") if exc.code == 429 else (
            503, "Gemini is unavailable. Check GEMINI_API_KEY and service access.")
    if isinstance(exc, AIError):
        return (503 if isinstance(exc, AIUnavailable) else 502), str(exc)
    if isinstance(exc, ProductionError):
        return 422, str(exc)
    logger.error("Service failure while animating (%s)", type(exc).__name__)
    return 503, "Atlas or Voyage is unavailable. Check credentials, indexes, and service access."


@app.post("/api/animate")
async def animate(request: Request) -> StreamingResponse:
    """Pitch and choreograph an editable preview, streaming progress and errors."""
    body = await read_json(request, AnimateRequest)
    ai = request.app.state.ai

    def lines():
        try:
            for item in director.run(ai, body):
                yield json.dumps(item) + "\n"
        except Exception as exc:  # the response has started: report it in-band
            status, detail = failure_text(exc)
            yield json.dumps({"type": "error", "status": status, "detail": detail}) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.post("/api/sparks/guide")
async def spark_guide(request: Request) -> dict:
    """A refined, transparent trace guide for a region (never saved into the drawing)."""
    spark = await read_json(request, SparkRequest)
    return await run_in_threadpool(request.app.state.ai.guide, spark)


@app.get("/api/search")
def search(
    request: Request,
    q: str = Query(min_length=1, max_length=500),
    tag: str | None = Query(default=None, max_length=30),
) -> dict:
    query = q.strip()
    if not query:
        raise HTTPException(422, "Enter a search query.")
    return {"items": lib(request).search(query, optional_tag(tag))}


def find_drawing(request: Request, drawing_id: UUID) -> dict:
    record = lib(request).get(str(drawing_id))
    if record is None:
        raise HTTPException(404, "Drawing not found.")
    return record


def code_query():
    # A fresh Query per parameter: one shared instance makes FastAPI bind them all to the same input.
    return Query(default=None, pattern=CODE_PATTERN)


def status_query(status: str | None) -> str | None:
    if status and status != "open" and status not in SHOT_STATUSES:
        raise HTTPException(422, f"status must be open or one of {', '.join(SHOT_STATUSES)}.")
    return status or None


@app.post("/api/search/sketch")
async def search_by_sketch(request: Request) -> dict:
    """Search with a drawing instead of words: assets match its cropped ink; scenes, frames, and ideas
    match the whole canvas (where things sit matters there)."""
    body = await read_json(request, SketchSearch)
    visible = [layer for layer in body.layers if layer.visible]
    production = prod(request)
    if body.scope == "asset":
        crop = ink_crop(visible)
        items = await run_in_threadpool(production.search_assets, crop[0], asset_type=body.asset_type)
    else:
        picture = render_image(visible)
        if body.scope == "frame" and body.animated:
            items = await run_in_threadpool(production.find_frames, picture, animated=True)
        else:
            run = {"shot": production.search_shots, "frame": production.find_frames,
                   "idea": lib(request).search}[body.scope]
            items = await run_in_threadpool(run, picture)
    return {"items": items}


@app.post("/api/search/code")
async def search_code(request: Request) -> dict:
    """Find scenes by code: the sketch is embedded by Voyage and compared with every scene's code and story."""
    body = await read_json(request, CodeSearch)
    return {"items": await run_in_threadpool(prod(request).search_code, body.code)}


@app.get("/api/find")
def find(request: Request, q: str = Query(min_length=1, max_length=500)) -> dict:
    """Search everything by meaning: one Voyage embedding, three Atlas vector searches (drawings, animations, frames)."""
    query = q.strip()
    if not query:
        raise HTTPException(422, "Enter a search query.")
    return prod(request).find_everywhere(query)


@app.get("/api/frames")
def list_frames(request: Request, q: str = Query(default="", max_length=500), asset_id: UUID | None = None,
                project: str | None = code_query(), sequence: str | None = code_query(),
                status: str | None = Query(default=None), animated: bool = False) -> dict:
    """Every frame of every scene: search by words, filter by a placed asset or metadata, or browse the latest."""
    return {"items": prod(request).find_frames(
        q.strip() or None, asset_id=str(asset_id) if asset_id else None,
        project=project, sequence=sequence, status=status_query(status), **({"animated": True} if animated else {}))}


@app.get("/api/drawings/{drawing_id}/image")
def drawing_image(request: Request, drawing_id: UUID) -> Response:
    record = find_drawing(request, drawing_id)
    return Response(
        base64.b64decode(record["png"]), media_type="image/png",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.get("/api/drawings/{drawing_id}")
def get_drawing(request: Request, drawing_id: UUID) -> dict:
    record = find_drawing(request, drawing_id)
    return {
        "id": record["id"],
        "title": record["title"],
        "description": record["description"],
        # Drawings saved before layers existed have a flat stroke list.
        "layers": record.get("layers") or [
            {"name": "Layer 1", "visible": True, "opacity": 1.0, "strokes": record.get("strokes", [])}],
        "tags": record.get("tags", []),
    }


# ---------------------------------------------------------------- production: assets & shots
def png_response(record: dict) -> Response:
    return Response(base64.b64decode(record["png"]), media_type="image/png",
                    headers={"Cache-Control": "private, max-age=3600"})


def editable(record: dict, *fields: str) -> dict:
    return {"id": record["id"], **{field: record.get(field) for field in fields}, "layers": record["layers"],
            "history": record.get("history", [])}


@app.post("/api/assets", status_code=201)
async def create_asset(request: Request) -> dict:
    """Save a reusable asset (version 1). Untagged assets are auto-tagged."""
    asset = await read_json(request, Asset)
    asset, status = await auto_tag(request, asset, asset.name)
    return {**await run_in_threadpool(prod(request).save_asset, asset), "tags_status": status}


@app.put("/api/assets/{asset_id}")
async def update_asset(request: Request, asset_id: UUID) -> dict:
    """Save a new version of an asset. Shots that placed an older version are flagged as outdated."""
    asset = await read_json(request, Asset)
    asset, status = await auto_tag(request, asset, asset.name)
    saved = await run_in_threadpool(prod(request).save_asset, asset, str(asset_id))
    return {**saved, "tags_status": status}


@app.post("/api/assets/similar")
async def similar_assets(request: Request) -> dict:
    """Existing assets that look like this drawing (checked before saving a new asset)."""
    body = await read_json(request, LayersRequest)
    return {"items": await run_in_threadpool(prod(request).similar_to, body.layers)}


@app.get("/api/assets")
def list_assets(request: Request, q: str = Query(default="", max_length=500),
                type: str | None = Query(default=None), hand_min: float | None = Query(default=None, ge=0, le=1),
                color: str | None = Query(default=None, max_length=10)) -> dict:
    """Assets by words, or latest first; filter by type, by hand share (art math), and by color family."""
    if type and type not in ASSET_TYPES:
        raise HTTPException(422, f"type must be one of {', '.join(ASSET_TYPES)}.")
    return {"items": prod(request).list_assets(q.strip(), type, hand_min=hand_min, color=color)}


def find_asset(request: Request, asset_id: UUID) -> dict:
    record = prod(request).get_asset(str(asset_id))
    if record is None:
        raise HTTPException(404, "Asset not found.")
    return record


@app.get("/api/assets/{asset_id}")
def get_asset(request: Request, asset_id: UUID) -> dict:
    record = find_asset(request, asset_id)
    return editable(record, "name", "type", "description", "tags", "version", "origin", "stats")


@app.get("/api/assets/{asset_id}/similar")
def asset_similar(request: Request, asset_id: UUID) -> dict:
    """Assets and animation frames that look like this asset, ranked by its stored vector: no new embedding."""
    return prod(request).similar_everywhere(str(asset_id))


@app.get("/api/assets/{asset_id}/versions")
def asset_versions(request: Request, asset_id: UUID) -> dict:
    """Every saved version with its art math: the path from first doodle to finished asset."""
    find_asset(request, asset_id)
    return {"items": prod(request).asset_versions(str(asset_id))}


@app.get("/api/assets/{asset_id}/versions/{version}/image")
def asset_version_image(request: Request, asset_id: UUID, version: int) -> Response:
    png = prod(request).version_png(str(asset_id), version)
    if png is None:
        raise HTTPException(404, "Version not found.")
    return Response(base64.b64decode(png), media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/assets/{asset_id}/image")
def asset_image(request: Request, asset_id: UUID) -> Response:
    return png_response(find_asset(request, asset_id))


@app.post("/api/assets/{asset_id}/variations/plan")
async def plan_variations(request: Request, asset_id: UUID) -> dict:
    """Step 1 of variations: a short plan (name + brief per variation) the artist edits before anything is drawn."""
    plan = await read_json(request, VariationPlanRequest)
    asset = find_asset(request, asset_id)
    return {"items": await run_in_threadpool(request.app.state.ai.plan_variations, asset, plan)}


@app.post("/api/assets/{asset_id}/variations")
async def draw_variation(request: Request, asset_id: UUID) -> dict:
    """Step 2: one variation, drawn by editing the asset's own strokes. A preview; nothing is saved."""
    brief = await read_json(request, VariationRequest)
    asset = find_asset(request, asset_id)
    return await run_in_threadpool(request.app.state.ai.variation, asset, brief)


@app.get("/api/assets/{asset_id}/where-used")
def where_used(request: Request, asset_id: UUID, project: str | None = code_query(), sequence: str | None = code_query(),
               status: str | None = Query(default=None)) -> dict:
    """Shots that placed this asset (exact links), then shots with something that looks like it.

    Filters apply before ranking. ``status=open`` means anything not yet approved.
    """
    return prod(request).where_used(
        str(asset_id), project=project, sequence=sequence, status=status_query(status))


@app.delete("/api/assets/{asset_id}", status_code=204)
def delete_asset(request: Request, asset_id: UUID) -> Response:
    """Delete an asset that no shot uses (placed copies would otherwise lose their link)."""
    prod(request).delete_asset(str(asset_id))
    return Response(status_code=204)


@app.post("/api/shots", status_code=201)
async def create_shot(request: Request) -> dict:
    """Save a shot: artwork, placed-asset links, and production metadata. Indexes every element."""
    shot = await read_json(request, Shot, MAX_SHOT_BODY)
    shot, status = await auto_tag(request, shot, shot.code)
    return {**await run_in_threadpool(prod(request).save_shot, shot), "tags_status": status}


@app.put("/api/shots/{shot_id}")
async def replace_shot(request: Request, shot_id: UUID) -> dict:
    shot = await read_json(request, Shot, MAX_SHOT_BODY)
    shot, status = await auto_tag(request, shot, shot.code)
    saved = await run_in_threadpool(prod(request).save_shot, shot, str(shot_id))
    return {**saved, "tags_status": status}


@app.patch("/api/shots/{shot_id}")
async def update_shot(request: Request, shot_id: UUID) -> dict:
    """Change status or assignee. Metadata only: no artwork changes, so nothing is re-embedded."""
    update = await read_json(request, ShotUpdate)
    return await run_in_threadpool(prod(request).update_shot, str(shot_id), update)


class LinkRequest(BaseModel):
    asset_id: UUID
    layer_index: int = Field(ge=0, lt=MAX_LAYERS)


@app.post("/api/shots/{shot_id}/sync/{asset_id}")
async def sync_asset(request: Request, shot_id: UUID, asset_id: UUID) -> dict:
    """Update every older placement of an asset in a shot to its latest version (old art kept hidden)."""
    return await run_in_threadpool(prod(request).sync_asset, str(shot_id), str(asset_id))


@app.post("/api/shots/{shot_id}/link")
async def link_layer(request: Request, shot_id: UUID) -> dict:
    """Confirm a look-alike: link that layer to the asset so it becomes an exact use."""
    link = await read_json(request, LinkRequest)
    return await run_in_threadpool(
        prod(request).link_layer, str(shot_id), link.layer_index, str(link.asset_id))


@app.get("/api/shots")
def list_shots(request: Request, q: str = Query(default="", max_length=500), project: str | None = code_query(),
               sequence: str | None = code_query(), status: str | None = Query(default=None)) -> dict:
    return {"items": prod(request).list_shots(
        q.strip(), project=project, sequence=sequence, status=status_query(status))}


def find_shot(request: Request, shot_id: UUID) -> dict:
    record = prod(request).get_shot(str(shot_id))
    if record is None:
        raise HTTPException(404, "Shot not found.")
    return record


@app.get("/api/shots/{shot_id}")
def get_shot(request: Request, shot_id: UUID) -> dict:
    record = find_shot(request, shot_id)
    return {**editable(record, "code", "project", "sequence", "status", "assignee", "description", "tags", "assets"),
            "frames": record.get("frames", []), "fps": record.get("fps", 12), "motion": record.get("motion"), "sketch": record.get("sketch"),
            "share": prod(request).share_of(str(shot_id))}


@app.post("/api/shots/{shot_id}/share")
async def share_shot(request: Request, shot_id: UUID) -> dict:
    """A public link to this scene: a looping GIF and a page that explains how it moves."""
    result = await run_in_threadpool(prod(request).share_shot, str(shot_id))
    origin = public_origin(request)
    return {**result, "url": f"{origin}/s/{result['token']}", "gif_url": f"{origin}/s/{result['token']}/clip.gif"}


@app.delete("/api/shots/{shot_id}/share", status_code=204)
def unshare_shot(request: Request, shot_id: UUID) -> Response:
    prod(request).unshare(str(shot_id))
    return Response(status_code=204)


@app.get("/api/shots/{shot_id}/frames/{frame}/image")
def frame_image(request: Request, shot_id: UUID, frame: int) -> Response:
    png = prod(request).frame_png(str(shot_id), frame)
    if png is None:
        raise HTTPException(404, "Frame not found.")
    return Response(base64.b64decode(png), media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@app.delete("/api/shots/{shot_id}", status_code=204)
def delete_shot(request: Request, shot_id: UUID) -> Response:
    prod(request).delete_shot(str(shot_id))
    return Response(status_code=204)


# Revalidate the app shell on each load (cheap 304s via ETag) so upgrades never mix stale JS with new HTML.
REVALIDATE = {"Cache-Control": "no-cache"}


@app.get("/api/shots/{shot_id}/image")
def shot_image(request: Request, shot_id: UUID) -> Response:
    return png_response(find_shot(request, shot_id))


@app.get("/playground", include_in_schema=False)
def playground() -> FileResponse:
    """The original animation playground (SVG, canvas, and AI mocap demos)."""
    return FileResponse(ROOT / "index.html", headers=REVALIDATE)


def public_origin(request: Request) -> str:
    """Where this app lives, for link previews (crawlers need absolute URLs)."""
    configured = os.environ.get("PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL")  # Render sets the latter
    if configured:
        return configured.rstrip("/")
    host = (request.headers.get("x-forwarded-host") if TRUST_PROXY else None) or request.headers.get("host", "localhost")
    return f"{'https' if is_https(request) else 'http'}://{host.split(',')[0].strip()}"


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
@app.api_route("/studio", methods=["GET", "HEAD"], include_in_schema=False)
def studio(request: Request) -> HTMLResponse:
    page = (ROOT / "studio.html").read_text(encoding="utf-8")
    return HTMLResponse(page.replace("__ORIGIN__", html.escape(public_origin(request), quote=True)), headers=REVALIDATE)


SHARE_TOKEN = re.compile(r"[A-Za-z0-9_-]{12,32}")
PUBLIC_CACHE = {"Cache-Control": "public, max-age=300"}


def public_share(request: Request, token: str, *fields: str) -> dict:
    """Shared scenes are the one public read: only by unguessable token, only the snapshot."""
    production = getattr(request.app.state, "production", None)
    found = production.shared(token, *fields) if production and SHARE_TOKEN.fullmatch(token) else None
    if found is None:
        raise HTTPException(404, "This share link doesn't exist (or was turned off).")
    return found


@app.api_route("/s/{token}", methods=["GET", "HEAD"], include_in_schema=False)
def shared_page(request: Request, token: str) -> HTMLResponse:
    share = public_share(request, token, "token", "code", "description", "fps", "frames", "motion", "cast")
    return HTMLResponse(share_page(share, public_origin(request)), headers=PUBLIC_CACHE)


@app.api_route("/s/{token}/clip.gif", methods=["GET", "HEAD"], include_in_schema=False)
def shared_clip(request: Request, token: str) -> Response:
    return Response(public_share(request, token, "gif")["gif"], media_type="image/gif", headers=PUBLIC_CACHE)


@app.api_route("/s/{token}/poster.png", methods=["GET", "HEAD"], include_in_schema=False)
def shared_poster(request: Request, token: str) -> Response:
    return Response(public_share(request, token, "poster")["poster"], media_type="image/png", headers=PUBLIC_CACHE)


@app.get("/robots.txt", include_in_schema=False)
def robots(request: Request) -> Response:
    """Crawl the front door; the API and private share links stay out of search results."""
    body = f"User-agent: *\nAllow: /$\nDisallow: /api/\nDisallow: /s/\nSitemap: {public_origin(request)}/sitemap.xml\n"
    return Response(body, media_type="text/plain", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/sitemap.xml", include_in_schema=False)
def sitemap(request: Request) -> Response:
    origin = html.escape(public_origin(request), quote=True)
    body = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            f'<url><loc>{origin}/</loc><changefreq>weekly</changefreq></url></urlset>\n')
    return Response(body, media_type="application/xml", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/og.png", include_in_schema=False)
def social_card() -> FileResponse:
    return FileResponse(ROOT / "og.png", media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


# The Lab's scripts. The studio inlines them into a sandboxed iframe (opaque origin) whose own policy refuses the
# network; served on their own, they carry the same policy.
LAB_FILES = {"inkling-lab.js": "text/javascript", "p5.min.js": "text/javascript", "p5.LICENSE.txt": "text/plain"}
LAB_POLICY = ("default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; "
              "font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; "
              "base-uri 'none'; form-action 'none'; frame-ancestors 'self'")


@app.get("/lab/{name}", include_in_schema=False)
def lab_file(name: str) -> FileResponse:
    if name not in LAB_FILES:
        raise HTTPException(404, "Not part of the Lab.")
    headers = {**REVALIDATE, "Content-Security-Policy": LAB_POLICY, "X-Content-Type-Options": "nosniff"}
    return FileResponse(ROOT / "lab" / name, media_type=LAB_FILES[name], headers=headers)


# The installable app: manifest, icons, and a service worker that caches only the app shell (never /api/).
APP_ICONS = {"icon-192.png", "icon-512.png", "maskable-512.png", "apple-touch-icon.png"}


@app.get("/manifest.webmanifest", include_in_schema=False)
def web_manifest() -> FileResponse:
    return FileResponse(ROOT / "manifest.webmanifest", media_type="application/manifest+json", headers=REVALIDATE)


@app.get("/sw.js", include_in_schema=False)
def service_worker() -> FileResponse:
    return FileResponse(ROOT / "sw.js", media_type="text/javascript", headers={**REVALIDATE, "Service-Worker-Allowed": "/"})


@app.get("/apple-touch-icon.png", include_in_schema=False)
@app.get("/icons/{name}", include_in_schema=False)
def app_icon(name: str = "apple-touch-icon.png") -> FileResponse:
    if name not in APP_ICONS:
        raise HTTPException(404, "No such icon.")
    return FileResponse(ROOT / "icons" / name, media_type="image/png", headers={"Cache-Control": "public, max-age=604800"})


@app.get("/studio.js", include_in_schema=False)
def studio_script() -> FileResponse:
    return FileResponse(ROOT / "studio.js", media_type="text/javascript", headers=REVALIDATE)


@app.get("/studio.css", include_in_schema=False)
def studio_styles() -> FileResponse:
    return FileResponse(ROOT / "studio.css", media_type="text/css", headers=REVALIDATE)
