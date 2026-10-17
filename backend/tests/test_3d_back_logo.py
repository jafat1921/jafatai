"""3D Studio addendum (M20, contract v40 §8): better back (side and back views made first, then the four-view
graph) and the logo start (traced, extruded and bevelled on the CPU, written as a GLB)."""
import io
import json
import struct

import numpy as np
from PIL import Image, ImageDraw
from sqlalchemy import select

from app import model3d as m3
from app import model3d_logo as ml
from app import models_catalog as mc
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import ANGLES_LORA, plan_generation
from app.lanes import lane_for
from app.models import Generation, Job, MediaItem
from tests.test_3d import FakeLookup, _drain, _glb_ok, _photo
from tests.test_3d_starts import _character, _panel, _rec
from tests.test_accounts import PW, make_user
from tests.test_api_tokens import _mint, flags, login  # noqa: F401  (fixtures)
from tests.test_library import upload
from tests.test_mcp import Mcp


def _gen(gen_id: str) -> Generation:
    with SessionLocal() as db:
        g = db.get(Generation, gen_id)
        db.expunge(g)
        return g


def _fail(job_id: str, gen_id: str, why="out of memory"):
    with SessionLocal() as db:
        j = db.get(Job, job_id)
        j.status, j.error = "failed", why
        db.get(Generation, gen_id).status = "failed"
        db.commit()


# ---------------------------------------------------------------- better back

def test_better_back_makes_side_and_back_views_then_the_four_view_model(client, fast_driver):
    src = _photo(client)
    r = client.post("/api/3d/make", json={"source_id": src["id"], "better_back": True, "engine": "trellis2",
                                          "remove_background": False, "quality": "draft"})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["better_back"] is True and out["model_resolved"] == "pixal3d" and "Pixal3D" in out["engine_note"]
    assert out["background_note"] == ("The side and back views are made on a plain background, so the backgrounds "
                                      "were removed.")
    side, back = out["back_views"]
    assert side["home"] == back["home"] == "3d" and side["kind"] == "image"
    assert side["title"] == "Teapot · 3D · side view" and back["title"] == "Teapot · 3D · back view"
    assert [j["status"] for j in out["back_jobs"]] == ["queued", "queued"]

    for item, view in ((side, "side"), (back, "back")):
        g = _gen(item["generation_id"])
        assert g.kind == "sheet_view" and g.target_type == "media" and g.prompt == ""
        assert g.params["view"] == view and g.params["angles_lora"] == 1.0
        assert g.params["reference_ids"] == [src["generation_id"]]
        assert g.params["model_resolved"] == g.params["edit_model"] == m3.BACK_EDIT_MODEL
        assert g.params["created_by"]["flow"] == "make_3d:better_back"
        # the same edit the Character Studio turnaround runs: Qwen edit with the angles LoRA, the view's own words
        plan = plan_generation("sheet_view", g.prompt, g.params, 3, FakeLookup(get_settings().data_dir))
        assert plan.template == mc.MODELS[m3.BACK_EDIT_MODEL].template and plan.loras[0] == (ANGLES_LORA, 1.0)
        assert plan.inputs["view"] == view
        assert "Show the same character from a new camera angle" in plan.inputs["prompt"]

    rec = _rec(out["item"]["generation_id"])["model3d"]
    assert rec["better_back"] == {"status": "pending", "views": {
        "left": {"generation_id": side["generation_id"], "media_id": side["id"]},
        "back": {"generation_id": back["generation_id"], "media_id": back["id"]}}}
    assert rec["remove_background"] is True and rec["measure_fov"] is True and "views" not in rec
    with SessionLocal() as db:
        db.get(Job, out["job"]["id"]).priority = 5  # the model's job goes first, so it has to wait
        db.commit()

    from app.worker import process_one

    assert process_one(driver_factory=fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, out["job"]["id"])
        assert job.status == "queued" and job.message == "Making the side and back views first"
        assert sorted(job.result["waiting_on"]) == sorted(j["id"] for j in out["back_jobs"])

    _drain(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, out["item"]["generation_id"])
        assert g.status == "ready" and db.get(Job, g.job_id).result["template"] == m3.MULTIVIEW_TEMPLATE
        rec = g.params["model3d"]
        assert rec["views"] == {"front": src["generation_id"], "left": side["generation_id"],
                                "back": back["generation_id"]}
        assert rec["view_media"] == {"front": src["id"], "left": side["id"], "back": back["id"]}
        assert rec["better_back"]["status"] == "done" and "better_back_note" not in rec
        assert rec["source_id"] == src["generation_id"]
    # the views are working parts: in the 3D Studio's own list, not the Library grid
    grid = {i["id"] for i in client.get("/api/media").json()["items"]}
    assert side["id"] not in grid and side["id"] in {i["id"] for i in client.get("/api/media?home=3d").json()["items"]}
    assert client.get(f"/api/media/{out['item']['id']}").json()["thumb_url"]


def test_better_back_defaults(client):
    src = _photo(client)
    out = client.post("/api/3d/make", json={"source_id": src["id"]}).json()
    assert out["better_back"] is False and out["back_views"] is None
    assert "better_back" not in _rec(out["item"]["generation_id"])["model3d"]

    # a character with no turnaround gets it unless it's turned off
    c = _character(client)
    _panel(c["id"], "portrait")
    out = client.post("/api/3d/make", json={"character_id": c["id"]}).json()
    assert out["better_back"] is True and len(out["back_views"]) == 2
    rec = _rec(out["item"]["generation_id"])["model3d"]
    assert rec["measure_fov"] is False  # a character's picture is a render, not a photo
    off = client.post("/api/3d/make", json={"character_id": c["id"], "better_back": False}).json()
    assert off["better_back"] is False

    # a turnaround already has its views; text starts and four views don't take it
    for p in ("turn_front", "turn_side", "turn_back"):
        _panel(c["id"], "sheet_view", p)
    out = client.post("/api/3d/make", json={"character_id": c["id"], "better_back": True}).json()
    assert out["better_back"] is False and out["views_used"] == ["front", "left", "back"]
    assert client.post("/api/3d/make", json={"prompt": "a lamp", "better_back": True}).json()["better_back"] is False


def test_better_back_falls_back_when_a_view_fails(client, fast_driver):
    src = _photo(client)
    out = client.post("/api/3d/make", json={"source_id": src["id"], "better_back": True}).json()
    side, back = out["back_views"]
    _fail(out["back_jobs"][1]["id"], back["generation_id"])
    _drain(fast_driver)
    rec = _rec(out["item"]["generation_id"])["model3d"]
    assert rec["views"] == {"front": src["generation_id"], "left": side["generation_id"]}
    assert rec["better_back_note"] == "The back view couldn't be made, so the model used the others."
    assert _gen(out["item"]["generation_id"]).status == "ready"

    out = client.post("/api/3d/make", json={"source_id": src["id"], "better_back": True}).json()
    for item, job in zip(out["back_views"], out["back_jobs"]):
        _fail(job["id"], item["generation_id"])
    _drain(fast_driver)
    g = _gen(out["item"]["generation_id"])
    assert g.status == "ready" and "views" not in g.params["model3d"]
    assert g.params["model3d"]["better_back_note"] == m3.BACK_FAILED
    assert g.params["model3d"]["better_back"]["status"] == "failed"
    with SessionLocal() as db:
        assert db.get(Job, g.job_id).result["template"] == m3.TEMPLATE


def test_better_back_without_the_views_model_uses_the_one_picture(client, monkeypatch):
    src = _photo(client)
    monkeypatch.setattr(mc, "capability_unavailable", lambda m, cap: "the multi-view weights are missing")
    out = client.post("/api/3d/make", json={"source_id": src["id"], "better_back": True, "engine": "trellis2"}).json()
    assert out["better_back"] is False and out["model_resolved"] == "trellis2"
    assert "multi-view weights are missing" in out["better_back_note"]
    assert client.get("/api/3d/options").json()["better_back"]["available"] is False


def test_better_back_needs_the_edit_model_in_the_package(client, login):  # noqa: F811
    uid = make_user()
    ben = login({"email": "ben@example.com", "password": PW})
    src = _photo(ben)
    pid = client.post("/api/admin/packages", json={"name": "Pixal only", "models": ["pixal3d"]}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    r = ben.post("/api/3d/make", json={"source_id": src["id"], "better_back": True})
    assert r.status_code == 403 and m3.BACK_EDIT_MODEL in r.json()["detail"]
    with SessionLocal() as db:
        # nothing was left half-made
        assert not db.scalars(select(MediaItem).where(MediaItem.kind == "model")).all()
        assert not db.scalars(select(Generation).where(Generation.kind == "sheet_view")).all()
    assert ben.post("/api/3d/make", json={"source_id": src["id"]}).status_code == 202

    pid = client.post("/api/admin/packages", json={"name": "3D, no images", "features": {"image": False}}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    r = ben.post("/api/3d/make", json={"source_id": src["id"], "better_back": True})
    assert r.status_code == 403 and "Image" in r.json()["detail"]

    both = {"name": "Both", "models": ["pixal3d", m3.BACK_EDIT_MODEL]}
    pid = client.post("/api/admin/packages", json=both).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    assert ben.post("/api/3d/make", json={"source_id": src["id"], "better_back": True}).status_code == 202


def test_estimate_counts_the_views(client):
    plain = client.get("/api/estimate?kind=model3d&model=pixal3d&speed=draft").json()
    back = client.get("/api/estimate?kind=model3d&model=pixal3d&speed=draft&better_back=true").json()
    assert back["low_s"] > plain["low_s"] + 20 and back["high_s"] > plain["high_s"] + 20
    logo = client.get("/api/estimate?kind=model3d&model=logo").json()
    assert logo["high_s"] < 30 and logo["load_s"] == 0


# ---------------------------------------------------------------- logo geometry

def _ring_and_bar(size=(640, 320), colour=(200, 30, 30, 255)) -> Image.Image:
    """An O (one hole) and an I (none), like two letters of a logo."""
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((20, 20, 300, 300), fill=colour)
    d.ellipse((100, 100, 220, 220), fill=(0, 0, 0, 0))
    d.rectangle((400, 30, 470, 290), fill=colour)
    return im


def _parse(data: bytes):
    assert _glb_ok(data)
    n = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20:20 + n])
    blob = data[28 + n:]

    def read(acc, dtype, width):
        a = doc["accessors"][acc]
        v = doc["bufferViews"][a["bufferView"]]
        return np.frombuffer(blob, dtype, a["count"] * width, v["byteOffset"]).reshape(-1, width)

    prims = []
    for p in doc["meshes"][0]["primitives"]:
        prims.append({"pos": read(p["attributes"]["POSITION"], np.float32, 3),
                      "tri": read(p["indices"], np.uint32, 1).reshape(-1, 3),
                      "uv": "TEXCOORD_0" in p["attributes"], "material": p["material"]})
    return doc, prims


def _closed(prims) -> tuple[np.ndarray, int]:
    """Edge-use counts once the parts are welded by position, and the Euler characteristic."""
    pos = np.vstack([p["pos"] for p in prims])
    base = np.cumsum([0] + [len(p["pos"]) for p in prims])[:-1]
    tri = np.vstack([p["tri"].astype(np.int64) + b for p, b in zip(prims, base)])
    _, weld = np.unique(np.round(pos / 1e-5).astype(np.int64), axis=0, return_inverse=True)
    t = weld.reshape(-1)[tri]
    edges = np.sort(np.vstack([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]), 1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return counts, len(np.unique(weld)) - len(counts) + len(t)


def _volume(prims) -> float:
    v = 0.0
    for p in prims:
        a, b, c = (p["pos"][p["tri"][:, k]].astype(np.float64) for k in range(3))
        v += float((a * np.cross(b, c)).sum()) / 6
    return v


def test_logo_traces_the_hole_and_makes_a_closed_badge():
    data, info = ml.make(_ring_and_bar(), {"depth": "thick", "bevel": "none"})
    assert info["outlines"] == 2 and info["holes"] == 1
    doc, (front, back, sides) = _parse(data)
    assert [m["name"] for m in doc["materials"]] == ["Artwork", "Gold"]
    assert (front["material"], back["material"], sides["material"]) == (0, 0, 1)
    assert front["uv"] and back["uv"] and not sides["uv"]
    assert doc["images"][0]["mimeType"] == "image/png" and doc["textures"] == [{"sampler": 0, "source": 0}]

    counts, chi = _closed([front, back, sides])
    # every edge is shared by two faces, and an O (genus 1) plus an I (genus 0) has Euler characteristic 0 + 2
    assert set(counts.tolist()) == {2} and chi == 2
    assert _volume([front, back, sides]) > 0  # the faces point outwards
    assert 30 < len(front["tri"]) < 5000

    pos = np.vstack([front["pos"], back["pos"], sides["pos"]])
    size = pos.max(0) - pos.min(0)
    assert abs(max(size[0], size[1]) - 1.0) < 1e-3
    assert abs(size[2] / size[0] - ml.DEPTHS["thick"]) < 0.002
    # the front faces -Z, where the viewer's camera starts
    assert np.allclose(front["pos"][:, 2], -size[2] / 2, atol=1e-5)

    # nothing covers the middle of the O: where is it? the O is on the left of the picture, and the art reads
    # the right way round from -Z, so it is on +X
    o_centre = np.array([front["pos"][:, 0].max() - 0.5 * 280 / 450, 0.0])
    a, b, c = (front["pos"][front["tri"][:, k], :2] for k in range(3))

    def side(p, q, r):
        return (q[:, 0] - p[:, 0]) * (r[1] - p[:, 1]) - (q[:, 1] - p[:, 1]) * (r[0] - p[:, 0])

    d1, d2, d3 = side(a, b, o_centre), side(b, c, o_centre), side(c, a, o_centre)
    covered = ((d1 >= 0) & (d2 >= 0) & (d3 >= 0)) | ((d1 <= 0) & (d2 <= 0) & (d3 <= 0))
    assert not covered.any()

    thin, _ = ml.make(_ring_and_bar(), {"depth": "thin", "bevel": "none"})
    _, parts = _parse(thin)
    pos = np.vstack([p["pos"] for p in parts])
    size = pos.max(0) - pos.min(0)
    assert abs(size[2] / size[0] - ml.DEPTHS["thin"]) < 0.002


def test_logo_bevels_stay_closed():
    counts = {}
    for bevel in ml.BEVELS:
        data, info = ml.make(_ring_and_bar(), {"bevel": bevel})
        _, prims = _parse(data)
        uses, _ = _closed(prims)
        # folded corners can stack faces, but nothing is left open
        assert not (uses % 2).any(), bevel
        assert _volume(prims) > 0, bevel
        counts[bevel] = info["vertices"]
        # the front stays flat and whole: the art keeps its full width on the face
        front = prims[0]
        assert np.ptp(front["pos"][:, 2]) < 1e-6
    assert counts["none"] < counts["soft"] < counts["round"]


def test_logo_finishes_and_backs():
    data, info = ml.make(_ring_and_bar(), {"finish": "colour", "back": "plain"})
    doc, (front, back, sides) = _parse(data)
    assert info["colour"] == "#c81e1e"
    mat = doc["materials"][1]
    assert mat["name"] == "Logo colour"
    base = mat["pbrMetallicRoughness"]["baseColorFactor"]
    assert abs(base[0] - ml._linear(200)) < 1e-3 and base[0] > base[1] * 10
    assert back["material"] == 1 and not back["uv"]

    for finish in ("gold", "chrome", "steel"):
        doc, _ = _parse(ml.make(_ring_and_bar(), {"finish": finish})[0])
        pbr = doc["materials"][1]["pbrMetallicRoughness"]
        colour, metal, rough = ml.FINISHES[finish]
        assert pbr["baseColorFactor"][:3] == list(colour) and pbr["metallicFactor"] == metal == 1.0
        assert pbr["roughnessFactor"] == rough
    assert ml.FINISHES["chrome"][2] < ml.FINISHES["gold"][2] < ml.FINISHES["steel"][2]


def test_logo_texture_is_the_art_at_full_size():
    big = _ring_and_bar().resize((2000, 1000))
    data, info = ml.make(big)
    # cropped to the art (plus a small margin), not shrunk to the tracing size
    assert info["texture"][0] > 1000
    tex = ml.texture(ml.crop_to_art(_ring_and_bar()))
    assert tex.mode == "RGB"
    # under the soft edge the art's own red spreads out instead of black
    px = np.asarray(tex)
    assert px[2, tex.width // 4][0] > 100


def test_keying_out_a_plain_background():
    im = Image.new("RGB", (200, 120), "white")
    ImageDraw.Draw(im).rectangle((50, 30, 150, 90), fill=(20, 60, 160))
    keyed = ml.key_out(im.convert("RGBA"))
    a = np.asarray(keyed.getchannel("A"))
    assert a[0, 0] == 0 and a[60, 100] == 255
    _, info = ml.make(keyed)
    assert info["outlines"] == 1 and info["holes"] == 0


def test_logo_with_nothing_to_trace():
    import pytest

    with pytest.raises(ml.LogoError):
        ml.make(Image.new("RGBA", (64, 64), (0, 0, 0, 0)))


# ---------------------------------------------------------------- the logo start

def _logo(client, transparent=True) -> dict:
    buf = io.BytesIO()
    im = _ring_and_bar()
    if not transparent:
        flat = Image.new("RGB", im.size, "white")
        flat.paste(im, mask=im.getchannel("A"))
        im = flat
    im.save(buf, "PNG")
    r = upload(client, "badge.png", buf.getvalue(), "image/png", title="Badge")
    assert r.status_code == 201, r.text
    return r.json()


def test_logo_start_with_a_transparent_picture(client, fast_driver):
    src = _logo(client)
    r = client.post("/api/3d/make", json={"logo_id": src["id"], "engine": "trellis2", "quality": "draft",
                                          "logo": {"depth": "thick", "bevel": "round", "finish": "chrome",
                                                   "back": "plain"}})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["start"] == "logo" and out["model_resolved"] == "logo" and out["cutout"] is None
    assert out["item"]["kind"] == "model" and out["item"]["title"] == "Badge · 3D"
    rec = _rec(out["item"]["generation_id"])["model3d"]
    assert rec == {"start": "logo", "source_id": src["generation_id"], "source_media_id": src["id"], "alpha": "own",
                   "logo": {"depth": "thick", "bevel": "round", "finish": "chrome", "back": "plain"}}
    with SessionLocal() as db:
        job = db.get(Job, out["job"]["id"])
        assert job.type == ml.JOB and job.lane == "general"
    assert lane_for(ml.JOB) == "general"

    _drain(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, out["item"]["generation_id"])
        job = db.get(Job, g.job_id)
        assert g.status == "ready" and g.media_type == "model/gltf-binary" and g.file_path.endswith(".glb")
        assert job.status == "done" and job.gpu_seconds == 0 and job.result["holes"] == 1
        mesh = g.params["model3d"]["mesh"]
        assert mesh["outlines"] == 2 and mesh["finish"] == "chrome" and mesh["size"]["width"] == 1.0
        data = (get_settings().data_dir / g.file_path).read_bytes()
    doc, prims = _parse(data)
    assert doc["materials"][1]["name"] == "Chrome" and prims[1]["material"] == 1
    item = client.get(f"/api/media/{out['item']['id']}").json()
    assert item["status"] == "ready" and item["thumb_url"]
    assert out["item"]["id"] in {i["id"] for i in client.get("/api/media?kind=model").json()["items"]}
    assert client.get(item["media_url"]).content[:4] == b"glTF"


def test_logo_start_cuts_an_opaque_picture_out_first(client, fast_driver):
    src = _logo(client, transparent=False)
    out = client.post("/api/3d/make", json={"logo_id": src["id"]}).json()
    cut = out["cutout"]
    assert cut["home"] == "3d" and cut["kind"] == "image" and out["cutout_job"]["status"] == "queued"
    with SessionLocal() as db:
        child = db.get(Generation, cut["generation_id"])
        assert child.params["restore"]["tool"] == "cutout" and child.params["cutout"]["stage"] == "mask"
        assert db.get(Job, child.job_id).lane == "image"
        rec = db.get(Generation, out["item"]["generation_id"]).params["model3d"]
        assert rec["alpha"] == "cutout" and rec["cutout"]["status"] == "pending"
        assert rec["logo"] == ml.DEFAULTS
        db.get(Job, out["job"]["id"]).priority = 5
        db.commit()

    from app.worker import process_one

    assert process_one(driver_factory=fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, out["job"]["id"])
        assert job.status == "queued" and job.message == "Cutting the logo out first"
        assert job.result == {"waiting_on": [out["cutout_job"]["id"]]}
    _drain(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, out["item"]["generation_id"])
        assert g.status == "ready" and g.params["model3d"]["cutout"]["status"] == "done"
        # the mock cut-out is an oval: one outline, no holes
        assert g.params["model3d"]["mesh"]["outlines"] == 1

    # asked not to: the plain white around it is keyed off instead, with no GPU step
    out = client.post("/api/3d/make", json={"logo_id": src["id"], "remove_background": False}).json()
    assert out["cutout"] is None and _rec(out["item"]["generation_id"])["model3d"]["alpha"] == "key"
    _drain(fast_driver)
    mesh = _rec(out["item"]["generation_id"])["model3d"]["mesh"]
    assert mesh["outlines"] == 2 and mesh["holes"] == 1


def test_logo_fails_when_its_cutout_does(client, fast_driver):
    src = _logo(client, transparent=False)
    out = client.post("/api/3d/make", json={"logo_id": src["id"]}).json()
    _fail(out["cutout_job"]["id"], out["cutout"]["generation_id"])
    _drain(fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, out["job"]["id"])
        assert job.status == "failed" and "couldn't be cut out of its background (out of memory)" in job.error
        assert db.get(Generation, out["item"]["generation_id"]).params["model3d"]["cutout"]["status"] == "failed"


def test_logo_rules_and_gates(client, login):  # noqa: F811
    src = _logo(client)
    post = lambda body: client.post("/api/3d/make", json=body)  # noqa: E731
    assert post({"logo_id": src["id"], "source_id": src["id"]}).status_code == 422
    assert post({"logo_id": "nope"}).status_code == 404
    assert post({"logo_id": src["id"], "logo": {"finish": "brass"}}).status_code == 422
    opts = client.get("/api/3d/options").json()["logo"]
    assert opts["depths"] == ["thin", "medium", "thick"] and opts["defaults"] == ml.DEFAULTS
    assert [f["label"] for f in opts["finishes"]] == ["Gold", "Chrome", "Brushed steel", "Logo colour"]

    uid = make_user()
    ben = login({"email": "ben@example.com", "password": PW})
    mine = _logo(ben)
    opaque = _logo(ben, transparent=False)
    pid = client.post("/api/admin/packages", json={"name": "No 3D", "features": {"3d": False}}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    r = ben.post("/api/3d/make", json={"logo_id": mine["id"]})
    assert r.status_code == 403 and "3D Studio" in r.json()["detail"]
    # the cut-out is image work; a transparent logo needs none
    pid = client.post("/api/admin/packages", json={"name": "3D, no images", "features": {"image": False}}).json()["id"]
    client.post(f"/api/admin/users/{uid}/subscription", json={"package_id": pid})
    assert ben.post("/api/3d/make", json={"logo_id": opaque["id"]}).status_code == 403
    assert ben.post("/api/3d/make", json={"logo_id": mine["id"]}).status_code == 202
    # someone else's picture isn't found
    assert ben.post("/api/3d/make", json={"logo_id": src["id"]}).status_code == 404


# ---------------------------------------------------------------- MCP

def test_mcp_better_back_and_logo(client, anon, fast_driver):
    m = Mcp(anon, _mint(client, ["read", "generate"])["token"])
    src = _photo(client)
    out = m.call_json("make_3d_model", image_id=src["id"], better_back=True)
    assert out["start"] == "picture" and len(out["better_back"]) == 2
    assert all(v["job_id"] and v["kind"] == "image" for v in out["better_back"])

    logo = _logo(client)
    out = m.call_json("make_3d_model", logo_id=logo["id"], depth="thin", bevel="none", finish="steel", back="plain")
    assert out["start"] == "logo" and out["model"] == "logo" and "cutout" not in out
    assert _rec(out["items"][0]["generation_id"])["model3d"]["logo"] == {"depth": "thin", "bevel": "none",
                                                                         "finish": "steel", "back": "plain"}
    _drain(fast_driver)
    done = m.call_json("wait_for_job", job_id=out["jobs"][0]["job_id"], timeout_s=5)
    assert done["status"] == "done" and done["media_type"] == "model/gltf-binary"
    bad = m.call("make_3d_model", logo_id=logo["id"], image_id=src["id"])
    assert bad["isError"] and "exactly one" in json.dumps(bad)
