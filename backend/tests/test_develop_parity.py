"""Develop v2 point operations, and the parity fixture that pins the browser's copy of the maths.

frontend/src/test/develop-parity.json holds real engine renders of small images; the frontend test runs
lib/photo/maths.ts on the same pixels and has to land within a couple of 8-bit steps. Run with
UPDATE_PARITY=1 after changing any formula on purpose.
"""
import json
import os
from pathlib import Path

import numpy as np
import pytest

from app.photo import colour as cl
from app.photo import develop as dv

FIXTURE = Path(__file__).resolve().parents[2] / "frontend" / "src" / "test" / "develop-parity.json"
W, H = 6, 4

CASES = {
    "identity": {},
    "exposure_ev": {"version": 2, "exposure": 0.8, "contrast": 20},
    "v1_exposure": {"exposure": 50},
    "wb_tone": {"version": 2, "temperature": 30, "tint": -20, "highlights": -40, "shadows": 35, "whites": 10, "blacks": -15},
    "curve_points": {"version": 2, "curve": {"mids": 20}, "pcurve": {"highlights": 60, "darks": -40, "s2": 40},
                     "points": {"rgb": [[0, 0], [64, 50], [190, 210], [255, 255]], "blue": [[0, 20], [255, 235]]}},
    "refine": {"version": 2, "contrast": 70, "refineSat": 0},
    "hsl_point_color": {"version": 2, "hsl": {"red": {"h": 30, "s": -20}, "blue": {"l": 25}},
                        "pointColor": [{"hue": 20, "sat": 0.6, "val": 0.7, "dh": 50, "ds": -30, "dl": 20,
                                        "hueRange": 70, "satRange": 60, "lumRange": 60}]},
    "bw": {"version": 2, "treatment": "bw", "bw": {"red": 60, "blue": -40, "green": 20}},
    "vibrance": {"version": 2, "vibrance": 60, "saturation": -20},
    "grading": {"version": 2, "grading": {"shadows": {"h": 210, "s": 60, "l": -20}, "midtones": {"h": 90, "s": 20},
                                          "highlights": {"h": 40, "s": 50, "l": 15}, "global": {"h": 300, "s": 10},
                                          "blending": 70, "balance": -30}},
    "calibration": {"version": 2, "calibration": {"shadowsTint": 40, "redHue": 50, "greenSat": -40, "blueHue": -30, "blueSat": 30}},
    "vignette_v1": {"vignette": -60},
    "vignette_shape": {"version": 2, "vignette": -70, "vignetteMidpoint": 30, "vignetteRoundness": -60,
                       "vignetteFeather": 20, "vignetteHighlights": 60},
    "vignette_round_white": {"version": 2, "vignette": 50, "vignetteRoundness": 80},
    "grain": {"version": 2, "grainAmount": 70, "grainSize": 60, "grainRoughness": 80},
}


def pixels(seed: int = 7) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = rng.random((H, W, 3))
    img[0, 0], img[0, 1], img[1, 0] = (0.95, 0.2, 0.15), (0.2, 0.4, 0.9), (0.5, 0.5, 0.5)
    return (img * 255).round().astype(np.uint8)


def build() -> dict:
    src = pixels()
    out = {"w": W, "h": H, "src": (src / 255.0).round(6).reshape(-1, 3).tolist(), "cases": {}}
    for name, p in CASES.items():
        res = dv.develop(src, p)
        out["cases"][name] = {"params": p, "out": res.reshape(-1, 3).round(5).tolist()}
    return out


def test_parity_fixture_is_current():
    data = build()
    if os.environ.get("UPDATE_PARITY") or not FIXTURE.exists():
        FIXTURE.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    saved = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert saved["cases"].keys() == data["cases"].keys(), "run with UPDATE_PARITY=1"
    for name, case in data["cases"].items():
        assert np.allclose(saved["cases"][name]["out"], case["out"], atol=1e-4), f"{name} changed: UPDATE_PARITY=1"


def test_every_v2_tool_does_something_and_stays_in_range():
    src = pixels(3)
    base = dv.develop(src, {})
    for name, p in CASES.items():
        if name in ("identity",):
            continue
        out = dv.develop(src, p)
        assert out.min() >= 0 and out.max() <= 1, name
        assert np.abs(out - base).mean() > 1e-3, name


def test_v1_vignette_is_the_v2_default_shape():
    u, v = np.meshgrid(np.linspace(0, 1, 9), np.linspace(0, 1, 7))
    p = dv.normalise({"vignette": -50})
    d = np.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.75
    old = 0.8 * 0.5 * cl.smoothstep(0.5, 1.0, d)
    assert np.allclose(cl.vignette_alpha(u, v, 1.5, p), old, atol=1e-6)


def test_monotone_curve_is_monotone_and_hits_its_points():
    x = np.linspace(0, 1, 1001)
    pts = [[0, 0], [40, 90], [128, 100], [200, 230], [255, 255]]
    y = cl.monotone(pts, x)
    assert np.all(np.diff(y) >= -1e-9)
    for px, py in pts:
        assert y[int(round(px / 255 * 1000))] == pytest.approx(py / 255, abs=0.01)


def test_profiles_bake_and_amount():
    from app.photo import profiles

    src = pixels(5)
    plain = dv.develop(src, {})
    vivid = dv.develop(src, {"version": 2, "profile": {"id": "vivid", "amount": 100}})
    double = dv.develop(src, {"version": 2, "profile": {"id": "vivid", "amount": 200}})
    assert np.abs(vivid - plain).mean() > 0.005 and np.abs(double - plain).mean() > np.abs(vivid - plain).mean()
    assert profiles.table("color") is None and dv.normalise({"profile": {"id": "color"}})["profile"] is None
    assert {p["id"] for p in profiles.listing()} >= {"color", "neutral", "landscape", "portrait", "vivid", "monochrome"}


def test_profile_and_look_lut_endpoints(client):
    r = client.get("/api/photo/profiles")
    assert r.status_code == 200 and any(p["id"] == "vivid" for p in r.json())
    t = client.get("/api/photo/luts/profile/vivid").json()
    import base64

    assert t["size"] == 33 and len(base64.b64decode(t["data"])) == 33 ** 3 * 3
    assert client.get("/api/photo/luts/profile/nope").status_code == 404
