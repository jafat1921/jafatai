"""Milestone 9a: Photo Studio develop engine, preview/render, Auto, effects, history (contract v9)."""
import io
import time

import numpy as np
import pytest
from PIL import Image

from app.config import get_settings
from app.db import SessionLocal
from app.models import Generation, Job, MediaItem
from app.photo import analysis as an
from app.photo import develop as dv
from app.photo import effects as fx
from app.worker import process_one

rng = np.random.default_rng(42)


def scene(h=240, w=360, noise=0.0, dark=1.0) -> np.ndarray:
    """Gradients plus saturated and pastel patches: something for every slider to bite on."""
    y = np.linspace(0, 1, h)[:, None]
    x = np.linspace(0, 1, w)[None, :]
    img = np.stack([0.15 + 0.7 * x * np.ones_like(y), 0.1 + 0.8 * y * np.ones_like(x),
                    0.5 + 0.3 * np.sin(6 * x + 3 * y)], axis=-1)
    patches = [(0.85, 0.15, 0.1), (0.95, 0.85, 0.1), (0.1, 0.7, 0.2), (0.15, 0.3, 0.9), (0.8, 0.6, 0.55),
               (0.5, 0.5, 0.5)]
    for i, c in enumerate(patches):
        img[h // 2:h // 2 + h // 6, 10 + i * (w // 7):10 + i * (w // 7) + w // 9] = c
    if noise:
        img = img + rng.normal(0, noise, img.shape)
    return (np.clip(img * dark, 0, 1) * 255 + 0.5).astype(np.uint8)


def png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    return buf.getvalue()


def upload(client, arr: np.ndarray, name="photo.png") -> dict:
    r = client.post("/api/media/upload", files={"file": (name, png(arr), "image/png")})
    assert r.status_code == 201, r.text
    item = r.json()
    with SessionLocal() as db:
        gen_id = db.get(MediaItem, item["id"]).generation_id
    return {"item": item["id"], "gen": gen_id}


def run_jobs():
    while process_one():
        pass


def dev(arr, **p):
    return dv.quantise(dv.develop(arr, p))


def lum(arr) -> np.ndarray:
    return dv.luma(dv.to_unit(arr))


def chroma(arr) -> np.ndarray:
    a = dv.to_unit(arr)
    return a.max(-1) - a.min(-1)


def highpass(arr) -> float:
    y = lum(arr)
    return float(np.abs(np.diff(y, axis=0)).mean() + np.abs(np.diff(y, axis=1)).mean())


# ------------------------------------------------------------------ params / schema

def test_schema_lists_every_param(client):
    r = client.get("/api/photo/schema")
    assert r.status_code == 200
    s = r.json()
    assert s["defaults"] == dv.normalise({}) and s["version"] == 1
    for k in dv.SLIDERS:
        assert k in s["ranges"]
    assert s["ranges"]["sharpness"]["min"] == 0 and s["ranges"]["sharpness"]["spatial"] is True
    assert {"curve.mids", "hsl.h", "rotate", "lut.amount"} <= set(s["ranges"])
    assert [b["id"] for b in s["hsl_bands"]] == ["red", "orange", "yellow", "green", "aqua", "blue", "purple",
                                                 "magenta"]
    grouped = {k for g in s["groups"] for k in g["keys"]}
    assert set(dv.SLIDERS) <= grouped
    assert {f["id"] for f in s["formats"]} == {"jpeg", "png", "png16", "tiff16"}
    assert len(s["effects"]) == 9


def test_normalise_clamps_and_sparse_round_trips():
    p = dv.normalise({"exposure": 500, "sharpness": -5, "hsl": {"blue": {"s": -300}}, "bogus": 1,
                      "lightPoints": [{"x": 1, "y": 2, "exposure": 50}] * 30})
    assert p["exposure"] == 100 and p["sharpness"] == 0 and p["hsl"]["blue"]["s"] == -100
    assert "bogus" not in p and len(p["lightPoints"]) == dv.MAX_POINTS
    assert dv.normalise(dv.sparse(p)) == p
    assert dv.sparse({}) == {} and dv.is_identity({"curve": {"mids": 0}})


def test_api_rejects_out_of_range_params(client):
    ids = upload(client, scene(60, 80))
    r = client.post(f"/api/photo/{ids['gen']}/preview", json={"params": {"exposure": 150}})
    assert r.status_code == 422
    # unknown keys are ignored, not an error
    r = client.post(f"/api/photo/{ids['gen']}/preview", json={"params": {"exposure": 10, "grain": 4}})
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"


# ------------------------------------------------------------------ maths

def test_identity_params_leave_the_image_alone():
    a = scene(noise=0.02)
    out = dev(a)
    assert an.delta_e(out, a).max() < 0.5
    assert np.array_equal(out, a)
    # a 16-bit source too
    a16 = (dv.to_unit(a) * 65535).astype(np.uint16)
    assert np.abs(dv.quantise(dv.develop(a16, {}), 16).astype(int) - a16).max() <= 8


@pytest.mark.parametrize("params,metric,direction", [
    ({"exposure": 50}, lambda a: lum(a).mean(), 1),
    ({"exposure": -50}, lambda a: lum(a).mean(), -1),
    ({"contrast": 60}, lambda a: lum(a).std(), 1),
    ({"contrast": -60}, lambda a: lum(a).std(), -1),
    ({"highlights": -80}, lambda a: lum(a)[lum(scene()) > 0.7].mean(), -1),
    ({"shadows": 80}, lambda a: lum(a)[lum(scene()) < 0.3].mean(), 1),
    ({"whites": 80}, lambda a: lum(a)[lum(scene()) > 0.8].mean(), 1),
    ({"blacks": -80}, lambda a: lum(a)[lum(scene()) < 0.15].mean(), -1),
    ({"temperature": 50}, lambda a: dv.to_unit(a)[..., 0].mean() / dv.to_unit(a)[..., 2].mean(), 1),
    ({"temperature": -50}, lambda a: dv.to_unit(a)[..., 0].mean() / dv.to_unit(a)[..., 2].mean(), -1),
    ({"tint": 50}, lambda a: (dv.to_unit(a)[..., 0] + dv.to_unit(a)[..., 2]).mean() / dv.to_unit(a)[..., 1].mean(), 1),
    ({"saturation": 50}, lambda a: chroma(a).mean(), 1),
    ({"saturation": -50}, lambda a: chroma(a).mean(), -1),
    ({"vibrance": 60}, lambda a: chroma(a).mean(), 1),
    ({"curve": {"mids": 40}}, lambda a: lum(a).mean(), 1),
    ({"curve": {"blacks": 40}}, lambda a: lum(a)[lum(scene()) < 0.2].mean(), 1),
    ({"clarity": 80}, highpass, 1),
    ({"sharpness": 80}, highpass, 1),
])
def test_each_slider_moves_its_statistic(params, metric, direction):
    a = scene()
    before, after = metric(a), metric(dev(a, **params))
    assert (after - before) * direction > 1e-3, (params, before, after)


def test_white_balance_keeps_grey_brightness():
    grey = np.full((20, 20, 3), 128, np.uint8)
    for t in (-80, 80):
        out = dev(grey, temperature=t)
        assert abs(lum(out).mean() - lum(grey).mean()) < 0.03


def test_saturation_minus_100_is_monochrome_and_vibrance_protects_saturated():
    a = scene()
    assert chroma(dev(a, saturation=-100)).max() < 0.01
    out = dev(a, vibrance=60)
    c0, c1 = chroma(a), chroma(out)
    low, high = (c0 > 0.05) & (c0 < 0.2), c0 > 0.6
    assert (c1[low] / c0[low]).mean() > (c1[high] / c0[high]).mean()


def test_noise_reduction_and_vignette():
    noisy = scene(noise=0.06)
    assert highpass(dev(noisy, noiseReduction=70)) < highpass(noisy) * 0.8
    a = np.full((200, 300, 3), 160, np.uint8)
    out = lum(dev(a, vignette=-60))
    assert out[0, 0] < out[100, 150] - 0.1 and abs(out[100, 150] - lum(a)[100, 150]) < 0.005
    out = lum(dev(a, vignette=60))
    assert out[0, 0] > out[100, 150] + 0.05


def test_light_point_brightens_around_it_only():
    a = np.full((200, 300, 3), 90, np.uint8)
    out = lum(dev(a, lightPoints=[{"x": 150, "y": 100, "exposure": 80, "falloff": 30}]))
    base = lum(a)
    assert out[100, 150] > base[100, 150] + 0.1
    assert abs(out[5, 5] - base[5, 5]) < 0.005


def test_tone_curve_is_monotonic_for_any_settings():
    r = np.random.default_rng(3)
    for _ in range(200):
        p = dv.normalise({k: float(r.uniform(-100, 100)) for k in ("contrast", "highlights", "shadows", "whites",
                                                                    "blacks")}
                         | {"curve": {k: float(r.uniform(-100, 100)) for k, _, _ in dv.CURVE_POINTS}})
        t = dv.tone_curve(p)
        assert np.all(np.diff(t) >= 0) and t.min() >= 0 and t.max() <= 1


def test_hsl_bands_are_isolated():
    patches = {"red": (230, 30, 30), "yellow": (230, 220, 30), "green": (40, 200, 50), "aqua": (40, 200, 200),
               "blue": (40, 60, 230), "magenta": (220, 40, 220), "grey": (128, 128, 128)}
    a = np.concatenate([np.full((8, 8, 3), c, np.uint8) for c in patches.values()], axis=1)
    names = list(patches)
    for band in ("red", "green", "blue"):
        out = dev(a, hsl={band: {"h": 60, "s": -80, "l": -60}})
        de = an.delta_e(out, a).reshape(8, len(names), 8).mean(axis=(0, 2))
        for i, n in enumerate(names):
            if n == band:
                assert de[i] > 10, (band, n, de[i])
            else:
                assert de[i] < 0.5, (band, n, de[i])


def test_geometry_crop_rotate_flip():
    a = scene(100, 160)
    im = Image.fromarray(a)
    p = dv.normalise({"crop": {"x": 10, "y": 20, "width": 80, "height": 50}})
    assert dv.apply_geometry(im, p, (160, 100)).size == (80, 50) == dv.frame_size(160, 100, p)
    p = dv.normalise({"rotate": 90})
    out = np.asarray(dv.apply_geometry(im, p, (160, 100)))
    assert out.shape[:2] == (160, 100) and np.array_equal(out[0, -1], a[0, 0])  # clockwise: top-left goes top-right
    p = dv.normalise({"rotate": 10})
    w, h = dv.apply_geometry(im, p, (160, 100)).size
    assert (w, h) == dv.frame_size(160, 100, p) and w < 160 and abs(w / h - 1.6) < 0.05
    p = dv.normalise({"flipH": True})
    assert np.array_equal(np.asarray(dv.apply_geometry(im, p, (160, 100))), a[:, ::-1])


# ------------------------------------------------------------------ preview, histogram, analysis, auto

def test_preview_matches_the_saved_render(client):
    a = scene(300, 400)
    ids = upload(client, a)
    params = {"exposure": 20, "contrast": 25, "temperature": -15, "vibrance": 30, "clarity": 30, "sharpness": 40,
              "vignette": -30, "hsl": {"blue": {"h": 20, "s": 30}}, "curve": {"shadows": 10}}
    r = client.post(f"/api/photo/{ids['gen']}/preview", json={"params": params, "max_side": 1280})
    assert r.status_code == 200, r.text
    assert r.headers["x-source-size"] == "400x300" and r.headers["x-output-size"] == "400x300"
    prev = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"))

    r = client.post(f"/api/photo/{ids['gen']}/render", json={"params": params, "format": "png"})
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["type"] == "photo_render" and job["lane"] == "general"
    run_jobs()
    with SessionLocal() as db:
        assert db.get(Job, job["id"]).status == "done"
        g = db.get(Generation, job["generation_id"])
        assert g.status == "ready" and g.kind == "image" and g.parent_id == ids["gen"]
        assert g.params["develop"]["base"] == ids["gen"] and g.params["size"] == [400, 300]
        assert g.media_type == "image/png"
        full = np.asarray(Image.open(get_settings().data_dir / g.file_path).convert("RGB"))
        assert db.get(MediaItem, ids["item"]).generation_id == g.id
    assert an.delta_e(prev, full).mean() < 1.0


def test_preview_is_fast_on_a_ci_sized_image(client):
    ids = upload(client, scene(853, 1280, noise=0.02))
    params = {"exposure": 15, "contrast": 20, "highlights": -30, "shadows": 30, "temperature": 10, "vibrance": 20,
              "clarity": 20, "sharpness": 25, "vignette": -20, "hsl": {"orange": {"s": -10}}}
    client.post(f"/api/photo/{ids['gen']}/preview", json={"params": {}})  # decode + cache the source
    t0 = time.perf_counter()
    r = client.post(f"/api/photo/{ids['gen']}/preview", json={"params": params})
    took = time.perf_counter() - t0
    assert r.status_code == 200
    assert took < 1.0, f"preview took {took:.2f}s (server says {r.headers['x-develop-ms']} ms)"


def test_histogram_analysis_palette(client):
    ids = upload(client, scene())
    h = client.get(f"/api/photo/{ids['gen']}/histogram").json()
    assert all(len(h[k]) == 256 for k in ("r", "g", "b", "luma")) and max(max(h[k]) for k in "rgb") == 1.0
    brighter = client.post(f"/api/photo/{ids['gen']}/histogram", json={"params": {"exposure": 80}}).json()
    mean = lambda hist: sum(i * v for i, v in enumerate(hist)) / sum(hist)  # noqa: E731
    assert mean(brighter["luma"]) > mean(h["luma"])
    r = client.get(f"/api/photo/{ids['gen']}/histogram", params={"params": '{"exposure": 999}'})
    assert r.status_code == 422
    a = client.get(f"/api/photo/{ids['gen']}/analysis").json()
    assert a["width"] == 360 and a["height"] == 240 and not a["is_grayscale"] and a["face_count"] is None
    pal = client.get(f"/api/photo/{ids['gen']}/palette", params={"k": 6}).json()["clusters"]
    assert 1 <= len(pal) <= 6 and abs(sum(c["coverage"] for c in pal) - 1) < 0.01
    # clusters go straight back in as params.palette
    pal[0]["enabled"] = False
    r = client.post(f"/api/photo/{ids['gen']}/preview", json={"params": {"palette": pal}})
    assert r.status_code == 200


def test_auto_brightens_an_underexposed_photo(client):
    dark = upload(client, scene(dark=0.25), "dark.png")
    out = client.post(f"/api/photo/{dark['gen']}/auto").json()
    assert out["params"]["exposure"] > 20 and out["analysis"]["is_underexposed"]
    assert any("Underexposed" in n for n in out["notes"])
    bright = upload(client, np.clip(scene().astype(int) + 90, 0, 255).astype(np.uint8), "bright.png")
    assert client.post(f"/api/photo/{bright['gen']}/auto").json()["params"].get("exposure", 0) < 0
    # nothing was saved
    with SessionLocal() as db:
        assert db.get(MediaItem, dark["item"]).generation_id == dark["gen"]


def test_auto_neutralises_a_yellow_cast():
    a = scene().astype(np.float32)
    a[..., 2] *= 0.6
    a = a.astype(np.uint8)
    params, _ = an.suggest(an.analyse(a), a)
    assert params["temperature"] < 0


# ------------------------------------------------------------------ effects

def test_effects():
    a = scene()
    for name in fx.NAMES:
        out = fx.apply(a, name, 1.0)
        assert out.shape == a.shape and out.dtype == np.float32 and 0 <= out.min() and out.max() <= 1
        assert np.allclose(fx.apply(a, name, 0.0), dv.to_unit(a), atol=1e-6)
    assert chroma(dv.quantise(fx.apply(a, "bw"))).max() < 0.01
    warm = fx.apply(a, "warm")
    assert warm[..., 0].mean() > dv.to_unit(a)[..., 0].mean()
    sep = dv.quantise(fx.apply(a, "sepia"))
    assert (dv.to_unit(sep)[..., 0] >= dv.to_unit(sep)[..., 2] - 0.01).all()


def test_effect_job_makes_a_version(client):
    ids = upload(client, scene())
    r = client.post(f"/api/photo/{ids['item']}/effect", json={"name": "bw", "strength": 1})
    assert r.status_code == 202, r.text
    assert client.post(f"/api/photo/{ids['item']}/effect", json={"name": "bw", "strength": 1}).json()["id"] == \
        r.json()["id"]  # same request while queued: same job
    run_jobs()
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["generation_id"])
        assert g.status == "ready" and g.params["effect"]["name"] == "bw" and g.media_type == "image/jpeg"
        out = np.asarray(Image.open(get_settings().data_dir / g.file_path).convert("RGB"))
    assert chroma(out).max() < 0.05
    assert client.post(f"/api/photo/{ids['gen']}/effect", json={"name": "vintage"}).status_code == 422


# ------------------------------------------------------------------ formats, history, revert

def test_16_bit_formats_and_alpha(client):
    a = scene(80, 120)
    rgba = np.dstack([a, np.full(a.shape[:2], 128, np.uint8)])
    r = client.post("/api/media/upload", files={"file": ("cut.png", png(rgba), "image/png")})
    item = r.json()["id"]
    for fmt, mt in (("png16", "image/png"), ("tiff16", "image/tiff")):
        r = client.post(f"/api/photo/{item}/render", json={"params": {"exposure": 10}, "format": fmt})
        assert r.status_code == 202, r.text
        run_jobs()
        with SessionLocal() as db:
            g = db.get(Generation, r.json()["generation_id"])
            assert g.media_type == mt
            raw = (get_settings().data_dir / g.file_path).read_bytes()
        if fmt == "png16":
            assert raw[24] == 16 and raw[25] == 6  # bit depth 16, RGBA
        else:
            assert raw[:4] == b"II*\x00"
        im = Image.open(io.BytesIO(raw))
        im.load()
        assert im.size == (120, 80)
        assert client.get(f"/api/media/thumb/{g.id}?w=256").status_code == 200


def test_history_and_revert_on_a_library_item(client):
    ids = upload(client, scene(60, 90))
    client.post(f"/api/photo/{ids['gen']}/render", json={"params": {"exposure": 20}})
    run_jobs()
    h = client.get(f"/api/photo/{ids['item']}/history").json()
    v2 = h["versions"][0]
    assert len(h["versions"]) == 2 and v2["current"] and v2["edit"] == "develop"
    assert v2["develop"]["params"]["exposure"] == 20 and h["versions"][1]["edit"] is None
    # develop again from the developed version: base still points at the original
    client.post(f"/api/photo/{v2['generation']['id']}/render", json={"params": {"contrast": 10}})
    run_jobs()
    h = client.get(f"/api/photo/{ids['gen']}/history").json()
    assert len(h["versions"]) == 3 and h["versions"][0]["develop"]["base"] == ids["gen"]
    assert h["versions"][0]["develop"]["parent"] == v2["generation"]["id"]

    r = client.post(f"/api/photo/{ids['gen']}/revert")
    assert r.status_code == 200 and r.json()["current_id"] == ids["gen"]
    assert client.get(f"/api/media/{ids['item']}").json()["generation_id"] == ids["gen"]
    client.post(f"/api/generations/{v2['generation']['id']}/reject")
    assert client.post(f"/api/photo/{v2['generation']['id']}/revert").status_code == 409


def test_revert_on_a_project_frame_approves(client, project, character, fast_driver):
    r = client.post("/api/generations", json={"target_type": "character", "target_id": character["id"],
                                              "kind": "portrait", "prompt": "a diver"})
    assert r.status_code == 201, r.text
    while process_one(driver_factory=fast_driver):
        pass
    first = r.json()["id"]
    r = client.post(f"/api/photo/{first}/render", json={"params": {"exposure": 10}, "format": "png"})
    run_jobs()
    second = r.json()["generation_id"]
    with SessionLocal() as db:
        g = db.get(Generation, second)
        assert (g.kind, g.target_type, g.status) == ("portrait", "character", "ready")
    assert client.post(f"/api/generations/{second}/approve").status_code == 200
    h = client.post(f"/api/photo/{first}/revert").json()
    assert h["current_id"] == first
    assert client.get(f"/api/generations/{second}").json()["status"] == "ready"


def test_photo_routes_refuse_videos_and_other_workspaces(client, tmp_path):
    from tests.test_upscale import _source

    r = client.post("/api/projects", json={"title": "Film", "authoring_mode": "scene_by_scene"})
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"\0" * 10)
    vid = _source(r.json()["id"], clip)
    assert client.post(f"/api/photo/{vid}/preview", json={}).status_code == 422
    assert client.post("/api/photo/nope/preview", json={}).status_code == 404
