"""Contract v6: model catalog, the new templates and model choice everywhere."""
import copy
import json
import time
from pathlib import Path

import pytest

from app import models_catalog as mc
from app import upscale
from app.db import SessionLocal
from app.drivers.comfy import plan_generation
from app.models import Generation, Job, MediaItem, Project
from app.workflows import build, check_template, find_node, list_templates
from tests.test_library import png_bytes, upload
from tests.test_storyboard import _approved, _run_all, _scene, _shot

FIXTURE = Path(__file__).parent / "fixtures" / "comfy_object_info.json"
NEW = ("qwen_image_t2i", "flux2_klein_t2i", "flux2_klein_edit", "ltx23_two_stage", "wan22_t2v")


def node(graph, title):
    return graph[find_node(graph, title)]["inputs"]


def titles(graph):
    return {n["_meta"]["title"] for n in graph.values()}


@pytest.fixture
def info():
    return json.loads(FIXTURE.read_text())


@pytest.fixture
def cached_info(info):
    """Pretend a recent /object_info was fetched, so validation can see availability."""
    from app.config import get_settings

    s = get_settings()
    old = (s.gen_driver, dict(upscale._INFO_CACHE))
    s.gen_driver = "comfy"
    upscale._INFO_CACHE.update(at=time.monotonic(), info=info, error=None)
    yield info
    s.gen_driver = old[0]
    upscale._INFO_CACHE.clear()
    upscale._INFO_CACHE.update(old[1])


class Lookup:
    def __init__(self, tmp):
        self.tmp = tmp

    def generation_file(self, gid):
        p = self.tmp / f"{gid}.png"
        p.write_bytes(b"png")
        return p

    def project_aspect(self, _):
        return "16:9"

    def character_portrait(self, _):
        return "portrait-gen"


# ------------------------------------------------------------------ catalog

def test_catalog_shape_and_defaults(client):
    r = client.get("/api/models")
    assert r.status_code == 200
    rows = r.json()
    assert {m["type"] for m in rows} == {"image", "edit", "video", "upscale", "audio"}
    for t in mc.TYPES:
        if t == "audio":  # one default per generation kind instead (song, music, sfx)
            continue
        assert sum(m["default"] for m in rows if m["type"] == t) == 1, t
    for m in rows:
        assert {"id", "type", "label", "badge", "description", "capabilities", "available", "default"} <= set(m)
        assert m["available"] is True  # mock driver

    images = client.get("/api/models?type=image").json()
    assert [m["id"] for m in images] == ["auto", "zimage_turbo", "qwen_image_2512", "flux2_klein"]
    assert images[0]["auto"] and images[0]["description"] == "Picks the best model for your prompt"
    qwen = images[2]
    assert [s["id"] for s in qwen["speeds"]] == ["full", "lightning", "turbo"] and qwen["default_speed"] == "lightning"
    assert "text_render" in qwen["capabilities"]

    edit = {m["id"]: m for m in client.get("/api/models?type=edit").json()}
    assert edit["qwen_image_edit_2511"]["max_refs"] == 3 and edit["flux2_klein_edit"]["max_refs"] == 3

    video = {m["id"]: m for m in client.get("/api/models?type=video").json()}
    assert video["wan22_t2v"]["capabilities"] == ["t2v"] and video["wan22_t2v"]["audio"] is False
    assert video["wan22_t2v"]["max_duration_s"] == 5.0
    assert video["ltx23_distilled"]["audio"] and "longtake" in video["ltx23_distilled"]["capabilities"]
    assert video["ltx23_hq"]["max_duration_s"] == pytest.approx(10.67, abs=0.01)
    assert video["ltx23_hq"]["smooth_motion"]["available"] and "smooth_motion" not in video["wan22_t2v"]
    assert client.get("/api/models?type=nope").status_code == 422


def test_availability_from_object_info(info):
    rows = {m["id"]: m for m in mc.catalog(None, info, driver="comfy")}
    assert all(m["available"] for m in rows.values()), [m["id"] for m in rows.values() if not m["available"]]

    broken = copy.deepcopy(info)
    del broken["Flux2Scheduler"]
    lora = broken["LoraLoaderModelOnly"]["input"]["required"]["lora_name"]
    opts = lora[0] if isinstance(lora[0], list) else lora[1]["options"]
    opts.remove(mc.QWEN_TURBO)
    loader = broken["LatentUpscaleModelLoader"]["input"]["required"]["model_name"]
    lopts = loader[0] if isinstance(loader[0], list) else loader[1]["options"]
    lopts.remove("ltx-2.3-temporal-upscaler-x2-1.0.safetensors")
    rows = {m["id"]: m for m in mc.catalog(None, broken, driver="comfy")}
    assert not rows["flux2_klein"]["available"] and "Flux2Scheduler" in rows["flux2_klein"]["reason"]
    assert not rows["flux2_klein_edit"]["available"]
    assert rows["qwen_image_2512"]["available"]
    speeds = {s["id"]: s for s in rows["qwen_image_2512"]["speeds"]}
    assert speeds["lightning"]["available"] and not speeds["turbo"]["available"]
    # the temporal upscaler only switches smooth motion off; the models stay available
    assert rows["ltx23_distilled"]["available"] and rows["ltx23_hq"]["available"]
    assert not rows["ltx23_hq"]["smooth_motion"]["available"]
    assert "temporal" in rows["ltx23_hq"]["smooth_motion"]["reason"]

    down = mc.catalog("video", None, driver="comfy", error="timeout")
    assert all(not m["available"] and "reachable" in m["reason"] for m in down)


def test_measured_estimates():
    rows = [{"comfy": {"template": "flux2_klein_t2i", "gpu_seconds": 3.0}},
            {"comfy": {"template": "flux2_klein_t2i", "gpu_seconds": 5.0}},
            {"comfy": {"template": "wan22_t2v", "gpu_seconds": 100.0}, "duration_s": 5.0}]
    m = mc.measured_seconds(rows)
    assert m["flux2_klein_t2i"] == 4.0 and m["wan22_t2v"] == 20.0
    out = mc.model_out(mc.MODELS["wan22_t2v"], mc.availability(mc.MODELS["wan22_t2v"], None, driver="mock"), m)
    assert out["est_seconds"] == 100 and out["estimate_source"] == "measured"


# ------------------------------------------------------------------ templates

@pytest.mark.parametrize("name", NEW)
def test_new_templates_valid(name, info):
    assert name in list_templates()
    res = check_template(name, info)
    assert res["ok"], res


def test_qwen_image_speeds():
    g, _ = build("qwen_image_t2i", {"prompt": "a shop sign that says CHAI", "steps": 30, "cfg": 4.0})
    assert "SpeedLoRA" not in titles(g)
    assert node(g, "ModelSampling")["model"] == [find_node(g, "UNet"), 0]
    assert node(g, "Sampler")["steps"] == 30 and node(g, "Sampler")["cfg"] == 4.0

    g, _ = build("qwen_image_t2i", {"prompt": "x", "steps": 2, "speed_lora": mc.QWEN_TURBO, "shift": 3.0},
                 loras=[("style.safetensors", 0.6)])
    assert node(g, "SpeedLoRA")["lora_name"] == mc.QWEN_TURBO and node(g, "ModelSampling")["shift"] == 3.0
    # user LoRAs sit between the UNet and the speed LoRA
    assert node(g, "SpeedLoRA")["model"] == [find_node(g, "LoRA 1"), 0]


def test_flux2_edit_reference_chain():
    g, _ = build("flux2_klein_edit", {"prompt": "make it blue", "images": ["a.png"]})
    assert not titles(g) & {"Ref2", "Ref3", "PosRef2", "NegRef3", "Ref2Latent"}
    assert node(g, "Guider")["positive"] == [find_node(g, "PosRef1"), 0]
    assert node(g, "Guider")["negative"] == [find_node(g, "NegRef1"), 0]

    g, _ = build("flux2_klein_edit", {"prompt": "x", "images": ["a.png", "b.png"]})
    assert node(g, "Guider")["positive"] == [find_node(g, "PosRef2"), 0] and "PosRef3" not in titles(g)
    assert node(g, "PosRef2")["conditioning"] == [find_node(g, "PosRef1"), 0]

    g, _ = build("flux2_klein_edit", {"prompt": "x", "images": ["a", "b", "c"]})
    assert node(g, "Guider")["negative"] == [find_node(g, "NegRef3"), 0]
    with pytest.raises(Exception):
        build("flux2_klein_edit", {"prompt": "x", "images": ["a", "b", "c", "d"]})


def test_ltx_two_stage_modes():
    g, r = build("ltx23_two_stage", {"prompt": "waves", "num_frames": 121, "width": 1280, "height": 704,
                                     "half_width": 640, "half_height": 352})
    # t2v: no image nodes, both stages fed straight from the empty / upsampled latents
    assert not titles(g) & {"FirstImage", "FirstFrame", "FirstFrame2", "LastGuide", "LastGuide2", "TemporalLoader",
                            "TemporalUp"}
    assert node(g, "AVLatent")["video_latent"] == [find_node(g, "VideoLatent"), 0]
    assert node(g, "AVLatent2")["video_latent"] == [find_node(g, "Upsample"), 0]
    assert node(g, "Decode")["samples"] == [find_node(g, "CropGuides2"), 2]
    assert node(g, "VideoLatent")["width"] == 640 and node(g, "Save")["frame_rate"] == 24.0

    g, _ = build("ltx23_two_stage", {"prompt": "x", "first_image": "s.png", "last_image": "e.png",
                                     "smooth_fps": 48.0})
    assert node(g, "FirstFrame2")["latent"] == [find_node(g, "Upsample"), 0]
    assert node(g, "LastGuide2")["latent"] == [find_node(g, "FirstFrame2"), 0]
    assert node(g, "Decode")["samples"] == [find_node(g, "TemporalUp"), 0]
    assert node(g, "Save")["frame_rate"] == 48.0 and node(g, "Conditioning")["frame_rate"] == 24.0


def test_standard_ltx_t2v_and_smooth():
    g, r = build("ltx23_i2v", {"prompt": "rain on a window", "num_frames": 49})
    assert not titles(g) & {"FirstImage", "FirstFrame", "TemporalUp"} and r["first_image"] is None
    assert node(g, "AVLatent")["video_latent"] == [find_node(g, "VideoLatent"), 0]
    g, _ = build("ltx23_i2v", {"prompt": "x", "first_image": "a.png", "smooth_fps": 48})
    assert node(g, "Decode")["samples"] == [find_node(g, "TemporalUp"), 0] and node(g, "Save")["frame_rate"] == 48.0


def test_wan_template():
    g, _ = build("wan22_t2v", {"prompt": "a fox runs", "num_frames": 81, "seed": 9})
    assert node(g, "HighSampler")["noise_seed"] == 9 and node(g, "Latent")["length"] == 81
    assert node(g, "LowSampler")["latent_image"] == [find_node(g, "HighSampler"), 0]
    assert node(g, "Save")["frame_rate"] == 16.0 and "audio" not in node(g, "Save")
    assert mc.wan_frames(5) == 81 and mc.wan_frames(2) == 33 and mc.wan_frames(30) == 81


# ------------------------------------------------------------------ routing

def test_routing_per_model(tmp_path):
    lk = Lookup(tmp_path)
    p = plan_generation("image", "poster", {"width": 1024, "height": 1024, "model": "qwen_image_2512",
                                            "speed": "turbo"}, 1, lk)
    assert p.template == "qwen_image_t2i" and p.inputs["steps"] == 2 and p.inputs["speed_lora"] == mc.QWEN_TURBO
    build(p.template, p.inputs)
    p = plan_generation("image", "poster", {"model": "qwen_image_2512", "speed": "full"}, 1, lk)
    assert p.inputs["steps"] == 30 and p.inputs["cfg"] == 4.0 and p.inputs["speed_lora"] is None
    p = plan_generation("image", "fox", {"model": "flux2_klein", "loras": ["zimage_style.safetensors"]}, 1, lk)
    assert p.template == "flux2_klein_t2i" and p.loras == []  # Z-Image LoRAs don't go into FLUX
    p = plan_generation("image", "night", {"model": "flux2_klein_edit", "reference_ids": ["a", "b"]}, 1, lk)
    assert p.template == "flux2_klein_edit" and len(p.images["images"]) == 2
    build(p.template, {**p.inputs, "images": ["a", "b"]})

    # studio: image model when there are no refs, the edit model when there are
    p = plan_generation("keyframe_start", "dock", {"model": "flux2_klein"}, 1, lk)
    assert p.template == "flux2_klein_t2i"
    p = plan_generation("keyframe_start", "dock", {"model": "flux2_klein", "reference_ids": ["c"],
                                                   "reference_labels": ["Maya"]}, 1, lk)
    assert p.template == "qwen_edit" and p.inputs["prompt"].startswith("Picture 1 shows Maya")
    p = plan_generation("portrait", "Maya", {"edit_model": "flux2_klein_edit", "reference_ids": ["c"]}, 1, lk)
    assert p.template == "flux2_klein_edit"
    p = plan_generation("sheet_view", "", {"target_id": "x", "edit_model": "flux2_klein_edit"}, 1, lk)
    assert p.template == "qwen_edit"  # angles stay on Qwen

    take = {"first_frame_id": "s", "last_frame_id": "e", "duration_s": 5, "aspect_ratio": "9:16"}
    p = plan_generation("take", "turn", {**take, "quality": "hq", "smooth_motion": True}, 1, lk)
    assert p.template == "ltx23_two_stage" and (p.inputs["width"], p.inputs["height"]) == (704, 1280)
    assert p.inputs["half_width"] == 352 and p.inputs["smooth_fps"] == 48.0
    build(p.template, {**p.inputs, "first_image": "s.png", "last_image": "e.png"})
    p = plan_generation("take", "turn", {**take, "smooth_motion": True}, 1, lk)
    assert p.template == "ltx23_i2v" and p.inputs["smooth_fps"] == 48.0

    p = plan_generation("video", "fox", {"model": "wan22_t2v", "duration_s": 5}, 1, lk)
    assert p.template == "wan22_t2v" and p.inputs["num_frames"] == 81 and p.inputs["fps"] == 16.0
    p = plan_generation("video", "fox", {"model": "ltx23_distilled", "duration_s": 4}, 1, lk)
    assert p.template == "ltx23_i2v" and not p.images and p.inputs["num_frames"] == 97
    build(p.template, p.inputs)
    p = plan_generation("video", "fox", {"model": "ltx23_hq", "first_frame_id": "img"}, 1, lk)
    assert p.template == "ltx23_two_stage" and "first_image" in p.images


# ------------------------------------------------------------------ API validation

def test_image_generate_and_edit_models(client, fast_driver):
    r = client.post("/api/images/generate", json={"prompt": "a sign saying OPEN", "model": "qwen_image_2512",
                                                  "speed": "turbo"})
    assert r.status_code == 202, r.text
    gid = r.json()["items"][0]["generation_id"]
    with SessionLocal() as db:
        p = db.get(Generation, gid).params
        assert p["model"] == "qwen_image_2512" and p["speed"] == "turbo"
    r = client.post("/api/images/generate", json={"prompt": "x"})
    with SessionLocal() as db:
        assert db.get(Generation, r.json()["items"][0]["generation_id"]).params["model"] == "zimage_turbo"

    bad = client.post("/api/images/generate", json={"prompt": "x", "model": "wan22_t2v"})
    assert bad.status_code == 422 and "isn't an image model" in bad.json()["detail"]
    assert client.post("/api/images/generate", json={"prompt": "x", "model": "nope"}).status_code == 422
    bad = client.post("/api/images/generate", json={"prompt": "x", "model": "qwen_image_2512", "speed": "warp"})
    assert bad.status_code == 422 and "speed" in bad.json()["detail"]
    assert client.post("/api/images/generate", json={"prompt": "x", "model": "flux2_klein",
                                                     "speed": "turbo"}).status_code == 422

    up = upload(client, "a.png", png_bytes(), "image/png").json()
    r = client.post("/api/images/edit", json={"source_ids": [up["id"]], "instruction": "night",
                                              "model": "flux2_klein_edit"})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        assert db.get(Generation, r.json()["items"][0]["generation_id"]).params["model"] == "flux2_klein_edit"
    bad = client.post("/api/images/edit", json={"source_ids": [up["id"]] * 4, "instruction": "x",
                                                "model": "flux2_klein_edit"})
    assert bad.status_code == 422 and "at most 3" in bad.json()["detail"]
    assert client.post("/api/images/edit", json={"source_ids": [up["id"]], "instruction": "x",
                                                 "model": "zimage_turbo"}).status_code == 422
    _run_all(fast_driver)


def test_unavailable_model_is_refused(client, cached_info):
    del cached_info["Flux2Scheduler"]
    bad = client.post("/api/images/generate", json={"prompt": "x", "model": "flux2_klein"})
    assert bad.status_code == 422 and "isn't available" in bad.json()["detail"]
    assert client.post("/api/images/generate", json={"prompt": "x", "model": "zimage_turbo"}).status_code == 202


def test_videos_generate_validation(client):
    up = upload(client, "a.png", png_bytes(), "image/png").json()
    bad = client.post("/api/videos/generate", json={"prompt": "a fox", "model": "wan22_t2v", "image_id": up["id"]})
    assert bad.status_code == 422 and "text only" in bad.json()["detail"]
    bad = client.post("/api/videos/generate", json={"prompt": "a fox", "model": "wan22_t2v", "duration_s": 8})
    assert bad.status_code == 422 and "up to 5.0 s" in bad.json()["detail"]
    bad = client.post("/api/videos/generate", json={"prompt": "a fox", "model": "ltx23_hq", "duration_s": 20})
    assert bad.status_code == 422
    bad = client.post("/api/videos/generate", json={"prompt": "a fox", "model": "wan22_t2v", "smooth_motion": True})
    assert bad.status_code == 422 and "Smooth motion" in bad.json()["detail"]
    bad = client.post("/api/videos/generate", json={"prompt": "a fox", "duration_s": 30, "smooth_motion": True})
    assert bad.status_code == 422
    assert client.post("/api/videos/generate", json={"prompt": "x", "model": "zimage_turbo"}).status_code == 422
    assert client.post("/api/videos/generate", json={"prompt": "x", "image_id": "nope"}).status_code == 404


def test_videos_generate_makes_a_video_item(client, fast_driver):
    up = upload(client, "a.png", png_bytes(), "image/png").json()
    r = client.post("/api/videos/generate", json={"prompt": "the boat leaves", "duration_s": 2, "aspect": "9:16",
                                                  "image_id": up["id"], "seed": 4})
    assert r.status_code == 202, r.text
    item = r.json()
    assert item["kind"] == "video" and item["status"] == "queued" and item["job"]["status"] == "queued"
    wan = client.post("/api/videos/generate", json={"prompt": "a fox", "model": "wan22_t2v"}).json()
    with SessionLocal() as db:
        g = db.get(Generation, item["generation_id"])
        assert g.kind == "video" and g.target_type == "media" and g.seed == 4
        assert g.params["first_frame_id"] == up["generation_id"] and g.params["model"] == "ltx23_distilled"
        w = db.get(Generation, wan["generation_id"])
        assert (w.params["num_frames"], w.params["fps"], w.params["duration_s"]) == (81, 16.0, 5.0)
    _run_all(fast_driver)
    done = client.get(f"/api/media/{item['id']}").json()
    assert done["status"] == "ready" and done["media_url"] and done["duration_s"] == pytest.approx(2, abs=0.1)
    assert done["thumb_url"]
    assert client.get(f"/api/media?kind=video").json()["items"][0]["kind"] == "video"


def test_long_text_clip_renders_in_chunks(client, fast_driver):
    r = client.post("/api/videos/generate", json={"prompt": "a long slow pan over the sea", "duration_s": 14})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["generation_id"])
        assert g.params["longtake"] and len(g.params["chunks"]) == 2
    _run_all(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["generation_id"])
        job = db.get(Job, g.job_id)
        assert g.status == "ready", job.error
        assert "/media/" in g.file_path and g.params["assembly"]["status"] == "done"


# ------------------------------------------------------------------ studio + quick

def _shot_with_start(client, project, fast_driver, duration):
    scene = _scene(client, project)
    shot = _shot(client, scene, duration_s=duration, description="Maya walks the deck")
    _approved(client, fast_driver, "shot", shot["id"], "keyframe_start")
    return shot


def test_project_default_image_model(client, project, character, fast_driver):
    bad = client.patch(f"/api/projects/{project['id']}", json={"settings": {"image_model": "wan22_t2v"}})
    assert bad.status_code == 422
    r = client.patch(f"/api/projects/{project['id']}",
                     json={"settings": {"image_model": "flux2_klein", "video_quality": "hq", "brand_kit_id": "k1"}})
    assert r.status_code == 200 and r.json()["settings"] == {"image_model": "flux2_klein", "video_quality": "hq",
                                                            "brand_kit_id": "k1"}
    r = client.patch(f"/api/projects/{project['id']}", json={"settings": {"video_quality": None}})
    assert r.json()["settings"] == {"image_model": "flux2_klein", "brand_kit_id": "k1"}

    loc = client.post(f"/api/projects/{project['id']}/locations", json={"name": "Reef"}).json()
    est = client.post("/api/generations", json={"target_type": "location", "target_id": loc["id"],
                                                "kind": "establishing", "prompt": "", "params": {}}).json()
    por = client.post("/api/generations", json={"target_type": "character", "target_id": character["id"],
                                                "kind": "portrait", "prompt": "Maya",
                                                "params": {"model": "qwen_image_2512"}}).json()
    assert est["params"]["model"] == "flux2_klein"
    assert por["params"]["model"] == "qwen_image_2512" and por["params"]["speed"] == "lightning"
    bad = client.post("/api/generations", json={"target_type": "character", "target_id": character["id"],
                                                "kind": "portrait", "prompt": "Maya",
                                                "params": {"model": "flux2_klein_edit"}})
    assert bad.status_code == 422


def test_take_quality_rules(client, project, fast_driver):
    short = _shot_with_start(client, project, fast_driver, 4)
    r = client.post(f"/api/shots/{short['id']}/takes", json={"count": 1, "quality": "hq", "smooth_motion": True})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        g = db.get(Generation, db.get(Job, r.json()[0]["id"]).generation_id)
        assert g.params["quality"] == "hq" and g.params["smooth_motion"] is True

    long = _shot_with_start(client, project, fast_driver, 20)
    bad = client.post(f"/api/shots/{long['id']}/takes", json={"count": 1, "quality": "hq"})
    assert bad.status_code == 422 and "Standard" in bad.json()["detail"]
    bad = client.post(f"/api/shots/{long['id']}/takes", json={"count": 1, "smooth_motion": True})
    assert bad.status_code == 422

    # a project default of HQ falls back on long takes, with a note
    client.patch(f"/api/projects/{project['id']}", json={"settings": {"video_quality": "hq"}})
    r = client.post(f"/api/shots/{long['id']}/takes", json={"count": 1})
    assert r.status_code == 202
    with SessionLocal() as db:
        g = db.get(Generation, db.get(Job, r.json()[0]["id"]).generation_id)
        assert g.params["quality"] == "standard" and "Standard" in g.params["quality_note"]
    r = client.post(f"/api/shots/{short['id']}/takes", json={"count": 1})
    with SessionLocal() as db:
        assert db.get(Generation, db.get(Job, r.json()[0]["id"]).generation_id).params["quality"] == "hq"


def test_quick_create_passes_models_through(client):
    r = client.post("/api/quick", json={"prompt": "a fisherman at dawn", "duration_s": 10,
                                        "image_model": "qwen_image_2512", "video_quality": "hq"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["project"]["settings"] == {"image_model": "qwen_image_2512", "video_quality": "hq"}
    with SessionLocal() as db:
        assert db.get(Job, body["job"]["id"]).payload["models"]["image_model"] == "qwen_image_2512"
        assert db.get(Project, body["project"]["id"]).settings["video_quality"] == "hq"
    assert client.post("/api/quick", json={"prompt": "a fisherman", "image_model": "nope"}).status_code == 422
    assert client.post("/api/quick", json={"prompt": "a fisherman", "video_quality": "ultra"}).status_code == 422


def test_comfy_check_lists_new_templates(client, monkeypatch, info):
    from app.drivers import comfy_client

    class Fake:
        base_url = "http://comfy.test"

        async def object_info(self):
            return info

        async def close(self):
            pass

    async def fake_pick(*a, **k):
        return Fake()

    monkeypatch.setattr(comfy_client, "pick_client", fake_pick)
    body = client.get("/api/system/comfy-check").json()
    assert set(NEW) <= set(body["templates"]) and body["ok"]
    assert body["templates"]["ltx23_two_stage"]["features"]["smooth_motion"]["ok"]
