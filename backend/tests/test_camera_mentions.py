import io

import pytest
from PIL import Image

from app import camera
from app import mentions as mn
from app.db import SessionLocal
from app.models import Generation, Job, Project

# ------------------------------------------------------------------ camera vocabulary


@pytest.mark.parametrize("cam, text", [
    ({"motion": "push_in", "speed": "slow"}, "Slow push-in."),
    ({"motion": "static"}, "Static locked-off shot."),
    ({"motion": "handheld", "speed": "slow"}, "Handheld, subtle shake."),
    ({"motion": "handheld", "speed": "fast"}, "Handheld, energetic shake."),
    ({"motion": "pan_left", "speed": "medium"}, "Steady pan to the left."),
    ({"motion": "orbit_right", "speed": "fast"}, "Fast orbit around the subject to the right."),
    ({"motion": "crane_up"}, "Slow crane up."),
    ({"motion": "dolly_left", "speed": "slow"}, "Slow dolly tracking left."),
    ({"motion": "zoom_out", "speed": "fast"}, "Fast zoom out."),
    ({"size": "ecu"}, "Extreme close-up."),
    ({"size": "ls", "angle": "overhead"}, "Wide shot, overhead bird's-eye view."),
    ({"size": "ms", "angle": "low", "motion": "push_in", "speed": "slow"},
     "Medium shot, low-angle shot looking up, slow push-in."),
    ({"size": "cu", "angle": "eye"}, "Close-up."),  # eye level is the default, not worth words
    ({"angle": "dutch"}, "Dutch angle with a tilted horizon."),
    ({"angle": "ots", "motion": "tilt_down"}, "Over-the-shoulder shot, slow tilt down."),
    ({}, ""),
    (None, ""),
])
def test_to_prompt_wording(cam, text):
    assert camera.to_prompt(cam) == text


def test_every_preset_has_a_phrase_and_aliases_work():
    for size in camera.SHOT_SIZES:
        assert camera.to_prompt({"size": size})
    for angle in camera.ANGLES:
        if angle != "eye":
            assert camera.to_prompt({"angle": angle})
    for motion in camera.MOTIONS:
        assert camera.to_prompt({"motion": motion}).endswith(".")
    assert camera.to_prompt({"size": "Wide", "angle": "birds_eye", "motion": "dolly-in"}) == \
        "Wide shot, overhead bird's-eye view, slow push-in."
    assert camera.to_prompt({"motion": "moonwalk"}) == ""
    assert camera.summary({"size": "ms", "angle": "low", "motion": "push_in", "speed": "slow"}) == "MS · Low · Push-in slow"


def test_presets_endpoint(client):
    r = client.get("/api/camera/presets")
    assert r.status_code == 200
    data = r.json()
    assert [x["id"] for x in data["shot_size"]] == ["ecu", "cu", "mcu", "ms", "mls", "ls", "ews"]
    assert {"static", "push_in", "orbit_left", "zoom_out"} <= {x["id"] for x in data["motion"]}
    assert all(x["label"] and x["description"] and x["short"] for x in data["angle"])
    assert data["default_speed"] == "slow"


def test_video_generate_composes_camera_before_brand(client):
    kit = client.post("/api/brand-kits", json={"name": "Leaf", "style_text": "soft daylight"}).json()
    r = client.post("/api/videos/generate", json={
        "prompt": "a fisherman mends nets at dawn.", "duration_s": 4, "brand_kit_id": kit["id"],
        "camera": {"size": "ms", "angle": "low", "motion": "push_in", "speed": "slow"}})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["generation_id"])
        assert g.prompt.startswith("a fisherman mends nets at dawn. Medium shot, low-angle shot looking up, slow push-in.")
        assert "soft daylight" in g.prompt.split("slow push-in.")[1]
        assert g.params["camera"] == {"size": "ms", "angle": "low", "motion": "push_in", "speed": "slow"}
        assert g.params["user_prompt"] == "a fisherman mends nets at dawn."


def test_video_generate_rejects_unknown_camera_ids(client):
    r = client.post("/api/videos/generate", json={"prompt": "waves", "camera": {"motion": "moonwalk"}})
    assert r.status_code == 422
    plain = client.post("/api/videos/generate", json={"prompt": "waves", "camera": {}})
    assert plain.status_code == 202
    with SessionLocal() as db:
        assert db.get(Generation, plain.json()["generation_id"]).prompt == "waves"


# ------------------------------------------------------------------ mentions

def png_bytes(colour=(120, 60, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), colour).save(buf, "PNG")
    return buf.getvalue()


def upload(client) -> dict:
    r = client.post("/api/media/upload", files={"file": ("p.png", png_bytes(), "image/png")})
    assert r.status_code == 201, r.text
    return r.json()


def picture(target_type: str, target: dict, kind: str, project_id: str) -> str:
    """A finished, approved still for a character or location (no GPU: the file is just a png)."""
    with SessionLocal() as db:
        p = db.get(Project, project_id)
        g = Generation(workspace_id=p.workspace_id, project_id=project_id, target_type=target_type,
                       target_id=target["id"], kind=kind, status="approved", file_path=f"x/{target['id']}.png",
                       media_type="image/png")
        db.add(g)
        db.commit()
        return g.id


@pytest.fixture
def cast(client, project):
    mara = client.post(f"/api/projects/{project['id']}/characters",
                       json={"name": "Mara", "description": "A tall fisherwoman in a red coat"}).json()
    omar = client.post(f"/api/projects/{project['id']}/characters",
                       json={"name": "Omar", "description": "Grey beard, blue cap"}).json()
    dock = client.post(f"/api/projects/{project['id']}/locations",
                       json={"name": "Harbour", "description": "Stone quay at dawn"}).json()
    ids = {"mara": picture("character", mara, "portrait", project["id"]),
           "omar": picture("character", omar, "portrait", project["id"]),
           "dock": picture("location", dock, "establishing", project["id"])}
    return {"mara": mara, "omar": omar, "dock": dock, "refs": ids, "project": project}


def test_mentions_search_project_and_brand(client, cast):
    logo = upload(client)
    product = upload(client)
    client.post("/api/brand-kits", json={"name": "Leaf", "is_default": True,
                                         "logos": {"primary": {"media_id": logo["id"], "description": "green leaf"}},
                                         "products": [{"media_id": product["id"], "name": "Leaf Cold Brew"}]})
    pid = cast["project"]["id"]
    rows = client.get(f"/api/mentions?project_id={pid}").json()
    by = {(r["type"], r["label"]): r for r in rows}
    assert {("character", "Mara"), ("character", "Omar"), ("location", "Harbour"), ("logo", "Leaf logo"),
            ("product", "Leaf Cold Brew")} <= set(by)
    assert by[("character", "Mara")]["ref_generation_id"] == cast["refs"]["mara"]
    assert by[("character", "Mara")]["thumb_url"].endswith(".png")
    assert by[("product", "Leaf Cold Brew")]["ref_generation_id"] == product["generation_id"]

    q = client.get(f"/api/mentions?q=ma&project_id={pid}&types=character").json()
    assert [r["label"] for r in q] == ["Mara"]
    # no project: recent projects, with the project title as a hint
    anywhere = client.get("/api/mentions?q=omar").json()
    assert anywhere[0]["label"] == "Omar" and anywhere[0]["hint"] == "Reef"
    assert client.get("/api/mentions?types=wizard").status_code == 422


def test_parse_and_plain_keep_urdu():
    text = "@[مارا](character:abc-123) ساحل پر چل رہی ہے، پھر @[Omar](character:def) آتا ہے"
    assert mn.parse(text) == [("مارا", "character", "abc-123"), ("Omar", "character", "def")]
    assert mn.plain(text) == "مارا ساحل پر چل رہی ہے، پھر Omar آتا ہے"


def test_image_generate_resolves_mentions_to_refs(client, cast):
    m, o, d = cast["mara"], cast["omar"], cast["dock"]
    prompt = f"@[Mara](character:{m['id']}) and @[Omar](character:{o['id']}) on @[Harbour](location:{d['id']}), " \
             f"@[Mara](character:{m['id']}) laughs"
    r = client.post("/api/images/generate", json={"prompt": prompt, "count": 1})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["items"][0]["generation_id"])
        refs = cast["refs"]
        assert g.params["reference_ids"] == [refs["mara"], refs["omar"], refs["dock"]]  # order of appearance, once
        assert g.params["reference_labels"] == ["Mara", "Omar", "Harbour"]
        assert g.params["user_prompt"] == "Mara and Omar on Harbour, Mara laughs"
        assert g.prompt.startswith("Picture 1 shows Mara; Picture 2 shows Omar; Picture 3 shows Harbour. Mara and Omar")
        assert "@[" not in g.prompt


def test_too_many_mentions_is_a_plain_422(client, cast, project):
    extra = client.post(f"/api/projects/{project['id']}/characters", json={"name": "Zara"}).json()
    picture("character", extra, "portrait", project["id"])
    m, o, d = cast["mara"], cast["omar"], cast["dock"]
    prompt = (f"@[Mara](character:{m['id']}) @[Omar](character:{o['id']}) @[Harbour](location:{d['id']}) "
              f"@[Zara](character:{extra['id']})")
    r = client.post("/api/images/generate", json={"prompt": prompt})
    assert r.status_code == 422
    assert "at most 3 reference pictures" in r.json()["detail"] and "Remove a mention" in r.json()["detail"]

    # an edit counts its source pictures too
    src = upload(client)
    two = f"put @[Mara](character:{m['id']}) and @[Omar](character:{o['id']}) here"
    ok = client.post("/api/images/edit", json={"source_ids": [src["id"]], "instruction": two})
    assert ok.status_code == 202, ok.text
    with SessionLocal() as db:
        g = db.get(Generation, ok.json()["items"][0]["generation_id"])
        assert g.params["reference_ids"] == [src["generation_id"], cast["refs"]["mara"], cast["refs"]["omar"]]
        assert g.params["instruction"].startswith("Picture 2 shows Mara; Picture 3 shows Omar. put Mara and Omar")
    over = client.post("/api/images/edit", json={"source_ids": [src["id"], src["id"]], "instruction": two})
    assert over.status_code == 422 and "2 sources + 2 mentioned" in over.json()["detail"]


def test_video_and_quick_mentions_become_words(client, cast):
    m = cast["mara"]
    r = client.post("/api/videos/generate", json={"prompt": f"@[Mara](character:{m['id']}) walks the quay",
                                                  "camera": {"motion": "static"}})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["generation_id"])
        assert g.prompt == "Mara walks the quay. Mara: A tall fisherwoman in a red coat. Static locked-off shot."
        assert g.params["mentions"][0]["label"] == "Mara" and "reference_ids" not in g.params
    q = client.post("/api/quick", json={"prompt": f"A day with @[Mara](character:{m['id']}) at sea"})
    assert q.status_code == 201, q.text
    assert q.json()["project"]["title"] == "A day with Mara at sea"
    with SessionLocal() as db:
        job = db.get(Job, q.json()["job"]["id"])
        assert job.payload["prompt"].startswith("A day with Mara at sea. Mara: A tall fisherwoman")
        assert job.payload["mentions"][0]["id"] == m["id"]


def test_foreign_or_missing_mentions_fall_back_to_names(client):
    r = client.post("/api/images/generate", json={"prompt": "@[Ghost](character:nope) in the fog"})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["items"][0]["generation_id"])
        assert "reference_ids" not in g.params
        assert g.params["mentions"] == [{"type": "character", "id": "nope", "label": "Ghost",
                                         "ref_generation_id": None, "missing": True}]
        assert g.prompt.startswith("Ghost in the fog")
