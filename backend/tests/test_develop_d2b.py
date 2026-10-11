"""Develop D2b: Texture, Dehaze, full Detail, Lens corrections, Transform / Upright, RAW masters, XMP keys."""
import io
import math

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.config import get_settings
from app.db import SessionLocal
from app.models import Generation
from app.photo import colour as cl
from app.photo import develop as dv
from app.photo import geometry as gm
from app.photo import spatial as sp
from app.photo import upright as up
from app.photo import xmp

rng = np.random.default_rng(11)


def grey(a: np.ndarray) -> np.ndarray:
    return np.repeat(a[..., None], 3, axis=2)


def u8(a) -> np.ndarray:
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def checker(h=240, w=320, cell=20) -> np.ndarray:
    y, x = np.mgrid[0:h, 0:w]
    return (((x // cell) + (y // cell)) % 2).astype(np.float32) * 0.6 + 0.2


# ------------------------------------------------------------------ old engine, kept to prove old records render the same

def old_denoise(p, amount, scale):
    r = max(1, int(round((1 + 4 * amount) * scale)))
    cr = max(1, 2 * r)
    eps = (0.004 + 0.05 * amount) ** 2

    def run(part):
        y = dv.luma(part)
        chroma = dv.box2d(dv.box2d(part - y[..., None], cr), cr)
        out = dv.guided(y, r, eps)[..., None] + chroma
        return np.clip(out, 0, 1, out=out)

    return dv.by_strips(run, p, 2 * r + 2 * cr + 2)


def old_detail(p, clarity, sharpness, scale):
    y = dv.luma(p)
    delta = np.zeros_like(y)
    if abs(clarity) > 0.005:
        big = dv.gaussian(y, max(1.0, 0.01 * max(p.shape[0], p.shape[1])))
        mask = np.clip(1 - (2 * y - 1) ** 2, 0, 1)
        delta += np.float32(0.8 * clarity) * (y - big) * mask
    sigma = (0.7 + sharpness) * scale
    if sharpness > 0.005 and sigma >= 0.25:
        hf = dv.by_strips(lambda part: part - dv.gaussian(part, sigma), y, int(math.ceil(3 * sigma)) + 1)
        delta += np.float32(0.5 + 1.5 * sharpness) * hf
    out = p + delta[..., None]
    return np.clip(out, 0, 1, out=out)


@pytest.mark.parametrize("scale", [1.0, 0.4])
def test_old_sharpness_and_noise_records_render_as_before(scale):
    from tests.test_photo import scene

    src = scene(120, 180, noise=0.04)
    p = {"version": 2, "sharpness": 40, "noiseReduction": 30, "clarity": 20, "contrast": 10}
    got = dv.develop(src, p, scale=scale)
    base = dv.develop(old_denoise(dv.to_unit(src), 0.3, scale), {"version": 2, "contrast": 10}, scale=scale)
    want = old_detail(base, 0.2, 0.4, scale)
    assert np.abs(dv.quantise(got).astype(int) - dv.quantise(want).astype(int)).max() <= 1
    n = dv.normalise(p)
    assert n["sharpness"] == 0 and n["sharpen"] == dv.legacy_sharpen(40) and n["nr"]["luminance"] == 30
    # the new keys win over the old ones when both are there
    assert dv.normalise({"sharpness": 40, "sharpen": {"amount": 10}})["sharpen"]["amount"] == 10


# ------------------------------------------------------------------ texture, dehaze, sharpen, NR

def band_energy(out):
    y = dv.luma(out)
    return float(np.abs(dv.gaussian(y, 1.0) - dv.gaussian(y, 3.0)).mean())


def test_texture_and_clarity_directions():
    src = u8(grey(0.5 + 0.2 * np.sin(np.mgrid[0:200, 0:300][1] / 2.5) * np.sin(np.mgrid[0:200, 0:300][0] / 3.0)))
    plain = band_energy(dv.develop(src, {}))
    assert band_energy(dv.develop(src, {"texture": 60})) > plain * 1.2
    assert band_energy(dv.develop(src, {"texture": -60})) < plain * 0.8
    # Texture is the finer of the two: on the same picture it moves the mid band more than Clarity
    assert band_energy(dv.develop(src, {"texture": 60})) > band_energy(dv.develop(src, {"clarity": 60}))


def hazy() -> np.ndarray:
    from tests.test_photo import scene

    a = dv.to_unit(scene(160, 240))
    t = np.linspace(0.35, 0.9, a.shape[0])[:, None, None]  # farther (hazier) towards the top
    return u8(a * t + 0.8 * (1 - t))


def test_dehaze_removes_and_adds_haze():
    src = hazy()
    base, clear, more = (dv.develop(src, {"dehaze": d}) for d in (0, 60, -60))
    dark = lambda o: float(o.min(axis=2).mean())  # noqa: E731 (dark channel: haze lifts it)
    assert dark(clear) < dark(base) - 0.05 and dv.luma(clear).std() > dv.luma(base).std()
    assert dark(more) > dark(base) + 0.03 and dv.luma(more).std() < dv.luma(base).std()
    assert clear.min() >= 0 and clear.max() <= 1


def test_sharpen_masking_only_touches_edges():
    flat = 0.5 + rng.normal(0, 0.01, (200, 200))
    flat[:, 100:] += 0.3  # one strong edge in quiet noise
    src = u8(grey(flat))
    p = {"sharpen": {"amount": 120, "radius": 1.0, "detail": 60, "masking": 80}}
    out, base = dv.develop(src, p), dv.develop(src, {})
    edge = lambda o: float(o[:, 101, 0].mean() - o[:, 98, 0].mean())  # noqa: E731
    assert edge(out) > edge(base) + 0.01
    quiet = (slice(20, 180), slice(20, 80))
    assert abs(out[quiet].std() - base[quiet].std()) < 0.002
    all_over = dv.develop(src, {"sharpen": {"amount": 120, "masking": 0}})
    assert all_over[quiet].std() > base[quiet].std() * 1.2
    mask = dv.develop(src, p, debug="sharpen_mask")
    assert mask[:, 99:102].mean() > 0.5 and mask[quiet].mean() < 0.1
    assert dv.develop(src, {}, debug="sharpen_mask").min() == 1.0  # Masking 0: everything is sharpened


def test_noise_reduction_luminance_and_colour():
    clean = np.full((160, 160, 3), 0.45, np.float32)
    lum_noise = clean + rng.normal(0, 0.04, (160, 160, 1))
    col_noise = clean + rng.normal(0, 0.04, (160, 160, 3)) * np.array([1, -1, 1])
    src_l, src_c = u8(lum_noise), u8(col_noise)
    base = dv.develop(src_l, {})
    assert dv.develop(src_l, {"nr": {"luminance": 60}}).std() < base.std() * 0.6
    chroma = lambda o: float((o.max(2) - o.min(2)).mean())  # noqa: E731
    assert chroma(dv.develop(src_c, {"nr": {"color": 60}})) < chroma(dv.develop(src_c, {})) * 0.5
    # Detail keeps more of the original
    hi = dv.develop(src_l, {"nr": {"luminance": 60, "detail": 100}}).std()
    lo = dv.develop(src_l, {"nr": {"luminance": 60, "detail": 0}}).std()
    assert hi > lo


# ------------------------------------------------------------------ lens

def test_ca_detection_and_correction_line_up_the_channels():
    g = dv.gaussian(checker(300, 400, 24), 1.5)  # soft edges, so resampling itself adds no error
    h, w = g.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = (w - 1) / 2, (h - 1) / 2
    m = 1.004  # red is magnified 0.4 % about the centre, blue shrunk as much

    def sample(img, x, y):
        return up._sample(img, x, y)

    r = sample(g, cx + (xx - cx) / m, cy + (yy - cy) / m)
    b = sample(g, cx + (xx - cx) * m, cy + (yy - cy) * m)
    src = u8(np.dstack([r, g, b]))
    found = up.chromatic(src)
    assert found["caRed"] == pytest.approx(0.004 / gm.CA_UNIT * 100, abs=4)
    assert found["caBlue"] == pytest.approx(-0.004 / gm.CA_UNIT * 100, abs=4)
    p = dv.normalise({"lens": {"caRed": found["caRed"], "caBlue": found["caBlue"]}})
    fixed = dv.apply_geometry(Image.fromarray(src), p, (w, h))
    mis = lambda a, c: float(np.abs(a[30:-30, 30:-30, c] - a[30:-30, 30:-30, 1]).mean())  # noqa: E731
    for c in (0, 2):
        assert mis(fixed.rgb, c) < mis(dv.to_unit(src), c) * 0.5


def test_manual_distortion_straightens_a_barrel_grid():
    h, w = 300, 400
    k = -0.08  # the lens: lines bow out
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    aspect = w / h
    su, sv = (xx + 0.5) / w, (yy + 0.5) / h
    dx, dy = (su - 0.5) * aspect, sv - 0.5
    rd2 = (dx * dx + dy * dy) / (0.25 * (aspect * aspect + 1))
    ru2 = rd2.copy()
    for _ in range(20):  # captured radius -> ideal radius
        ru2 = rd2 / (1 + k * ru2) ** 2
    f = 1 + k * ru2
    iu, iv = 0.5 + (su - 0.5) / f, 0.5 + (sv - 0.5) / f
    ideal = lambda u, v: ((np.abs(((v * h) % 50) - 25) < 2) | (np.abs(((u * w) % 50) - 25) < 2)).astype(np.float32)  # noqa: E731
    src = u8(grey(0.85 - 0.7 * ideal(iu, iv)))
    p = dv.normalise({"lens": {"distortion": -k / gm.DIST_UNIT * 100}})
    out = dv.apply_geometry(Image.fromarray(src), p, (w, h)).rgb[..., 0]
    # the line near the top (ideal y = 25 px) is straight again: its darkest row is the same across x
    rows = [int(np.argmin(out[5:60, x])) for x in range(40, w - 40, 20)]
    before = [int(np.argmin(dv.to_unit(src)[5:60, x, 0])) for x in range(40, w - 40, 20)]
    assert np.ptp(rows) <= 1 < np.ptp(before)


def test_lens_vignette_and_defringe_are_point_ops():
    src = np.full((60, 90, 3), 128, np.uint8)
    out = dv.develop(src, {"lens": {"vignette": 80}})
    assert out[0, 0].mean() > out[30, 45].mean() + 0.05 and abs(out[30, 45].mean() - 128 / 255) < 0.01
    darker = dv.develop(src, {"lens": {"vignette": -80, "vignetteMidpoint": 80}})
    assert darker[0, 0].mean() < 0.45 and abs(darker[30, 40].mean() - 128 / 255) < 0.01
    # measured on the lens, not the crop: a centre crop of a vignetted frame stays even
    p = dv.normalise({"lens": {"vignette": 80}, "crop": {"x": 30, "y": 20, "width": 30, "height": 20}})
    warp = dv.warp_for(p, (90, 60))
    crop = dv.develop(src[20:40, 30:60], p, warp=warp)
    assert np.ptp(crop) < 0.02
    purple = np.zeros((40, 40, 3), np.uint8)
    purple[:] = (150, 60, 200)
    purple[:, 20:] = (240, 240, 240)
    fr = {"lens": {"purpleAmount": 20}}
    hsv_s = lambda o: float((o.max(2) - o.min(2)).mean())  # noqa: E731
    near, far = dv.develop(purple, fr)[:, 15:20], dv.develop(purple, fr)[:, :6]
    assert hsv_s(near) < 0.2 and hsv_s(far) > 0.3  # edges lose the fringe, the flat purple stays
    assert hsv_s(dv.develop(purple, fr, edges=False)[:, :6]) < 0.15  # the preview's point formula


# ------------------------------------------------------------------ transform and Upright

def test_transform_homography_round_trip_and_directions():
    t = dv.normalise({"transform": {"vertical": 30, "horizontal": -20, "rotate": 3, "aspect": 15, "scale": 110,
                                    "offsetX": 10, "offsetY": -5}})["transform"]
    f = gm.manual(t, 400, 300)
    inv = np.linalg.inv(f)
    for u, v in ((0.1, 0.2), (0.5, 0.5), (0.9, 0.7)):
        q = f @ [u, v, 1]
        back = inv @ (q / q[2])
        assert back[:2] / back[2] == pytest.approx([u, v], abs=1e-9)
    top = gm.manual(dv.normalise({"transform": {"vertical": -50}})["transform"], 400, 300)
    ap = lambda m, u, v: (m @ [u, v, 1])[:2] / (m @ [u, v, 1])[2]  # noqa: E731
    assert (ap(top, 1, 0) - ap(top, 0, 0))[0] > (ap(top, 1, 1) - ap(top, 0, 1))[0]
    assert gm.manual(dv.normalise({})["transform"], 400, 300) is None
    centre = gm.manual(dv.normalise({"transform": {"vertical": 40}})["transform"], 400, 300)
    assert ap(centre, 0.5, 0.5) == pytest.approx([0.5, 0.5], abs=1e-9)


def test_constrain_crop_keeps_blank_corners_out():
    p = dv.normalise({"transform": {"vertical": -60, "constrain": True}})
    w = gm.Warp(p, 400, 300)
    assert w.zoom < 0.95
    src = np.full((300, 400, 3), 200, np.uint8)
    out = dv.apply_geometry(Image.fromarray(src), p, (400, 300)).rgb
    assert out.min() > 0.7
    loose = dv.apply_geometry(Image.fromarray(src), {**p, "transform": {**p["transform"], "constrain": False}}, (400, 300)).rgb
    assert loose.min() == 0.0


def horizon(w=600, h=400, ang=3.0) -> np.ndarray:
    im = Image.new("L", (w * 2, h * 2), 128)
    d = ImageDraw.Draw(im)
    for i, y in enumerate(range(0, h * 2, 60)):
        d.rectangle([0, y, w * 2, y + 30], fill=40 if i % 2 else 210)
    im = im.rotate(ang, resample=Image.Resampling.BICUBIC).crop((w // 2, h // 2, w // 2 + w, h // 2 + h))
    return grey(np.asarray(im))


@pytest.mark.parametrize("ang", [3.0, -2.2])
def test_upright_level_fixes_a_rotated_horizon(ang):
    src = horizon(ang=ang)  # PIL turns counter-clockwise: the picture's clockwise tilt is -ang
    r = up.upright(src, "level")
    assert r["angle"] == pytest.approx(ang, abs=0.5)
    p = dv.normalise({"transform": {"upright": "level", "uprightMatrix": r["matrix"]}})
    fixed = u8(dv.apply_geometry(Image.fromarray(src), p, (600, 400)).rgb)
    assert abs(up.level_angle(up.lines(fixed)[0])) < 0.5
    # Crop's Auto straighten uses the same number as a plain rotate
    straight = np.asarray(dv.apply_geometry(Image.fromarray(src), dv.normalise({"rotate": r["angle"]}), (600, 400)))
    assert abs(up.level_angle(up.lines(straight)[0])) < 0.5


def test_upright_vertical_makes_verticals_parallel():
    w, h = 600, 450
    im = Image.new("L", (w, h), 200)
    d = ImageDraw.Draw(im)
    for x in range(30, w, 70):
        d.rectangle([x, 0, x + 25, h], fill=50)
    for y in range(40, h, 120):
        d.rectangle([0, y, w, y + 8], fill=120)
    keystone = gm.manual(dv.normalise({"transform": {"vertical": -40}})["transform"], w, h)
    p = dv.normalise({"transform": {"vertical": -40}})
    src = u8(gm.remap(grey(np.asarray(im)), gm.Warp(p, w, h), w, h))
    r = up.upright(src, "vertical")
    c = np.array([[w, 0, -w / 2], [0, h, -h / 2], [0, 0, 1.0]])
    total = c @ np.array(r["matrix"]).reshape(3, 3) @ keystone @ np.linalg.inv(c)
    v = total @ [0, 1, 0]  # where the scene's vertical direction ends up
    lean = max(abs(math.degrees(math.atan2(x - v[0] / v[2], v[1] / v[2]))) for x in (-w / 2, w / 2)) \
        if abs(v[2]) > 1e-12 else 0.0
    assert lean < 0.5
    assert up.upright(np.full((80, 80, 3), 128, np.uint8), "auto")["matrix"] is None


# ------------------------------------------------------------------ RAW master

def test_master_tiff_round_trip(tmp_path):
    lin = (rng.random((30, 40, 3)) * 65535).astype(np.uint16)
    path = tmp_path / "x.master.tif"
    dv.write_master(path, lin, 2.5)
    arr, desc = dv.read_tiff16(path)
    assert np.array_equal(np.asarray(arr), lin) and desc.endswith("gain=2.500000")
    del arr
    assert Image.open(path).size == (40, 30)  # an ordinary TIFF to other tools


def test_raw_master_is_preferred_and_recovers_highlights(client, tmp_path):
    from tests.test_photo import upload

    # a "RAW" whose sky is twice as bright as the JPEG can hold
    h, w = 120, 160
    lin = np.zeros((h, w, 3), np.float32)
    lin[:] = 0.18
    lin[:40] = np.linspace(0.6, 1.6, w)[None, :, None]  # past white from the middle on
    shown = dv.quantise(dv.enc(np.minimum(lin, 1)))
    ids = upload(client, shown)
    with SessionLocal() as db:
        g = db.get(Generation, ids["gen"])
        path = get_settings().data_dir / g.file_path
    dv.write_master(dv.master_path(path), (np.clip(lin / 2, 0, 1) * 65535).astype(np.uint16), 2.0)
    im, size = dv.open_image(path)
    assert isinstance(im, dv.Pixels) and im.linear and size == (w, h) and im.rgb.max() > 1.5
    small, _ = dv.open_image(path, 50)
    assert max(small.size) <= 50
    r = client.post(f"/api/photo/{ids['gen']}/preview", json={"params": {"version": 2, "exposure": -1}, "max_side": 160})
    assert r.status_code == 200
    out = np.asarray(Image.open(io.BytesIO(r.content)).convert("L"), np.float32)
    sky = out[5:35, w // 2:]
    assert np.ptp(sky.mean(axis=0)) > 30  # the JPEG has a flat white band there; the master doesn't
    flat = np.asarray(Image.fromarray(shown).convert("L"), np.float32)[5:35, w // 2 + 10:]
    assert np.ptp(flat.mean(axis=0)) < 3
    # analysis and Auto still read 8-bit pictures
    from app.photo import service as svc

    with SessionLocal() as db:
        assert svc.source_rgb(db.get(Generation, ids["gen"]), 64).dtype == np.uint8


def test_raw_import_writes_a_master_beside_the_jpeg(client, monkeypatch):
    rawpy = pytest.importorskip("rawpy")
    from tests.test_catalogue import upload as cat_upload

    lin = np.zeros((90, 160, 3), np.uint16)
    lin[:] = (20000, 12000, 6000)
    lin[:10] = 65535

    class FakeRaw:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def postprocess(self, **kw):
            assert kw["output_bps"] == 16 and kw["gamma"] == (1, 1) and kw["no_auto_bright"] is True
            return lin

    monkeypatch.setattr(rawpy, "imread", lambda p: FakeRaw())
    item = cat_upload(client, "DSC_2.NEF", b"II*\x00\x08\x00\x00\x00" + b"\0" * 400)
    with SessionLocal() as db:
        from app.models import MediaItem

        g = db.get(Generation, db.get(MediaItem, item["id"]).generation_id)
        jpg = get_settings().data_dir / g.file_path
    master = dv.master_path(jpg)
    assert master.is_file()
    im, _ = dv.open_image(jpg)
    shown = np.asarray(Image.open(jpg).convert("RGB"), np.float32)
    assert np.abs(dv.quantise(dv.split(im)[0]).astype(np.float32) - shown).mean() < 2.5


# ------------------------------------------------------------------ API and presets

def test_upright_ca_and_mask_endpoints(client):
    from tests.test_photo import upload

    ids = upload(client, horizon(300, 200, 2.5))
    r = client.post(f"/api/photo/{ids['gen']}/upright", json={"mode": "level"})
    assert r.status_code == 200 and r.json()["angle"] == pytest.approx(2.5, abs=0.6) and len(r.json()["matrix"]) == 9
    assert client.post(f"/api/photo/{ids['gen']}/upright", json={"mode": "sideways"}).status_code == 422
    r = client.post(f"/api/photo/{ids['gen']}/lens/ca")
    assert r.status_code == 200 and {"caRed", "caBlue"} <= r.json().keys()
    r = client.post(f"/api/photo/{ids['gen']}/preview", json={"params": {"version": 2, "sharpen": {"amount": 50, "masking": 60}},
                                                              "max_side": 200, "debug": "sharpen_mask"})
    assert r.status_code == 200
    mask = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"))
    assert np.ptp(mask[..., 0]) > 100 and np.abs(mask[..., 0].astype(int) - mask[..., 2]).max() <= 2
    # a mode without its matrix (a pasted preset) is measured when it renders
    r = client.post(f"/api/photo/{ids['gen']}/render", json={"params": {"version": 2, "transform": {"upright": "level"}}})
    assert r.status_code == 202
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["generation_id"])
        assert len(g.params["develop"]["params"]["transform"]["uprightMatrix"]) == 9


def test_sync_measures_upright_again():
    from app.photo import workflow as wf

    mine = dv.normalise({})
    theirs = dv.normalise({"transform": {"upright": "auto", "uprightMatrix": [1, 0, 0.01, 0, 1, 0, 0, 0, 1]},
                           "lens": {"caAuto": True, "caRed": 20, "caBlue": -10}})
    out = wf.merge_groups(mine, theirs, ["transform", "lens"])
    assert out["transform"]["upright"] == "auto" and out["transform"]["uprightMatrix"] is None
    assert out["lens"]["caAuto"] and out["lens"]["caRed"] == 0


XMP_D2B = """<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
 <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Texture="+25" crs:Dehaze="-12"
  crs:Sharpness="60" crs:SharpenRadius="+1.4" crs:SharpenDetail="35" crs:SharpenEdgeMasking="20"
  crs:LuminanceSmoothing="30" crs:LuminanceNoiseReductionDetail="60" crs:LuminanceNoiseReductionContrast="10"
  crs:ColorNoiseReduction="25" crs:ColorNoiseReductionDetail="40" crs:ColorNoiseReductionSmoothness="70"
  crs:LensManualDistortionAmount="-8" crs:VignetteAmount="+30" crs:VignetteMidpoint="40" crs:AutoLateralCA="1"
  crs:DefringePurpleAmount="5" crs:DefringePurpleHueLo="25" crs:DefringePurpleHueHi="75"
  crs:DefringeGreenAmount="3" crs:DefringeGreenHueLo="45" crs:DefringeGreenHueHi="55"
  crs:PerspectiveVertical="-20" crs:PerspectiveHorizontal="5" crs:PerspectiveRotate="1.5" crs:PerspectiveAspect="4"
  crs:PerspectiveScale="95" crs:PerspectiveX="2" crs:PerspectiveY="-3" crs:PerspectiveUpright="3"
  crs:UprightVersion="151388160" crs:CropConstrainToWarp="1" crs:HasCrop="True" crs:CropAngle="-2.5"
  crs:CropLeft="0.1" crs:CropTop="0.05" crs:CropRight="0.9" crs:CropBottom="0.95"/>
</rdf:RDF></x:xmpmeta>"""


def test_xmp_maps_the_d2b_keys():
    out = xmp.parse("d2b.xmp", XMP_D2B.encode(), size=(1000, 800))
    p = out["params"]
    assert (p["texture"], p["dehaze"]) == (25, -12)
    assert p["sharpen"] == {"amount": 60, "radius": 1.4, "detail": 35, "masking": 20}
    assert p["nr"] == {"luminance": 30, "detail": 60, "contrast": 10, "color": 25, "colorDetail": 40, "smoothness": 70}
    lens = p["lens"]
    assert (lens["distortion"], lens["vignette"], lens["vignetteMidpoint"], lens["caAuto"]) == (-8, 30, 40, True)
    assert (lens["purpleAmount"], lens["purpleHueLo"], lens["greenHueHi"]) == (5, 25, 55)
    t = p["transform"]
    assert (t["vertical"], t["horizontal"], t["rotate"], t["aspect"], t["scale"], t["offsetX"], t["offsetY"]) == \
        (-20, 5, 1.5, 4, 95, 2, -3)
    assert t["upright"] == "vertical" and t["constrain"] is True and t["uprightMatrix"] is None
    assert p["rotate"] == -2.5 and p["crop"] == {"x": 100, "y": 40, "width": 800, "height": 720}
    assert out["unmapped"] == []
    # without a picture the box can't be placed and says so
    assert "CropLeft" in xmp.parse("d2b.xmp", XMP_D2B.encode())["unmapped"]


def test_schema_and_sparse_cover_the_new_groups(client):
    s = client.get("/api/photo/schema").json()
    assert s["ranges"]["sharpen.radius"] == {"min": 0.5, "max": 3.0, "step": 0.1, "default": 1.0, "label": "Radius",
                                             "spatial": True}
    assert s["ranges"]["lens.distortion"]["spatial"] is False and s["ranges"]["lens.purpleAmount"]["spatial"] is True
    assert {"lens", "transform"} <= set(s["switchable"]) and "geometry" not in s["switchable"]
    basic = next(g for g in s["groups"] if g["id"] == "basic")["keys"]
    assert basic.index("texture") < basic.index("clarity") < basic.index("dehaze") < basic.index("vibrance")
    assert dv.sparse({"sharpen": {"amount": 30}, "transform": {"constrain": True}}) == \
        {"version": 2, "sharpen": {"amount": 30.0}, "transform": {"constrain": True}}
    assert dv.is_identity({"sharpen": {"radius": 1.0}, "lens": {"vignetteMidpoint": 50}})
    assert set(dv.spatial_used({"dehaze": 20, "lens": {"distortion": 5}})) == {"dehaze", "lens"}
    off = dv.bypass(dv.normalise({"lens": {"vignette": 40}, "off": ["lens"]}))
    assert off["lens"] == dv.DEFAULTS["lens"]


def test_defringe_hues_follow_the_sliders():
    lens = dv.normalise({"lens": {"purpleAmount": 10}})["lens"]
    (plo, phi), (glo, ghi) = cl.fringe_hues(lens)
    assert (plo, phi) == (242.0, 298.0) and (glo, ghi) == (108.0, 132.0)
    h = np.array([270.0, 0.0, 120.0])
    w = cl.defringe_weight(h, np.ones(3), lens)
    assert w[0] == pytest.approx(0.5) and w[1] == 0 and w[2] == 0
