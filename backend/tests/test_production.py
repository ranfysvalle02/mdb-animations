from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import ValidationError
from pymongo.errors import OperationFailure

from backend.models import Asset, Shot, ShotUpdate
from backend.production import (
    CODE_INDEX, Production, ProductionError, element_records, group_where_used, metadata_filter,
)

ASSET_ID = "11111111-2222-4333-8444-555555555555"
SHOT_ID = "e8de20c1-5ad3-45a6-8ca0-abf2a40e4051"


def ink(x0, y0, x1, y1, color="#ff0000"):
    return {"color": color, "width": 8, "points": [{"x": x0, "y": y0}, {"x": x1, "y": y1}]}


def shot_payload(**changes):
    return {
        "code": "SQ010_0010", "project": "demo", "sequence": "SQ010", "status": "in_progress", "assignee": "maya",
        "layers": [
            {"name": "BG", "strokes": [ink(0, 0.9, 1, 0.9, "#00ff00")]},
            {"name": "Rocket", "asset": {"asset_id": ASSET_ID, "version": 1}, "strokes": [ink(0.1, 0.1, 0.2, 0.3)]},
            {"name": "Hidden sketch", "visible": False, "strokes": [ink(0.5, 0.5, 0.6, 0.6)]},
            {"name": "Empty", "strokes": []},
        ],
        **changes,
    }


@pytest.mark.parametrize("change", [
    {"code": "SQ 010"}, {"project": ""}, {"sequence": "x" * 41}, {"status": "done"}, {"assignee": "a" * 61},
    {"layers": [{"strokes": [ink(0, 0, 1, 1)], "asset": {"asset_id": "not-a-uuid", "version": 1}}]},
    {"layers": [{"strokes": [ink(0, 0, 1, 1)], "asset": {"asset_id": ASSET_ID, "version": 0}}]},
])
def test_shot_validation(change):
    with pytest.raises(ValidationError):
        Shot.model_validate(shot_payload(**change))


def test_assets_cannot_nest_placed_assets_and_updates_need_a_change():
    with pytest.raises(ValidationError, match="flatten"):
        Asset.model_validate({"name": "Rig", "layers": shot_payload()["layers"]})
    with pytest.raises(ValidationError, match="status or an assignee"):
        ShotUpdate.model_validate({})


def test_elements_are_visible_inked_layers_with_shot_metadata_and_ink_boxes():
    shot = Shot.model_validate(shot_payload())
    elements = element_records(SHOT_ID, shot, {ASSET_ID: {"name": "Red Rocket"}})
    assert [e["layer_name"] for e in elements] == ["BG", "Rocket"]  # hidden and empty layers are skipped
    rocket = elements[1]
    assert rocket["id"] == f"{SHOT_ID}:1" and rocket["layer_index"] == 1
    assert (rocket["asset_id"], rocket["asset_name"], rocket["asset_version"]) == (ASSET_ID, "Red Rocket", 1)
    assert {k: rocket[k] for k in ("code", "project", "sequence", "status", "assignee")} == {
        "code": "SQ010_0010", "project": "demo", "sequence": "SQ010", "status": "in_progress", "assignee": "maya"}
    box = rocket["box"]
    assert box["x"] < 0.1 < 0.2 < box["x"] + box["w"] and box["y"] < 0.1 < 0.3 < box["y"] + box["h"]
    assert box["w"] < 0.2  # cropped to the prop, not the whole canvas
    assert elements[0]["asset_id"] is None and rocket["image"].startswith(b"\x89PNG")


def test_where_used_groups_links_then_look_alikes():
    asset = {"id": ASSET_ID, "name": "Red Rocket", "type": "prop", "version": 2, "updated_at": "t"}
    row = lambda shot, code, **extra: {"shot_id": shot, "code": code, "project": "demo", "sequence": "SQ010",
                                       "status": "todo", "assignee": "", "layer_name": "L", "box": {}, **extra}
    linked = [row("a", "SQ010_0010", asset_id=ASSET_ID, asset_version=1), row("b", "SQ010_0030", asset_id=ASSET_ID, asset_version=2)]
    similar = [
        row("a", "SQ010_0010", score=0.95, asset_id=ASSET_ID),  # already linked: not repeated
        row("c", "SQ010_0020", score=0.80), row("c", "SQ010_0020", score=0.86),  # best element per shot
        row("d", "SQ020_0010", score=0.90), row("e", "SQ030_0010", score=0.60),  # below the cutoff
    ]
    result = group_where_used(asset, linked, similar, 0.72)
    assert [(e["code"], e["outdated"]) for e in result["linked"]] == [("SQ010_0010", True), ("SQ010_0030", False)]
    assert [(e["code"], e["score"]) for e in result["similar"]] == [("SQ020_0010", 0.9), ("SQ010_0020", 0.86)]


def test_metadata_filter_open_means_not_approved():
    assert metadata_filter("demo", "SQ010", "open") == {"project": "demo", "sequence": "SQ010", "status": {"$ne": "approved"}}
    assert metadata_filter(None, None, "review") == {"status": "review"}
    assert metadata_filter(None, None, None) == {}


def offline_production():
    production = Production.__new__(Production)
    production.owner = "tester"
    production.assets, production.shots, production.elements, production.frames = Mock(), Mock(), Mock(), Mock()
    production.min_score = 0.72
    production.frames.mongo.find.return_value = []
    production.versions = Mock()
    for collection in (production.assets, production.shots, production.elements, production.frames):
        collection.add.side_effect = lambda records, retries: SimpleNamespace(added=len(records), failed=0, skipped=0)
    production.assets.mongo.find.return_value = [{"id": ASSET_ID, "name": "Red Rocket", "version": 3}]
    production.shots.mongo.find_one.return_value = None
    return production


def test_status_change_updates_metadata_only():
    production = offline_production()
    production.shots.mongo.update_one.return_value = SimpleNamespace(matched_count=1)
    production.shots.mongo.find_one.return_value = {"id": SHOT_ID, "code": "SQ010_0010", "status": "approved", "updated_at": "t"}
    production.update_shot(SHOT_ID, ShotUpdate(status="approved"))
    production.elements.mongo.update_many.assert_called_once_with({"shot_id": SHOT_ID, "owner": "tester"}, {"$set": {"status": "approved"}})
    production.shots.add.assert_not_called()
    production.elements.add.assert_not_called()  # nothing re-embedded


def test_save_shot_indexes_elements_links_assets_and_rolls_back_on_failure():
    production = offline_production()
    saved = production.save_shot(Shot.model_validate(shot_payload()))
    record = production.shots.add.call_args.args[0][0]
    assert record["asset_ids"] == [ASSET_ID] and record["assets"] == [{"id": ASSET_ID, "name": "Red Rocket", "version": 1}]
    assert saved["elements"] == 2 and len(production.elements.add.call_args.args[0]) == 2
    production.elements.mongo.delete_many.assert_called_once()  # stale elements of an edited shot are dropped

    production.elements.add.side_effect = RuntimeError("voyage down")
    with pytest.raises(RuntimeError):
        production.save_shot(Shot.model_validate(shot_payload()))
    production.shots.mongo.delete_one.assert_called_once()  # a new shot never exists without its elements

    previous = {"id": SHOT_ID, "status": "review", "embedding": [0.1], "created_at": "t"}
    production.shots.mongo.find_one.return_value = previous
    with pytest.raises(RuntimeError):
        production.save_shot(Shot.model_validate(shot_payload(status="approved")), SHOT_ID)
    production.shots.mongo.replace_one.assert_called_once_with({"id": SHOT_ID, "owner": "tester"}, previous)  # update undone exactly


@pytest.mark.parametrize("found, message", [([], "no longer exists"), ([{"id": ASSET_ID, "name": "Red Rocket", "version": 0}], "no version 1")])
def test_save_shot_rejects_broken_asset_links(found, message):
    production = offline_production()
    production.assets.mongo.find.return_value = found
    with pytest.raises(ProductionError, match=message):
        production.save_shot(Shot.model_validate(shot_payload()))
    production.shots.add.assert_not_called()


def test_used_assets_cannot_be_deleted():
    production = offline_production()
    production.shots.mongo.aggregate.return_value = [{"_id": ASSET_ID, "shots": 2}]
    with pytest.raises(ProductionError, match="placed in 2 shots"):
        production.delete_asset(ASSET_ID)
    production.assets.mongo.delete_one.assert_not_called()


def test_where_used_endpoint_passes_each_filter_separately(client):
    http, _ = client
    http.production.where_used.return_value = {"linked": [], "similar": []}
    http.get(f"/api/assets/{ASSET_ID}/where-used", params={"project": "demo", "status": "open"})
    http.production.where_used.assert_called_with(ASSET_ID, project="demo", sequence=None, status="open")
    for bad in ({"status": "done"}, {"project": "has space"}, {"sequence": "a$b"}):
        assert http.get(f"/api/assets/{ASSET_ID}/where-used", params=bad).status_code == 422


def test_production_endpoints_validate_and_map_errors(client):
    http, _ = client
    http.production.save_shot.side_effect = lambda shot, shot_id=None: {"id": SHOT_ID, "elements": 2}
    response = http.post("/api/shots", json={**shot_payload(), "tags": ["launch"], "description": "Rocket lifts off"})
    assert response.status_code == 201 and response.json()["tags_status"] == "provided"
    http.ai.describe.assert_not_called()
    assert http.post("/api/shots", json=shot_payload(code="bad code")).status_code == 422
    http.production.update_shot.side_effect = ProductionError("Shot not found.")
    assert http.patch(f"/api/shots/{SHOT_ID}", json={"status": "approved"}).status_code == 404
    http.production.delete_asset.side_effect = ProductionError("This asset is placed in 2 shots; remove those layers first.")
    assert http.delete(f"/api/assets/{ASSET_ID}").status_code == 422
    assert http.get("/api/assets", params={"type": "vehicle"}).status_code == 422


def test_blank_metadata_is_written_by_ai_and_artist_words_are_kept(client):
    http, _ = client
    http.production.save_asset.side_effect = lambda asset, asset_id=None: {"id": ASSET_ID, "description": asset.description, "tags": asset.tags}
    asset = {"name": "Red Rocket", "layers": [{"name": "Ink", "strokes": [ink(0.1, 0.1, 0.2, 0.3)]}]}
    response = http.post("/api/assets", json=asset)
    assert response.json() == {"id": ASSET_ID, "description": "A friendly robot face.", "tags": ["robot", "face"], "tags_status": "auto"}
    response = http.post("/api/assets", json={**asset, "description": "My rocket", "tags": []})
    assert response.json()["description"] == "My rocket" and response.json()["tags"] == ["robot", "face"]

    http.production.save_shot.side_effect = lambda shot, shot_id=None: {"id": SHOT_ID, "description": shot.description}
    motion = {"by": "path", "note": "Drawn path", "seconds": 10, "tracks": [{"name": "Rocket", "gait": "hop", "keys": [
        {"t": 0, "x": 0, "y": 0, "sx": 1, "sy": 1, "r": 0}, {"t": 1, "x": 0.3, "y": -0.2, "sx": 1, "sy": 1, "r": 0}]}]}
    frames = [{"layers": shot_payload()["layers"]}] * 79
    response = http.post("/api/shots", json={**shot_payload(), "tags": ["launch"], "frames": frames, "fps": 8, "motion": motion})
    assert response.status_code == 201 and response.json()["description"] == "A friendly robot face."
    assert http.production.save_shot.call_args.args[0].motion.tracks[0].gait == "hop"
    assert http.post("/api/shots", json={**shot_payload(), "motion": {**motion, "tracks": [{**motion["tracks"][0], "gait": "moonwalk"}]}}).status_code == 422
    context = http.ai.describe.call_args.args[1]
    assert "10 seconds" in context and 'what happens: "Drawn path"' in context and "Rocket" in context

    from starlette.requests import Request as Req

    from backend.main import AI_BUDGET, budget_for
    scope = {"type": "http", "method": "POST", "path": "/api/describe", "query_string": b"", "headers": []}
    assert budget_for(Req(scope)) is AI_BUDGET  # one Gemini call each, metered like every AI draft


def test_scenes_can_be_searched_within_one_asset(client):
    http, _ = client
    http.production.list_shots.return_value = []
    http.get("/api/shots", params={"asset_id": ASSET_ID, "q": "on the beach"})
    http.production.list_shots.assert_called_with("on the beach", project=None, sequence=None, status=None, asset_id=ASSET_ID)
    assert http.get("/api/shots", params={"asset_id": "nope"}).status_code == 422
    production = offline_production()
    production.shots.search.return_value.rerank.return_value.limit.return_value.where.return_value = []
    production.list_shots("on the beach", asset_id=ASSET_ID)
    where = production.shots.search.return_value.rerank.return_value.limit.return_value.where.call_args.kwargs
    assert where["asset_ids"] == ASSET_ID


def test_only_placed_layers_carry_an_asset_link():
    layers = Shot.model_validate(shot_payload()).model_dump()["layers"]
    assert "asset" not in layers[0]
    assert layers[1]["asset"] == {"asset_id": ASSET_ID, "version": 1}


def test_hidden_placements_still_count_as_links():
    production = offline_production()
    production.shots.mongo.find.return_value = [{
        "id": SHOT_ID, "code": "SQ010_0010", "project": "demo", "sequence": "SQ010", "status": "todo", "assignee": "",
        "assets": [{"id": ASSET_ID, "name": "Red Rocket", "version": 1}]}]
    production.elements.mongo.find.return_value = []  # the placed layer is hidden: no element
    rows = production._linked(ASSET_ID, {"status": {"$ne": "approved"}})
    assert production.shots.mongo.find.call_args.args[0] == {"asset_ids": ASSET_ID, "status": {"$ne": "approved"}}
    assert rows[0]["shot_id"] == SHOT_ID and rows[0]["box"] is None and rows[0]["asset_version"] == 1


def test_oldest_placement_decides_outdated():
    production = offline_production()
    payload = shot_payload()
    payload["layers"].append({"name": "Rocket 2", "asset": {"asset_id": ASSET_ID, "version": 3}, "strokes": [ink(0.7, 0.1, 0.8, 0.3)]})
    production.save_shot(Shot.model_validate(payload))
    assert production.shots.add.call_args.args[0][0]["assets"] == [{"id": ASSET_ID, "name": "Red Rocket", "version": 1}]


def shot_record(**changes):
    return {"id": SHOT_ID, "created_at": "t", "updated_at": "t", **shot_payload(**changes)}


def test_sync_swaps_latest_version_into_same_spot_and_keeps_backup():
    production = offline_production()
    latest = {"name": "Rocket", "strokes": [ink(0.4, 0.4, 0.6, 0.8, "#0000ff")]}
    production.assets.mongo.find_one.return_value = {"id": ASSET_ID, "name": "Red Rocket", "version": 3, "layers": [latest]}
    production.shots.mongo.find_one.side_effect = lambda query, projection=None: shot_record()
    result = production.sync_asset(SHOT_ID, ASSET_ID)
    layers = production.shots.add.call_args.args[0][0]["layers"]
    assert [layer["name"] for layer in layers] == ["BG", "Rocket (v1 backup)", "Rocket", "Hidden sketch", "Empty"]
    backup, updated = layers[1], layers[2]
    assert backup["visible"] is False and "asset" not in backup  # old art kept, no longer a link
    assert updated["asset"] == {"asset_id": ASSET_ID, "version": 3} and updated["strokes"][0]["color"] == "#0000ff"
    xs = [p["x"] for p in updated["strokes"][0]["points"]]
    assert 0.09 <= min(xs) and max(xs) <= 0.21  # fitted into where v1 was placed, not where v3 was drawn
    assert (result["updated"], result["backups"], result["version"]) == (1, 1, 3)


def test_sync_refuses_when_already_current():
    production = offline_production()
    production.assets.mongo.find_one.return_value = {"id": ASSET_ID, "name": "Red Rocket", "version": 1, "layers": []}
    production.shots.mongo.find_one.side_effect = lambda query, projection=None: shot_record()
    with pytest.raises(ProductionError, match="already uses the latest"):
        production.sync_asset(SHOT_ID, ASSET_ID)


def test_confirming_a_look_alike_links_that_layer_without_changing_art():
    production = offline_production()
    production.assets.mongo.find_one.return_value = {"id": ASSET_ID, "name": "Red Rocket", "version": 3, "layers": []}
    production.shots.mongo.find_one.side_effect = lambda query, projection=None: shot_record()
    production.link_layer(SHOT_ID, 0, ASSET_ID)
    layer = production.shots.add.call_args.args[0][0]["layers"][0]
    assert layer["asset"] == {"asset_id": ASSET_ID, "version": 3} and layer["strokes"][0]["color"] == "#00ff00"
    other = "99999999-2222-4333-8444-555555555555"
    production.assets.mongo.find_one.return_value = {"id": other, "name": "Other", "version": 1, "layers": []}
    with pytest.raises(ProductionError, match="different asset"):
        production.link_layer(SHOT_ID, 1, other)
    with pytest.raises(ProductionError, match="no longer exists"):
        production.link_layer(SHOT_ID, 9, other)


def test_sync_and_link_endpoints(client):
    http, _ = client
    http.production.sync_asset.return_value = {"updated": 1}
    assert http.post(f"/api/shots/{SHOT_ID}/sync/{ASSET_ID}").json() == {"updated": 1}
    http.production.link_layer.return_value = {"id": SHOT_ID}
    http.post(f"/api/shots/{SHOT_ID}/link", json={"asset_id": ASSET_ID, "layer_index": 2})
    http.production.link_layer.assert_called_once_with(SHOT_ID, 2, ASSET_ID)
    assert http.post(f"/api/shots/{SHOT_ID}/link", json={"asset_id": ASSET_ID, "layer_index": 12}).status_code == 422


def test_similar_assets_skip_itself_and_weak_matches():
    production = offline_production()
    production.asset_min_score = 0.75
    def hit(id_, score):
        return {"id": id_, "name": id_, "type": "prop", "version": 1, "updated_at": "t", "score": score}
    class Hit(dict):
        @property
        def score(self):
            return self["score"]
    production.assets.search.return_value.rerank.return_value.limit.return_value.where.return_value = [
        Hit(hit(ASSET_ID, 0.95)), Hit(hit("near-dupe", 0.83)), Hit(hit("unrelated", 0.66))]
    result = production.similar_assets({"id": ASSET_ID}, object())
    assert [(r["id"], r["score"]) for r in result] == [("near-dupe", 0.83)]
    assert production.similar_assets({"id": ASSET_ID}, None) == []


def test_sketch_and_similar_endpoints_validate(client):
    http, _ = client
    http.ai.sketch.return_value = {"kind": "sketch", "strokes": []}
    assert http.post("/api/sparks/sketch", json={"prompt": "a cozy house"}).json()["kind"] == "sketch"
    assert http.post("/api/sparks/sketch", json={"prompt": "hi"}).status_code == 422
    http.production.similar_to.return_value = [{"id": "x"}]
    assert http.post("/api/assets/similar", json={"layers": shot_payload()["layers"][:1]}).json() == {"items": [{"id": "x"}]}
    assert http.post("/api/assets/similar", json={"layers": [{"strokes": []}]}).status_code == 422


# ---------------------------------------------------------------- frames, lineage, and the audit trail
def frame_two(version=1):
    return {"layers": [{"name": "BG", "strokes": [ink(0, 0.9, 1, 0.9, "#00ff00")]},
                       {"name": "Rocket", "asset": {"asset_id": ASSET_ID, "version": version}, "strokes": [ink(0.1, 0.0, 0.2, 0.2)]}]}


@pytest.mark.parametrize("change", [{"fps": 30}, {"frames": [{"layers": []}]}, {"frames": [frame_two()] * 80},
                                    {"frames": [{"layers": [{"name": "Rocket", "ref": 5}]}]},  # frame 1 has no layer 5
                                    {"frames": [{"layers": [{"name": "Rocket", "xf": {"x": 0.1}}]}]},  # a pose of nothing
                                    {"layers": [{"name": "Rocket", "ref": 0}]}])  # frame 1 can't reference itself
def test_frame_validation(change):
    with pytest.raises(ValidationError):
        Shot.model_validate(shot_payload(**change))


def test_links_and_sync_cover_every_frame_and_are_logged():
    production = offline_production()
    production.save_shot(Shot.model_validate(shot_payload(layers=[shot_payload()["layers"][0]], frames=[frame_two()])))
    record = production.shots.add.call_args.args[0][0]
    assert record["asset_ids"] == [ASSET_ID]  # placed only in frame 2: still a link
    assert record["history"][-1]["action"] == "Saved" and "2 frames at 12 fps" in record["history"][-1]["detail"]

    latest = {"name": "Rocket", "strokes": [ink(0.4, 0.4, 0.6, 0.8, "#0000ff")]}
    production.assets.mongo.find_one.return_value = {"id": ASSET_ID, "name": "Red Rocket", "version": 3, "layers": [latest]}
    production.shots.mongo.find_one.side_effect = lambda query, projection=None: shot_record(frames=[frame_two(), frame_two()])
    result = production.sync_asset(SHOT_ID, ASSET_ID)
    record = production.shots.add.call_args.args[0][0]
    assert result["updated"] == 3  # frame 1 and both extra frames
    assert all(layer.get("asset", {}).get("version") in (None, 3) for frame in record["frames"] for layer in frame["layers"])
    assert record["history"][-1]["action"] == "Updated asset" and "across 3 frames" in record["history"][-1]["detail"]


def test_history_appends_artist_and_studio_events_to_the_stored_trail():
    production = offline_production()
    production.assets.mongo.find_one.return_value = {
        "id": ASSET_ID, "name": "Red Rocket", "version": 1, "created_at": "t",
        "history": [{"at": "t0", "by": "studio", "action": "Saved", "detail": "v1"}]}
    production.save_asset(Asset.model_validate({
        "name": "Red Rocket", "layers": [{"strokes": [ink(0, 0, 1, 1)]}],
        "history": [{"at": "2026-11-24T00:00:00Z", "by": "ai", "action": "Fix a spot", "detail": "accepted: window"}]}), ASSET_ID)
    trail = production.assets.add.call_args.args[0][0]["history"]
    assert [(e["by"], e["action"], e["detail"]) for e in trail] == [
        ("studio", "Saved", "v1"), ("ai", "Fix a spot", "accepted: window"), ("studio", "Saved", "v2")]


def test_status_changes_are_logged():
    production = offline_production()
    production.shots.mongo.update_one.return_value = SimpleNamespace(matched_count=1)
    production.shots.mongo.find_one.return_value = {"id": SHOT_ID, "code": "SQ010_0010", "status": "approved", "updated_at": "t"}
    production.update_shot(SHOT_ID, ShotUpdate(status="approved", assignee=""))
    pushed = production.shots.mongo.update_one.call_args.args[1]["$push"]["history"]["$each"][0]
    assert (pushed["action"], pushed["detail"]) == ("Changed", "status Approved, artist unassigned")


def test_variations_record_their_parent_and_show_up_as_family():
    production = offline_production()
    parent = {"id": ASSET_ID, "name": "Red Rocket", "type": "prop", "version": 2, "updated_at": "t", "created_at": "t"}
    production.assets.mongo.find_one.side_effect = lambda query, projection=None: parent if query["id"] == ASSET_ID else None
    variant = {"name": "Laser Rocket", "layers": [{"strokes": [ink(0, 0, 1, 1)]}],
               "origin": {"asset_id": ASSET_ID, "version": 2, "brief": "twin lasers", "kept": 5, "added": 4}}
    production.save_asset(Asset.model_validate(variant))
    record = production.assets.add.call_args.args[0][0]
    assert record["origin"]["name"] == "Red Rocket" and record["history"][0]["by"] == "ai"
    assert "kept 5 of the artist's strokes, added 4" in record["history"][0]["detail"]

    with pytest.raises(ProductionError, match="no version 3"):
        production.save_asset(Asset.model_validate({**variant, "origin": {**variant["origin"], "version": 3}}))
    production.assets.mongo.find_one.side_effect = lambda query, projection=None: None
    with pytest.raises(ProductionError, match="no longer exists"):
        production.save_asset(Asset.model_validate(variant))

    production.assets.mongo.find_one.side_effect = lambda query, projection=None: parent
    production.assets.mongo.find = Mock()
    production.assets.mongo.find.return_value.sort.return_value.limit.return_value = [
        {**record, "id": "22222222-2222-4333-8444-555555555555"}]
    family = production.family({**record, "id": "33333333-2222-4333-8444-555555555555"})
    assert family["parent"]["name"] == "Red Rocket" and family["parent"]["brief"] == "twin lasers"
    assert [v["origin"]["name"] for v in family["variants"]] == ["Red Rocket"]
    assert [v["id"] for v in family["siblings"]] == ["22222222-2222-4333-8444-555555555555"]  # other variations of the parent
    assert production.assets.mongo.find.call_args_list[-1].args[0] == {
        "origin.asset_id": ASSET_ID, "id": {"$ne": "33333333-2222-4333-8444-555555555555"}, "owner": "tester"}


def test_variation_endpoints(client):
    http, _ = client
    http.production.get_asset.return_value = {"id": ASSET_ID, "name": "Red Rocket"}
    http.ai.plan_variations.return_value = [{"name": "A", "brief": "b"}]
    assert http.post(f"/api/assets/{ASSET_ID}/variations/plan", json={"goal": "a battle", "count": 9}).json() == {
        "items": [{"name": "A", "brief": "b"}]}
    assert http.post(f"/api/assets/{ASSET_ID}/variations/plan", json={"goal": "a battle", "count": 10}).status_code == 422
    http.ai.variation.return_value = {"strokes": [], "kept": 1}
    assert http.post(f"/api/assets/{ASSET_ID}/variations", json={"brief": "with a shield"}).json()["kept"] == 1
    assert http.ai.variation.call_args.args[1].brief == "with a shield"
    http.production.get_asset.return_value = None
    assert http.post(f"/api/assets/{ASSET_ID}/variations", json={"brief": "with a shield"}).status_code == 404



def test_frames_are_indexed_once_per_change_with_their_own_assets():
    production = offline_production()
    shot = Shot.model_validate(shot_payload(layers=[shot_payload()["layers"][0]], frames=[frame_two(), frame_two()]))
    links = {ASSET_ID: {"name": "Red Rocket"}}
    assert production.index_frames(SHOT_ID, shot, links) == 3
    records = production.frames.add.call_args.args[0]
    assert [(r["id"], r["frame"], r["frames"], r["asset_ids"]) for r in records] == [
        (f"{SHOT_ID}:f1", 1, 3, []), (f"{SHOT_ID}:f2", 2, 3, [ASSET_ID]), (f"{SHOT_ID}:f3", 3, 3, [ASSET_ID])]
    assert records[1]["assets"] == [{"id": ASSET_ID, "name": "Red Rocket"}] and records[1]["png"]

    # Saving again with only frame 3 changed re-embeds just that frame; the rest get fresh metadata.
    production.frames.mongo.find.return_value = [{"id": r["id"], "hash": r["hash"]} for r in records]
    production.frames.add.reset_mock()
    moved = frame_two()
    moved["layers"][1]["strokes"] = [ink(0.1, 0.5, 0.2, 0.7)]
    changed = Shot.model_validate(shot_payload(layers=[shot_payload()["layers"][0]], frames=[frame_two(), moved], status="review"))
    assert production.index_frames(SHOT_ID, changed, links) == 1
    assert [r["id"] for r in production.frames.add.call_args.args[0]] == [f"{SHOT_ID}:f3"]
    assert production.frames.mongo.update_one.call_args_list[0].args[1]["$set"]["status"] == "review"


def test_frame_search_and_sketch_endpoints(client):
    http, _ = client
    http.production.find_frames.return_value = [{"id": "f"}]
    assert http.get("/api/frames", params={"q": "rocket in the sky", "asset_id": ASSET_ID, "status": "open"}).json() == {"items": [{"id": "f"}]}
    http.production.find_frames.assert_called_with("rocket in the sky", asset_id=ASSET_ID, project=None, sequence=None, status="open")
    assert http.get("/api/frames", params={"asset_id": "nope"}).status_code == 422
    layers = shot_payload()["layers"][:1]
    http.production.search_assets.return_value = [{"id": "a"}]
    found = http.post("/api/search/sketch", json={"scope": "asset", "layers": layers}).json()
    assert found["items"] == [{"id": "a"}] and found["timing"]["embeddings"] == 1  # the receipt the studio shows
    http.post("/api/search/sketch", json={"scope": "frame", "layers": layers})
    assert http.production.find_frames.call_args.args[0].size == (1000, 650)  # the whole canvas is the query
    assert http.post("/api/search/sketch", json={"scope": "movie", "layers": layers}).status_code == 422
    assert http.post("/api/search/sketch", json={"scope": "frame", "layers": [{"strokes": []}]}).status_code == 422
    http.production.frame_png.return_value = None
    assert http.get(f"/api/shots/{SHOT_ID}/frames/2/image").status_code == 404


def test_animated_and_backdrop_searches_filter_before_ranking(client):
    http, _ = client
    production = offline_production()
    production.frames.search.return_value.rerank.return_value.limit.return_value.where.return_value = []
    production.find_frames("rocket", animated=True)
    production.frames.search.return_value.rerank.return_value.limit.return_value.where.assert_called_once_with(
        owner="tester", frames={"$gte": 2})
    production.frames.mongo.find.return_value = Mock()
    production.frames.mongo.find.return_value.sort.return_value.limit.return_value = []
    production.find_frames(None, animated=True)
    assert production.frames.mongo.find.call_args.args[0] == {"owner": "tester", "frames": {"$gte": 2}}

    production.assets.search.return_value.rerank.return_value.limit.return_value.where.return_value = []
    production.shots.mongo.aggregate.return_value = []
    production.search_assets("picture", asset_type="environment")
    production.assets.search.return_value.rerank.return_value.limit.return_value.where.assert_called_once_with(
        owner="tester", type="environment")

    layers = shot_payload()["layers"][:1]
    http.production.search_assets.return_value = []
    http.production.find_frames.return_value = []
    http.post("/api/search/sketch", json={"scope": "asset", "asset_type": "environment", "layers": layers})
    assert http.production.search_assets.call_args.kwargs == {"asset_type": "environment"}
    http.post("/api/search/sketch", json={"scope": "frame", "animated": True, "layers": layers})
    assert http.production.find_frames.call_args.kwargs == {"animated": True}
    http.get("/api/frames", params={"q": "rocket", "animated": "true"})
    assert http.production.find_frames.call_args.kwargs["animated"] is True



def test_search_keeps_hits_close_to_the_best():
    from backend.production import close_to_best
    hit = lambda score: SimpleNamespace(score=score)  # noqa: E731
    assert [h.score for h in close_to_best([hit(0.785), hit(0.78), hit(0.73), hit(0.68)])] == [0.785, 0.78, 0.73]
    assert close_to_best([]) == []



# ---------------------------------------------------------------- art math, versions, process
def test_art_math_counts_hand_ai_ink_time_and_colors():
    from backend.art import art_stats, color_family
    from backend.models import Layer
    layers = [Layer.model_validate({"strokes": [
        {"color": "#dc2626", "width": 6, "points": [{"x": 0, "y": 0}, {"x": 0.3, "y": 0}], "ms": 1200, "seq": 1},
        {"color": "#2563eb", "width": 2, "points": [{"x": 0, "y": 0.5}, {"x": 0.1, "y": 0.5}], "ai": True, "seq": 2},
        {"color": "#000000", "width": 9, "erase": True, "points": [{"x": 0.1, "y": 0.1}], "ms": 300},
    ]})]
    stats = art_stats(layers)
    assert (stats["strokes"], stats["hand"], stats["ai"], stats["erasers"]) == (2, 1, 1, 1)
    assert stats["hand_share"] == 0.5 and stats["ink_px"] == 400 and stats["draw_ms"] == 1500
    assert stats["palette"] == ["#dc2626", "#2563eb"] and stats["colors"] == ["red", "blue"]
    assert [color_family(c) for c in ("#123b38", "#ffffff", "#f97316", "#78350f", "#94a3b8", "#7c3aed")] == [
        "black", "white", "orange", "brown", "gray", "purple"]
    assert layers[0].model_dump()["strokes"][2].get("seq") is None  # no process data, no field
    guides = Layer.model_validate({"visible": False, "strokes": [{"color": "#4f8fe6", "width": 2, "points": [{"x": 0, "y": 0}], "kit": True}]})
    kit = Layer.model_validate({"strokes": [{"color": "#86efac", "width": 2, "points": [{"x": 0, "y": 0}], "kit": True}]})
    mixed = art_stats([guides, kit, *layers])
    assert (mixed["strokes"], mixed["kit"], mixed["hand"]) == (3, 1, 1)  # hidden guides don't count; kit isn't "hand"


def test_saving_an_asset_stores_art_math_and_snapshots_the_version():
    production = offline_production()
    production.assets.mongo.find_one.return_value = None
    production.save_asset(Asset.model_validate({"name": "Doodle", "layers": [{"strokes": [ink(0, 0, 1, 1)]}]}))
    record = production.assets.add.call_args.args[0][0]
    assert record["hand_share"] == 1.0 and record["colors"] == ["red"] and record["stats"]["strokes"] == 1
    query, snapshot = production.versions.replace_one.call_args.args[:2]
    assert query == {"asset_id": record["id"], "version": 1, "owner": "tester"} and snapshot["owner"] == "tester" and snapshot["stats"] == record["stats"] and snapshot["png"]


def test_assets_filter_by_how_they_were_made(client):
    production = offline_production()
    production.assets.mongo.find = Mock()
    production.assets.mongo.find.return_value.sort.return_value.limit.return_value = []
    production.shots.mongo.aggregate.return_value = []
    production.list_assets("", hand_min=0.8, color="red")
    assert production.assets.mongo.find.call_args.args[0] == {"owner": "tester", "hand_share": {"$gte": 0.8}, "colors": "red"}
    with pytest.raises(ProductionError, match="color must be"):
        production.list_assets("", color="plaid")
    http, _ = client
    http.production.list_assets.return_value = []
    http.get("/api/assets", params={"q": "rocket", "hand_min": "0.8", "color": "red"})
    http.production.list_assets.assert_called_with("rocket", None, hand_min=0.8, color="red")
    assert http.get("/api/assets", params={"hand_min": "2"}).status_code == 422


# ---------------------------------------------------------------- 10-second shots: frames that pose frame 1
def ref_frame(x=0.0, sx=1.0, version=1):
    return {"layers": [{"name": "BG", "ref": 0},
                       {"name": "Rocket", "ref": 1, "asset": {"asset_id": ASSET_ID, "version": version},
                        "xf": {"x": x, "sx": sx, "sy": 1 / sx, "px": 0.15, "py": 0.2}}]}


def test_frames_pose_frame_one_and_expand_exactly():
    from backend.models import Transform, pose_strokes
    from backend.models import Stroke
    stroke = Stroke.model_validate(ink(0.1, 0.1, 0.2, 0.3))
    assert pose_strokes([stroke], Transform())[0].points == stroke.points  # identity is identity
    moved = pose_strokes([stroke], Transform(x=0.5, px=0.15, py=0.2))[0]
    assert [round(p.x, 6) for p in moved.points] == [0.6, 0.7] and [p.y for p in moved.points] == [0.1, 0.3]
    squashed = pose_strokes([stroke], Transform(sx=2, sy=0.5, px=0.15, py=0.2))[0]
    assert squashed.width == 8 and [round(p.x, 6) for p in squashed.points] == [0.05, 0.25]
    assert pose_strokes([stroke], Transform(y=-1.2)) == []  # gone off the top: culled, not squashed at the edge
    mirrored = pose_strokes([stroke], Transform(sx=-1, px=0.15, py=0.2))[0]  # turned around to face the other way
    assert mirrored.width == 8 and [round(p.x, 6) for p in mirrored.points] == [0.2, 0.1]
    for flat in (0, 0.02, -0.02):
        with pytest.raises(ValidationError):
            Transform(sx=flat)

    shot = Shot.model_validate(shot_payload(frames=[ref_frame(x=0.3)] * 79))  # 80 frames, 10 s at 8 fps
    stored = shot.model_dump()["frames"][0]["layers"]
    assert stored[0] == {"name": "BG", "visible": True, "opacity": 1.0, "strokes": [], "ref": 0}  # compact on disk
    frame = shot.all_frames()[1]
    assert frame[0].strokes == shot.layers[0].strokes and frame[0].ref is None
    assert round(frame[1].strokes[0].points[0].x, 6) == 0.4 and frame[1].asset.version == 1


def test_backdrop_marker_survives_scene_frames():
    first = {"name": "Forest", "backdrop": ASSET_ID, "strokes": [ink(0.1, 0.1, 0.9, 0.9)]}
    shot = Shot.model_validate(shot_payload(layers=[first], frames=[{"layers": [
        {"name": "Forest", "backdrop": ASSET_ID, "ref": 0}]}]))
    stored = shot.model_dump()
    assert stored["layers"][0]["backdrop"] == ASSET_ID
    assert stored["frames"][0]["layers"][0]["backdrop"] == ASSET_ID
    assert shot.all_frames()[1][0].backdrop == ASSET_ID


def test_similar_finds_linked_animations_and_only_animated_visual_matches():
    production = offline_production()
    production.assets.mongo.find_one.return_value = {"id": ASSET_ID, "name": "Rocket", "embedding": [0.1, 0.2]}
    linked = {"id": f"{SHOT_ID}:f1", "shot_id": SHOT_ID, "frame": 1, "frames": 8, "updated_at": "t"}
    visual = {"id": "other:f2", "shot_id": "other", "frame": 2, "frames": 8, "updated_at": "t", "score": 0.9}
    production.frames.mongo.aggregate.return_value = [linked]
    production._nearest = Mock(side_effect=[[], [linked, visual]])
    production.usage_counts = Mock(return_value={})

    result = production.similar_everywhere(ASSET_ID)
    assert [frame["id"] for frame in result["frames"]] == [linked["id"], visual["id"]]
    assert production.frames.mongo.aggregate.call_args.args[0][0] == {
        "$match": {"owner": "tester", "asset_ids": ASSET_ID, "frames": {"$gte": 2}}}
    assert production._nearest.call_args.args[3] == {"owner": "tester", "frames": {"$gte": 2}}


def test_long_shots_get_a_sample_of_frame_vectors():
    from backend.production import FRAME_VECTORS, sampled_frames
    assert sampled_frames(6) == list(range(6))
    picks = sampled_frames(80)
    assert len(picks) == FRAME_VECTORS and picks[0] == 0 and picks[-1] == 79
    production = offline_production()
    production.save_shot(Shot.model_validate(shot_payload(frames=[ref_frame(x=i / 200) for i in range(79)])))
    assert len(production.frames.add.call_args.args[0]) == FRAME_VECTORS  # 16 embeddings, not 80


def test_a_new_asset_version_flows_into_frames_that_reference_frame_one():
    production = offline_production()
    latest = {"name": "Rocket", "strokes": [ink(0.4, 0.4, 0.6, 0.8, "#0000ff")]}
    production.assets.mongo.find_one.return_value = {"id": ASSET_ID, "name": "Red Rocket", "version": 3, "layers": [latest]}
    production.shots.mongo.find_one.side_effect = lambda query, projection=None: shot_record(frames=[ref_frame(x=0.2), ref_frame(x=0.4)])
    result = production.sync_asset(SHOT_ID, ASSET_ID)
    record = production.shots.add.call_args.args[0][0]
    first = [layer["name"] for layer in record["layers"]]
    assert first[1:3] == ["Rocket (v1 backup)", "Rocket"]  # the old art is kept, just below
    for frame in record["frames"]:
        rocket = frame["layers"][1]
        assert rocket["ref"] == first.index("Rocket") and rocket["asset"]["version"] == 3  # re-pointed past the backup
        assert rocket["strokes"] == [] and "xf" in rocket  # still a pose of frame 1: the new art, same motion
    assert result["updated"] == 3


def test_direct_endpoint_validates_and_is_metered_as_ai(client):
    from starlette.requests import Request as Req

    from backend.main import AI_BUDGET, budget_for
    http, _ = client
    http.ai.direct.return_value = {"ideas": []}
    subject = {"id": 0, "name": "Red Rocket", "box": {"x": 0.4, "y": 0.5, "w": 0.1, "h": 0.3}}
    assert http.post("/api/sparks/direct", json={"subjects": [subject], "backdrop": "Beach"}).json() == {"ideas": []}
    assert http.post("/api/sparks/direct", json={"subjects": []}).status_code == 422
    scope = {"type": "http", "method": "POST", "path": "/api/sparks/direct", "query_string": b"", "headers": []}
    assert budget_for(Req(scope)) is AI_BUDGET


MOTION = {"by": "ai", "prompt": "the rocket wobbles, then blasts off", "note": "", "seconds": 1, "fps": 8, "strength": 1,
          "tracks": [{"name": "Rocket", "keys": [{"t": 0, "x": 0, "y": 0, "sx": 1, "sy": 1, "r": 0, "label": "start"},
                                                  {"t": 0.5, "x": 0, "y": 0.01, "sx": 1.1, "sy": 0.9, "r": 0, "label": "anticipation"},
                                                  {"t": 1, "x": 0, "y": -0.3, "sx": 0.9, "sy": 1.2, "r": 0, "label": "takeoff"}]}]}


def test_scenes_embed_their_story_and_share_as_a_gif_snapshot():
    production = offline_production()
    production.save_shot(Shot.model_validate(shot_payload(frames=[ref_frame(x=i / 20) for i in range(7)], fps=8, motion=MOTION)))
    story = production.shots.add.call_args.args[0][0]["story"]
    assert story.startswith("the rocket wobbles, then blasts off. Beats: anticipation, takeoff. 8 frames")
    assert "Cast: Red Rocket. Layers: BG, Rocket" in story and ".." not in story

    production.shares = Mock()
    production.shares.find_one.return_value = None
    production.shots.mongo.find_one.side_effect = lambda query, projection=None: shot_record(
        frames=[ref_frame(x=i / 20) for i in range(7)], fps=8, motion=MOTION, assets=[{"id": ASSET_ID, "name": "Red Rocket", "version": 1}])
    first = production.share_shot(SHOT_ID)
    query, update = production.shares.update_one.call_args.args[:2]
    assert query == {"shot_id": SHOT_ID, "owner": "tester"} and first["frames"] == 8
    snapshot = update["$set"]
    assert snapshot["gif"].startswith(b"GIF89a") and snapshot["poster"].startswith(b"\x89PNG") and snapshot["cast"] == ["Red Rocket"]
    assert snapshot["motion"]["prompt"] == MOTION["prompt"] and len(first["token"]) >= 16
    assert snapshot["sketch"] is None  # no code on this scene: the page simply skips the code section
    production.shares.find_one.return_value = {"token": first["token"]}
    assert production.share_shot(SHOT_ID)["token"] == first["token"]  # re-sharing refreshes, the link stays


def test_shared_scenes_are_public_by_token_only_and_escaped(client):
    from starlette.requests import Request as Req

    from backend.main import EMBED_BUDGET, budget_for
    http, _ = client
    token = "AbCdEfGhIjKlMnOp"
    http.production.shared.return_value = {"token": token, "code": "SQ010_0010", "description": "<script>alert(1)</script>",
                                           "fps": 8, "frames": 8, "motion": MOTION, "cast": ["Red Rocket"]}
    page = http.get(f"/s/{token}", headers={"host": 'evil.test"><script>x()</script>'})
    assert page.status_code == 200 and "<script>alert" not in page.text and "&lt;script&gt;" in page.text
    assert "<script>x()" not in page.text  # a forged Host header can't inject markup
    assert "anticipation" in page.text and "chose 3 keyframes" in page.text and f"/s/{token}/clip.gif" in page.text
    http.production.shared.reset_mock()
    assert http.get("/s/short").status_code == 404 and not http.production.shared.called  # malformed: no lookup at all
    http.production.shared.return_value = None
    assert http.get(f"/s/{token}").status_code == 404
    http.production.shared.return_value = {"gif": b"GIF89a..."}
    clip = http.get(f"/s/{token}/clip.gif")
    assert clip.headers["content-type"] == "image/gif" and clip.content == b"GIF89a..."

    http.production.share_shot.return_value = {"token": token, "frames": 8, "bytes": 9}
    shared = http.post(f"/api/shots/{SHOT_ID}/share").json()
    assert shared["url"].endswith(f"/s/{token}") and shared["gif_url"].endswith("/clip.gif")
    assert http.delete(f"/api/shots/{SHOT_ID}/share").status_code == 204
    scope = {"type": "http", "method": "POST", "path": f"/api/shots/{SHOT_ID}/share", "query_string": b"", "headers": []}
    assert budget_for(Req(scope)) is EMBED_BUDGET


def test_shared_path_scenes_credit_the_artists_trail():
    from backend.share import explain, page
    motion = {**MOTION, "by": "path", "prompt": "", "note": "Red Rocket travels right, in an arc"}
    assert "The artist's drawn path became 3 keyframes" in explain(motion, 8, 8)["lead"]
    html = page({"token": "AbCdEfGhIjKlMnOp", "code": "SQ010_0010", "fps": 8, "frames": 8, "motion": motion}, "https://x.test")
    assert "A path the artist drew" in html and "Red Rocket travels right, in an arc" in html


def test_shared_scenes_show_their_code_escaped_and_hand_it_to_remix(client):
    http, _ = client
    token = "AbCdEfGhIjKlMnOp"
    code = "const MOTION = { Rocket: { keys: [] } }; // </code></pre><script>steal()</script>"
    http.production.shared.return_value = {"token": token, "code": "SQ010_0010", "description": "", "fps": 8, "frames": 8,
                                           "motion": MOTION, "cast": [], "sketch": {"title": "Takeoff", "by": "ai", "code": code}}
    page = http.get(f"/s/{token}").text
    assert "<script>steal()" not in page and "&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;steal()" in page
    assert f"/?remix={token}" in page and "Gemini chose these poses" in page
    assert http.get(f"/s/{token}/sketch.json").json() == {"title": "Takeoff", "by": "ai", "code": code}
    http.production.shared.return_value = {"code": "SQ010_0010"}  # shared before scenes kept their code
    assert http.get(f"/s/{token}/sketch.json").status_code == 404
    http.production.shared.reset_mock()
    assert http.get("/s/short/sketch.json").status_code == 404 and not http.production.shared.called


def test_scene_motion_records_code_effects_but_rejects_unknown_ones():
    from backend.models import MotionRecord
    record = MotionRecord.model_validate({**MOTION, "effects": ["snow", "rain"]})
    assert record.model_dump()["effects"] == ["snow", "rain"]
    assert "effects" not in MotionRecord.model_validate(MOTION).model_dump()
    for bad in (["lava"], ["snow", "rain", "bubbles"]):
        with pytest.raises(ValidationError):
            MotionRecord.model_validate({**MOTION, "effects": bad})


def test_scenes_keep_the_lab_code_their_frames_were_baked_from():
    from backend.production import shot_story
    code = "function setup(){}\nfunction draw(){}"
    stroke = {"color": "#123b38", "width": 3, "points": [{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.2}], "code": True}
    shot = Shot.model_validate(shot_payload(sketch={"by": "ai", "title": "Galaxy spiral", "prompt": "spiral into a galaxy", "code": code, "frames": 2},
                                            frames=[{"layers": [{"name": "Lab", "strokes": [stroke]}]}]))
    assert shot.model_dump()["sketch"]["code"] == code
    assert shot.frames[0].layers[0].strokes[0].model_dump()["code"] is True  # baked strokes stay marked as code
    story = shot_story(shot, [])
    assert "Galaxy spiral" in story and story.endswith(code)  # the code itself is embedded: scenes are findable by code
    for bad in ({"by": "robot"}, {"code": "x" * 12_001}, {"frames": 81}):
        with pytest.raises(ValidationError):
            Shot.model_validate(shot_payload(sketch={"by": "ai", "title": "t", "code": code, "frames": 2, **bad}))


def test_code_search_asks_atlas_to_embed_the_query_and_stays_in_the_owners_library():
    production = offline_production()
    production.shots._query_vector = Mock()
    production.shots.mongo.aggregate.return_value = [
        {"id": "b", "code": "SQ2", "updated_at": "t", "score": 0.61, "sketch": {"title": "Galaxy", "by": "ai", "code": "x"}}]
    found = production.search_code("function draw() { spiral(); }")
    stage = production.shots.mongo.aggregate.call_args.args[0][0]["$vectorSearch"]
    assert stage["index"] == CODE_INDEX and stage["path"] == "sketch.code"
    assert stage["query"] == "function draw() { spiral(); }" and stage["filter"] == {"owner": "tester"}
    production.shots._query_vector.assert_not_called()  # Atlas embeds the query: no Voyage call from Inkling
    assert found["engine"]["by"] == "atlas-autoembed" and [hit["id"] for hit in found["items"]] == ["b"]


def test_code_search_falls_back_to_multimodal_vectors_without_autoembed():
    production = offline_production()
    production.shots.mongo.aggregate.side_effect = OperationFailure("autoEmbed is not supported")
    production.shots._query_vector = Mock(return_value=[0.1, 0.2])
    rows = [{"id": "a", "code": "SQ1", "updated_at": "t", "score": 0.9},
            {"id": "b", "code": "SQ2", "updated_at": "t", "score": 0.8, "sketch": {"title": "Galaxy", "by": "ai", "code": "x"}}]
    production._nearest = Mock(return_value=rows)
    found = production.search_code("function draw() { spiral(); }")
    assert production.shots._query_vector.call_args.args[0][0].startswith("Code:\nfunction draw()")
    assert found["engine"]["by"] == "voyage-multimodal"
    assert [hit["id"] for hit in found["items"]] == ["b", "a"] and found["items"][0]["sketch"] == {"title": "Galaxy", "by": "ai"}


def test_setup_creates_the_autoembed_index_once_and_survives_clusters_without_it():
    from backend.setup import ensure_code_index
    shots = Mock()
    shots.list_search_indexes.return_value = []
    ensure_code_index(shots)
    model = shots.create_search_index.call_args.args[0].document
    assert model["name"] == CODE_INDEX and model["type"] == "vectorSearch"
    assert model["definition"]["fields"][0] == {"type": "autoEmbed", "modality": "text", "path": "sketch.code", "model": "voyage-code-4"}
    shots.reset_mock()
    shots.list_search_indexes.return_value = [{"name": CODE_INDEX, "latestDefinition": {"fields": [
        {"type": "filter", "path": "owner"}, {"type": "autoEmbed", "modality": "text", "path": "sketch.code", "model": "voyage-code-4", "similarity": "dotProduct"}]}}]
    ensure_code_index(shots)  # Atlas adds its defaults; same type, path, and model: leave it alone
    shots.create_search_index.assert_not_called()
    shots.drop_search_index.assert_not_called()
    shots.list_search_indexes.return_value = []
    shots.create_search_index.side_effect = OperationFailure("autoEmbed is not supported", details={"errmsg": "no autoEmbed"})
    ensure_code_index(shots)  # logged; code search falls back instead of failing setup


def test_a_saved_scene_prints_as_a_flipbook():
    from backend.share import render_flipbook
    shot = Shot.model_validate(shot_payload(frames=[ref_frame(x=0.03 * i) for i in range(1, 12)]))  # 12 frames: 2 pages
    pdf = render_flipbook(shot.all_frames(), shot.code)
    import re
    assert pdf.startswith(b"%PDF") and len(re.findall(rb"/Type\s*/Page(?!s)", pdf)) == 2  # ten frames a page


def test_flipbook_endpoint_is_owner_scoped_and_inline(client):
    http, _ = client
    http.production.flipbook.return_value = ("SQ010_0010", b"%PDF-1.4 fake")
    response = http.get(f"/api/shots/{SHOT_ID}/flipbook.pdf")
    assert response.status_code == 200 and response.headers["content-type"] == "application/pdf"
    assert 'filename="SQ010_0010-flipbook.pdf"' in response.headers["content-disposition"]
    http.production.flipbook.side_effect = ProductionError("Shot not found.")
    assert http.get(f"/api/shots/{SHOT_ID}/flipbook.pdf").status_code == 404


def test_rigged_parts_bend_about_their_joint_before_the_pose():
    from backend.models import Bend, Layer, Stroke, Transform, expand_frame, pose_strokes
    leg = Stroke.model_validate({"color": "#000000", "width": 4, "points": [{"x": 0.5, "y": 0.5}, {"x": 0.5, "y": 0.6}]})
    body = Stroke.model_validate(ink(0.4, 0.4, 0.6, 0.4))
    swung = pose_strokes([body, leg], Transform(x=0.1), [Bend(s=[1], r=90, px=0.5, py=0.5)])
    assert [round(p.x, 4) for p in swung[0].points] == [0.5, 0.7]  # the body only moves with the pose
    end = swung[1].points[1]  # the leg's foot swings 90 degrees clockwise about the hip: from below to the left
    assert (round(end.x, 4), round(end.y, 4)) == (round(0.6 - 0.1 * 650 / 1000, 4), 0.5)
    with pytest.raises(ValidationError, match="bend"):
        Layer.model_validate({"name": "Fox", "ref": 0, "bend": [{"s": [0], "r": 10, "px": 0.5, "py": 0.5}]})
    first = [Layer(name="Fox", strokes=[body, leg])]
    frame = expand_frame(first, [Layer.model_validate({"name": "Fox", "ref": 0, "xf": {"x": 0}, "bend": [{"s": [1, 7], "r": 90, "px": 0.5, "py": 0.5}]})])
    assert frame[0].bend is None and round(frame[0].strokes[1].points[1].x, 4) == round(0.5 - 0.1 * 650 / 1000, 4)  # out-of-range index ignored


def test_rig_keeps_moving_parts_each_stroke_once_with_joints_in_the_box():
    from backend.ai import Sparks, _Bone, _Rig
    from backend.models import Layer
    strokes = [ink(0.4, 0.4, 0.6, 0.4), ink(0.45, 0.4, 0.45, 0.6), ink(0.55, 0.4, 0.55, 0.6),
               {"color": "#000000", "width": 9, "erase": True, "points": [{"x": 0.5, "y": 0.5}]}, ink(0.4, 0.4, 0.6, 0.6)]
    sparks = Sparks.__new__(Sparks)
    sparks._json = Mock(return_value=_Rig(kind="cyborg", bones=[
        _Bone(part="leg_front", strokes=[1, 1, 3, 4, 9], joint_x=50, joint_y=-20), _Bone(part="leg_back", strokes=[1, 2], joint_x=150, joint_y=40),
        _Bone(part="body", strokes=[0], joint_x=50, joint_y=50), _Bone(part="antenna", strokes=[0], joint_x=1, joint_y=1)]))
    rig = sparks.rig([Layer(name="Bug", strokes=strokes)])
    assert rig["kind"] == "object" and rig["strokes"] == 5  # stroke 4 outlines the whole figure: never a limb
    assert rig["bones"] == [{"part": "leg_front", "strokes": [1], "px": 0.5, "py": 0.0}, {"part": "leg_back", "strokes": [2], "px": 1.0, "py": 0.4}]
    prompt = "".join(part for part in sparks._json.call_args.args[0] if isinstance(part, str))
    assert "1: #ff0000, box" in prompt and "\n3:" not in prompt  # erasers aren't parts


def test_rig_is_made_once_per_version_and_new_endpoints_are_metered(client):
    from starlette.requests import Request as Req

    from backend.main import AI_BUDGET, budget_for
    http, _ = client
    layers = [{"name": "Fox", "strokes": [ink(0.1, 0.1, 0.2, 0.3)]}]
    rig = {"kind": "quadruped", "strokes": 1, "bones": []}
    http.production.get_asset.return_value = {"id": ASSET_ID, "name": "Fox", "type": "character", "version": 2, "layers": layers}
    http.ai.rig.return_value = rig
    assert http.post(f"/api/assets/{ASSET_ID}/rig").json() == {"rig": rig, "version": 2}
    http.production.store_rig.assert_called_once_with(ASSET_ID, 2, rig)
    http.production.get_asset.return_value = {**http.production.get_asset.return_value, "rig": rig, "rig_version": 2}
    assert http.get(f"/api/assets/{ASSET_ID}").json()["rig"] == rig
    http.post(f"/api/assets/{ASSET_ID}/rig")
    assert http.ai.rig.call_count == 1  # cached for this version
    http.production.get_asset.return_value = {**http.production.get_asset.return_value, "version": 3}
    assert "rig" not in http.get(f"/api/assets/{ASSET_ID}").json()  # a new version needs a new rig
    http.post(f"/api/assets/{ASSET_ID}/rig?redo=true")
    assert http.ai.rig.call_count == 2  # asked again on purpose
    rig2 = {"kind": "biped", "strokes": 1, "bones": [{"part": "leg_front", "strokes": [0], "px": 0.5, "py": 0.9}]}
    assert http.put(f"/api/assets/{ASSET_ID}/rig", json={"rig": rig2}).json()["rig"] == rig2  # made before the save, kept
    assert http.put(f"/api/assets/{ASSET_ID}/rig", json={"rig": {**rig2, "strokes": 4}}).status_code == 409
    assert http.ai.rig.call_count == 2
    http.ai.rig.return_value = rig2
    assert http.post("/api/sparks/rig", json={"layers": layers}).json() == {"rig": rig2}
    for path in (f"/api/assets/{ASSET_ID}/rig", "/api/sparks/picture", "/api/sparks/rig"):
        assert budget_for(Req({"type": "http", "method": "POST", "path": path, "query_string": b"", "headers": []})) is AI_BUDGET
    http.ai.picture.return_value = {"note": "n", "image": "data:image/png;base64,AA=="}
    assert http.post("/api/sparks/picture", json={"prompt": "a fox"}).json()["image"].startswith("data:image/png")
    assert http.post("/api/sparks/picture", json={"prompt": "x"}).status_code == 422
