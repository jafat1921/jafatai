"""Contract v31: the style catalogue, Restyle, Depth / Sketch / Pose to image, and saved templates."""
import io
import json
from pathlib import Path

import pytest
from PIL import Image

from app import control as ctl
from app import models_catalog as mc
from app import styles as st
from app.api import library as lib_api
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import TIMEOUTS, plan_generation
from app.library import STYLES, styled_prompt
from app.models import Generation, UserTemplate, Workspace
from app.workflows import build, check_template, load
from tests.test_library import png_bytes, upload

FIXTURE = Path(__file__).parent / "fixtures" / "comfy_object_info.json"
OLD_IDS = ("photoreal", "cinematic", "illustration", "product")


def info():
    return json.loads(FIXTURE.read_text())


def params_of(item: dict) -> Generation:
    with SessionLocal() as db:
        g = db.get(Generation, item["generation_id"])
        db.expunge(g)
        return g


@pytest.fixture
def photo(client):
    return upload(client, "street.png", png_bytes((320, 200)), "image/png").json()


@pytest.fixture
def sketch(client):
    # a pencil drawing: dark lines on white paper
    im = Image.new("RGB", (300, 400), "white")
    for x in range(40, 260):
        im.putpixel((x, 200), (20, 20, 20))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return upload(client, "sketch.png", buf.getvalue(), "image/png").json()


# ------------------------------------------------------------------ the catalogue

def test_catalogue_is_sound():
    rows = st.catalogue()
    groups = {g["id"] for g in st.groups()}
    assert len(rows) == 45 and len(groups) == 7
    assert {s.group for s in rows.values()} == groups
    for s in rows.values():
        assert s.label and s.subtitle and s.positive and s.preview == f"styles/{s.id}.webp"
        assert mc.MODELS[s.best_model].type == "image", s.id
        assert "[" not in s.positive
    for g in st.groups():
        assert 0.2 <= g["restyle_strength"] <= 0.7
    # the four old ids keep working and painterly lands on oil
    assert all(i in STYLES for i in OLD_IDS)
    assert STYLES["painterly"] is rows["oil"] and "painterly" not in rows
    assert "impasto" in styled_prompt("a harbour", "painterly")
    assert styled_prompt("A harbour.", "anime") == f"A harbour. {rows['anime'].positive}"
    assert styled_prompt("", "anime") == rows["anime"].positive


def test_template_defaults_use_real_styles():
    for t in lib_api.templates().values():
        style = (t.get("defaults") or {}).get("style")
        if t["type"] == "image" and style:
            assert style in STYLES, t["id"]


def test_negative_only_where_cfg_reads_it():
    s = st.get("anime")
    assert st.joined_negative("blur", s, 1.0) == "blur"
    assert st.joined_negative("blur", s, 4.0) == f"blur, {s.negative}"
    assert st.joined_negative(None, st.get("cosmic"), 4.0) is None  # cosmic has no negative
    assert st.joined_negative("", None, 4.0) is None


def test_options_endpoint_and_previews(client, tmp_path, monkeypatch):
    body = client.get("/api/images/options").json()
    ids = [s["id"] for s in body["styles"]]
    assert len(ids) == 45 and "painterly" not in ids and body["style_aliases"] == {"painterly": "oil"}
    assert [g["id"] for g in body["style_groups"]][:2] == ["photo", "painting"]
    oil = next(s for s in body["styles"] if s["id"] == "oil")
    assert oil["group"] == "painting" and oil["best_model"] == "qwen_image_2512" and oil["suffix"].startswith("oil")

    monkeypatch.setattr(st, "PREVIEW_DIR", tmp_path)
    (tmp_path / "styles").mkdir()
    (tmp_path / "styles" / "oil.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBPfake")
    rows = {s["id"]: s for s in client.get("/api/images/options").json()["styles"]}
    assert rows["oil"]["preview_url"].startswith("/api/images/styles/oil/preview?v=")
    assert rows["anime"]["preview_url"] is None  # no file: the UI falls back to a swatch
    assert client.get(rows["oil"]["preview_url"]).content.endswith(b"fake")
    assert client.get("/api/images/styles/anime/preview").status_code == 404
    assert client.get("/api/images/styles/..%2Fsecret/preview").status_code == 404


def test_generate_with_new_and_old_styles(client):
    r = client.post("/api/images/generate", json={"prompt": "a lighthouse", "style": "anime"})
    assert r.status_code == 202, r.text
    g = params_of(r.json()["items"][0])
    assert g.prompt.endswith(st.get("anime").positive) and g.params["style"] == "anime"
    assert "negative" not in g.params  # Z-Image runs at CFG 1

    r = client.post("/api/images/generate", json={"prompt": "a lighthouse", "style": "painterly"})
    assert "impasto" in params_of(r.json()["items"][0]).prompt

    r = client.post("/api/images/generate", json={"prompt": "a lighthouse", "style": "oil", "negative": "text",
                                                  "model": "qwen_image_2512", "speed": "full"})
    assert params_of(r.json()["items"][0]).params["negative"] == "text, photo, smooth"
    r = client.post("/api/images/generate", json={"prompt": "x", "style": "vaporwave"})
    assert r.status_code == 422 and "/api/images/options" in r.json()["detail"]


# ------------------------------------------------------------------ restyle

def test_img2img_style_and_strength_presets(client, photo):
    r = client.post("/api/images/img2img", json={"source_id": photo["id"], "style": "oil"})
    assert r.status_code == 202, r.text
    g = params_of(r.json()["items"][0])
    assert g.prompt == st.get("oil").positive and g.params["style"] == "oil"
    assert g.params["img2img_of"]["strength"] == 0.6  # the painting group's preset
    assert g.params["magic_prompt"]["status"] == "off" and r.json()["items"][0]["title"] == "Restyle · Oil Painting"

    r = client.post("/api/images/img2img", json={"source_id": photo["id"], "style": "photoreal", "prompt": "at noon"})
    g = params_of(r.json()["items"][0])
    assert g.params["img2img_of"]["strength"] == 0.3 and g.prompt.startswith("at noon. photorealistic")

    # a value the user set wins over the preset
    r = client.post("/api/images/img2img", json={"source_id": photo["id"], "style": "anime", "strength": 0.4})
    assert params_of(r.json()["items"][0]).params["img2img_of"]["strength"] == 0.4

    r = client.post("/api/images/img2img", json={"source_id": photo["id"], "prompt": "   "})
    assert r.status_code == 422 and "style" in r.json()["detail"]
    assert client.post("/api/images/img2img", json={"source_id": photo["id"], "style": "nope"}).status_code == 422


def test_restyle_template_builds_the_instruction(client, photo):
    rows = {t["id"]: t for t in client.get("/api/prompt-templates", params={"type": "image"}).json()}
    card = rows["image-edit-restyle"]
    opt = card["options"][0]
    assert opt["slot"] == "style" and opt["gallery"] == "styles" and len(opt["choices"]) == 45
    oil = next(c for c in opt["choices"] if c["style_id"] == "oil")
    assert oil["value"] == f"Oil Painting: {st.get('oil').positive}"

    start = client.post("/api/prompt-templates/image-edit-restyle/start").json()
    assert start["target"] == "image-edit" and start["prefill"]["placeholders"] == ["style"]
    text = start["prefill"]["instruction"].replace("[style]", oil["value"])
    assert text == (f"Redraw image 1 as Oil Painting: {st.get('oil').positive}; keep the composition, faces and "
                    "identity.")
    r = client.post("/api/images/edit", json={"source_ids": [photo["id"]], "instruction": text,
                                              "template_id": "image-edit-restyle"})
    assert r.status_code == 202 and r.json()["model_resolved"] == "qwen_image_edit_2511"

    prompt = rows["image-edit-image-prompt"]
    assert prompt["ref_labels"] == ["Reference"] and "image 1" in prompt["defaults"]["instruction_scaffold"]


# ------------------------------------------------------------------ ControlNet workflows

@pytest.mark.parametrize("name", sorted(ctl.TEMPLATES))
def test_control_workflows_build_and_check(name):
    assert check_template(name, info())["ok"], name
    assert name in TIMEOUTS
    m = load(name).manifest
    assert m["requires"]["assumed"].startswith("UNVERIFIED")
    assert "QwenImageDiffsynthControlnet" in m["requires"]["nodes"]
    assert m["models"]["model_patches"] == [ctl.MODEL_PATCH]
    g, resolved = build(name, {"image": "c.png", "prompt": "a knight", "width": 896, "height": 1152, "seed": 4,
                               "strength": 0.9, "resolution": 896})
    by = {n["_meta"]["title"]: n for n in g.values()}
    assert by["ControlNet"]["inputs"]["strength"] == 0.9 and by["Latent"]["inputs"]["width"] == 896
    assert by["Patch"]["inputs"]["name"] == ctl.MODEL_PATCH and by["Sampler"]["inputs"]["model"] == [
        next(k for k, n in g.items() if n["_meta"]["title"] == "ControlNet"), 0]
    assert ("Detect" in by) == (name != ctl.RAW_TEMPLATE)


def test_pose_uses_the_torchscript_dwpose():
    g, _ = build("zimage_controlnet_pose", {"image": "c.png", "prompt": "x"})
    d = next(n for n in g.values() if n["_meta"]["title"] == "Detect")
    assert d["class_type"] == "DWPreprocessor" and d["inputs"]["pose_estimator"].endswith(".torchscript.pt")


def test_missing_controlnet_is_reported():
    broken = info()
    del broken["QwenImageDiffsynthControlnet"]
    assert check_template("zimage_controlnet", broken)["missing_nodes"] == ["QwenImageDiffsynthControlnet"]
    broken = info()
    broken["ModelPatchLoader"]["input"]["required"]["name"][0] = ["SUPIR-v0Q_fp16.safetensors"]
    assert check_template("zimage_controlnet_depth", broken)["missing_models"] == [ctl.MODEL_PATCH]
    s = ctl.status(broken, driver="comfy")
    assert not s["available"] and all(not t["available"] for t in s["types"])
    assert not ctl.status(None, driver="comfy", error="down")["available"]


def test_control_plan_dispatch(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "data_dir", tmp_path)
    src = tmp_path / "src.png"
    src.write_bytes(png_bytes())
    (tmp_path / "inv.png").write_bytes(png_bytes())

    class Lookup:
        def generation_file(self, gid):
            return src

    rec = {"type": "depth", "template": "zimage_controlnet_depth", "source_id": "g1",
           "inputs": {"width": 896, "height": 1152, "strength": 0.8, "resolution": 896}}
    plan = plan_generation("image", "a castle", {"control": rec, "negative": "blur"}, 9, Lookup())
    assert plan.template == "zimage_controlnet_depth" and plan.images["image"] == src
    assert plan.inputs["prompt"] == "a castle" and plan.inputs["negative"] == "blur" and plan.inputs["seed"] == 9
    assert plan.sources == {"source_id": "g1", "control": "depth", "as_is": False}
    build(plan.template, {**plan.inputs, "image": "f.png"})

    rec = {"type": "scribble", "template": "zimage_controlnet", "source_id": "g1", "as_is": True,
           "control_file": "inv.png", "inputs": {"width": 512, "height": 512, "strength": 0.7}}
    plan = plan_generation("image", "x", {"control": rec}, 1, Lookup())
    assert plan.images["image"] == tmp_path / "inv.png" and plan.sources["as_is"]
    with pytest.raises(Exception, match="unknown control template"):
        plan_generation("image", "x", {"control": {**rec, "template": "qwen_edit"}}, 1, Lookup())


# ------------------------------------------------------------------ POST /images/control

def test_control_request_runs_the_controlnet(client, photo):
    r = client.post("/api/images/control", json={"source_id": photo["id"], "control": "pose",
                                                 "prompt": "a dancer in red", "style": "cinematic", "count": 2,
                                                 "seed": 5, "template_id": "image-control-pose"})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["tool_resolved"] == "controlnet:pose" and len(body["items"]) == 2
    g = params_of(body["items"][0])
    c = g.params["control"]
    assert c["template"] == "zimage_controlnet_pose" and c["inputs"]["strength"] == 0.8
    assert c["inputs"]["resolution"] == 832 and (c["inputs"]["width"], c["inputs"]["height"]) == (1280, 832)
    assert g.prompt.startswith("a dancer in red. cinematic still") and g.params["template_id"] == "image-control-pose"
    assert g.seed == 5 and body["items"][0]["title"] == "Pose · a dancer in red"

    r = client.post("/api/images/control", json={"source_id": photo["id"], "control": "depth", "prompt": "x",
                                                 "strength": 1.2})
    assert r.status_code == 422


def test_control_sketch_as_is_is_inverted(client, sketch):
    r = client.post("/api/images/control", json={"source_id": sketch["id"], "control": "scribble", "use_as_is": True,
                                                 "prompt": "a lighthouse", "aspect": "1:1"})
    assert r.status_code == 202, r.text
    c = params_of(r.json()["items"][0]).params["control"]
    assert c["template"] == "zimage_controlnet" and c["inverted"] and "resolution" not in c["inputs"]
    inv = get_settings().data_dir / c["control_file"]
    with Image.open(inv) as im:
        assert im.convert("L").getpixel((5, 5)) == 0  # the white paper is black now
    # a depth map used as is stays as it is
    r = client.post("/api/images/control", json={"source_id": sketch["id"], "control": "depth", "use_as_is": True,
                                                 "prompt": "a lighthouse"})
    assert "control_file" not in params_of(r.json()["items"][0]).params["control"]


def test_control_falls_back_to_qwen_edit(client, photo, monkeypatch):
    broken = info()
    del broken["QwenImageDiffsynthControlnet"]
    monkeypatch.setattr(get_settings(), "gen_driver", "comfy")
    monkeypatch.setattr(mc, "_cached_info", lambda: broken)
    r = client.post("/api/images/control", json={"source_id": photo["id"], "control": "pose", "prompt": "a knight",
                                                 "style": "fantasy"})
    assert r.status_code == 202, r.text
    assert "missing nodes" in r.json()["tool_fallback"] and r.json()["model_resolved"] == "qwen_image_edit_2511"
    g = params_of(r.json()["items"][0])
    assert "control" not in g.params and g.params["reference_ids"] == [photo["generation_id"]]
    assert g.prompt.startswith("Render a knight, high-fantasy scene") and "following the pose" in g.prompt
    r = client.post("/api/images/control", json={"source_id": photo["id"], "control": "pose", "prompt": "a knight",
                                                 "engine": "controlnet"})
    assert r.status_code == 422 and "missing nodes" in r.json()["detail"]


def test_control_switch_and_tools_listing(client, photo, monkeypatch):
    monkeypatch.setattr(get_settings(), "image_allow_noncommercial", False)
    r = client.post("/api/images/control", json={"source_id": photo["id"], "control": "hed", "prompt": "x"})
    assert r.status_code == 202 and "IMAGE_ALLOW_NONCOMMERCIAL" in r.json()["tool_fallback"]
    block = client.get("/api/images/tools").json()["control"]
    assert block["available"] and {t["id"] for t in block["types"]} == {"depth", "canny", "pose", "scribble"}
    assert block["strength"] == {"min": 0.65, "max": 1.0, "default": 0.8}
    r = client.post("/api/images/control", json={"source_id": photo["id"], "control": "hed", "prompt": "x",
                                                 "engine": "edit"})
    assert r.json()["tool_fallback"] == "the edit model was asked for"


def test_control_templates(client):
    rows = {t["id"]: t for t in client.get("/api/prompt-templates", params={"type": "image"}).json()}
    for tid, kind in (("image-control-depth", "depth"), ("image-control-sketch", "scribble"),
                      ("image-control-pose", "pose"), ("image-control-edges", "canny")):
        t = rows[tid]
        assert t["target"] == "image-control" and t["control"]["type"] == kind
        assert t["category"] == "Sketch, depth & pose"
        start = client.post(f"/api/prompt-templates/{tid}/start").json()
        p = start["prefill"]
        assert start["target"] == "image-control" and p["control"] == kind and len(p["placeholders"]) == 2
        assert ctl.STRENGTH_MIN <= p["strength"] <= ctl.STRENGTH_MAX and p["aspect"] == "source"
    assert rows["image-control-sketch"]["control"]["as_is"] is True
    assert client.post("/api/prompt-templates/image-control-sketch/start").json()["prefill"]["use_as_is"] is True


# ------------------------------------------------------------------ my templates

def test_user_templates_crud_and_start(client, photo):
    r = client.post("/api/my-templates", json={"title": "Product on marble", "prompt": "[product] on white marble",
                                               "style": "product", "aspect": "4:3", "count": 3, "negative": "text",
                                               "examples": {"product": "a perfume bottle", "other": "dropped"},
                                               "from_media_id": photo["id"]})
    assert r.status_code == 201, r.text
    mine = r.json()
    assert mine["mine"] and mine["category"] == "My templates" and mine["target"] == "image-generate"
    assert mine["examples"] == {"product": "a perfume bottle"} and mine["preview_url"]
    assert mine["defaults"]["prompt_scaffold"] == "[product] on white marble"

    listed = client.get("/api/prompt-templates", params={"type": "image"}).json()
    assert listed[0]["id"] == mine["id"]  # the workspace's own lead the image cards
    assert [t["id"] for t in client.get("/api/my-templates").json()] == [mine["id"]]
    video = client.get("/api/prompt-templates", params={"type": "video"}).json()
    assert mine["id"] not in {t["id"] for t in video}

    start = client.post(f"/api/prompt-templates/{mine['id']}/start").json()
    assert start["target"] == "image"
    p = start["prefill"]
    assert p["prompt"] == "[product] on white marble" and p["style"] == "product" and p["aspect"] == "4:3"
    assert p["count"] == 3 and p["negative"] == "text" and p["placeholders"] == ["product"] and p["mine"]

    r = client.patch(f"/api/my-templates/{mine['id']}", json={"title": "  Marble packshot "})
    assert r.status_code == 200 and r.json()["title"] == "Marble packshot"
    assert client.patch(f"/api/my-templates/{mine['id']}", json={"title": ""}).status_code == 422

    edit = client.post("/api/my-templates", json={"title": "Swap", "target": "edit", "ref_labels": ["Person", "Coat"],
                                                  "prompt": "Dress the person in image 1 in the coat from image 2",
                                                  "model": "qwen_image_edit_2511"}).json()
    start = client.post(f"/api/prompt-templates/{edit['id']}/start").json()
    assert start["target"] == "image-edit" and start["prefill"]["ref_labels"] == ["Person", "Coat"]
    assert start["prefill"]["instruction"].startswith("Dress the person")

    assert client.delete(f"/api/my-templates/{mine['id']}").status_code == 204
    assert client.post(f"/api/prompt-templates/{mine['id']}/start").status_code == 404
    assert client.delete(f"/api/my-templates/{mine['id']}").status_code == 404


def test_user_template_validation(client):
    bad = [
        {"title": "x", "prompt": "y", "style": "vaporwave"},
        {"title": "x", "prompt": "y", "model": "qwen_image_edit_2511"},
        {"title": "x", "prompt": "y", "target": "edit", "model": "zimage_turbo"},
        {"title": "x", "prompt": "y", "target": "edit", "style": "oil"},
        {"title": "x", "prompt": "y", "ref_labels": ["Person"]},
        {"title": "x", "prompt": "y", "count": 9},
        {"title": "", "prompt": "y"},
    ]
    for body in bad:
        assert client.post("/api/my-templates", json=body).status_code == 422, body


def test_user_templates_stay_in_their_workspace(client):
    tid = client.post("/api/my-templates", json={"title": "Mine", "prompt": "a [thing]"}).json()["id"]
    with SessionLocal() as db:
        other = Workspace(name="Other")
        db.add(other)
        db.flush()
        db.get(UserTemplate, tid).workspace_id = other.id
        db.commit()
    assert client.get("/api/my-templates").json() == []
    assert tid not in {t["id"] for t in client.get("/api/prompt-templates").json()}
    assert client.post(f"/api/prompt-templates/{tid}/start").status_code == 404
    assert client.patch(f"/api/my-templates/{tid}", json={"title": "Hijack"}).status_code == 404
    assert client.delete(f"/api/my-templates/{tid}").status_code == 404
