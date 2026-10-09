import json
from pathlib import Path

import pytest
from PIL import Image

from app import upscale as up
from app import upscale_image as ui
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import plan_generation
from app.models import Generation, Job
from app.workflows import build, check_template, list_templates, load
from tests.test_storyboard import _approved, _gen, _run_all, _scene, _shot
from tests.test_upscale import FIXTURE, _fake_comfy, _source, film  # noqa: F401  (fixture re-export)


def _image(client, fast_driver, target_type, target_id, kind, prompt="a diver on deck"):
    r = _gen(client, target_type, target_id, kind, prompt)
    assert r.status_code == 201, r.text
    _run_all(fast_driver)
    return client.get(f"/api/generations/{r.json()['id']}").json()


def _file(gen_id: str) -> Path:
    with SessionLocal() as db:
        return get_settings().data_dir / db.get(Generation, gen_id).file_path


# ------------------------------------------------------------------ sizes

@pytest.mark.parametrize("src,target,engine,want", [
    ((768, 1024), "2x", "redraw", (1536, 2048)),
    ((768, 1024), "2x", "quick", (1536, 2048)),
    ((1280, 720), "2k", "redraw", (2048, 1152)),
    ((1280, 720), "4k", "redraw", (3840, 2160)),
    ((720, 1280), "4k", "quick", (2160, 3840)),
    ((768, 1024), "4x", "quick", (3072, 4096)),
    ((2048, 1152), "4x", "quick", (8192, 4608)),  # quick stops at 8192 on the long side
])
def test_image_size_targets(src, target, engine, want):
    sz = ui.image_size(ui.ENGINES[engine], *src, target)
    assert (sz.width, sz.height) == want


@pytest.mark.parametrize("src", [(768, 1024), (1280, 720), (1536, 640), (1024, 1024), (720, 1280), (1001, 667)])
@pytest.mark.parametrize("target", list(ui.TARGETS))
@pytest.mark.parametrize("engine", list(ui.ENGINES))
def test_image_size_invariants(src, target, engine):
    e = ui.ENGINES[engine]
    try:
        sz = ui.image_size(e, *src, target)
    except up.UpscaleError:
        return  # already at or past the target
    assert sz.width % e.multiple == 0 and sz.height % e.multiple == 0
    assert sz.width % 2 == 0 and sz.height % 2 == 0
    assert abs(sz.width / sz.height - src[0] / src[1]) < 0.02
    assert max(sz.width, sz.height) <= e.max_long
    if e.mp_capped:
        assert sz.width * sz.height <= get_settings().image_upscale_max_mp * 1e6


def test_image_size_caps_and_refusals():
    sz = ui.image_size(ui.ENGINES["redraw"], 768, 1024, "4x")  # 12.6 MP asked, VRAM cap wins
    assert sz.capped and sz.width * sz.height <= 8.4e6 and sz.height <= 4096
    assert not ui.image_size(ui.ENGINES["quick"], 768, 1024, "4x").capped
    assert ui.image_size(ui.ENGINES["redraw"], 768, 1024, "4x", max_mp=4.0).width * 1024 / 768 <= 2400
    with pytest.raises(up.UpscaleError, match="already"):
        ui.image_size(ui.ENGINES["quick"], 2048, 1152, "2k")
    with pytest.raises(up.UpscaleError, match="Unknown target"):
        ui.image_size(ui.ENGINES["quick"], 768, 1024, "1080p")


# ------------------------------------------------------------------ templates

def test_image_templates_valid_and_plans(tmp_path):
    info = json.loads(FIXTURE.read_text(encoding="utf-8"))
    src = tmp_path / "src.png"

    class Lookup:
        def generation_file(self, gid):
            assert gid == "src1"
            return src

    for e in ui.ENGINES.values():
        assert check_template(e.template, info)["ok"], e.template
    base = {"source_id": "src1", "width": 1536, "height": 2048}
    plan = plan_generation("portrait", "", {"upscale": {**base, "template": "image_upscale_zimage", "prompt": "a diver",
                                                        "denoise": 0.25, "pre_enlarge": True}}, 5, Lookup())
    assert plan.template == "image_upscale_zimage" and plan.images == {"image": src} and plan.media == "image"
    graph, _ = build(plan.template, {**plan.inputs, "image": "up.png"})
    t = {n["_meta"]["title"]: n for n in graph.values()}
    assert t["Resize"]["inputs"]["width"] == 1536 and t["Resize"]["inputs"]["image"][0] == load(
        "image_upscale_zimage").node_id("Enlarge")
    assert t["Sampler"]["inputs"]["denoise"] == 0.25 and t["Sampler"]["inputs"]["sampler_name"] == "dpmpp_2m_sde"
    assert t["Positive"]["inputs"]["text"] == "a diver" and t["Source"]["inputs"]["image"] == "up.png"

    # small step: no ESRGAN, lanczos straight from the source
    plan = plan_generation("keyframe_end", "", {"upscale": {**base, "template": "image_upscale_zimage",
                                                            "pre_enlarge": False}}, 5, Lookup())
    graph, _ = build(plan.template, {**plan.inputs, "image": "up.png"})
    t = {n["_meta"]["title"]: n for n in graph.values()}
    assert "Enlarge" not in t and "UpscaleModel" not in t
    assert graph[t["Resize"]["inputs"]["image"][0]]["_meta"]["title"] == "Source"

    plan = plan_generation("establishing", "", {"upscale": {**base, "template": "image_upscale_seedvr2",
                                                            "model": "seedvr2_7b_int8_convrot.safetensors"}}, 5, Lookup())
    graph, _ = build(plan.template, {**plan.inputs, "image": "up.png"})
    t = {n["_meta"]["title"]: n for n in graph.values()}
    assert t["Model"]["inputs"]["unet_name"].startswith("seedvr2_7b") and t["Post"]["inputs"]["color_correction_method"] == "lab"


def test_no_template_uses_the_ltx_latent_upscalers():
    # the ltx-2.3-* files in upscale_models are latent upscalers symlinked in; not pixel models
    for name in list_templates():
        tpl = load(name)
        for n in tpl.graph.values():
            if n["class_type"] == "UpscaleModelLoader":
                assert not n["inputs"]["model_name"].startswith("ltx-"), name


# ------------------------------------------------------------------ the endpoint

def test_upscale_portrait_makes_a_new_version(client, character, fast_driver):
    src = _image(client, fast_driver, "character", character["id"], "portrait")
    assert Image.open(_file(src["id"])).size == (768, 1024)
    r = client.post(f"/api/generations/{src['id']}/upscale", json={"target": "2x"})
    assert r.status_code == 202, r.text
    job = r.json()
    # same request while queued: same job
    assert client.post(f"/api/generations/{src['id']}/upscale", json={"target": "2x"}).json()["id"] == job["id"]
    _run_all(fast_driver)

    g = client.get(f"/api/generations/{job['generation_id']}").json()
    assert g["status"] == "ready" and g["kind"] == "portrait" and g["target_id"] == character["id"]
    assert g["parent_id"] == src["id"] and g["version"] == src["version"] + 1 and g["prompt"] == src["prompt"]
    u = g["params"]["upscale"]
    assert (u["engine"], u["target"], u["width"], u["height"], u["source_id"]) == ("redraw", "2x", 1536, 2048, src["id"])
    assert u["denoise"] == 0.33 and u["prompt"] == "a diver on deck" and u["source_version"] == src["version"]
    assert g["params"]["size"] == [1536, 2048] and "comfy" not in g["params"]
    assert Image.open(_file(g["id"])).size == (1536, 2048)

    # it slots into the review loop: approve, and the character's approved portrait is the upscale
    assert client.post(f"/api/generations/{g['id']}/approve").status_code == 200
    ch = client.get(f"/api/projects/{character['project_id']}/characters").json()[0]
    assert ch["approved_portrait"]["id"] == g["id"]

    # regenerating the upscaled version gives a fresh picture, not another upscale
    r = client.post(f"/api/generations/{g['id']}/regenerate", json={"mode": "same"})
    assert r.status_code == 201, r.text
    assert "upscale" not in r.json()["params"] and "size" not in r.json()["params"]


@pytest.mark.parametrize("kind,target_type", [("sheet_view", "character"), ("establishing", "location"),
                                              ("keyframe_start", "shot"), ("keyframe_end", "shot"),
                                              ("keyframe_mid", "shot")])
def test_upscale_every_image_kind(client, project, character, fast_driver, kind, target_type):
    if target_type == "character":
        _approved(client, fast_driver, "character", character["id"], "portrait")
        tid = character["id"]
    elif target_type == "location":
        tid = client.post(f"/api/projects/{project['id']}/locations", json={"name": "Deck"}).json()["id"]
    else:
        tid = _shot(client, _scene(client, project))["id"]
    src = _image(client, fast_driver, target_type, tid, kind)
    assert src["status"] == "ready", src
    w, h = Image.open(_file(src["id"])).size
    r = client.post(f"/api/generations/{src['id']}/upscale", json={"engine": "quick", "target": "4k"})
    assert r.status_code == 202, r.text
    _run_all(fast_driver)
    g = client.get(f"/api/generations/{r.json()['generation_id']}").json()
    assert g["status"] == "ready" and g["kind"] == kind and g["target_type"] == target_type and g["target_id"] == tid
    out = Image.open(_file(g["id"])).size
    assert max(out) == 3840 and abs(out[0] / out[1] - w / h) < 0.01
    assert g["params"]["upscale"]["denoise"] is None  # only redraw has a detail strength


def test_upscale_payload_validation(client, character, project, fast_driver, film):
    src = _image(client, fast_driver, "character", character["id"], "portrait")
    url = f"/api/generations/{src['id']}/upscale"
    assert client.post(url, json={"denoise": 0.1}).status_code == 422
    assert client.post(url, json={"denoise": 0.6}).status_code == 422
    assert client.post(url, json={"target": "8k"}).status_code == 422
    r = client.post(url, json={"engine": "fast"})
    assert r.status_code == 422 and "image upscale engine" in r.text
    r = client.post(url, json={"target": "1080p"})
    assert r.status_code == 422 and "Unknown target" in r.text
    r = client.post(url, json={"engine": "redraw", "denoise": 0.2, "prompt": "  sharper diver  "})
    assert r.status_code == 202
    with SessionLocal() as db:
        u = db.get(Generation, r.json()["generation_id"]).params["upscale"]
    assert u["denoise"] == 0.2 and u["prompt"] == "sharper diver"
    r = client.post(url, json={"engine": "faithful", "target": "2k", "variant": "7b"})
    assert r.status_code == 202
    with SessionLocal() as db:
        u = db.get(Generation, r.json()["generation_id"]).params["upscale"]
    assert u["engine"] == "best" and u["model"] == "seedvr2_7b_int8_convrot.safetensors" and u["height"] == 2048

    # video side keeps its own vocabulary
    vid = _source(project["id"], film)
    r = client.post(f"/api/generations/{vid}/upscale", json={"target": "2x"})
    assert r.status_code == 422 and "for images" in r.text
    assert client.post(f"/api/generations/{vid}/upscale", json={"engine": "quick"}).status_code == 202


def test_upscale_unfinished_image_refused(client, character):
    r = _gen(client, "character", character["id"], "portrait", "x")
    r = client.post(f"/api/generations/{r.json()['id']}/upscale", json={})
    assert r.status_code == 422 and "isn't finished" in r.text


# ------------------------------------------------------------------ options

def test_options_per_media_type(client, character, project, fast_driver, film):
    src = _image(client, fast_driver, "character", character["id"], "portrait")
    body = client.get(f"/api/system/upscale-options?generation_id={src['id']}").json()
    assert body["media"] == "image" and body["default_engine"] == "redraw"
    assert [e["id"] for e in body["engines"]] == ["redraw", "quick", "anime", "best"]
    redraw = body["engines"][0]
    assert redraw["denoise"] == {"min": 0.15, "max": 0.5, "default": 0.33}
    assert [t["id"] for t in body["targets"]] == ["2x", "4x", "2k", "4k"]
    assert body["source"]["width"] == 768 and body["source"]["prompt"] == "a diver on deck"
    est = body["estimates"]["redraw"]["2x"]
    assert est["allowed"] and (est["width"], est["height"]) == (1536, 2048) and est["est_gpu_s"] > 0
    assert body["estimates"]["redraw"]["4x"]["capped"]

    vid = _source(project["id"], film)
    body = client.get(f"/api/system/upscale-options?generation_id={vid}").json()
    assert body["media"] == "video" and [e["id"] for e in body["engines"]] == ["best", "fast", "quick"]
    assert "estimates" in body and body["source"]["duration_s"] == 6.0
    assert not any(e.get("warning") for e in body["engines"])  # FlashVSR's weights are on the server


def test_image_options_from_object_info(client, character, fast_driver, monkeypatch):
    src = _image(client, fast_driver, "character", character["id"], "portrait")
    info = json.loads(FIXTURE.read_text(encoding="utf-8"))
    del info["ImageUpscaleWithModel"]
    _fake_comfy(monkeypatch, info)
    body = client.get(f"/api/system/upscale-options?generation_id={src['id']}").json()
    eng = {e["id"]: e for e in body["engines"]}
    assert not eng["redraw"]["available"] and "ImageUpscaleWithModel" in eng["redraw"]["reason"]
    assert not eng["quick"]["available"] and eng["best"]["available"]
    assert body["default_engine"] == "best"


# ------------------------------------------------------------------ downstream

def test_take_runs_from_an_approved_4k_keyframe(client, project, fast_driver):
    shot = _shot(client, _scene(client, project), duration_s=2)
    start = _image(client, fast_driver, "shot", shot["id"], "keyframe_start")
    r = client.post(f"/api/generations/{start['id']}/upscale", json={"engine": "quick", "target": "4k"})
    _run_all(fast_driver)
    big = client.get(f"/api/generations/{r.json()['generation_id']}").json()
    assert client.post(f"/api/generations/{big['id']}/approve").status_code == 200
    client.patch(f"/api/shots/{shot['id']}", json={"motion_prompt": "She turns to the sea."})

    take = _gen(client, "shot", shot["id"], "take").json()
    p = take["params"]
    assert p["first_frame_id"] == big["id"] and (p["width"], p["height"]) == (768, 448)  # draft size, not 4K

    # the LTX graph scales the 3840x2160 still down to the draft size itself
    class Lookup:
        def generation_file(self, gid):
            return _file(gid)

        def project_aspect(self, _):
            return "16:9"

    plan = plan_generation("take", take["prompt"], p, 3, Lookup())
    assert Image.open(plan.images["first_image"]).size == (3840, 2160)
    graph, _ = build(plan.template, {**plan.inputs, "first_image": "big.png"})
    t = {n["_meta"]["title"]: n for n in graph.values()}
    assert (t["FirstScale"]["inputs"]["width"], t["FirstScale"]["inputs"]["height"]) == (768, 448)

    _run_all(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, take["id"])
        assert g.status == "ready", db.get(Job, g.job_id).error


def test_anime_engine_uses_the_anime_esrgan(client, character, fast_driver):
    from app.drivers.comfy import image_upscale_plan

    src = _image(client, fast_driver, "character", character["id"], "portrait")
    r = client.post(f"/api/generations/{src['id']}/upscale", json={"engine": "cartoon", "target": "2x"})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        up = db.get(Generation, r.json()["generation_id"]).params["upscale"]
    assert up["engine"] == "anime" and up["model"] == "RealESRGAN_x4plus_anime_6B.pth"

    class Lookup:
        def generation_file(self, gid):
            return gid

    assert image_upscale_plan(up, "", 1, Lookup()).inputs["model"] == "RealESRGAN_x4plus_anime_6B.pth"
