"""3D Studio part 1 (M20, contract v40): the UI-to-API converter, the image-to-3D template, the make_3d route,
the GLB in ComfyUI history, packages, MCP and isolation."""
import importlib.util
import io
import json
import struct
from pathlib import Path

import httpx
import pytest
from PIL import Image
from sqlalchemy import select

from app import model3d as m3
from app import models_catalog as mc
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import ComfyDriver, plan_generation
from app.drivers.comfy_client import ComfyClient, parse_outputs
from app.lanes import lane_for
from app.models import Generation, Job, MediaItem
from app.workflows import TEMPLATE_DIR, build, check_template, load
from app.worker import process_one
from tests.test_accounts import PW, make_user
from tests.test_api_tokens import _mint, flags, login  # noqa: F401  (fixtures)
from tests.test_library import png_bytes, upload
from tests.test_mcp import Mcp

FIX = Path(__file__).parent / "fixtures"
REPO = Path(__file__).resolve().parents[2]
TPL = m3.TEMPLATE


def _converter():
    spec = importlib.util.spec_from_file_location("comfy_ui_to_api", REPO / "scripts" / "comfy_ui_to_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _info() -> dict:
    return json.loads((FIX / "comfy_object_info.json").read_text())


def _titled(graph: dict) -> dict:
    return {n["_meta"]["title"]: n for n in graph.values()}


def _glb_ok(data: bytes) -> bool:
    magic, version, length = struct.unpack("<4sII", data[:12])
    return magic == b"glTF" and version == 2 and length == len(data)


def _photo(client, transparent=False) -> dict:
    buf = io.BytesIO()
    if transparent:
        im = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
        im.paste((180, 90, 40, 255), (64, 64, 192, 192))
        im.save(buf, "PNG")
    else:
        buf.write(png_bytes((256, 256)))
    r = upload(client, "teapot.png", buf.getvalue(), "image/png", title="Teapot")
    assert r.status_code == 201, r.text
    return r.json()


def _drain(fast_driver):
    while process_one(driver_factory=fast_driver):
        pass


# ---------------------------------------------------------------- the converter

def test_converter_reproduces_the_committed_template():
    conv = _converter()
    manifest = json.loads((TEMPLATE_DIR / TPL / "manifest.json").read_text())
    src = manifest["source"]
    ui = json.loads((REPO / "backend" / src["ui"]).read_text())
    info = json.loads((FIX / "object_info_3d.json").read_text())
    graph = conv.convert(ui, info, src["output"], titles={int(k): v for k, v in src["titles"].items()})
    assert graph == json.loads((TEMPLATE_DIR / TPL / "workflow.json").read_text())

    assert len(graph) == 46 and len(ui["nodes"]) == 66
    classes = {n["class_type"] for n in graph.values()}
    assert not classes & {"PreviewImage", "MaskPreview", "Note", "MarkdownNote", "Preview3DAdvanced",
                          "PrimitiveInt", "PrimitiveBoolean"}
    # nothing the save doesn't need: the voxel preview, the painted-mesh preview and the UV atlas went
    assert not classes & {"VoxelToMesh", "PaintMesh", "RenderUVAtlas"}
    t = _titled(graph)
    # the 4096 PrimitiveInt was inlined into both inputs it fed
    assert t["Bake texture"]["inputs"]["texture_size"] == 4096 and t["Unwrap"]["inputs"]["resolution"] == 4096
    # pass-through previews are wired around: the bake feeds the textures, the crop feeds the conditioning
    assert t["Apply textures"]["inputs"]["base_color"] == ["147", 0]
    assert t["Apply textures"]["inputs"]["normal_map"] == ["224", 0]
    assert t["Pixal3D conditioning"]["inputs"]["image"] == ["312", 0]
    assert t["Crop to subject"]["inputs"]["masks"] == ["248", 0]
    # an INT the old frontend saved as "1536"; a widget newer than the export gets the server default
    assert t["Upsample"]["inputs"]["target_resolution"] == 1536
    assert t["MoGe"]["inputs"]["refine_steps"] == 3
    assert t["Remesh"]["inputs"]["sign_mode.qef"] is False
    assert t["Load Image"]["inputs"] == {"image": "viking_wolf_rune_axe.png"}
    assert t["Sampler: structure"]["inputs"]["seed"] == 56 and "control_after_generate" not in t["Sampler: structure"]["inputs"]
    assert t["Switch: model"]["inputs"] == {"switch": False, "on_false": ["319", 0], "on_true": ["40", 0]}
    # duplicate class names become unique titles
    assert {"RescaleCFG 125", "RescaleCFG 126", "CFGOverride 199", "CFGOverride 279"} <= set(t)


def test_converter_inlines_switches_bypass_and_unnamed_widgets():
    conv = _converter()
    ui = {
        "nodes": [
            {"id": 1, "type": "LoadImage", "mode": 0, "inputs": [], "widgets_values": ["a.png", "image"],
             "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [1]}]},
            {"id": 2, "type": "Blur", "mode": 4, "inputs": [{"name": "image", "type": "IMAGE", "link": 1}],
             "widgets_values": [3], "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [2]}]},
            {"id": 3, "type": "Sharpen", "mode": 2, "inputs": [], "widgets_values": [],
             "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [3]}]},
            {"id": 4, "type": "PrimitiveBoolean", "mode": 0, "inputs": [], "widgets_values": [True],
             "outputs": [{"name": "BOOLEAN", "type": "BOOLEAN", "links": [4]}]},
            {"id": 5, "type": "ComfySwitchNode", "mode": 0, "widgets_values": [False],
             "inputs": [{"name": "on_false", "type": "IMAGE", "link": 3}, {"name": "on_true", "type": "IMAGE", "link": 2},
                        {"name": "switch", "type": "BOOLEAN", "link": 4, "widget": {"name": "switch"}}],
             "outputs": [{"name": "output", "type": "IMAGE", "links": [5]}]},
            {"id": 6, "type": "KSamplerish", "mode": 0, "inputs": [{"name": "image", "type": "IMAGE", "link": 5}],
             "widgets_values": [7, "randomize", 20], "outputs": []},
            {"id": 7, "type": "SaveImage", "mode": 0, "inputs": [{"name": "images", "type": "IMAGE", "link": 6}],
             "widgets_values": ["out"], "outputs": []},
        ],
        "links": [[1, 1, 0, 2, 0, "IMAGE"], [2, 2, 0, 5, 1, "IMAGE"], [3, 3, 0, 5, 0, "IMAGE"],
                  [4, 4, 0, 5, 2, "BOOLEAN"], [5, 5, 0, 6, 0, "IMAGE"], [6, 1, 0, 7, 0, "IMAGE"]],
    }
    info = {
        "LoadImage": {"input": {"required": {"image": [["a.png"], {"image_upload": True}]}},
                      "input_order": {"required": ["image"]}},
        "KSamplerish": {"input": {"required": {"image": ["IMAGE", {}], "seed": ["INT", {}], "steps": ["INT", {}],
                                               "cfg": ["FLOAT", {"default": 4.5}]}},
                        "input_order": {"required": ["image", "seed", "steps", "cfg"]}},
        "SaveImage": {"input": {"required": {"images": ["IMAGE", {}], "filename_prefix": ["STRING", {}]}},
                      "input_order": {"required": ["images", "filename_prefix"]}, "output_node": True},
    }
    g = conv.convert(ui, info, [6, 7], inline_switches=True)
    assert set(g) == {"1", "6", "7"}
    # switch on (from the primitive) -> on_true -> the bypassed blur -> straight to the image
    assert g["6"]["inputs"] == {"seed": 7, "steps": 20, "cfg": 4.5, "image": ["1", 0]}
    assert g["1"]["inputs"] == {"image": "a.png"}
    with pytest.raises(conv.ConvertError):
        conv.convert(ui, None, [6])  # unnamed widgets need /object_info


# ---------------------------------------------------------------- the template

def test_template_passes_check_and_engines_are_features():
    res = check_template(TPL, _info())
    assert res["ok"], res
    assert res["features"] == {"pixal3d": {"ok": True, "problems": []}, "trellis2": {"ok": True, "problems": []}}

    info = _info()
    info["UNETLoader"]["input"]["required"]["unet_name"][0].remove("pixal3d_int8_convrot.safetensors")
    res = check_template(TPL, info)
    assert res["ok"] and not res["features"]["pixal3d"]["ok"] and res["features"]["trellis2"]["ok"]
    av = mc.availability(mc.MODELS["pixal3d"], info)
    assert not av["available"] and "pixal3d_int8" in av["reason"]
    assert mc.availability(mc.MODELS["trellis2"], info)["available"]

    del info["Trellis2ShapeStage"]
    assert check_template(TPL, info)["missing_nodes"] == ["Trellis2ShapeStage"]


def test_merged_fixture_matches_the_3d_dump():
    # comfy_object_info.json carries the 3D nodes copied verbatim; only MoGe's file list was filled in by hand
    dump = json.loads((FIX / "object_info_3d.json").read_text())
    info = _info()
    classes = {n["class_type"] for n in load(TPL).graph.values()}
    for cls in classes & set(dump):
        if cls != "LoadMoGeModel":
            assert info[cls]["input"] == dump[cls]["input"], cls
    assert info["LoadMoGeModel"]["input"]["required"]["model_name"][1]["options"] == \
        ["moge_2_vitl_normal_fp16.safetensors"]


def test_build_resolves_the_switches_and_prunes_the_other_engine():
    g, res = build(TPL, {"image": "in.png", **m3.inputs_for({"engine": "pixal3d", "quality": "final"}, 9)})
    t = _titled(g)
    ids = {n["_meta"]["title"]: k for k, n in g.items()}
    assert not any(n["class_type"] == "ComfySwitchNode" for n in g.values())
    assert {"Model Pixal3D", "MoGe", "Field of view"} <= set(t) and "Model TRELLIS.2" not in t
    assert "TRELLIS.2 conditioning" not in t
    assert t["Sampler: structure"]["inputs"]["positive"] == [ids["Pixal3D conditioning"], 0]
    assert t["Sampler: structure"]["inputs"]["negative"] == [ids["Pixal3D conditioning"], 1]
    assert t["CFGOverride 199"]["inputs"]["model"] == [ids["Model Pixal3D"], 0]
    assert t["Crop to subject"]["inputs"]["masks"] == [ids["Remove background"], 0]
    assert t["Crop to subject"]["inputs"]["pad_factor"] == 1.1
    assert {t[s]["inputs"]["seed"] for s in ("Sampler: structure", "Sampler: shape", "Sampler: upsample",
                                             "Sampler: texture")} == {9}
    assert (t["Upsample"]["inputs"]["target_resolution"], t["Bake texture"]["inputs"]["texture_size"],
            t["Decimate"]["inputs"]["target_face_count"]) == (1536, 4096, 700_000)
    assert res["trellis2"] is False and res["remove_background"] is True

    g, res = build(TPL, {"image": "in.png", **m3.inputs_for(
        {"engine": "trellis2", "quality": "draft", "remove_background": False}, 9)})
    t = _titled(g)
    assert "Model TRELLIS.2" in t and not {"Model Pixal3D", "MoGe", "MoGe model", "Pixal3D conditioning"} & set(t)
    # the background stays: the crop uses the picture's own alpha and BiRefNet is pruned away
    load_id = next(k for k, n in g.items() if n["_meta"]["title"] == "Load Image")
    assert t["Crop to subject"]["inputs"]["masks"] == [load_id, 1] and "Remove background" not in t
    assert t["Crop to subject"]["inputs"]["pad_factor"] == 1.0
    assert (t["Upsample"]["inputs"]["target_resolution"], t["Bake texture"]["inputs"]["texture_size"],
            t["Unwrap"]["inputs"]["resolution"], t["Decimate"]["inputs"]["target_face_count"],
            t["Bake normals"]["inputs"]["resolution"]) == (1024, 2048, 2048, 200_000, 1024)
    assert check_template(TPL, _info())["ok"]


# ---------------------------------------------------------------- history and the driver

def test_parse_outputs_finds_the_glb_whatever_the_key():
    entry = {"outputs": {
        "9": {"images": [{"filename": "a.png", "subfolder": "", "type": "output"}]},
        "322": {"result": ["mixai/g1_00001_.glb [output]", {"position": [0, 0, 1]}, None]},
        "40": {"3d": [{"filename": "x_00001_.glb", "subfolder": "3d", "type": "output"}]},
        "41": {"3d": [{"filename": "p.glb", "subfolder": "", "type": "temp"}]},
        "42": {"model_file": "3d\\y_00001_.glb"},
    }}
    outs = {(o.node_id, o.subfolder, o.filename, o.type, o.kind) for o in parse_outputs(entry)}
    assert ("322", "mixai", "g1_00001_.glb", "output", "model") in outs
    assert ("40", "3d", "x_00001_.glb", "output", "model") in outs
    assert ("42", "3d", "y_00001_.glb", "output", "model") in outs
    assert ("9", "", "a.png", "output", "image") in outs
    assert not any(o[2] == "p.glb" for o in outs)


class FakeLookup:
    def __init__(self, tmp_path: Path):
        self.tmp = tmp_path

    def generation_file(self, gen_id):
        p = self.tmp / f"{gen_id}.png"
        p.write_bytes(png_bytes((64, 64)))
        return p


def test_plan_for_a_model():
    lk = FakeLookup(get_settings().data_dir)
    p = plan_generation("model3d", "", {"model3d": {"engine": "trellis2", "quality": "draft", "source_id": "s1"}},
                        5, lk)
    assert p.template == TPL and p.media == "model" and p.images["image"].name == "s1.png"
    assert p.inputs["trellis2"] is True and p.inputs["texture_size"] == 2048 and p.inputs["seed"] == 5
    assert p.sources == {"source_id": "s1", "engine": "trellis2", "quality": "draft"}


GLB = b"glTF\x02\x00\x00\x00\x0c\x00\x00\x00"


class GlbClient(ComfyClient):
    def __init__(self):
        def server(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/upload/image":
                return httpx.Response(200, json={"name": "src.png", "subfolder": "", "type": "input"})
            if request.url.path == "/view":
                self.viewed.append(dict(request.url.params))
                return httpx.Response(200, content=GLB)
            return httpx.Response(404)

        super().__init__("http://comfy.test", transport=httpx.MockTransport(server), websocket=False)
        self.graphs, self.viewed = [], []

    async def run(self, graph, on_progress=None, timeout=0, weights=None):
        self.graphs.append(graph)
        save = next(k for k, n in graph.items() if n["_meta"]["title"] == "Save 3D")
        prefix = graph[save]["inputs"]["filename_prefix"]
        return "p1", {"outputs": {save: {"result": [f"{prefix}_00001_.glb [output]", None]}},
                      "status": {"status_str": "success", "messages": []}}


def test_worker_runs_a_model_through_the_comfy_driver(client, tmp_path):
    src = _photo(client)
    made = []

    async def factory():
        c = GlbClient()
        made.append(c)
        return c

    r = client.post("/api/3d/make", json={"source_id": src["id"], "engine": "pixal3d", "quality": "draft", "seed": 77})
    assert r.status_code == 202, r.text
    assert process_one(driver_factory=lambda: ComfyDriver(client_factory=factory, lookup=FakeLookup(tmp_path)))
    gen_id = r.json()["item"]["generation_id"]
    with SessionLocal() as db:
        g = db.get(Generation, gen_id)
        assert g.status == "ready" and g.file_path.endswith(".glb") and g.media_type == "model/gltf-binary"
        assert g.params["comfy"]["template"] == TPL and g.params["comfy"]["sources"]["engine"] == "pixal3d"
        assert (get_settings().data_dir / g.file_path).read_bytes() == GLB
    graph = made[0].graphs[0]
    assert _titled(graph)["Save 3D"]["inputs"]["filename_prefix"] == f"mixai/{gen_id}"
    assert made[0].viewed == [{"filename": f"{gen_id}_00001_.glb", "subfolder": "mixai", "type": "output"}]


# ---------------------------------------------------------------- the studio route, mock driver

def test_make_3d_from_a_library_picture(client, fast_driver):
    src = _photo(client)
    r = client.post("/api/3d/make", json={"source_id": src["id"], "quality": "draft"})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["model_resolved"] == "pixal3d" and out["item"]["kind"] == "model"
    assert out["item"]["title"] == "Teapot · 3D" and out["job"]["status"] == "queued"
    with SessionLocal() as db:
        job = db.get(Job, out["job"]["id"])
        g = db.get(Generation, job.generation_id)
        assert job.lane == "image" and g.kind == "model3d"
        assert g.params["model3d"] == {"engine": "pixal3d", "quality": "draft", "remove_background": True,
                                       "source_id": src["generation_id"], "source_media_id": src["id"]}
        assert g.params["model_resolved"] == "pixal3d"

    _drain(fast_driver)
    item = client.get(f"/api/media/{out['item']['id']}").json()
    assert item["status"] == "ready" and item["media_type"] == "model/gltf-binary"
    assert item["media_url"].endswith(".glb") and item["thumb_url"]
    f = client.get(item["media_url"])
    assert f.status_code == 200 and f.headers["content-type"] == "model/gltf-binary" and _glb_ok(f.content)
    thumb = client.get(item["thumb_url"])
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/webp"

    models = client.get("/api/media?kind=model").json()["items"]
    assert [m["id"] for m in models] == [out["item"]["id"]]
    assert out["item"]["id"] not in {m["id"] for m in client.get("/api/media").json()["items"]}

    # a model isn't a picture, so it can't be the source of another
    r = client.post("/api/3d/make", json={"source_id": out["item"]["id"]})
    assert r.status_code == 422
    assert client.post("/api/3d/make", json={"source_id": src["id"], "engine": "nope"}).status_code == 422


def test_thumbs_come_back_after_they_are_deleted(client, fast_driver):
    src = _photo(client)
    out = client.post("/api/3d/make", json={"source_id": src["id"]}).json()
    _drain(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, out["item"]["generation_id"])
        glb = get_settings().data_dir / g.file_path
    thumbs = sorted(glb.parent.glob(f"{glb.stem}.thumb*.webp"))
    assert len(thumbs) == 2
    for t in thumbs:
        t.unlink()
    assert client.get(f"/api/media/thumb/{g.id}?w=256").status_code == 200


def test_keeping_the_background_needs_a_transparent_picture(client):
    flat = _photo(client)
    out = client.post("/api/3d/make", json={"source_id": flat["id"], "remove_background": False}).json()
    assert out["background_note"] and "removed anyway" in out["background_note"]
    see_through = _photo(client, transparent=True)
    out2 = client.post("/api/3d/make", json={"source_id": see_through["id"], "remove_background": False,
                                             "engine": "trellis2"}).json()
    assert out2["background_note"] is None
    with SessionLocal() as db:
        recs = {g.params["model3d"]["source_media_id"]: g.params["model3d"]
                for g in db.scalars(select(Generation).where(Generation.kind == "model3d"))}
    assert recs[flat["id"]]["remove_background"] is True
    assert recs[see_through["id"]]["remove_background"] is False and recs[see_through["id"]]["engine"] == "trellis2"


def test_options_estimate_catalog_and_lane(client):
    opts = client.get("/api/3d/options").json()
    assert [e["id"] for e in opts["engines"]] == ["pixal3d", "trellis2"]
    assert [q["id"] for q in opts["qualities"]] == ["draft", "final"]
    assert "licence" not in json.dumps(opts).lower()

    rows = client.get("/api/models?type=model3d").json()
    assert [m["id"] for m in rows] == ["pixal3d", "trellis2"] and rows[0]["default"]
    assert "licence" not in json.dumps(rows).lower()

    draft = client.get("/api/estimate?kind=model3d&model=pixal3d&speed=draft").json()
    final = client.get("/api/estimate?kind=model3d&model=pixal3d&speed=final").json()
    assert draft["basis"] == "rough" and draft["high_s"] < final["high_s"]
    assert client.get("/api/estimate?kind=model3d&model=zimage_turbo").status_code == 422
    assert lane_for("generate", "model3d") == "image"


def test_package_feature_and_model_gates(client, login):  # noqa: F811
    uid = make_user()
    ben = login({"email": "ben@example.com", "password": PW})
    src = _photo(ben)
    pid = client.post("/api/admin/packages", json={"name": "No 3D", "features": {"3d": False}}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    r = ben.post("/api/3d/make", json={"source_id": src["id"]})
    assert r.status_code == 403 and "3D Studio" in r.json()["detail"]
    assert ben.get("/api/account/usage").json()["features"]["3d"] is False

    pid = client.post("/api/admin/packages", json={"name": "TRELLIS only", "models": ["trellis2"]}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    r = ben.post("/api/3d/make", json={"source_id": src["id"], "engine": "pixal3d"})
    assert r.status_code == 403 and "pixal3d" in r.json()["detail"]
    assert ben.post("/api/3d/make", json={"source_id": src["id"], "engine": "trellis2"}).status_code == 202
    with SessionLocal() as db:
        assert db.scalars(select(MediaItem).where(MediaItem.kind == "model")).all()[0].title == "Teapot · 3D"


def test_mcp_make_3d_model(client, anon, fast_driver):
    src = _photo(client)
    m = Mcp(anon, _mint(client, ["read", "generate"])["token"])
    out = m.call_json("make_3d_model", image_id=src["id"], engine="trellis2", quality="draft")
    assert out["model"] == "trellis2" and out["items"][0]["kind"] == "model" and len(out["jobs"]) == 1
    _drain(fast_driver)
    done = m.call_json("wait_for_job", job_id=out["jobs"][0]["job_id"], timeout_s=5)
    assert done["status"] == "done" and done["media_type"] == "model/gltf-binary"
    r = anon.get(done["download_url"].removeprefix("http://testserver"))
    assert r.status_code == 200 and _glb_ok(r.content)
    found = m.call_json("search_library", kind="model")
    assert [i["media_id"] for i in found["items"]] == [out["items"][0]["media_id"]]
    bad = m.call("make_3d_model", image_id="nope")
    assert bad["isError"]


def test_another_studio_cannot_use_or_see_it(client, login, fast_driver):  # noqa: F811
    src = _photo(client)
    out = client.post("/api/3d/make", json={"source_id": src["id"]}).json()
    _drain(fast_driver)
    make_user("bea@example.com", "Bea")
    bea = login({"email": "bea@example.com", "password": PW})
    assert bea.post("/api/3d/make", json={"source_id": src["id"]}).status_code == 404
    assert bea.post("/api/3d/make", json={"source_id": src["generation_id"]}).status_code == 404
    assert bea.get(f"/api/media/{out['item']['id']}").status_code == 404
    assert bea.get("/api/media?kind=model").json()["items"] == []
    assert bea.get(f"/api/media/thumb/{out['item']['generation_id']}").status_code == 404
    item = client.get(f"/api/media/{out['item']['id']}").json()
    assert bea.get(item["media_url"]).status_code == 404
