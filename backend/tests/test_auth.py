import base64
import json
import time
from unittest.mock import Mock

import pytest

from backend.auth import SESSION_COOKIE, AuthError, AuthUnavailable, MStash, Throttle, User, username_for
from backend.library import LibraryError, Scoped
from backend.production import Production


def jwt(**claims) -> str:
    def part(data: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
    body = {"iss": "m-stash", "uid": "u1", "email": "ada@example.com", "appId": "app1", "exp": time.time() + 3600, **claims}
    return f"{part({'alg': 'HS256'})}.{part(body)}.c2lnbmF0dXJl"


GOOD = jwt()


class FakeAuth:
    def __init__(self):
        self.calls = 0

    def config(self):
        return {"mode": "mstash", "api": "https://m-stash.test", "app": "pk_test"}

    def signup(self, email, password):
        return GOOD, True

    def login(self, email, password):
        if password != "a long drawing phrase":
            raise AuthError("That email and password don't match.")
        return GOOD

    def verify(self, token):
        self.calls += 1
        if token != GOOD:
            raise AuthError("Sign in again.")
        return User("u1", "ada@example.com")


@pytest.fixture
def signed(client):
    test_client, _ = client
    test_client.app.state.auth = FakeAuth()
    return test_client


def test_unscoped_access_fails_closed_and_scoping_does_not_leak():
    base = Scoped()
    with pytest.raises(LibraryError, match="Unscoped"):
        base.q({"id": "x"})
    mine = base.scoped("u1")
    assert mine.q({"id": "x"}) == {"id": "x", "owner": "u1"}
    assert base.owner is None  # the shared app object never becomes someone's


def test_token_is_trusted_only_after_mstash_accepts_it_and_is_cached():
    auth = MStash("https://m-stash.test", "pk_test", "app1")
    auth._call = Mock(return_value=(200, {"active": True, "claims": {"uid": "u1", "email": "ada@example.com"}}))
    assert auth.verify(GOOD) == User("u1", "ada@example.com")
    auth.verify(GOOD)
    assert auth._call.call_count == 1  # cached: drawing never waits on the network
    auth._call.return_value = (403, {"error": "Invalid or expired token"})
    with pytest.raises(AuthError):
        auth.verify(jwt(uid="u2"))
    auth._call.return_value = (200, {"active": False})
    with pytest.raises(AuthError):
        auth.verify(jwt(uid="u3"))


def test_the_member_id_comes_from_mstash_not_from_the_token_we_were_handed():
    auth = MStash("https://m-stash.test", "pk_test")
    auth._call = Mock(return_value=(200, {"active": True, "claims": {"uid": "real", "email": "ada@example.com"}}))
    assert auth.verify(jwt(uid="claimed")).id == "real"


def test_signup_signs_in_a_returning_member_and_explains_a_taken_email():
    auth = MStash("https://m-stash.test", "pk_test")
    auth._public = Mock(side_effect=[(409, {"error": "Email or username is already claimed"}), (200, {"token": GOOD})])
    assert auth.signup("ada@example.com", "a long drawing phrase") == (GOOD, False)
    auth._public = Mock(side_effect=[(409, {}), (401, {"error": "Invalid email or password"})])
    with pytest.raises(AuthError, match="Switch to Sign in"):
        auth.signup("ada@example.com", "someone else's phrase")
    auth._public = Mock(return_value=(400, {"error": "password must be between 12 and 72 characters"}))
    with pytest.raises(AuthError, match="^Password must be between 12 and 72 characters.$"):
        auth.signup("ada@example.com", "short")


def test_usernames_are_derived_and_valid_for_mstash():
    for email in ("Ada.Lovelace@x.com", "__@x.com", "9lives@x.com"):
        name = username_for(email)
        assert name[0].isalnum() and name[-1].isalnum() and name == name.lower() and len(name) <= 32


def test_sign_in_attempts_are_throttled_per_address():
    throttle = Throttle(limit=2, window=60)
    assert throttle.allow("1.2.3.4") and throttle.allow("1.2.3.4")
    assert not throttle.allow("1.2.3.4") and throttle.allow("5.6.7.8")


@pytest.mark.parametrize("claims", [{"appId": "someone-elses-app"}, {"exp": time.time() - 5}, {"iss": "elsewhere"}])
def test_foreign_expired_or_odd_tokens_are_refused_before_any_network_call(claims):
    auth = MStash("https://m-stash.test", "pk_test", "app1")
    auth._call = Mock()
    with pytest.raises(AuthError):
        auth.verify(jwt(**claims))
    auth._call.assert_not_called()


def test_unreachable_account_service_is_a_503_not_a_sign_out():
    auth = MStash("https://m-stash.test", "pk_test")
    auth._call = Mock(return_value=(502, {}))
    with pytest.raises(AuthUnavailable):
        auth.verify(GOOD)


def test_api_requires_a_session_and_binds_every_call_to_its_owner(signed):
    assert signed.get("/api/assets").status_code == 401
    assert signed.get("/api/assets", headers={"Authorization": "Bearer nope"}).status_code == 401
    signed.production.list_assets.return_value = []
    assert signed.get("/api/assets", headers={"Authorization": f"Bearer {GOOD}"}).status_code == 200
    signed.production.scoped.assert_called_with("u1")
    assert signed.get("/api/ready").status_code == 200 and signed.get("/health").status_code == 200


def test_service_key_is_refused_from_outside_the_container(signed, monkeypatch):
    monkeypatch.setenv("INKLING_SERVICE_KEY", "k" * 32)
    response = signed.get("/api/assets", headers={"X-Inkling-Service": "k" * 32, "X-Inkling-Owner": "demo"})
    assert response.status_code == 401  # the test client isn't loopback


def test_session_cookie_is_httponly_strict_and_signs_later_calls_in(signed):
    signed.production.counts.return_value = {"assets": 0, "scenes": 0, "ideas": 0}
    response = signed.post("/api/session", json={"token": GOOD})
    assert response.status_code == 200 and response.json()["user"]["email"] == "ada@example.com"
    cookie = response.headers["set-cookie"].lower()
    assert SESSION_COOKIE in cookie and "httponly" in cookie and "samesite=strict" in cookie
    assert signed.get("/api/session").status_code == 200  # the cookie alone signs the browser in (images too)
    assert signed.delete("/api/session").status_code == 204
    signed.cookies.clear()
    assert signed.get("/api/session").status_code == 401


def test_signup_and_login_keep_the_token_out_of_page_scripts(signed):
    signed.production.counts.return_value = {"assets": 0, "scenes": 0, "ideas": 0}
    assert signed.post("/api/auth/signup", json={"email": "ada@example.com", "password": "too short"}).status_code == 422
    response = signed.post("/api/auth/signup", json={"email": "Ada@Example.com", "password": "a long drawing phrase"})
    assert response.status_code == 200 and response.json()["created"] is True
    assert GOOD not in response.text  # only the HttpOnly cookie carries it
    assert "httponly" in response.headers["set-cookie"].lower()
    assert signed.get("/api/session").status_code == 200
    signed.cookies.clear()
    assert signed.post("/api/auth/login", json={"email": "ada@example.com", "password": "wrong phrase here"}).status_code == 401


def test_demo_copy_refuses_to_mix_into_existing_work(signed):
    signed.production.counts.return_value = {"assets": 2, "scenes": 0, "ideas": 0}
    response = signed.post("/api/library/demo", headers={"Authorization": f"Bearer {GOOD}"})
    assert response.status_code == 409
    signed.production.copy_library.assert_not_called()


class Store:
    def __init__(self, name, docs):
        self.name, self.docs = name, docs

    def find(self, where, projection=None):
        return [dict(doc) for doc in self.docs if doc["owner"] == where["owner"]]

    def insert_many(self, docs):
        self.docs += docs


def test_copying_a_library_remaps_every_id_so_the_copy_is_independent():
    asset, shot = "a" * 8, "s" * 8
    stores = {
        "drawings": Store("drawings", []),
        "assets": Store("assets", [{"id": asset, "_key": asset, "owner": "demo", "origin": None, "embedding": [0.1, 0.2]}]),
        "asset_versions": Store("asset_versions", [{"asset_id": asset, "owner": "demo", "version": 1}]),
        "shots": Store("shots", [{"id": shot, "_key": shot, "owner": "demo", "asset_ids": [asset],
                                  "layers": [{"asset": {"asset_id": asset, "version": 1}}], "created_at": "2026-01-01T00:00:00+00:00"}]),
        "shot_elements": Store("shot_elements", [{"id": f"{shot}:0", "owner": "demo", "shot_id": shot, "asset_id": asset}]),
        "shot_frames": Store("shot_frames", [{"id": f"{shot}:f2", "owner": "demo", "shot_id": shot, "asset_ids": [asset]}]),
        "clips": Store("clips", []),
    }
    production = Production.__new__(Production)
    production.owner = "u1"
    production.library = Mock()
    production.library.drawings.mongo = stores["drawings"]
    production.assets, production.shots = Mock(mongo=stores["assets"]), Mock(mongo=stores["shots"])
    production.elements, production.frames = Mock(mongo=stores["shot_elements"]), Mock(mongo=stores["shot_frames"])
    production.clips = Mock(mongo=stores["clips"])
    production.versions = stores["asset_versions"]

    copied = production.copy_library("demo")
    assert copied == {"drawings": 0, "assets": 1, "asset_versions": 1, "shots": 1, "shot_elements": 1, "shot_frames": 1, "clips": 0}
    new_asset = stores["assets"].find({"owner": "u1"})[0]
    new_shot = stores["shots"].find({"owner": "u1"})[0]
    assert new_asset["id"] != asset and new_asset["_key"] == new_asset["id"] and new_asset["embedding"] == [0.1, 0.2]
    assert new_shot["asset_ids"] == [new_asset["id"]] and new_shot["layers"][0]["asset"]["asset_id"] == new_asset["id"]
    assert new_shot["created_at"] == "2026-01-01T00:00:00+00:00"  # colons in values that aren't ids survive
    assert stores["shot_elements"].find({"owner": "u1"})[0]["id"] == f"{new_shot['id']}:0"
    assert stores["shot_frames"].find({"owner": "u1"})[0]["id"] == f"{new_shot['id']}:f2"
    assert stores["asset_versions"].find({"owner": "u1"})[0]["asset_id"] == new_asset["id"]
    assert len(stores["assets"].find({"owner": "demo"})) == 1  # the source is untouched


def test_the_starter_pack_copies_assets_once_with_vectors_and_lineage():
    fox, rocket, twin = "f" * 8, "r" * 8, "t" * 8
    assets = Store("assets", [
        {"id": fox, "_key": fox, "owner": "demo", "name": "Little Fox", "embedding": [0.1, 0.2]},
        {"id": rocket, "_key": rocket, "owner": "demo", "name": "Red Rocket"},
        {"id": twin, "_key": twin, "owner": "demo", "name": "Rocket Ship", "origin": {"asset_id": rocket, "version": 1}}])
    versions = Store("asset_versions", [{"asset_id": fox, "owner": "demo", "version": 1}])
    production = Production.__new__(Production)
    production.owner = "u1"
    production.assets, production.versions = Mock(mongo=assets), versions

    assert production.add_starter("demo") == {"assets": 3, "asset_versions": 1}
    mine = {doc["name"]: doc for doc in assets.find({"owner": "u1"})}
    assert mine["Little Fox"]["embedding"] == [0.1, 0.2] and mine["Little Fox"]["id"] != fox
    assert mine["Little Fox"]["starter"] == fox and mine["Little Fox"]["_key"] == mine["Little Fox"]["id"]
    assert mine["Rocket Ship"]["origin"]["asset_id"] == mine["Red Rocket"]["id"]
    assert versions.find({"owner": "u1"})[0]["asset_id"] == mine["Little Fox"]["id"]
    assert production.add_starter("demo") == {"assets": 0, "asset_versions": 0}  # never twice
    assert len(assets.find({"owner": "demo"})) == 3  # the source is untouched


def test_behind_a_tls_proxy_the_session_cookie_is_secure(signed, monkeypatch):
    import backend.main as main

    signed.production.counts.return_value = {"assets": 0, "scenes": 0, "ideas": 0}
    monkeypatch.setattr(main, "TRUST_PROXY", True)
    response = signed.post("/api/session", json={"token": GOOD}, headers={"X-Forwarded-Proto": "https"})
    assert "secure" in response.headers["set-cookie"].lower()
    monkeypatch.setattr(main, "TRUST_PROXY", False)  # without trust, the header is ignored
    response = signed.post("/api/session", json={"token": GOOD}, headers={"X-Forwarded-Proto": "https"})
    assert "secure" not in response.headers["set-cookie"].lower()


def test_sign_ins_are_also_limited_per_account(signed, monkeypatch):
    import backend.main as main

    monkeypatch.setattr(main, "SIGN_INS", Throttle(limit=2, window=60))
    monkeypatch.setattr(main, "TRUST_PROXY", True)
    body = {"email": "ada@example.com", "password": "wrong phrase here"}
    codes = [signed.post("/api/auth/login", json=body, headers={"X-Forwarded-For": f"10.0.0.{n}"}).status_code
             for n in range(3)]
    assert codes == [401, 401, 429]  # a new address per guess doesn't help


def test_the_root_url_is_the_studio(signed):
    assert "inkling" in signed.get("/").text.lower()
    assert signed.get("/playground").status_code == 200


def test_only_billable_calls_are_metered():
    from starlette.requests import Request as Req

    from backend.main import AI_BUDGET, EMBED_BUDGET, budget_for

    def kind(method, path, query=""):
        budget = budget_for(Req({"type": "http", "method": method, "path": path, "query_string": query.encode(), "headers": []}))
        return budget and budget.name

    uid = "11111111-2222-4333-8444-555555555555"
    assert kind("POST", "/api/sparks/sketch") == AI_BUDGET.name
    assert kind("POST", f"/api/assets/{uid}/variations/plan") == AI_BUDGET.name
    assert kind("POST", "/api/assets") == kind("PUT", f"/api/shots/{uid}") == EMBED_BUDGET.name
    assert kind("GET", "/api/frames", "q=rocket") == kind("GET", f"/api/assets/{uid}/where-used") == EMBED_BUDGET.name
    # browsing, images, metadata-only edits, and the demo copy (no re-embedding) are free
    assert kind("GET", "/api/frames") is kind("GET", f"/api/assets/{uid}/image") is kind("PATCH", f"/api/shots/{uid}") is None
    assert kind("POST", "/api/library/demo") is None


def test_a_member_who_spends_the_hour_gets_a_friendly_429_and_failures_are_free(signed, monkeypatch):
    import backend.main as main
    from backend.auth import Budget

    monkeypatch.setattr(main, "AI_BUDGET", Budget("ai", "AI drafts", 2))
    monkeypatch.setattr(main, "METERED", [(main.AI_BUDGET, *rule[1:]) if rule[0].name == "ai" else rule for rule in main.METERED])
    auth = {"Authorization": f"Bearer {GOOD}"}
    body = {"title": "Robot", "layers": [{"strokes": [{"color": "#000000", "width": 4, "points": [{"x": 0.1, "y": 0.1}]}]}]}
    assert signed.post("/api/tags/suggest", json={"layers": []}, headers=auth).status_code == 422  # failed: not charged
    assert [signed.post("/api/tags/suggest", json=body, headers=auth).status_code for _ in range(3)] == [200, 200, 429]
    blocked = signed.post("/api/tags/suggest", json=body, headers=auth)
    assert "2 AI drafts" in blocked.json()["detail"] and int(blocked.headers["Retry-After"]) > 3000
    signed.production.counts.return_value = {"assets": 0, "scenes": 0, "ideas": 0}
    assert signed.get("/api/session", headers=auth).json()["budget"]["ai"] == {"used": 2, "limit": 2, "left": 0}


def test_link_previews_use_absolute_urls_and_escape_the_host(signed, monkeypatch):
    monkeypatch.delenv("PUBLIC_URL", raising=False)
    monkeypatch.delenv("RENDER_EXTERNAL_URL", raising=False)
    page = signed.get("/", headers={"Host": 'evil.test"><script>'}).text
    assert "__ORIGIN__" not in page and "<script>\"" not in page and "&quot;&gt;&lt;script&gt;" in page
    monkeypatch.setenv("RENDER_EXTERNAL_URL", "https://inkling.onrender.com")
    page = signed.get("/").text
    assert '<meta property="og:image" content="https://inkling.onrender.com/og.png">' in page
    image = signed.get("/og.png")
    assert image.status_code == 200 and image.headers["content-type"] == "image/png"


def test_crawlers_get_a_sitemap_and_stay_out_of_the_api_and_shares(client, monkeypatch):
    monkeypatch.setenv("PUBLIC_URL", "https://inkling.example")
    client, _ = client  # signed out, like a crawler
    robots = client.get("/robots.txt")
    assert robots.status_code == 200 and "Disallow: /api/" in robots.text and "Disallow: /s/" in robots.text
    assert "Sitemap: https://inkling.example/sitemap.xml" in robots.text
    sitemap = client.get("/sitemap.xml")
    assert sitemap.status_code == 200 and "<loc>https://inkling.example/</loc>" in sitemap.text


def test_hosts_can_probe_with_head(signed):
    assert signed.head("/").status_code == 200 and signed.head("/health").status_code == 200


def test_ready_explains_a_fresh_boot_instead_of_a_dead_end(client):
    from backend import boot

    test_client, library = client
    library.ready.return_value = False
    boot.set_phase("indexing", "Building search indexes. On a new Atlas cluster this takes 1-3 minutes.")
    assert "Building search indexes" in test_client.get("/api/ready").json()["detail"]
    boot.set_phase("failed", "Atlas refused the index setup: maximum number of search indexes reached")
    assert "maximum number" in test_client.get("/api/ready").json()["detail"]
    boot.set_phase("ready")
    library.ready.return_value = True
    assert test_client.get("/api/ready").json()["status"] == "ready"


def test_ai_motion_counts_against_the_ai_budget():
    from starlette.requests import Request as Req

    from backend.main import AI_BUDGET, budget_for
    scope = {"type": "http", "method": "POST", "path": "/api/sparks/motion", "query_string": b"", "headers": []}
    assert budget_for(Req(scope)) is AI_BUDGET


def test_the_installable_app_ships_a_manifest_icons_and_a_root_scoped_worker(client):
    client, _ = client  # signed out: the shell must load with no session (and no signal)
    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200 and manifest.headers["content-type"].startswith("application/manifest+json")
    for icon in manifest.json()["icons"]:
        image = client.get(icon["src"])
        assert image.status_code == 200 and image.headers["content-type"] == "image/png"
    worker = client.get("/sw.js")
    assert worker.status_code == 200 and worker.headers["service-worker-allowed"] == "/"
    assert "/api/" not in worker.text.split("SHELL")[1].split(";")[0]  # the private library is never precached
    assert client.get("/apple-touch-icon.png").status_code == 200
    assert client.get("/icons/studio.js").status_code == 404  # only the named icons
