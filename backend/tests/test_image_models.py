"""Contract v32: the test-mode image models, their licence gate, graphs, plans and Auto routing."""
import copy
import json
import time
from pathlib import Path

import pytest

from app import models_catalog as mc
from app import upscale
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import plan_generation
from app.models import Generation, Job
from app.workflows import build, check_template, find_node, list_templates, load
from tests.test_storyboard import _run_all

FIXTURE = Path(__file__).parent / "fixtures" / "comfy_object_info.json"
NEW_TEMPLATES = (
    "krea2_t2i", "krea2_raw_t2i", "hidream_o1_dev_t2i", "hidream_o1_t2i", "anima_t2i", "anima_i2i",
    "illustrious_xl_t2i", "illustrious_xl_i2i", "realvis_xl_t2i", "realvis_xl_i2i", "flux2_klein9b_t2i",
    "flux2_klein9b_i2i", "flux2_klein9b_edit", "qwen_image21_t2i", "qwen_image21_full_t2i", "ernie_turbo_t2i",
    "zimage_base_t2i", "zimage_base_i2i", "chroma1_hd_t2i", "wan22_still_t2i",
)
NC_IMAGE = {"anima", "krea2_turbo", "flux2_klein_9b", "qwen_image_21"}


def node(graph, title):
    return graph[find_node(graph, title)]["inputs"]


@pytest.fixture
def info():
    return json.loads(FIXTURE.read_text())


@pytest.fixture
def cached(info):
    """A recent /object_info on a real (comfy) driver; tests edit the dict in place."""
    s = get_settings()
    old = (s.gen_driver, dict(upscale._INFO_CACHE))
    s.gen_driver = "comfy"
    upscale._INFO_CACHE.update(at=time.monotonic(), info=info, error=None)
    yield info
    s.gen_driver = old[0]
    upscale._INFO_CACHE.clear()
    upscale._INFO_CACHE.update(old[1])


def drop_file(info, loader, field, name):
    spec = info[loader]["input"]["required"][field]
    opts = spec[1]["options"] if spec[0] == "COMBO" else spec[0]
    opts.remove(name)


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


# ------------------------------------------------------------------ the licence gate

def test_switch_off_hides_and_refuses_nc_image_models(client, monkeypatch):
    on = {m["id"]: m for m in client.get("/api/models?type=image").json()}
    assert NC_IMAGE <= set(on)
    assert on["anima"]["extra"] == {"licence": mc.ANIMA_LICENCE, "licence_kind": "noncommercial", "noncommercial": True}
    assert on["krea2_turbo"]["extra"]["licence_kind"] == "conditional"
    assert on["zimage_turbo"]["extra"] == {"licence": mc.APACHE, "licence_kind": "commercial"}
    assert "flux2_klein_9b_edit" in {m["id"] for m in client.get("/api/models?type=edit").json()}

    monkeypatch.setattr(get_settings(), "image_allow_noncommercial", False)
    off = {m["id"] for m in client.get("/api/models?type=image").json()}
    assert not off & NC_IMAGE
    assert {"illustrious_xl2", "realvis_xl5", "zimage_base", "hidream_o1", "ernie_image_turbo", "chroma1_hd",
            "wan22_still"} <= off
    assert "flux2_klein_9b_edit" not in {m["id"] for m in client.get("/api/models?type=edit").json()}

    bad = client.post("/api/images/generate", json={"prompt": "a fox", "model": "anima"})
    assert bad.status_code == 422
    assert "IMAGE_ALLOW_NONCOMMERCIAL" in bad.json()["detail"] and "AUDIO" not in bad.json()["detail"]
    with pytest.raises(Exception) as e:
        mc.get("flux2_klein_9b_edit", "edit")
    assert "IMAGE_ALLOW_NONCOMMERCIAL" in str(e.value.detail)
    # the names offered in the 'choose one of' list leave the hidden ones out too
    bad = client.post("/api/images/generate", json={"prompt": "a fox", "model": "nope"})
    assert "anima" not in bad.json()["detail"] and "illustrious_xl2" in bad.json()["detail"]


def test_audio_switch_does_not_touch_image_models(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "audio_allow_noncommercial", False)
    ids = {m["id"] for m in client.get("/api/models?type=image").json()}
    assert NC_IMAGE <= ids
    assert "minimax_music3" not in {m["id"] for m in client.get("/api/models?type=audio").json()}
    monkeypatch.setattr(get_settings(), "audio_allow_noncommercial", True)
    monkeypatch.setattr(get_settings(), "image_allow_noncommercial", False)
    assert "minimax_music3" in {m["id"] for m in client.get("/api/models?type=audio").json()}


def test_catalogue_cards(client):
    rows = {m["id"]: m for m in client.get("/api/models?type=image").json()}
    for mid, m in rows.items():
        if mid == "auto":
            continue
        assert m["group"] in mc.IMAGE_GROUPS, mid
        assert m["extra"]["licence"], mid
        assert m["installed"] is True and m["estimate_source"] == "rough", mid
        assert m["best_for"], mid
    assert rows["anima"]["badge"] == "ANIME" and rows["illustrious_xl2"]["badge"] == "ANIME"
    assert rows["realvis_xl5"]["badge"] == "PHOTO" and rows["hidream_o1"]["badge"] == "2K"
    assert [s["id"] for s in rows["krea2_turbo"]["speeds"]] == ["turbo", "raw"]
    assert rows["krea2_turbo"]["default_speed"] == "turbo"
    assert [s["id"] for s in rows["realvis_xl5"]["speeds"]] == ["full", "lightning"]
    # the defaults stay the defaults
    assert [m["id"] for m in rows.values() if m["default"]] == ["zimage_turbo"]
    assert "i2i" in rows["illustrious_xl2"]["capabilities"] and "i2i" not in rows["krea2_turbo"]["capabilities"]


# ------------------------------------------------------------------ graphs

@pytest.mark.parametrize("name", NEW_TEMPLATES)
def test_new_templates_check_and_build(name, info):
    assert name in list_templates()
    res = check_template(name, info)
    assert res["ok"], res
    tpl = load(name)
    req = tpl.manifest["requires"]
    assert req["pack"] and req["nodes"] and (req.get("assumed") or req.get("verified"))
    inputs = {"prompt": "a lighthouse at dusk", "seed": 3}
    spec = tpl.manifest["inputs"]
    if "image" in spec:
        inputs["image"] = "src.png"
    if "images" in spec:
        inputs["images"] = ["a.png"]
    graph, resolved = build(name, inputs)
    assert resolved["prompt"] == "a lighthouse at dusk"
    assert any(n["class_type"] == "SaveImage" for n in graph.values())


def test_speed_loras_bypass_when_off():
    g, _ = build("anima_t2i", {"prompt": "x", "steps": 30, "cfg": 4.0})
    assert "SpeedLoRA" not in {n["_meta"]["title"] for n in g.values()}
    assert node(g, "Sampler")["model"] == [find_node(g, "UNet"), 0]
    g, _ = build("realvis_xl_t2i", {"prompt": "x", "speed_lora": mc.SDXL_LIGHTNING, "steps": 8, "cfg": 1.0,
                                    "sampler": "euler", "scheduler": "sgm_uniform"})
    s = node(g, "Sampler")
    assert (s["steps"], s["cfg"], s["sampler_name"], s["scheduler"]) == (8, 1.0, "euler", "sgm_uniform")
    assert node(g, "SpeedLoRA")["lora_name"] == mc.SDXL_LIGHTNING


def test_hidream_snaps_to_32_and_seeds_the_sampler():
    g, r = build("hidream_o1_dev_t2i", {"prompt": "x", "width": 1280, "height": 720, "seed": 11})
    assert (node(g, "Latent")["width"], node(g, "Latent")["height"]) == (1280, 704)
    assert node(g, "Sampler")["noise_seed"] == 11 and node(g, "Scheduler")["steps"] == 28


def test_qwen21_prompt_goes_through_its_encoder():
    g, _ = build("qwen_image21_t2i", {"prompt": "a sign that says OPEN", "negative": "blur"})
    enc = node(g, "Encode")
    assert enc["prompt"] == "a sign that says OPEN" and enc["negative_prompt"] == "blur"
    assert node(g, "Guider")["negative"] == [find_node(g, "Encode"), 1]


# ------------------------------------------------------------------ plan dispatch

@pytest.mark.parametrize("model,speed,template,steps", [
    ("krea2_turbo", None, "krea2_t2i", 8),
    ("krea2_turbo", "raw", "krea2_raw_t2i", 52),
    ("hidream_o1", None, "hidream_o1_dev_t2i", 28),
    ("hidream_o1", "full", "hidream_o1_t2i", 40),
    ("anima", None, "anima_t2i", 8),
    ("anima", "full", "anima_t2i", 30),
    ("illustrious_xl2", None, "illustrious_xl_t2i", None),
    ("realvis_xl5", None, "realvis_xl_t2i", 30),
    ("realvis_xl5", "lightning", "realvis_xl_t2i", 8),
    ("flux2_klein_9b", None, "flux2_klein9b_t2i", None),
    ("qwen_image_21", None, "qwen_image21_t2i", 8),
    ("qwen_image_21", "full", "qwen_image21_full_t2i", 25),
    ("ernie_image_turbo", None, "ernie_turbo_t2i", None),
    ("zimage_base", None, "zimage_base_t2i", None),
    ("chroma1_hd", None, "chroma1_hd_t2i", None),
    ("wan22_still", None, "wan22_still_t2i", None),
])
def test_plan_dispatch(model, speed, template, steps, tmp_path):
    params = {"width": 1024, "height": 1024, "model": model, "loras": ["zimage_style.safetensors"]}
    if speed:
        params["speed"] = speed
    p = plan_generation("image", "a fox in snow", params, 5, Lookup(tmp_path))
    assert p.template == template and p.sources["model"] == model
    assert p.loras == []  # Z-Image LoRAs never go into another family's graph
    if steps is not None:
        assert p.inputs["steps"] == steps
    graph, _ = build(p.template, p.inputs)
    assert graph
    assert mc.template_for(mc.MODELS[model], speed) == template


def test_plan_speed_details(tmp_path):
    lk = Lookup(tmp_path)
    p = plan_generation("image", "x", {"model": "realvis_xl5", "speed": "lightning"}, 1, lk)
    assert (p.inputs["sampler"], p.inputs["scheduler"], p.inputs["speed_lora"]) == ("euler", "sgm_uniform",
                                                                                     mc.SDXL_LIGHTNING)
    p = plan_generation("image", "x", {"model": "anima"}, 1, lk)
    assert p.inputs["speed_lora"] == mc.ANIMA_TURBO and p.inputs["cfg"] == 1.0
    p = plan_generation("image", "x", {"model": "krea2_turbo", "speed": "raw"}, 1, lk)
    assert p.inputs["cfg"] == 3.5 and p.sources["speed"] == "raw"


@pytest.mark.parametrize("model,template", [
    ("illustrious_xl2", "illustrious_xl_i2i"), ("realvis_xl5", "realvis_xl_i2i"), ("anima", "anima_i2i"),
    ("zimage_base", "zimage_base_i2i"), ("flux2_klein_9b", "flux2_klein9b_i2i"),
])
def test_img2img_plans(model, template, tmp_path):
    p = plan_generation("image", "night", {"model": model, "img2img_of": {"generation_id": "src", "strength": 0.5}},
                        1, Lookup(tmp_path))
    assert p.template == template and p.inputs["denoise"] == 0.5 and "image" in p.images
    build(p.template, {**p.inputs, "image": "src.png"})
    if model == "flux2_klein_9b":
        assert p.inputs["steps"] == 8  # stretched so ~4 real steps run at strength 0.5


def test_no_img2img_for_t2i_only_models(tmp_path):
    from app.drivers.comfy_client import ComfyError

    with pytest.raises(ComfyError):
        plan_generation("image", "x", {"model": "krea2_turbo", "img2img_of": {"generation_id": "s"}}, 1,
                        Lookup(tmp_path))


def test_klein9b_edit_plan(tmp_path):
    p = plan_generation("image", "make it night", {"model": "flux2_klein_9b_edit", "reference_ids": ["a", "b"]}, 1,
                        Lookup(tmp_path))
    assert p.template == "flux2_klein9b_edit" and len(p.images["images"]) == 2
    g, _ = build(p.template, {**p.inputs, "images": ["a.png", "b.png"]})
    assert node(g, "Guider")["negative"] == [find_node(g, "NegRef2"), 0] and node(g, "Scheduler")["steps"] == 4


def test_mock_driver_records_the_graph(client, fast_driver):
    r = client.post("/api/images/generate", json={"prompt": "a lighthouse", "model": "hidream_o1", "speed": "full"})
    assert r.status_code == 202, r.text
    gid = r.json()["items"][0]["generation_id"]
    _run_all(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, gid)
        assert g.status == "ready"
        assert db.get(Job, g.job_id).result["template"] == "hidream_o1_t2i"


# ------------------------------------------------------------------ availability and Auto

def test_not_installed_models_show_as_such(info):
    broken = copy.deepcopy(info)
    drop_file(broken, "CheckpointLoaderSimple", "ckpt_name", "Illustrious-XL-v2.0.safetensors")
    drop_file(broken, "UNETLoader", "unet_name", "krea2_raw_fp8_scaled.safetensors")
    rows = {m["id"]: m for m in mc.catalog("image", broken, driver="comfy")}
    ill = rows["illustrious_xl2"]
    assert ill["available"] is False and ill["installed"] is False
    assert "Illustrious-XL-v2.0.safetensors" in ill["reason"]
    # a missing Raw file only takes the Raw speed away
    krea = rows["krea2_turbo"]
    speeds = {s["id"]: s for s in krea["speeds"]}
    assert krea["available"] and speeds["turbo"]["available"] and not speeds["raw"]["available"]
    assert "krea2_raw_fp8_scaled" in speeds["raw"]["reason"]
    down = mc.catalog("image", None, driver="comfy", error="timeout")
    assert all(m.get("installed") is None for m in down if m["id"] != "auto")


def test_auto_keeps_the_defaults():
    assert mc.resolve_auto("image", "a misty harbour at dawn")[0].id == "zimage_turbo"
    assert mc.resolve_auto("image", 'a poster that says "SALE"')[0].id == "qwen_image_2512"
    assert mc.resolve_auto("image", "a shop sign in Urdu: چائے")[0].id == "qwen_image_2512"
    assert mc.resolve_auto("image", "a misty harbour", count=4)[0].id == "flux2_klein"
    # text still wins over anime, and never goes to the research-licence Qwen 2.1
    assert mc.resolve_auto("image", 'an anime poster that says "HELLO"')[0].id == "qwen_image_2512"


def test_auto_sends_anime_to_installed_anime_models(cached, monkeypatch):
    m, why = mc.resolve_auto("image", "anime girl on a rooftop, cel shaded")
    assert m.id == "illustrious_xl2" and "anime" in why
    assert mc.resolve_auto("image", "manga panel of a samurai", count=4)[0].id == "illustrious_xl2"

    drop_file(cached, "CheckpointLoaderSimple", "ckpt_name", "Illustrious-XL-v2.0.safetensors")
    assert mc.resolve_auto("image", "anime girl on a rooftop")[0].id == "anima"
    monkeypatch.setattr(get_settings(), "image_allow_noncommercial", False)
    assert mc.resolve_auto("image", "anime girl on a rooftop")[0].id == "zimage_turbo"
    monkeypatch.setattr(get_settings(), "image_allow_noncommercial", True)
    drop_file(cached, "UNETLoader", "unet_name", "anima-base-v1.0.safetensors")
    assert mc.resolve_auto("image", "anime girl on a rooftop")[0].id == "zimage_turbo"
    assert mc.resolve_auto("image", "anime girl on a rooftop", count=4)[0].id == "flux2_klein"


def test_auto_without_a_recent_object_info_stays_put():
    s = get_settings()
    old = (s.gen_driver, dict(upscale._INFO_CACHE))
    s.gen_driver = "comfy"
    upscale._INFO_CACHE.update(at=0.0, info=None, error=None)
    try:
        assert mc.resolve_auto("image", "anime girl on a rooftop")[0].id == "zimage_turbo"
    finally:
        s.gen_driver = old[0]
        upscale._INFO_CACHE.clear()
        upscale._INFO_CACHE.update(old[1])


def test_auto_img2img_needs_i2i(cached):
    del cached["VAEEncode"]  # every redraw graph needs it
    m, _ = mc.resolve_auto("image", "anime girl", cap="i2i")
    assert m.id == "zimage_turbo"


def test_edit_auto_skips_hidden(monkeypatch):
    monkeypatch.setattr(get_settings(), "image_allow_noncommercial", False)
    assert mc.resolve_auto("edit", "make it night", refs=2)[0].id == "qwen_image_edit_2511"


def test_anime_styles_hint_illustrious(client):
    styles = {s["id"]: s for s in client.get("/api/images/options").json()["styles"]}
    assert styles["anime"]["best_model"] == "illustrious_xl2" and styles["chibi"]["best_model"] == "illustrious_xl2"
    assert styles["photoreal"]["best_model"] == "zimage_turbo"


def test_qwen21_leaves_its_empty_reference_list_out(info):
    # the live server lists TextEncodeQwenImage21.images (a min-0 autogrow) as required; the pre-flight check
    # used to call that "required input not set" and refuse every Qwen-Image 2.1 job
    from app.workflows import check_template

    for name in ("qwen_image21_t2i", "qwen_image21_full_t2i"):
        assert check_template(name, info)["ok"], name
