"""Who is drawing: m-stash accounts, verified server-side, turned into an ``owner`` for every query.

Sign-up and login go through Inkling's own backend to m-stash, server to server: the bearer token
never touches browser JavaScript, only an HttpOnly, SameSite=Strict cookie. (``POST /api/session``
also accepts a token minted elsewhere.) The token is an HS256 JWT signed by m-stash and we don't hold
its secret, so m-stash's own ``/v1/auth/verify`` decides; the user id comes from its answer, not from
the token we were handed. Verified tokens are cached briefly so drawing never waits on the network.

Scripts inside the container (demo seed, backfill, smoke test setup) may act as a named owner with a
service key derived from a server-side secret, and only over loopback.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

DEMO_OWNER = "demo"  # the shared starter library new members can copy into their own space
SESSION_COOKIE = "inkling_session"
LOOPBACK = {"127.0.0.1", "::1"}


class AuthError(Exception):
    """The caller isn't signed in (401) or their token was refused (401)."""


class AuthUnavailable(Exception):
    """m-stash couldn't be reached to verify a token (503)."""


@dataclass(frozen=True)
class User:
    id: str
    email: str = ""

    def public(self) -> dict:
        return {"id": self.id, "email": self.email}


def jwt_claims(token: str) -> dict:
    """The (not yet trusted) payload of a JWT; trust comes from m-stash accepting the token."""
    try:
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError) as exc:
        raise AuthError("That sign-in token is malformed. Sign in again.") from exc


def service_key() -> str:
    explicit = os.environ.get("INKLING_SERVICE_KEY")
    if explicit:
        return explicit
    secret = os.environ.get("VOYAGE_API_KEY", "")
    return hashlib.sha256(f"inkling-service:{secret}".encode()).hexdigest() if secret else ""


class MStash:
    """Verifies m-stash bearer tokens for one app, with a short in-memory cache."""

    def __init__(self, api: str, app_key: str, app_id: str = "", *, ttl: float = 300, timeout: float = 60) -> None:
        self.api = api.rstrip("/")
        self.app_key = app_key
        self.app_id = app_id
        self.ttl = ttl
        self.timeout = timeout
        self._cache: dict[str, tuple[User, float]] = {}
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "MStash | OpenAuth":
        if os.environ.get("INKLING_AUTH", "mstash").lower() == "off":
            return OpenAuth()
        key = os.environ.get("MSTASH_APP_KEY", "")
        if not key.startswith("pk_"):
            raise RuntimeError("Set MSTASH_APP_KEY to the m-stash publishable key (pk_...), or INKLING_AUTH=off for local-only use.")
        return cls(os.environ.get("MSTASH_API", "https://m-stash.onrender.com"), key, os.environ.get("MSTASH_APP_ID", ""))

    def config(self) -> dict:
        return {"mode": "mstash", "api": self.api, "app": self.app_key}

    def _call(self, method: str, path: str, token: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.api}{path}", data=data, method=method, headers={
            "X-M-Stash-App": self.app_key, "Authorization": f"Bearer {token}",
            **({"Content-Type": "application/json"} if data is not None else {})})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.load(exc)
            except ValueError:
                return exc.code, {}
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise AuthUnavailable("The account service is waking up or unreachable. Try again in a moment.") from exc

    def verify(self, token: str) -> User:
        claims = jwt_claims(token)
        now = time.time()
        if claims.get("iss") != "m-stash" or not claims.get("uid"):
            raise AuthError("That isn't an Inkling sign-in. Sign in again.")
        if float(claims.get("exp", 0)) <= now:
            raise AuthError("Your session expired. Sign in again.")
        if self.app_id and claims.get("appId") != self.app_id:
            raise AuthError("That sign-in belongs to a different app.")
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            cached = self._cache.get(digest)
            if cached and cached[1] > now:
                return cached[0]
        status, body = self._call("GET", "/v1/auth/verify", token)
        if status in (401, 403) or (status == 200 and not body.get("active")):
            raise AuthError("Your session expired or was signed out. Sign in again.")
        if status != 200 or not (body.get("claims") or {}).get("uid"):
            raise AuthUnavailable("The account service had a problem. Try again in a moment.")
        verified = body["claims"]
        user = User(id=str(verified["uid"]), email=str(verified.get("email", "")))
        with self._lock:
            if len(self._cache) > 5000:
                self._cache = {k: v for k, v in self._cache.items() if v[1] > now}
            self._cache[digest] = (user, min(float(claims["exp"]), now + self.ttl))
        return user

    def _public(self, path: str, body: dict) -> tuple[int, dict]:
        req = urllib.request.Request(f"{self.api}{path}", data=json.dumps(body).encode(), method="POST",
                                     headers={"X-M-Stash-App": self.app_key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.load(exc)
            except ValueError:
                return exc.code, {}
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise AuthUnavailable("The account service is waking up or unreachable. Try again in a moment.") from exc

    def login(self, email: str, password: str) -> str:
        status, body = self._public("/v1/auth/login", {"email": email, "password": password})
        if status == 401:
            raise AuthError("That email and password don't match. Try again, or create an account.")
        return self._token(status, body)

    def signup(self, email: str, password: str) -> tuple[str, bool]:
        """A new member (username derived from the email). Returns (token, created). An existing member
        whose password matches is simply signed in: nobody gets stuck on the wrong tab."""
        status, body = self._public("/v1/auth/signup", {"email": email, "password": password, "username": username_for(email)})
        if status == 409:
            try:
                return self.login(email, password), False
            except AuthError:
                raise AuthError("That email already has an Inkling studio. Switch to Sign in.") from None
        return self._token(status, body), True

    @staticmethod
    def _token(status: int, body: dict) -> str:
        if status in (200, 201) and body.get("token"):
            return body["token"]
        if status in (400, 413, 429) and body.get("error"):
            message = str(body["error"])
            raise AuthError(message[:1].upper() + message[1:].rstrip(".") + ".")
        raise AuthUnavailable("The account service had a problem. Try again in a moment.")

    # Per-user preferences live in m-stash as a private `item` record, written with the user's own token.
    PREFS = "/v1/me/resources/item/inkling-prefs"

    def get_prefs(self, token: str) -> dict:
        status, body = self._call("GET", self.PREFS, token)
        if status == 404:
            return {}
        if status != 200:
            raise AuthUnavailable("Couldn't load your preferences.")
        return (body.get("data") or {}).get("data") or {}

    def put_prefs(self, token: str, prefs: dict) -> dict:
        record = {"slug": "inkling-prefs", "title": "Inkling preferences", "visibility": "private",
                  "data": {"title": "Inkling preferences", "notes": "Guide progress and studio settings.", **prefs}}
        status, body = self._call("PUT", self.PREFS, token, record)
        if status == 404:
            status, body = self._call("POST", "/v1/me/resources/item", token, record)
        if status not in (200, 201):
            raise AuthUnavailable("Couldn't save your preferences.")
        return (body.get("data") or {}).get("data") or {}


class OpenAuth:
    """INKLING_AUTH=off: one local, single-user studio (offline development and tests)."""

    def __init__(self, owner: str = "local") -> None:
        self.user = User(id=owner, email="")

    def config(self) -> dict:
        return {"mode": "off"}

    def verify(self, token: str) -> User:
        return self.user

    def login(self, email: str, password: str) -> str:
        return "local-session-token-for-offline-use"

    def signup(self, email: str, password: str) -> tuple[str, bool]:
        return self.login(email, password), True

    def get_prefs(self, token: str) -> dict:
        return {}

    def put_prefs(self, token: str, prefs: dict) -> dict:
        return prefs


def username_for(email: str) -> str:
    """m-stash wants a username; artists shouldn't have to invent one. ada.l@x.com -> ada-l-7k2f"""
    base = re.sub(r"[^a-z0-9]+", "-", email.split("@")[0].lower()).strip("-")[:20] or "artist"
    return f"{base}-{secrets.token_hex(2)}"


class Throttle:
    """Sign-in attempts per client address (every login leaves from this server, so m-stash sees one IP)."""

    def __init__(self, limit: int = 10, window: float = 300) -> None:
        self.limit, self.window = limit, window
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            hits = [t for t in self._hits.get(key, []) if t > now - self.window]
            allowed = len(hits) < self.limit
            if allowed:
                hits.append(now)
            self._hits[key] = hits
            if len(self._hits) > 10000:
                self._hits = {k: v for k, v in self._hits.items() if v and v[-1] > now - self.window}
            return allowed

    def _live(self, key: str, now: float) -> list[float]:
        hits = [t for t in self._hits.get(key, []) if t > now - self.window]
        self._hits[key] = hits
        return hits

    def used(self, key: str) -> int:
        with self._lock:
            return len(self._live(key, time.time()))

    def record(self, key: str) -> None:
        now = time.time()
        with self._lock:
            self._live(key, now).append(now)

    def retry_after(self, key: str) -> int:
        """Seconds until the oldest counted call leaves the window."""
        now = time.time()
        with self._lock:
            hits = self._live(key, now)
            return max(1, int(hits[0] + self.window - now) + 1) if hits else 0


class Budget:
    """Billable calls per member per hour: checked before the call, charged only when it succeeds."""

    def __init__(self, name: str, label: str, per_hour: int) -> None:
        self.name, self.label, self.limit = name, label, per_hour
        self.meter = Throttle(limit=max(per_hour, 1), window=3600)

    @property
    def unlimited(self) -> bool:
        return self.limit <= 0

    def exhausted(self, owner: str) -> bool:
        return not self.unlimited and self.meter.used(owner) >= self.limit

    def status(self, owner: str) -> dict:
        used = self.meter.used(owner)
        return {"used": used, "limit": self.limit or None, "left": None if self.unlimited else max(0, self.limit - used)}


def service_owner(headers, client_host: str | None) -> str | None:
    """A container-internal script acting as a named owner (loopback + the derived service key only)."""
    supplied = headers.get("x-inkling-service")
    owner = headers.get("x-inkling-owner", "")
    if not supplied or client_host not in LOOPBACK:
        return None
    expected = service_key()
    if not expected or not hmac.compare_digest(supplied, expected) or not owner:
        raise AuthError("Service credentials refused.")
    return owner
