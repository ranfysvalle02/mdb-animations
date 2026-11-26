import base64
import io
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from PIL import Image
from pydantic import ValidationError
from pymongo.errors import ServerSelectionTimeoutError

from google.genai.errors import ClientError

import httpx

from backend.ai import AIError, AIUnavailable, Sparks, _Point, _Stroke, ink_to_alpha, to_canvas_strokes
from backend.library import Library, LibraryError, render_image, render_png
from backend.main import MAX_BODY
from backend.models import Drawing, SparkRequest

DRAWING_ID = "e8de20c1-5ad3-45a6-8ca0-abf2a40e4051"


def box(x0, y0, x1, y1):
    return [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}, {"x": x0, "y": y0}]


LAYERED = {
    "title": "Layered robot",
    "description": "",
    "layers": [
        {"name": "Sky", "opacity": 0.5, "strokes": [
            {"color": "#0000ff", "width": 2, "fill": "#0000ff", "points": box(0, 0, 1, 0.5)}]},
        {"name": "Ink", "strokes": [
            {"color": "#ff0000", "width": 20, "points": [{"x": 0.2, "y": 0.8}, {"x": 0.8, "y": 0.8}]},
            {"color": "#000000", "width": 20, "erase": True, "points": [{"x": 0.5, "y": 0.8}]}]},
        {"name": "Notes", "visible": False, "strokes": [
            {"color": "#00ff00", "width": 30, "points": [{"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.9}]}]},
    ],
}


def test_save_and_reopen_editable_drawing(client, payload):
    http, library = client
    layered = {**LAYERED, "tags": ["  Green   Robot "]}
    response = http.post("/api/drawings", json=layered)
    assert response.status_code == 201
    http.ai.suggest_tags.assert_not_called()
    saved = library.save.call_args.args[0]
    assert saved.model_dump() == Drawing.model_validate({**LAYERED, "tags": ["green robot"]}).model_dump()
    assert [layer.name for layer in saved.layers] == ["Sky", "Ink", "Notes"]
    assert response.json()["tags_status"] == "provided"

    library.get.return_value = {"id": DRAWING_ID, **saved.model_dump(), "embedding": [1], "png": "private"}
    response = http.get(f"/api/drawings/{DRAWING_ID}")
    assert response.json() == {"id": DRAWING_ID, **saved.model_dump()}


def test_legacy_flat_strokes_become_one_layer(client, payload):
    http, library = client
    http.post("/api/drawings", json=payload)
    (layer,) = library.save.call_args.args[0].layers
    assert layer.name == "Layer 1" and layer.visible and layer.opacity == 1
    assert [s.model_dump(include={"color", "width", "points"}) for s in layer.strokes] == payload["strokes"]

    library.get.return_value = {"id": DRAWING_ID, **payload, "tags": [], "png": "private"}
    restored = http.get(f"/api/drawings/{DRAWING_ID}").json()
    assert restored["layers"] == [{"name": "Layer 1", "visible": True, "opacity": 1.0, "strokes": payload["strokes"]}]


def test_untagged_save_is_auto_tagged(client, payload):
    http, library = client
    response = http.post("/api/drawings", json=payload)
    assert response.json() == {"id": DRAWING_ID, "tags": ["robot", "face"], "tags_status": "auto"}
    assert library.save.call_args.args[0].tags == ["robot", "face"]


@pytest.mark.parametrize("failure", [
    ClientError(503, {"error": {"code": 503, "message": "down", "status": "UNAVAILABLE"}}),
    AIError("no tags"),
    AIUnavailable("unreachable"),
])
def test_tagging_failure_never_blocks_saving(client, payload, failure):
    http, library = client
    http.ai.suggest_tags.side_effect = failure
    response = http.post("/api/drawings", json=payload)
    assert response.status_code == 201
    assert response.json()["tags_status"] == "unavailable"
    assert library.save.call_args.args[0].tags == []


def test_tag_validation_and_filters(client, payload):
    http, library = client
    assert http.post("/api/drawings", json={**payload, "tags": ["<script>"]}).status_code == 422
    assert http.post("/api/drawings", json={**payload, "tags": [f"t{i}" for i in range(13)]}).status_code == 422
    assert http.get("/api/drawings", params={"tag": "a$b"}).status_code == 422
    http.get("/api/drawings", params={"tag": " Eye "})
    library.recent.assert_called_with("eye")
    http.get("/api/search", params={"q": "face", "tag": "hand"})
    library.search.assert_called_with("face", "hand")
    library.save.assert_not_called()


def test_image_is_png_not_internal_record(client, payload):
    http, library = client
    image = render_png(Drawing.model_validate(payload))
    library.get.return_value = {"png": base64.b64encode(image).decode()}
    response = http.get(f"/api/drawings/{DRAWING_ID}/image")
    assert response.headers["content-type"] == "image/png"
    assert response.content == image


@pytest.mark.parametrize("change", [
    {"title": "   "},
    {"strokes": []},
    {"strokes": [{"color": "javascript:alert(1)", "width": 2, "points": [{"x": 0, "y": 0}]}]},
    {"strokes": [{"color": "#123456", "width": 2, "points": [{"x": 1.01, "y": 0}]}]},
    {"strokes": [{"color": "#123456", "width": 0, "points": [{"x": 0, "y": 0}]}]},
])
def test_invalid_drawing_does_not_call_voyage(client, payload, change):
    http, library = client
    assert http.post("/api/drawings", json={**payload, **change}).status_code == 422
    library.save.assert_not_called()


def test_request_limits_and_json_contract(client):
    http, library = client
    assert http.post("/api/drawings", content="{}").status_code == 415
    assert http.post("/api/drawings", content="{", headers={"Content-Type": "application/json"}).status_code == 422
    response = http.post(
        "/api/drawings", content=b" " * (MAX_BODY + 1),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    library.save.assert_not_called()


def test_total_point_limit_across_strokes(payload):
    point = {"x": 0.5, "y": 0.5}
    payload["strokes"] = [
        {"color": "#123456", "width": 2, "points": [point] * 10001}
    ] * 2
    with pytest.raises(ValidationError, match="20,000"):
        Drawing.model_validate(payload)


def test_pen_pressure_and_single_point_are_rendered(payload):
    payload["strokes"] = [{
        "color": "#ff0000", "width": 10,
        "points": [{"x": 0.5, "y": 0.5, "pressure": 1}],
    }]
    image = Image.open(io.BytesIO(render_png(Drawing.model_validate(payload))))
    assert image.size == (1000, 650)
    assert image.getpixel((500, 325)) == (255, 0, 0)
    assert image.getpixel((505, 325)) == (255, 0, 0)
    assert image.getpixel((0, 0)) == (255, 255, 255)
    payload["strokes"][0]["points"][0]["pressure"] = 0
    light = Image.open(io.BytesIO(render_png(Drawing.model_validate(payload))))
    assert light.getpixel((500, 325)) == (255, 0, 0)
    assert light.getpixel((505, 325)) == (255, 255, 255)


def test_library_stores_editable_source_and_joint_image(payload):
    library = Library.__new__(Library)
    library.owner = "tester"
    library.drawings = Mock()
    library.drawings.add.return_value = SimpleNamespace(added=1, skipped=0, failed=0)
    result = library.save(Drawing.model_validate(LAYERED))
    record = library.drawings.add.call_args.args[0][0]
    assert record["layers"] == Drawing.model_validate(LAYERED).model_dump()["layers"]
    assert "strokes" not in record
    assert record["owner"] == "tester"
    assert base64.b64decode(record["png"]) == record["image"]
    assert result["image_url"] == f"/api/drawings/{record['id']}/image"
    assert "png" not in result and "image" not in result


@pytest.mark.parametrize("counts", [(0, 0, 1), (0, 1, 0)])
def test_cinematlas_partial_failure_is_not_reported_as_saved(payload, counts):
    library = Library.__new__(Library)
    library.owner = "tester"
    added, skipped, failed = counts
    library.drawings = Mock()
    library.drawings.add.return_value = SimpleNamespace(added=added, skipped=skipped, failed=failed)
    with pytest.raises(LibraryError, match="no save was confirmed"):
        library.save(Drawing.model_validate(payload))


def test_search_contract_and_validation(client):
    http, library = client
    library.search.return_value = [{"id": DRAWING_ID, "score": 0.78}]
    response = http.get("/api/search", params={"q": "  friendly robot  "})
    assert response.json() == {"items": [{"id": DRAWING_ID, "score": 0.78}]}
    library.search.assert_called_once_with("friendly robot", None)
    for query in ("", "  ", "x" * 501):
        assert http.get("/api/search", params={"q": query}).status_code == 422


def test_service_failure_is_explicit_and_does_not_expose_secrets(client, payload):
    http, library = client
    library.save.side_effect = ServerSelectionTimeoutError("secret connection string")
    response = http.post("/api/drawings", json=payload)
    assert response.status_code == 503
    assert "secret" not in response.text


def test_not_ready_missing_and_invalid_ids(client):
    http, library = client
    library.ready.return_value = False
    assert http.get("/api/ready").status_code == 503
    library.get.return_value = None
    assert http.get(f"/api/drawings/{DRAWING_ID}").status_code == 404
    assert http.get("/api/drawings/not-a-uuid").status_code == 422


def test_only_intended_static_files_are_served(client):
    http, _ = client
    assert http.get("/studio").status_code == 200
    assert http.get("/studio.js").headers["content-type"].startswith("text/javascript")
    assert http.get("/.env").status_code == 404
    assert http.get("/backend/main.py").status_code == 404


SPARK = {"region": {"x": 0.5, "y": 0.3, "w": 0.2, "h": 0.2}, "prompt": "fix the eye", "layers": []}


@pytest.mark.parametrize("kind", ["strokes", "guide"])
def test_spark_endpoints_pass_validated_request(client, kind):
    http, _ = client
    getattr(http.ai, kind).return_value = {"kind": kind}
    response = http.post(f"/api/sparks/{kind}", json=SPARK)
    assert response.json() == {"kind": kind}
    assert getattr(http.ai, kind).call_args.args[0].prompt == "fix the eye"


@pytest.mark.parametrize("region", [
    {"x": 0.9, "y": 0.1, "w": 0.2, "h": 0.2},
    {"x": 0.1, "y": 0.1, "w": 0.001, "h": 0.2},
])
def test_spark_region_must_be_inside_canvas(client, region):
    http, _ = client
    assert http.post("/api/sparks/strokes", json={**SPARK, "region": region}).status_code == 422
    http.ai.strokes.assert_not_called()


def test_spark_rate_limit_and_empty_answer_are_explicit(client):
    http, _ = client
    http.ai.strokes.side_effect = ClientError(429, {"error": {"code": 429, "message": "quota key=secret", "status": "RESOURCE_EXHAUSTED"}})
    response = http.post("/api/sparks/strokes", json=SPARK)
    assert response.status_code == 429 and "secret" not in response.text
    http.ai.strokes.side_effect = AIError("Gemini had no strokes to add here.")
    assert http.post("/api/sparks/strokes", json=SPARK).status_code == 502


def test_model_strokes_map_from_crop_to_canvas():
    raw = [_Stroke(color="not-a-color", width=900, points=[_Point(x=0, y=0), _Point(x=1, y=1), _Point(x=2, y=-1)])]
    (stroke,) = to_canvas_strokes(raw, (500, 200, 600, 300), ("#123456", 4))
    assert stroke["color"] == "#123456" and stroke["width"] == 40
    assert stroke["points"][0] == {"x": 0.5, "y": 200 / 650, "pressure": 0.75}
    assert len(stroke["points"]) > 3  # smoothed between sparse model points
    assert all(500 <= p["x"] * 1000 <= 600.001 and 199.999 <= p["y"] * 650 <= 300.001 for p in stroke["points"])


def test_guide_returns_only_the_selected_region_aligned():
    dot = {"color": "#000000", "width": 6, "points": [{"x": 0.55, "y": 0.4, "pressure": 0.75}]}
    request = SparkRequest(region={"x": 0.5, "y": 0.3, "w": 0.1, "h": 0.2}, strokes=[dot])

    def echo(model, contents, config):
        part = Mock(inline_data=Mock(data=contents[0].inline_data.data))
        return Mock(candidates=[Mock(content=Mock(parts=[part]))])

    ai = Sparks.__new__(Sparks)
    ai.image_model = "test"
    ai.client = Mock()
    ai.client.models.generate_content.side_effect = echo
    result = ai.guide(request)
    guide = Image.open(io.BytesIO(base64.b64decode(result["image"].split(",")[1])))
    assert guide.size == (100, 130)
    assert guide.getpixel((50, 0.1 * 650))[3] > 200  # the dot, at its canvas position inside the region
    assert guide.getpixel((5, 5))[3] == 0  # paper is transparent


def test_ink_to_alpha_keeps_ink_and_drops_paper():
    image = Image.new("RGB", (2, 1), "white")
    image.putpixel((1, 0), (0, 0, 0))
    rgba = ink_to_alpha(image)
    assert rgba.getpixel((0, 0))[3] == 0 and rgba.getpixel((1, 0))[3] == 255


def test_gemini_transport_errors_become_unavailable(client):
    ai = Sparks.__new__(Sparks)
    ai.client = Mock()
    ai.client.models.generate_content.side_effect = httpx.ReadTimeout("timed out")
    with pytest.raises(AIUnavailable):
        ai._generate(model="m", contents=[])

    http, _ = client
    http.ai.strokes.side_effect = AIUnavailable("Gemini is unreachable right now.")
    response = http.post("/api/sparks/strokes", json=SPARK)
    assert response.status_code == 503 and "unreachable" in response.json()["detail"]


def test_layers_composite_like_the_browser():
    image = render_image(Drawing.model_validate(LAYERED).layers)
    assert all(abs(a - b) <= 1 for a, b in zip(image.getpixel((100, 100)), (128, 128, 255)))  # 50% sky fill
    assert image.getpixel((300, 520)) == (255, 0, 0)  # red ink
    assert image.getpixel((500, 520)) == (255, 255, 255)  # erased through its own layer to the paper
    assert image.getpixel((900, 585)) == (255, 255, 255)  # hidden layer is not rendered


def test_eraser_only_cuts_its_own_layer():
    drawing = Drawing.model_validate({"title": "t", "layers": [
        {"name": "Under", "strokes": [{"color": "#0000ff", "width": 2, "fill": "#0000ff", "points": box(0.4, 0.4, 0.6, 0.6)}]},
        {"name": "Over", "strokes": [
            {"color": "#ff0000", "width": 30, "points": [{"x": 0.3, "y": 0.5}, {"x": 0.7, "y": 0.5}]},
            {"color": "#000000", "width": 30, "erase": True, "points": [{"x": 0.5, "y": 0.5}]}]},
    ]})
    image = render_image(drawing.layers)
    assert image.getpixel((500, 325)) == (0, 0, 255)  # the lower layer shows through the erased hole
    assert image.getpixel((350, 325)) == (255, 0, 0)


@pytest.mark.parametrize("change", [
    {"layers": [{"name": f"L{i}", "strokes": LAYERED["layers"][1]["strokes"]} for i in range(13)]},
    {"layers": [{"strokes": [{"color": "#000000", "width": 5, "erase": True, "points": [{"x": 0, "y": 0}]}]}]},
    {"layers": [{"visible": False, "strokes": LAYERED["layers"][1]["strokes"]}]},
    {"layers": [{"strokes": [{"color": "#000000", "width": 5, "erase": True, "fill": "#000000",
                              "points": box(0, 0, 0.1, 0.1)}]}]},
    {"layers": [{"name": "  ", "strokes": LAYERED["layers"][1]["strokes"]}]},
    {"layers": [{"strokes": [{"color": "#000000", "width": 1, "points": [{"x": 0, "y": 0}]}] * 501}] * 2},
])
def test_invalid_layers_are_rejected(client, change):
    http, library = client
    assert http.post("/api/drawings", json={**LAYERED, **change}).status_code == 422
    library.save.assert_not_called()


def test_spark_renders_layers_and_accepts_legacy_strokes(client):
    http, _ = client
    http.ai.strokes.return_value = {"kind": "strokes"}
    http.post("/api/sparks/strokes", json={**SPARK, "layers": LAYERED["layers"]})
    assert [layer.name for layer in http.ai.strokes.call_args.args[0].layers] == ["Sky", "Ink", "Notes"]
    legacy = {key: value for key, value in SPARK.items() if key != "layers"}
    http.post("/api/sparks/strokes", json={**legacy, "strokes": LAYERED["layers"][1]["strokes"]})
    assert len(http.ai.strokes.call_args.args[0].layers) == 1
    mixed = {**SPARK, "strokes": []}
    assert http.post("/api/sparks/strokes", json=mixed).status_code == 422


def test_sketch_maps_whole_canvas_in_blue_pencil():
    from backend.ai import BLUE_PENCIL, MAX_SKETCH_STROKES, to_canvas_strokes
    raw = [_Stroke(color="#ff0000", width=3, points=[_Point(x=0, y=0), _Point(x=1, y=1)])] * (MAX_SKETCH_STROKES + 5)
    strokes = to_canvas_strokes(raw, (0, 0, 1000, 650), (BLUE_PENCIL, 3), max_strokes=MAX_SKETCH_STROKES, color=BLUE_PENCIL)
    assert len(strokes) == MAX_SKETCH_STROKES and {s["color"] for s in strokes} == {BLUE_PENCIL}
    assert strokes[0]["points"][0] == {"x": 0.0, "y": 0.0, "pressure": 0.75} and strokes[0]["points"][-1]["x"] == 1.0


def test_variations_keep_artist_strokes_verbatim_and_mark_new_ones_as_ai():
    from backend.ai import _VarStroke, _Variation, apply_variation
    from backend.models import Stroke
    original = Stroke(color="#dc2626", width=6, points=[{"x": 0.1, "y": 0.2, "pressure": 0.31}, {"x": 0.3, "y": 0.4}])
    changed = Stroke(color="#dc2626", width=6, points=[{"x": 0.5, "y": 0.5}])
    eraser = Stroke(color="#ffffff", width=9, erase=True, points=[{"x": 0.2, "y": 0.3}])
    result = _Variation(note="added a spear", keep=[0, 0, 7, -1], strokes=[
        _VarStroke(color="#ffaa00", width=4, fill="", points=[_Point(x=100, y=65), _Point(x=2000, y=-5)]),
        _VarStroke(color="nope", width=float("nan"), fill="#00ff00", points=[]),  # dropped: no points
    ])
    out, kept, added = apply_variation([original, changed, eraser], result)
    assert out[0] == original.model_dump()  # byte-for-byte the artist's stroke, pressure included
    assert out[1]["erase"] is True and "ai" not in out[0]  # erasers always survive; hand strokes carry no flag
    assert out[2]["ai"] is True and out[2]["points"][1] == {"x": 1.0, "y": 0.0, "pressure": 0.75}
    assert (kept, added, len(out)) == (1, 1, 3)  # the changed stroke was left out (the model redraws it)


def test_encode_strokes_simplifies_to_a_budget_and_skips_erasers():
    from backend.ai import VARIATION_SOURCE_POINTS, encode_strokes
    from backend.models import Stroke
    line = Stroke(color="#000000", width=4, points=[{"x": i / 4000, "y": 0.5, "pressure": 0.75} for i in range(4000)])
    wiggle = Stroke(color="#112233", width=4, fill="#445566",
                    points=[{"x": i / 3000, "y": 0.5 + 0.2 * ((i // 40) % 2)} for i in range(3000)])
    eraser = Stroke(color="#ffffff", width=9, erase=True, points=[{"x": 0.2, "y": 0.3}])
    text = encode_strokes([line, eraser, wiggle])
    lines = text.splitlines()
    assert lines[0] == "S0 color #000000 width 4.0 points 0,325 1000,325"  # a straight line needs two points
    assert lines[1].startswith("S2 color #112233 width 3.0 fill #445566 points") and len(lines) == 2
    assert sum(len(line.split(" points ")[1].split()) for line in lines) <= VARIATION_SOURCE_POINTS


def test_motion_keys_start_from_the_drawn_pose_and_stay_in_bounds():
    from backend.ai import IDENTITY_KEY, _Key, clean_track
    raw = [_Key(t=0.5, x=9, y=-0.3, sx=0, sy=1.2, r=5000), _Key(t=0.2, x=0.1, y=0, sx=1, sy=1, r=0),
           _Key(t=0.5, x=0.2, y=-0.2, sx=1, sy=1, r=10, label="  Slow   IN "), _Key(t=0.1, x=0.4, y=0.4, sx=2, sy=2, r=45)]
    track = clean_track(raw)
    assert track[0] == IDENTITY_KEY  # whatever the model says, frame 1 is exactly the artist's pose
    assert [k["t"] for k in track] == [0, 0.1, 0.2, 0.5, 1.0]  # sorted, the duplicate t=0.5 resolved, an end key added
    assert track[3] == {"t": 0.5, "x": 0.2, "y": -0.2, "sx": 1.0, "sy": 1.0, "r": 10.0, "label": "slow in"}
    assert track[4] == {**track[3], "t": 1.0, "label": "hold"}  # holds the last pose
    assert clean_track([_Key(t=0.3, x=float("nan"), y=0, sx=1, sy=1, r=0)])[1]["x"] == -1.5  # non-finite values clamp


def test_motion_endpoint_validates_and_is_metered_as_ai(client):
    http, _ = client
    http.ai.motion.return_value = {"kind": "motion", "tracks": []}
    subject = {"id": 0, "name": "Red Rocket", "box": {"x": 0.4, "y": 0.5, "w": 0.1, "h": 0.3}}
    body = {"prompt": "blasts off to the top right", "seconds": 2, "subjects": [subject], "layers": [{"strokes": []}]}
    assert http.post("/api/sparks/motion", json=body).json()["kind"] == "motion"
    assert http.post("/api/sparks/motion", json={**body, "seconds": 11}).status_code == 422  # 10 s at most, by design
    assert http.post("/api/sparks/motion", json={**body, "subjects": [subject, subject]}).status_code == 422
    assert http.post("/api/sparks/motion", json={**body, "subjects": []}).status_code == 422


def test_subject_ink_past_the_canvas_edge_is_clipped_not_rejected(client):
    # Ink near an edge (plus its line width) gave x + w > 1, and the director refused the whole scene.
    http, _ = client
    http.ai.direct.return_value = {"ideas": []}
    subject = {"id": 0, "name": "BG city", "box": {"x": 0.9, "y": -0.01, "w": 0.2, "h": 1.03}}
    assert http.post("/api/sparks/direct", json={"subjects": [subject], "layers": [{"strokes": []}]}).status_code == 200
    clipped = http.ai.direct.call_args.args[0].subjects[0].box
    assert clipped.x + clipped.w <= 1 and clipped.y == 0 and clipped.h == 1


def director_fakes():
    from backend.ai import IDENTITY_KEY
    sparks = Mock()
    sparks.direct.return_value = {"ideas": [
        {"title": t, "logline": "", "prompt": f"{t} across the sky", "movers": [0]} for t in ("Takeoff", "Moon Hop", "Spin Out")]}
    sparks.motion.return_value = {"note": "hops", "tracks": [{"subject": 0, "keys": [
        dict(IDENTITY_KEY), {**IDENTITY_KEY, "t": 0.5, "y": -0.2, "label": "arc"}, {**IDENTITY_KEY, "t": 1.0, "label": "hold"}]}]}
    return sparks


ANIMATE = {"subjects": [{"id": 0, "name": "Red Rocket", "box": {"x": 0.4, "y": 0.5, "w": 0.1, "h": 0.3}}],
           "asset_ids": ["0b6b6a4e-3f0a-4c55-9e43-7f0f3f1a2b3c"], "layers": [{"strokes": []}]}


def test_director_animates_the_first_pitch_without_motion_memory():
    from backend import director
    from backend.models import AnimateRequest
    sparks = director_fakes()
    events = list(director.run(sparks, AnimateRequest.model_validate(ANIMATE)))
    assert [e["id"] for e in events[:-1]] == ["pitch", "choreograph"]
    assert events[-1]["idea"]["title"] == "Takeoff"
    assert sparks.motion.call_args.args[0].prompt == "Takeoff across the sky"


def test_director_follows_the_artists_direction_without_pitching():
    from backend import director
    from backend.models import AnimateRequest
    sparks = director_fakes()
    events = list(director.run(sparks, AnimateRequest.model_validate({**ANIMATE, "prompt": "spins twice and bows"})))
    assert "pitch" not in [e.get("id") for e in events] and not sparks.direct.called
    assert sparks.motion.call_args.args[0].prompt == "spins twice and bows"
    assert events[-1]["idea"]["prompt"] == "spins twice and bows"


def test_motion_revision_passes_previous_choreography_to_the_director():
    from backend import director
    from backend.ai import IDENTITY_KEY
    from backend.models import AnimateRequest
    previous = {"prompt": "The rocket dances", "tracks": [{"subject": 0, "keys": [
        IDENTITY_KEY, {**IDENTITY_KEY, "t": 1, "x": 0.3}]}]}
    sparks = director_fakes()
    list(director.run(sparks, AnimateRequest.model_validate({**ANIMATE, "prompt": "make it slower", "previous": previous})))
    assert sparks.motion.call_args.args[0].previous.model_dump() == previous
    with pytest.raises(ValidationError, match="Previous motion"):
        AnimateRequest.model_validate({**ANIMATE, "prompt": "slower", "previous": {
            **previous, "tracks": [{**previous["tracks"][0], "subject": 1}]}})


def test_animate_streams_each_step_then_the_result_or_an_in_band_error(client):
    import json
    http, _ = client
    http.ai.direct.return_value = {"ideas": [{"title": "Hop", "logline": "", "prompt": "hops to the right twice", "movers": [0]}]}
    http.ai.motion.return_value = {"note": "hop", "tracks": [{"subject": 0, "keys": [{"label": "start"}, {"label": "arc"}]}]}
    response = http.post("/api/animate", json=ANIMATE)
    lines = [json.loads(line) for line in response.text.splitlines()]
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert [line.get("id") for line in lines[:-1]] == ["pitch", "choreograph"]
    assert lines[-1]["type"] == "result" and lines[-1]["idea"]["title"] == "Hop"
    http.ai.direct.side_effect = AIError("Gemini couldn't pitch a shot for this.")
    lines = [json.loads(line) for line in http.post("/api/animate", json=ANIMATE).text.splitlines()]
    assert lines[-1] == {"type": "error", "status": 502, "detail": "Gemini couldn't pitch a shot for this."}
    assert http.post("/api/animate", json={**ANIMATE, "prompt": "go"}).status_code == 422


def test_refine_keeps_the_artists_strokes_by_index_and_works_on_a_placed_asset_too():
    from backend.ai import _VarStroke, _Variation
    from backend.models import RefineRequest
    ink = {"name": "Ink", "strokes": [
        {"color": "#123b38", "width": 6, "points": [{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.2}]},
        {"color": "#123b38", "width": 6, "points": [{"x": 0.3, "y": 0.3}]},
        {"color": "#ffffff", "width": 9, "erase": True, "points": [{"x": 0.2, "y": 0.2}]}]}
    request = RefineRequest.model_validate({"prompt": "add a smile", "target": 0, "layers": [ink]})
    sparks = Sparks.__new__(Sparks)
    sparks._json = Mock(return_value=_Variation(note="smiles", keep=[0], strokes=[
        _VarStroke(color="#123b38", width=4, fill="", points=[_Point(x=500, y=300), _Point(x=520, y=310)])]))
    result = sparks.refine(request)
    assert result["keep_indices"] == [0, 2]  # stroke 1 was redrawn; the eraser always stays
    assert result["strokes"][:2] == [s.model_dump() for s in (request.layers[0].strokes[0], request.layers[0].strokes[2])]
    assert result["strokes"][2]["ai"] is True and (result["kept"], result["added"]) == (1, 1)
    # The asset selected in a shot is refined there (its copy in the shot; the asset itself is untouched).
    placed = {**ink, "asset": {"asset_id": "0b6b6a4e-3f0a-4c55-9e43-7f0f3f1a2b3c", "version": 1}}
    assert sparks.refine(RefineRequest.model_validate({"prompt": "add a smile", "target": 0, "layers": [placed]}))["keep_indices"] == [0, 2]
    with pytest.raises(ValidationError, match="no ink"):
        RefineRequest.model_validate({"prompt": "add a smile", "target": 0, "layers": [{**placed, "strokes": ink["strokes"][2:]}, ink]})


def test_code_endpoint_sends_the_drawing_and_current_sketch_to_the_ai(client):
    http, _ = client
    http.ai.code_sketch.return_value = {"kind": "code", "code": "function setup(){}\nfunction draw(){}", "note": "spins"}
    body = {"prompt": "spiral into a galaxy", "code": "function draw(){}", "layers": [{"strokes": []}]}
    assert http.post("/api/sparks/code", json=body).json()["note"] == "spins"
    sent = http.ai.code_sketch.call_args.args[0]
    assert sent.prompt == "spiral into a galaxy" and sent.code == "function draw(){}"
    assert http.post("/api/sparks/code", json={**body, "prompt": "go"}).status_code == 422
    assert http.post("/api/sparks/code", json={**body, "code": "x" * 12_001}).status_code == 422


def test_ai_sketches_are_unfenced_bounded_and_complete():
    from backend.ai import AIError, clean_sketch
    assert clean_sketch("```js\nfunction setup() {}\nfunction draw() {}\n```") == "function setup() {}\nfunction draw() {}"
    for bad in ("function draw() {}", "let x = 1;", "function setup(){}\nfunction draw(){}\n" + "//" * 7000):
        with pytest.raises(AIError):
            clean_sketch(bad)


def test_a_connection_string_in_mongodb_db_fails_fast_with_a_clear_message(monkeypatch):
    monkeypatch.setenv("MONGODB_URI", "mongodb://localhost:1/?serverSelectionTimeoutMS=1")
    monkeypatch.setenv("VOYAGE_API_KEY", "test")
    monkeypatch.setenv("MONGODB_DB", "mongodb+srv://user:pass@cluster0.example.net/")
    with pytest.raises(LibraryError, match="Put the connection string in MONGODB_URI"):
        Library()


def test_describe_names_describes_and_tags_in_one_call_and_cleans_them(client):
    from backend.ai import _Described
    from backend.models import TagRequest
    sparks = Sparks.__new__(Sparks)
    sparks._json = Mock(return_value=_Described(name=" Little <b>Fox</b> Doodle!! ", description="  An orange fox\n  sits. ",
                                                tags=["Fox", "fox", "<x>", "orange fox"]))
    result = sparks.describe(TagRequest(layers=LAYERED["layers"]), "it is an animated scene")
    assert result == {"name": "Little Fox", "description": "An orange fox sits.", "tags": ["fox", "orange fox"]}
    assert "only its first frame" in sparks._json.call_args.args[0][1]

    http, _ = client
    assert http.post("/api/describe", json={"layers": LAYERED["layers"]}).json()["name"] == "Robot Face"
