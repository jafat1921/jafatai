"""Photo Studio Restore and Cut-out (contract v10), on the mock driver."""
import io
import json

import numpy as np
import pytest
from PIL import Image

from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import plan_generation
from app.models import Generation, Job, MediaItem
from app.photo import cutout as co
from app.photo import restore as rs
from app.workflows import build
from app.worker import process_one

rng = np.random.default_rng(3)


def picture(h=300, w=400, grey=False, sepia=False, noise=0.0, alpha=False) -> np.ndarray:
    y = np.linspace(0, 1, h)[:, None]
    x = np.linspace(0, 1, w)[None, :]
    img = np.stack([0.2 + 0.6 * x * np.ones_like(y), 0.15 + 0.7 * y * np.ones_like(x),
                    0.5 + 0.3 * np.sin(5 * x + 2 * y)], axis=-1)
    img[h // 3:h // 2, w // 4:w // 2] = (0.9, 0.2, 0.15)
    if grey or sepia:
        g = img.mean(-1, keepdims=True)
        img = np.repeat(g, 3, -1) * ((1.0, 0.86, 0.66) if sepia else 1.0)
    if noise:
        img = img + rng.normal(0, noise, img.shape)
    out = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
    if alpha:
        a = np.full((h, w, 1), 255, np.uint8)
        a[:20] = 0
        out = np.concatenate([out, a], -1)
    return out


def upload(client, arr, name="photo.png", fmt="PNG", **kw) -> dict:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, fmt, **kw)
    mt = "image/jpeg" if fmt == "JPEG" else "image/png"
    r = client.post("/api/media/upload", files={"file": (name, buf.getvalue(), mt)})
    assert r.status_code == 201, r.text
    with SessionLocal() as db:
        gen = db.get(MediaItem, r.json()["id"]).generation_id
    return {"item": r.json()["id"], "gen": gen}


def run(fast_driver):
    while process_one(driver_factory=fast_driver):
        pass


def version(job_id: str) -> Generation:
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        g = db.get(Generation, job.generation_id)
        db.expunge(g)
        return g


def read(g: Generation) -> Image.Image:
    return Image.open(get_settings().data_dir / g.file_path)


# ------------------------------------------------------------------ catalogue

def test_tools_list_groups_and_licence(client, monkeypatch):
    tools = {t["id"]: t for t in client.get("/api/photo/tools").json()["tools"]}
    assert {"repair", "scratches", "jpeg", "denoise", "deblur", "faces", "colourise", "deyellow", "polish", "fix",
            "stylise", "cutout", "select", "background", "heavy"} <= set(tools)
    assert tools["heavy"]["available"] is False and "non-commercial" in tools["heavy"]["reason"]
    assert [v["id"] for v in tools["colourise"]["variants"]] == ["natural", "vivid"]
    assert tools["deyellow"]["gpu"] is False and tools["faces"]["gpu"] is True
    monkeypatch.setattr(get_settings(), "photo_allow_noncommercial", True)
    tools = {t["id"]: t for t in client.get("/api/photo/tools").json()["tools"]}
    assert tools["heavy"]["available"] is True


def test_tool_options_follow_the_servers_models():
    info = json.load(open(__file__.replace("test_photo_restore.py", "fixtures/object_info_photo.json")))
    tools = {t["id"]: t for t in rs.tool_options(info, driver="comfy")}
    assert tools["denoise"]["available"] and [v["id"] for v in tools["denoise"]["variants"]] == ["strong"]
    assert tools["denoise"]["default_variant"] == "strong"
    assert not tools["jpeg"]["available"] and "1x_fbcnn_color.pth" in tools["jpeg"]["reason"]
    assert not tools["faces"]["available"] and "FaceRestoreModelLoader" in tools["faces"]["reason"]
    unreachable = {t["id"]: t for t in rs.tool_options(None, driver="comfy", error="refused")}
    assert not unreachable["cutout"]["available"] and unreachable["deyellow"]["available"]


# ------------------------------------------------------------------ single tools

def test_denoise_version_keeps_size_alpha_and_blends(client, fast_driver):
    ids = upload(client, picture(alpha=True))
    r = client.post(f"/api/photo/{ids['item']}/restore", json={"tool": "denoise", "variant": "gentle",
                                                               "strength": 0.5})
    assert r.status_code == 202, r.text
    # the same request while queued is the same job
    assert client.post(f"/api/photo/{ids['item']}/restore",
                       json={"tool": "denoise", "variant": "gentle", "strength": 0.5}).json()["id"] == r.json()["id"]
    run(fast_driver)
    g = version(r.json()["id"])
    assert g.status == "ready" and g.parent_id == ids["gen"] and g.media_type == "image/png"
    assert g.params["restore"]["inputs"]["model"] == "1x_scunet_color_real_psnr.pth"
    im = read(g)
    assert im.size == (400, 300) and im.mode == "RGBA" and np.asarray(im)[0, 0, 3] == 0
    hist = client.get(f"/api/photo/{ids['item']}/history").json()
    assert hist["versions"][0]["edit"] == "restore" and hist["versions"][0]["restore"]["tool"] == "denoise"


def test_restore_validation(client):
    ids = upload(client, picture())
    post = lambda body: client.post(f"/api/photo/{ids['item']}/restore", json=body)  # noqa: E731
    assert post({"tool": "teleport"}).status_code == 422
    assert post({"tool": "colourise", "variant": "neon"}).status_code == 422
    assert "description" in post({"tool": "fix"}).json()["detail"]
    assert "non-commercial" in post({"tool": "heavy"}).json()["detail"]
    assert "Remove the background first" in post({"tool": "background", "prompt": "a beach"}).json()["detail"]
    assert "Type what to select" in post({"tool": "select"}).json()["detail"]
    assert post({"tool": "denoise", "strength": 0}).status_code == 422


def test_colourise_greys_sepia_first_and_sizes_by_megapixels(client, fast_driver):
    ids = upload(client, picture(sepia=True))
    r = client.post(f"/api/photo/{ids['item']}/restore", json={"tool": "colourise"})
    g = version(r.json()["id"])
    assert g.params["restore"]["grey_first"] is True and g.params["restore"]["inputs"]["model_size"] == 512
    assert rs.ddcolor_size(3000, 2000) == 1024 and rs.ddcolor_size(2000, 1200) == 768
    with SessionLocal() as db:
        src = rs.comfy_input(g.params["restore"], get_settings().data_dir / g.params["restore"]["source_file"])
    grey = np.asarray(Image.open(src).convert("RGB"))
    assert np.ptp(grey.astype(int), axis=-1).max() == 0 and grey.min() < 10 and grey.max() > 245
    run(fast_driver)
    assert not list((get_settings().data_dir / "tmp").glob(f"grey-{ids['gen']}-*.png"))


def test_repair_and_supir_process_capped_then_come_back_full_size(client, fast_driver, monkeypatch):
    monkeypatch.setattr(get_settings(), "image_upscale_max_mp", 0.05)
    ids = upload(client, picture(h=300, w=400))
    r = client.post(f"/api/photo/{ids['item']}/restore", json={"tool": "repair", "variant": "7b"})
    g = version(r.json()["id"])
    w, h = g.params["restore"]["proc"]
    assert w * h <= 50_000 and g.params["restore"]["inputs"]["model"].startswith("seedvr2_7b")
    run(fast_driver)
    assert read(version(r.json()["id"])).size == (400, 300)
    assert rs.proc_size(rs.TOOLS["heavy"], 4000, 3000) == (1408, 1024)


def test_prompted_fix_only_pastes_where_the_edit_changed(client, fast_driver):
    arr = picture(h=600, w=800)
    ids = upload(client, arr)
    r = client.post(f"/api/photo/{ids['item']}/restore", json={"tool": "fix", "prompt": "remove the red box"})
    g = version(r.json()["id"])
    assert "remove the red box" in g.params["restore"]["inputs"]["prompt"]
    assert g.params["restore"]["proc"][0] * g.params["restore"]["proc"][1] <= 1.1e6
    run(fast_driver)
    g = version(r.json()["id"])
    out = np.asarray(read(g).convert("RGB")).astype(int)
    assert out.shape == (600, 800, 3) and 0 < g.params["restore"]["changed"] < 0.2
    # far from the mock's patch the source's own pixels survive untouched
    assert np.abs(out[500:, 500:] - arr[500:, 500:].astype(int)).max() <= 1
    assert np.abs(out[100:150, 100:200] - arr[100:150, 100:200].astype(int)).max() > 60


def test_sam_points_become_source_pixels_and_unused_prompts_drop():
    assert json.loads(rs._points([{"x": 0.5, "y": 1.0}], (401, 301))) == [{"x": 200, "y": 300}]
    g, _ = build("photo_sam_mask", {"image": "a.png", "words": "the dog"})
    det = next(n for n in g.values() if n["class_type"] == "SAM3_Detect")
    assert "conditioning" in det["inputs"] and "positive_coords" not in det["inputs"]


def test_comfy_plan_for_restore_and_edit_tools(tmp_path):
    class Lookup:
        def generation_file(self, gid):
            return tmp_path / f"{gid}.png"

    p = plan_generation("image", "", {"restore": {"template": "photo_model_1x", "source_id": "s",
                                                 "inputs": {"model": "1x_fbcnn_color.pth"}, "tool": "jpeg"}}, 7, Lookup())
    assert p.template == "photo_model_1x" and p.images == {"image": tmp_path / "s.png"} and p.loras == []
    p = plan_generation("portrait", "", {"loras": [{"name": "x.safetensors", "strength": 1}],
                                         "restore": {"template": "qwen_edit", "source_id": "s", "tool": "fix",
                                                     "inputs": {"prompt": "p", "width": 1024, "height": 1024,
                                                                "template": "qwen_edit"}}}, 7, Lookup())
    assert p.template == "qwen_edit" and p.images == {"images": [tmp_path / "s.png"]} and p.loras == []
    assert "template" not in p.inputs


# ------------------------------------------------------------------ cut-out

def test_cutout_then_select_subtract_then_backgrounds(client, fast_driver):
    ids = upload(client, picture())
    r = client.post(f"/api/photo/{ids['item']}/restore", json={"tool": "cutout"})
    assert r.status_code == 202, r.text
    run(fast_driver)
    cut = version(r.json()["id"])
    im = read(cut)
    assert im.mode == "RGBA" and im.size == (400, 300)
    a = np.asarray(im)[..., 3]
    assert a[150, 200] == 255 and a[5, 5] == 0
    assert 0.2 < cut.params["cutout"]["coverage"] < 0.5
    assert client.get(f"/api/photo/{cut.id}/mask").status_code == 200
    assert client.get(f"/api/photo/{ids['gen']}/mask").status_code == 404

    # words + clicks, subtracted from the current mask: works on the original pixels, not the cut-out
    r = client.post(f"/api/photo/{cut.id}/restore", json={"tool": "select", "words": "the hat", "op": "subtract",
                                                         "include": [{"x": 0.5, "y": 0.2}]})
    assert r.status_code == 202, r.text
    sel = version(r.json()["id"])
    assert sel.params["restore"]["source_id"] == ids["gen"] and sel.params["cutout"]["op"] == "subtract"
    run(fast_driver)
    sel = version(r.json()["id"])
    assert np.asarray(read(sel))[150, 200, 3] == 0  # the same oval taken away leaves nothing

    r = client.post(f"/api/photo/{cut.id}/background", json={"background": {"type": "colour", "colour": "#204060"},
                                                            "edge": {"feather": 0, "shift": 0}})
    assert r.status_code == 202, r.text
    run(fast_driver)
    bg = version(r.json()["id"])
    px = np.asarray(read(bg))
    assert read(bg).mode == "RGB" and tuple(px[5, 5]) == (32, 64, 96)
    assert bg.params["cutout"]["coverage"] == cut.params["cutout"]["coverage"]
    assert client.get(f"/api/photo/{bg.id}/history").json()["versions"][0]["cutout"]["background"]["type"] == "colour"

    r = client.post(f"/api/photo/{bg.id}/background", json={"background": {"type": "blur", "radius": 10}})
    run(fast_driver)
    assert read(version(r.json()["id"])).mode == "RGB"
    assert client.post(f"/api/photo/{ids['gen']}/background", json={"background": {"type": "blur"}}).status_code == 422
    assert client.post(f"/api/photo/{cut.id}/background",
                       json={"background": {"type": "colour", "colour": "teal"}}).status_code == 422


def test_prompted_background_keeps_the_subject_pixels(client, fast_driver):
    arr = picture()
    ids = upload(client, arr)
    r = client.post(f"/api/photo/{ids['item']}/restore", json={"tool": "cutout"})
    run(fast_driver)
    cut = version(r.json()["id"])
    r = client.post(f"/api/photo/{cut.id}/restore", json={"tool": "background", "prompt": "a sunny beach",
                                                         "edge": {"feather": 0}})
    assert r.status_code == 202, r.text
    run(fast_driver)
    g = version(r.json()["id"])
    assert g.params["cutout"]["background"]["file"] and g.params["cutout"]["mask_file"] == cut.params["cutout"]["mask_file"]
    out = np.asarray(read(g).convert("RGB")).astype(int)
    assert np.abs(out[150, 200] - arr[150, 200].astype(int)).max() <= 1


def test_mask_ops_and_edges():
    a = Image.new("L", (10, 10), 0)
    a.paste(255, (0, 0, 5, 10))
    b = Image.new("L", (10, 10), 0)
    b.paste(255, (3, 0, 8, 10))
    assert np.asarray(co.combine(a, b, "add"))[:, :8].min() == 255
    assert np.asarray(co.combine(a, b, "subtract"))[:, 3:].max() == 0
    assert np.asarray(co.refine_edge(a, shift=2))[:, 6].min() == 255
    assert np.asarray(co.refine_edge(a, shift=-2))[:, 3].max() == 0
    with pytest.raises(ValueError):
        co.parse_colour("red")


# ------------------------------------------------------------------ Smart Restore

def test_smart_plan_for_an_old_sepia_print(client):
    ids = upload(client, picture(sepia=True, noise=0.0))
    plan = client.get(f"/api/photo/{ids['item']}/smart-plan").json()
    tools = [s["tool"] for s in plan["steps"]]
    assert plan["analysis"]["is_monotone"] or plan["analysis"]["is_grayscale"]
    assert "colourise" in tools and tools[-1] == "polish"
    # landscape-shaped (400x300 is 1.33) gets the vivid model, like NoorViz
    assert next(s for s in plan["steps"] if s["tool"] == "colourise")["variant"] == "vivid"
    assert all("reason" in s and "est_gpu_s" in s for s in plan["steps"])


def test_smart_plan_on_a_clean_photo_says_so(client):
    ids = upload(client, picture())
    plan = client.get(f"/api/photo/{ids['item']}/smart-plan").json()
    assert plan["analysis"]["is_monotone"] is False and "colourise" not in [s["tool"] for s in plan["steps"]]
    if not plan["steps"]:
        assert "clean already" in plan["message"]
    assert rs.noise_sigma(picture(noise=0.05)) > rs.noise_sigma(picture()) + 3


def test_smart_restore_chains_one_version_per_step_and_survives_a_failure(client, fast_driver):
    ids = upload(client, picture(grey=True, h=320, w=240))
    steps = [{"tool": "denoise"}, {"tool": "colourise", "variant": "natural"}, {"tool": "faces", "on": False},
             {"tool": "deyellow", "strength": 0.5}, {"tool": "polish", "strength": 0.5}]
    r = client.post(f"/api/photo/{ids['item']}/smart-restore", json={"steps": steps})
    assert r.status_code == 202, r.text
    out = r.json()
    assert [s["tool"] for s in out["steps"]] == ["denoise", "colourise", "deyellow", "polish"]

    # make step 2 fail: the chain must carry on from step 1's version
    import app.drivers.mock as mock

    real = mock.MockDriver._restore
    calls = []

    def flaky(self, r, out_path, cb):
        calls.append(r["tool"])
        if r["tool"] == "colourise":
            raise RuntimeError("CUDA out of memory")
        return real(self, r, out_path, cb)

    mock.MockDriver._restore = flaky
    try:
        run(fast_driver)
    finally:
        mock.MockDriver._restore = real
    assert calls == ["denoise", "colourise"]
    with SessionLocal() as db:
        line = db.query(Generation).filter(Generation.target_id == ids["item"]).order_by(Generation.version).all()
        by = {(g.params or {}).get("chain", {}).get("index"): g for g in line if (g.params or {}).get("chain")}
        assert by[0].status == "ready" and by[1].status == "failed"
        assert by[2].parent_id == by[0].id and by[2].params["effect"]["name"] == "deyellow"
        assert by[3].parent_id == by[2].id and by[3].status == "ready"
        assert by[3].params["chain"]["id"] == out["chain_id"]
    hist = client.get(f"/api/photo/{ids['item']}/history").json()
    assert hist["versions"][0]["chain"]["index"] == 3


def test_smart_restore_rejects_cutout_and_empty_plans(client):
    ids = upload(client, picture())
    post = lambda steps: client.post(f"/api/photo/{ids['item']}/smart-restore", json={"steps": steps})  # noqa: E731
    assert post([{"tool": "cutout"}]).status_code == 422
    assert post([{"tool": "faces", "on": False}]).status_code == 422


# ------------------------------------------------------------------ describe

def test_describe_uses_the_vision_model(client, monkeypatch):
    from app import llm

    class Res:
        def __init__(self, data):
            self.data = data

    def fake(role, msgs, schema=None, **kw):
        assert role == "vision" and msgs[1]["images"]
        return Res(schema(caption=" A family on a porch. ", details="1950s print.", defects=["crease", "fading"],
                          suggested_tools=["scratches", "teleport", "colourise"]))

    monkeypatch.setattr(llm, "chat_sync", fake)
    ids = upload(client, picture())
    d = client.post(f"/api/photo/{ids['item']}/describe").json()
    assert d["caption"] == "A family on a porch." and d["suggested_tools"] == ["scratches", "colourise"]
