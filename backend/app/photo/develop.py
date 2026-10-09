"""Develop: Lightroom-style adjustments (a port of NoorViz develop.js, same sliders and presets).

Unlike the original (8-bit, everything in gamma space) this runs on float32 and puts each step in the space
where its maths is right: white balance, exposure, local light, saturation and vignette in linear light; the
tone curve, HSL and sharpening in sRGB, where the sliders are perceptual. The exact formulas are in
docs/api/contract-v9-photo.md because the WebGL preview has to reproduce them.

Point operations run in row blocks so a 24 MP render never holds more than a few full-size float copies.
"""
import copy
import io
import math
import os
import struct
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from app.photo import colour as cl
from app.photo.lut import apply_lut

# 2: exposure in EV (-5..+5) like Lightroom; v1 stored -100..100 for +-1.5 EV and is converted on read
PARAMS_VERSION = 2

HSL_BANDS = (("red", "Red", 0), ("orange", "Orange", 30), ("yellow", "Yellow", 60), ("green", "Green", 120),
             ("aqua", "Aqua", 180), ("blue", "Blue", 240), ("purple", "Purple", 270), ("magenta", "Magenta", 300))
CURVE_POINTS = (("blacks", "Blacks", 0.0), ("shadows", "Shadows", 0.25), ("mids", "Midtones", 0.5),
                ("highlights", "Highlights", 0.75), ("whites", "Whites", 1.0))

# key: (min, max, label, spatial)
SLIDERS = {
    "temperature": (-100, 100, "Temperature", False),
    "tint": (-100, 100, "Tint", False),
    "exposure": (-5, 5, "Exposure", False),
    "contrast": (-100, 100, "Contrast", False),
    "highlights": (-100, 100, "Highlights", False),
    "shadows": (-100, 100, "Shadows", False),
    "whites": (-100, 100, "Whites", False),
    "blacks": (-100, 100, "Blacks", False),
    "vibrance": (-100, 100, "Vibrance", False),
    "saturation": (-100, 100, "Saturation", False),
    "clarity": (-100, 100, "Clarity", True),
    "sharpness": (0, 100, "Sharpening", True),
    "noiseReduction": (0, 100, "Noise reduction", True),
    "vignette": (-100, 100, "Vignette", False),
    "vignetteMidpoint": (0, 100, "Midpoint", False),
    "vignetteRoundness": (-100, 100, "Roundness", False),
    "vignetteFeather": (0, 100, "Feather", False),
    "vignetteHighlights": (0, 100, "Highlights", False),
    "grainAmount": (0, 100, "Grain", False),
    "grainSize": (0, 100, "Size", False),
    "grainRoughness": (0, 100, "Roughness", False),
    "refineSat": (0, 100, "Refine saturation", False),
}
STEPS = {"exposure": 0.01}
# sliders whose neutral position is not 0
SLIDER_DEFAULTS = {"vignetteMidpoint": 50, "vignetteFeather": 50, "grainSize": 25, "grainRoughness": 50, "refineSat": 100}
PCURVE_KEYS = (("highlights", "Highlights"), ("lights", "Lights"), ("darks", "Darks"), ("shadows", "Shadows"))
PCURVE_SPLITS = {"s1": 25, "s2": 50, "s3": 75}
CURVE_CHANNELS = ("rgb", "red", "green", "blue")
GRADE_ZONES = ("shadows", "midtones", "highlights", "global")
CALIBRATION_KEYS = (("shadowsTint", "Shadows tint"), ("redHue", "Red hue"), ("redSat", "Red saturation"),
                    ("greenHue", "Green hue"), ("greenSat", "Green saturation"), ("blueHue", "Blue hue"),
                    ("blueSat", "Blue saturation"))
VIGNETTE_STYLES = ("highlight", "color", "paint")
SPATIAL_KEYS = ("clarity", "sharpness", "noiseReduction", "lightPoints")
# what a .cube (or a video grade) can't carry: anything that looks at neighbours or at the pixel's position
NOT_IN_LUT = ("clarity", "sharpness", "noiseReduction", "vignette", "lightPoints", "grainAmount")
MAX_POINTS = 16

DEFAULTS = {
    "version": PARAMS_VERSION,
    "exposure": 0, "contrast": 0, "highlights": 0, "shadows": 0, "whites": 0, "blacks": 0,
    "temperature": 0, "tint": 0, "vibrance": 0, "saturation": 0,
    "clarity": 0, "sharpness": 0, "noiseReduction": 0, "vignette": 0,
    "curve": {k: 0 for k, _, _ in CURVE_POINTS},
    "hsl": {k: {"h": 0, "s": 0, "l": 0} for k, _, _ in HSL_BANDS},
    "crop": None, "rotate": 0, "flipH": False, "flipV": False,
    "lightPoints": [],
    "palette": [],
    "lut": None,
    # params v2 (M10 / D2): every slider present, at its own neutral value
    **{k: SLIDER_DEFAULTS.get(k, 0) for k in SLIDERS if k not in ("exposure", "contrast", "highlights", "shadows",
                                                                   "whites", "blacks", "temperature", "tint", "vibrance",
                                                                   "saturation", "clarity", "sharpness",
                                                                   "noiseReduction", "vignette")},
    "vignetteStyle": "highlight",
    "profile": None,
    "treatment": "color",
    "bw": {k: 0 for k, _, _ in HSL_BANDS},
    "pcurve": {**{k: 0 for k, _ in PCURVE_KEYS}, **PCURVE_SPLITS},
    "points": {c: [] for c in CURVE_CHANNELS},
    "pointColor": [],
    "grading": {**{z: {"h": 0, "s": 0, "l": 0} for z in GRADE_ZONES}, "blending": 50, "balance": 0},
    "calibration": {k: 0 for k, _ in CALIBRATION_KEYS},
    # panels switched off with their eye icon: settings kept, effect bypassed (Lightroom's panel switch)
    "off": [],
}

GROUPS = [
    {"id": "basic", "label": "Basic", "keys": ["profile", "treatment", "temperature", "tint", "exposure", "contrast",
                                               "highlights", "shadows", "whites", "blacks", "vibrance", "saturation"]},
    {"id": "curve", "label": "Tone curve", "keys": [f"curve.{k}" for k, _, _ in CURVE_POINTS]
     + [f"pcurve.{k}" for k, _ in PCURVE_KEYS] + ["points", "refineSat"]},
    {"id": "hsl", "label": "Colour mixer", "keys": ["hsl", "pointColor", "bw"]},
    {"id": "grading", "label": "Colour grading", "keys": ["grading"]},
    {"id": "detail", "label": "Detail", "keys": ["clarity", "sharpness", "noiseReduction"]},
    {"id": "effects", "label": "Effects", "keys": ["vignette", "vignetteMidpoint", "vignetteRoundness", "vignetteFeather",
                                                   "vignetteHighlights", "vignetteStyle", "grainAmount", "grainSize",
                                                   "grainRoughness"]},
    {"id": "calibration", "label": "Calibration", "keys": ["calibration"]},
    {"id": "local", "label": "Local light · Selective colour", "keys": ["lightPoints", "palette"]},
    {"id": "geometry", "label": "Crop & rotate", "keys": ["crop", "rotate", "flipH", "flipV"]},
    {"id": "look", "label": "Look", "keys": ["lut"]},
]


GROUP_KEYS = {g["id"]: [k.split(".")[0] for k in g["keys"]] for g in GROUPS}
# crop & rotate has no switch in Lightroom either: turning geometry off would move every pin and box
SWITCHABLE = tuple(g for g in GROUP_KEYS if g != "geometry")


def defaults() -> dict:
    return copy.deepcopy(DEFAULTS)


def ranges() -> dict:
    out = {k: {"min": lo, "max": hi, "step": STEPS.get(k, 1), "default": SLIDER_DEFAULTS.get(k, 0), "label": label,
               "spatial": sp} for k, (lo, hi, label, sp) in SLIDERS.items()}
    for k, label in PCURVE_KEYS:
        out[f"pcurve.{k}"] = {"min": -100, "max": 100, "step": 1, "default": 0, "label": label, "spatial": False}
    for k, d in PCURVE_SPLITS.items():
        out[f"pcurve.{k}"] = {"min": 5, "max": 95, "step": 1, "default": d, "label": "Split", "spatial": False}
    out["grading.h"] = {"min": 0, "max": 360, "step": 1, "default": 0, "label": "Hue", "spatial": False}
    out["grading.s"] = {"min": 0, "max": 100, "step": 1, "default": 0, "label": "Saturation", "spatial": False}
    out["grading.l"] = {"min": -100, "max": 100, "step": 1, "default": 0, "label": "Luminance", "spatial": False}
    out["grading.blending"] = {"min": 0, "max": 100, "step": 1, "default": 50, "label": "Blending", "spatial": False}
    out["grading.balance"] = {"min": -100, "max": 100, "step": 1, "default": 0, "label": "Balance", "spatial": False}
    for k, label in CALIBRATION_KEYS:
        out[f"calibration.{k}"] = {"min": -100, "max": 100, "step": 1, "default": 0, "label": label, "spatial": False}
    out["bw"] = {"min": -100, "max": 100, "step": 1, "default": 0, "label": "B&W mix", "spatial": False}
    out["profile.amount"] = {"min": 0, "max": 200, "step": 1, "default": 100, "label": "Amount", "spatial": False}
    for k, label, lo, hi, d in (("dh", "Hue", -100, 100, 0), ("ds", "Saturation", -100, 100, 0),
                                ("dl", "Luminance", -100, 100, 0), ("hueRange", "Hue range", 0, 100, 50),
                                ("satRange", "Saturation range", 0, 100, 50), ("lumRange", "Luminance range", 0, 100, 50)):
        out[f"pointColor.{k}"] = {"min": lo, "max": hi, "step": 1, "default": d, "label": label, "spatial": False,
                                  "max_items": cl.MAX_POINT_COLORS}
    for k, label, at in CURVE_POINTS:
        out[f"curve.{k}"] = {"min": -100, "max": 100, "step": 1, "default": 0, "label": label, "at": at, "spatial": False}
    for ch, label in (("h", "Hue"), ("s", "Saturation"), ("l", "Luminance")):
        out[f"hsl.{ch}"] = {"min": -100, "max": 100, "step": 1, "default": 0, "label": label, "spatial": False}
    out["rotate"] = {"min": -180, "max": 180, "step": 0.1, "default": 0, "label": "Rotate", "spatial": False}
    out["lightPoints.exposure"] = {"min": -100, "max": 100, "step": 1, "default": 0, "label": "Exposure",
                                   "spatial": True, "max_items": MAX_POINTS}
    out["palette.h"] = {"min": -100, "max": 100, "step": 1, "default": 0, "label": "Hue", "spatial": False,
                        "max_items": MAX_POINTS}
    out["lut.amount"] = {"min": 0, "max": 100, "step": 1, "default": 100, "label": "Amount", "spatial": False}
    return out


def _num(v, lo, hi, default=0.0) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(x):
        return default
    return max(lo, min(hi, x))


def normalise(p: dict | None) -> dict:
    """Full params with defaults filled in and every number clamped. Imports and presets go through here;
    the API validates first (pydantic) so users get a 422 instead of a silent clamp."""
    p = p or {}
    out = defaults()
    v1 = int(_num(p.get("version"), 0, 99, 1)) < 2
    for k, (lo, hi, _, _) in SLIDERS.items():
        if p.get(k) is not None:
            raw = p[k]
            if k == "exposure" and v1:
                # v1 slider: +-100 was +-1.5 EV
                raw = round(_num(raw, -100, 100) * 0.015, 3)
            out[k] = _num(raw, lo, hi, SLIDER_DEFAULTS.get(k, 0.0))
    for k, _, _ in CURVE_POINTS:
        out["curve"][k] = _num((p.get("curve") or {}).get(k), -100, 100)
    for k, _, _ in HSL_BANDS:
        band = (p.get("hsl") or {}).get(k) or {}
        out["hsl"][k] = {c: _num(band.get(c), -100, 100) for c in "hsl"}
    c = p.get("crop")
    if isinstance(c, dict) and _num(c.get("width"), 0, 1e6) > 0 and _num(c.get("height"), 0, 1e6) > 0:
        out["crop"] = {k: _num(c.get(k), 0, 1e6) for k in ("x", "y", "width", "height")}
    out["rotate"] = _num(p.get("rotate"), -180, 180)
    out["flipH"], out["flipV"] = bool(p.get("flipH")), bool(p.get("flipV"))
    pts = []
    for pt in (p.get("lightPoints") or [])[:MAX_POINTS]:
        if not isinstance(pt, dict):
            continue
        q = {"x": _num(pt.get("x"), -1e6, 1e6), "y": _num(pt.get("y"), -1e6, 1e6),
             "exposure": _num(pt.get("exposure"), -100, 100)}
        for k in ("falloff", "refW", "refH"):
            if pt.get(k) is not None and _num(pt.get(k), 0, 1e6) > 0:
                q[k] = _num(pt.get(k), 0, 1e6)
        pts.append(q)
    out["lightPoints"] = pts
    pal = []
    for c in (p.get("palette") or [])[:MAX_POINTS]:
        if not isinstance(c, dict):
            continue
        pal.append({"centerR": _num(c.get("centerR"), 0, 255), "centerG": _num(c.get("centerG"), 0, 255),
                    "centerB": _num(c.get("centerB"), 0, 255), "enabled": c.get("enabled", True) is not False,
                    "h": _num(c.get("h"), -100, 100), "s": _num(c.get("s"), -100, 100),
                    "l": _num(c.get("l"), -100, 100)})
    out["palette"] = pal
    lut = p.get("lut")
    if isinstance(lut, dict) and lut.get("look_id"):
        out["lut"] = {"look_id": str(lut["look_id"]), "amount": _num(lut.get("amount", 100), 0, 100, 100.0)}
    off = p.get("off") or []
    out["off"] = [g for g in SWITCHABLE if isinstance(off, (list, tuple)) and g in off]
    _normalise_v2(p, out)
    return out


def _sub(p: dict, key: str) -> dict:
    v = p.get(key)
    return v if isinstance(v, dict) else {}


def _normalise_v2(p: dict, out: dict) -> None:
    out["vignetteStyle"] = p.get("vignetteStyle") if p.get("vignetteStyle") in VIGNETTE_STYLES else "highlight"
    out["treatment"] = "bw" if p.get("treatment") == "bw" else "color"
    prof = p.get("profile")
    if isinstance(prof, dict) and prof.get("id") and prof["id"] != "color":
        out["profile"] = {"id": str(prof["id"])[:60], "amount": _num(prof.get("amount", 100), 0, 200, 100.0)}
    out["bw"] = {k: _num(_sub(p, "bw").get(k), -100, 100) for k, _, _ in HSL_BANDS}
    pc = _sub(p, "pcurve")
    out["pcurve"] = {k: _num(pc.get(k), -100, 100) for k, _ in PCURVE_KEYS}
    out["pcurve"].update({k: _num(pc.get(k), 5, 95, float(d)) for k, d in PCURVE_SPLITS.items()})
    pts = _sub(p, "points")
    for c in CURVE_CHANNELS:
        clean = []
        for pt in (pts.get(c) or [])[:cl.MAX_CURVE_POINTS]:
            if isinstance(pt, (list, tuple)) and len(pt) == 2:
                clean.append([_num(pt[0], 0, 255), _num(pt[1], 0, 255)])
        out["points"][c] = clean if cl.points_active(clean) else []
    pcs = []
    for e in (p.get("pointColor") or [])[:cl.MAX_POINT_COLORS]:
        if not isinstance(e, dict):
            continue
        pcs.append({"hue": _num(e.get("hue"), 0, 360), "sat": _num(e.get("sat"), 0, 1), "val": _num(e.get("val"), 0, 1),
                    "dh": _num(e.get("dh"), -100, 100), "ds": _num(e.get("ds"), -100, 100),
                    "dl": _num(e.get("dl"), -100, 100), "hueRange": _num(e.get("hueRange"), 0, 100, 50.0),
                    "satRange": _num(e.get("satRange"), 0, 100, 50.0),
                    "lumRange": _num(e.get("lumRange"), 0, 100, 50.0)})
    out["pointColor"] = pcs
    g = _sub(p, "grading")
    for z in GRADE_ZONES:
        gz = _sub(g, z)
        out["grading"][z] = {"h": _num(gz.get("h"), 0, 360), "s": _num(gz.get("s"), 0, 100),
                             "l": _num(gz.get("l"), -100, 100)}
    out["grading"]["blending"] = _num(g.get("blending"), 0, 100, 50.0)
    out["grading"]["balance"] = _num(g.get("balance"), -100, 100)
    out["calibration"] = {k: _num(_sub(p, "calibration").get(k), -100, 100) for k, _ in CALIBRATION_KEYS}


def bypass(p: dict) -> dict:
    """The params a render actually uses: switched-off groups back at their defaults."""
    if not p.get("off"):
        return p
    out = dict(p)
    for g in p["off"]:
        for k in GROUP_KEYS.get(g, []):
            out[k] = copy.deepcopy(DEFAULTS[k])
    return out


def sparse(p: dict | None) -> dict:
    """Only what differs from the defaults (how looks are stored: applying one leaves other sliders alone)."""
    full, base = normalise(p), DEFAULTS
    # the version always travels: without it a stored v2 exposure would be read as v1
    out = {"version": PARAMS_VERSION}
    for k, v in full.items():
        if k == "version" or v == base[k]:
            continue
        if k in ("curve", "bw", "calibration"):
            v = {c: x for c, x in v.items() if x}
        elif k == "pcurve":
            v = {c: x for c, x in v.items() if x != base[k][c]}
        elif k == "points":
            v = {c: x for c, x in v.items() if x}
        elif k == "hsl":
            v = {band: {c: x for c, x in vals.items() if x} for band, vals in v.items() if any(vals.values())}
        elif k == "grading":
            v = {z: (x if z in ("blending", "balance") else {c: y for c, y in x.items() if y})
                 for z, x in v.items() if x != base[k][z]}
        out[k] = v
    return out


def is_identity(p: dict) -> bool:
    p = normalise(p)
    return p == normalise({})


def spatial_used(p: dict) -> list[str]:
    """Non-zero params a .cube can't carry."""
    p = normalise(p)
    out = [k for k in NOT_IN_LUT if k != "lightPoints" and abs(p[k]) > 0.5]
    if any(abs(pt["exposure"]) > 0.5 for pt in p["lightPoints"]):
        out.append("lightPoints")
    return out


# ---------------------------------------------------------------- colour

def srgb_to_linear(v):
    v = np.asarray(v, dtype=np.float64)
    return np.where(v <= 0.04045, v / 12.92, ((np.maximum(v, 0) + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x):
    x = np.asarray(x, dtype=np.float64)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.maximum(x, 0) ** (1 / 2.4) - 0.055)


# hot-path tables: nearest entry of 16384 is within 1/30000 of the exact curve, far below a 16-bit step
_M = 16384
_MGRID = np.linspace(0.0, 1.0, _M)
# enc is steep near black, so its table is indexed by sqrt(linear) to keep the shadows exact
_ENC_SQRT = linear_to_srgb(_MGRID ** 2).astype(np.float32)
_DEC = srgb_to_linear(_MGRID).astype(np.float32)
DEC8 = srgb_to_linear(np.arange(256) / 255.0).astype(np.float32)
_DEC16 = None
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def lookup(x: np.ndarray, table: np.ndarray) -> np.ndarray:
    """table sampled uniformly over 0..1; x is clamped. Nearest entry (the tables are fine enough)."""
    n = table.shape[0] - 1
    if np.ndim(x) == 0:
        return table[int(min(n, max(0.0, float(x) * n + 0.5)))]
    i = np.multiply(x, n, dtype=np.float32)
    i += 0.5
    np.clip(i, 0, n, out=i)
    return table.take(i.astype(np.int32))


def enc(lin: np.ndarray) -> np.ndarray:
    return lookup(np.sqrt(np.maximum(lin, 0.0)), _ENC_SQRT)


def dec(p: np.ndarray) -> np.ndarray:
    return lookup(p, _DEC)


def to_linear(src: np.ndarray) -> np.ndarray:
    global _DEC16
    if src.dtype == np.uint8:
        return DEC8.take(src)
    if src.dtype == np.uint16:
        if _DEC16 is None:
            _DEC16 = srgb_to_linear(np.arange(65536) / 65535.0).astype(np.float32)
        return _DEC16.take(src)
    return dec(src.astype(np.float32, copy=False))


def to_unit(src: np.ndarray) -> np.ndarray:
    if src.dtype == np.uint8:
        return src.astype(np.float32) / 255.0
    if src.dtype == np.uint16:
        return src.astype(np.float32) / 65535.0
    return src.astype(np.float32, copy=False)


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb @ LUMA


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- tone

def tone_curve(p: dict, n: int = _M) -> np.ndarray:
    """T sampled at n points over 0..1 (sRGB in, sRGB out). Monotonic by construction (running max)."""
    x = np.linspace(0.0, 1.0, n)
    a = 0.5 * p["contrast"] / 100
    t = x + a * (x - 0.5) * 4 * x * (1 - x)
    anchors = [0.5 * p["curve"][k] / 100 for k, _, _ in CURVE_POINTS]
    off = np.interp(t, [0.0, 0.25, 0.5, 0.75, 1.0], anchors)

    def g(mu, s):
        return np.exp(-((t - mu) ** 2) / (2 * s * s))

    reg = 0.35 * (p["blacks"] / 100 * g(0.05, 0.10) + p["shadows"] / 100 * g(0.25, 0.18)
                  + p["highlights"] / 100 * g(0.70, 0.18) + p["whites"] / 100 * g(0.92, 0.10))
    out = np.clip(t + off + reg, 0.0, 1.0)
    return np.maximum.accumulate(out).astype(np.float32)


def tone_active(p: dict) -> bool:
    return any(abs(p[k]) > 0.01 for k in ("contrast", "highlights", "shadows", "whites", "blacks")) or \
        any(abs(v) > 0.01 for v in p["curve"].values()) or cl.parametric_active(p["pcurve"]) or \
        any(p["points"][c] for c in CURVE_CHANNELS)


def tone_tables(p: dict, n: int = _M) -> np.ndarray:
    """(n,) master curve, or (n, 3) when a red/green/blue curve is set. sRGB in, sRGB out."""
    y = tone_curve(p, n).astype(np.float64)
    if cl.parametric_active(p["pcurve"]):
        y = np.maximum.accumulate(np.clip(y + cl.parametric(y, p["pcurve"]), 0.0, 1.0))
    if p["points"]["rgb"]:
        y = cl.monotone(p["points"]["rgb"], y)
    chans = [p["points"][c] for c in ("red", "green", "blue")]
    if not any(chans):
        return y.astype(np.float32)
    return np.stack([cl.monotone(c, y) if c else y for c in chans], axis=1).astype(np.float32)


def wb_gains(p: dict) -> np.ndarray:
    t, m = p["temperature"] / 100, p["tint"] / 100
    g = np.array([(1 + 0.3 * t) * (1 + 0.15 * m), 1 - 0.15 * m, (1 - 0.3 * t) * (1 + 0.15 * m)]) ** 2.2
    return (g / float(g @ LUMA.astype(np.float64))).astype(np.float32)


# ---------------------------------------------------------------- HSV helpers

def rgb_to_hsv(p: np.ndarray):
    """(N, 3) float32 -> hue degrees, saturation, value (hexcone, like the NoorViz code)."""
    r, g, b = p[:, 0], p[:, 1], p[:, 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    d = mx - mn
    inv = np.divide(np.float32(60.0), d, out=np.zeros_like(d), where=d > 1e-7)
    h = np.where(mx == r, (g - b) * inv, np.where(mx == g, (b - r) * inv + 120, (r - g) * inv + 240))
    h[h < 0] += 360
    s = np.divide(d, mx, out=np.zeros_like(d), where=mx > 1e-7)
    return h, s, mx


def hsv_to_rgb(h, s, v) -> np.ndarray:
    # f(n) = V - V*S*clamp(min(k, 4-k), 0, 1), k = (n + H/60) mod 6: no branches, no np.choose
    h6 = (h * np.float32(1 / 60.0)) % 6
    vs = v * s
    out = np.empty(h.shape + (3,), dtype=np.float32)
    for c, n in enumerate((5.0, 3.0, 1.0)):
        k = (h6 + np.float32(n)) % 6
        np.minimum(k, 4 - k, out=k)
        np.clip(k, 0, 1, out=k)
        out[:, c] = v - vs * k
    return out


_HUE_STEPS = 4  # hue table resolution: quarter degrees


def _hsl_tables(p: dict) -> np.ndarray:
    """Per-hue adjustment (h°, s, l) at quarter-degree steps: neighbouring band centres blended linearly."""
    centres = [c for _, _, c in HSL_BANDS] + [360.0]
    vals = np.array([[p["hsl"][k][c] for c in "hsl"] for k, _, _ in HSL_BANDS], dtype=np.float64) / 100
    vals = np.vstack([vals, vals[:1]])
    hue = np.arange(360 * _HUE_STEPS + 1) / _HUE_STEPS
    table = np.stack([np.interp(hue, centres, vals[:, i]) for i in range(3)], axis=1)
    table[:, 0] *= 30.0
    table[:, 2] *= 0.5
    return table.astype(np.float32)


def refine_saturation(before: np.ndarray, after: np.ndarray, refine: float) -> np.ndarray:
    """Curves change saturation as a side effect; Refine below 100 pulls the chroma back toward before."""
    def chroma(x):
        return x.max(1) - x.min(1)

    y = after @ LUMA
    k = np.where(chroma(after) > 1e-5, chroma(before) / np.maximum(chroma(after), 1e-5), 1.0)
    k = 1 + (1 - refine) * (np.minimum(k, 4.0) - 1)
    return np.clip(y[:, None] + (after - y[:, None]) * k[:, None], 0, 1)


def hsl_active(p: dict) -> bool:
    return any(abs(v) > 0.01 for band in p["hsl"].values() for v in band.values())


def apply_hsl(pb: np.ndarray, table: np.ndarray) -> np.ndarray:
    h, s, v = rgb_to_hsv(pb)
    adj = table.take((h * _HUE_STEPS + 0.5).astype(np.int32), axis=0)
    w = _smoothstep(0.02, 0.10, s)
    h += w * adj[:, 0]
    s *= 1 + w * adj[:, 1]
    np.clip(s, 0, 1, out=s)
    v *= 1 + w * adj[:, 2]
    np.clip(v, 0, 1, out=v)
    return hsv_to_rgb(h, s, v)


# ---------------------------------------------------------------- palette (NoorViz soft-membership mixer)

def _palette_ctx(palette: list[dict]):
    active = [c for c in palette if not c["enabled"] or any(abs(c[k]) > 0.5 for k in "hsl")]
    if not active:
        return None
    centres = np.array([[c["centerR"], c["centerG"], c["centerB"]] for c in palette], dtype=np.float32)
    k = len(centres)
    if k > 1:
        d = np.sqrt(((centres[:, None, :] - centres[None, :, :]) ** 2).sum(-1))
        spread = d[np.triu_indices(k, 1)].mean()
    else:
        spread = 80.0
    sigma = max(20.0, spread * 0.55)
    shifts = np.array([[c["h"] / 100 * 36.0, c["s"] / 100, c["l"] / 100] for c in palette], dtype=np.float32)
    off = np.array([0.0 if c["enabled"] else 1.0 for c in palette], dtype=np.float32)
    shifts[off > 0] = 0
    return centres, 1.0 / (2 * sigma * sigma), shifts, off


def apply_palette(pb: np.ndarray, ctx) -> np.ndarray:
    centres, inv2s2, shifts, off = ctx
    px = pb * 255.0
    d2 = ((px[:, None, :] - centres[None, :, :]) ** 2).sum(-1)
    w = np.exp(-d2 * inv2s2)
    tot = w.sum(1, keepdims=True)
    w = np.where(tot > 1e-6, w / np.maximum(tot, 1e-6), 0.0)
    desat = w @ off
    sh = w @ shifts
    out = pb
    if np.abs(sh).max() > 1e-4:
        h, s, v = rgb_to_hsv(pb)
        out = hsv_to_rgb(h + sh[:, 0], np.clip(s * (1 + sh[:, 1]), 0, 1), np.clip(v * (1 + sh[:, 2]), 0, 1))
    if desat.max() > 1e-4:
        y = luma(out)[:, None]
        out = out + (y - out) * desat[:, None]
    return np.clip(out, 0, 1)


# ---------------------------------------------------------------- blurs (all separable, numpy only)

def _sl(axis: int, start: int, stop: int, ndim: int):
    idx = [slice(None)] * ndim
    idx[axis] = slice(start, stop)
    return tuple(idx)


def box1d(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    if r < 1:
        return a
    n = a.shape[axis]
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis, dtype=np.float32)
    out = c[_sl(axis, 2 * r + 1, 2 * r + 1 + n, a.ndim)] - c[_sl(axis, 0, n, a.ndim)]
    out *= np.float32(1.0 / (2 * r + 1))
    return out


def box2d(a: np.ndarray, r: int) -> np.ndarray:
    return box1d(box1d(a, r, 0), r, 1)


def _resize_f(a: np.ndarray, size: tuple[int, int], resample) -> np.ndarray:
    return np.asarray(Image.fromarray(np.ascontiguousarray(a, dtype=np.float32), "F").resize(size, resample))


def gaussian(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur of a 2-D float32 array: exact taps when narrow, three box passes when wide, and a wide
    blur of a big image runs on a shrunken copy (the result is smooth, so nothing is lost)."""
    if sigma < 0.25:
        return a
    h, w = a.shape
    if sigma > 6 and min(h, w) > 64:
        f = sigma / 3.0
        sw, sh = max(8, int(round(w / f))), max(8, int(round(h / f)))
        small = _resize_f(a, (sw, sh), Image.Resampling.BOX)
        small = gaussian(small, sigma * sw / w)
        return _resize_f(small, (w, h), Image.Resampling.BILINEAR)
    if sigma <= 3.0:
        rad = int(math.ceil(3 * sigma))
        k = np.exp(-(np.arange(-rad, rad + 1) ** 2) / (2 * sigma * sigma)).astype(np.float32)
        k /= k.sum()
        out = a
        for axis in (0, 1):
            pad = [(0, 0)] * 2
            pad[axis] = (rad, rad)
            pa = np.pad(out, pad, mode="edge")
            n = out.shape[axis]
            acc = pa[_sl(axis, 0, n, 2)] * k[0]
            for i in range(1, len(k)):
                acc += pa[_sl(axis, i, i + n, 2)] * k[i]
            out = acc
        return out
    r = max(1, int(round((math.sqrt(4 * sigma * sigma + 1) - 1) / 2)))
    out = a
    for _ in range(3):
        out = box2d(out, r)
    return out


def guided(img: np.ndarray, r: int, eps: float) -> np.ndarray:
    """Self-guided filter (He et al.): smooths flat areas, keeps edges whose variance beats eps."""
    mean = box2d(img, r)
    var = box2d(img * img, r) - mean * mean
    a = var / (var + eps)
    b = mean - a * mean
    return box2d(a, r) * img + box2d(b, r)


def by_strips(fn, a: np.ndarray, halo: int) -> np.ndarray:
    """fn over horizontal strips (with `halo` extra rows each side) on the thread pool, then stitched.
    Exact as long as fn's support is within the halo."""
    h = a.shape[0]
    if THREADS < 2 or h < 4 * THREADS or a.size < (1 << 20):
        return fn(a)
    edges = np.linspace(0, h, THREADS + 1).astype(int)

    def one(i):
        lo, hi = edges[i], edges[i + 1]
        top, bot = max(0, lo - halo), min(h, hi + halo)
        return fn(a[top:bot])[lo - top:lo - top + (hi - lo)]

    return np.concatenate(list(_pool().map(one, range(THREADS))), axis=0)


def denoise(p: np.ndarray, amount: float, scale: float) -> np.ndarray:
    """amount 0..1 on an sRGB float image: guided filter on luma, a softer blur on chroma."""
    r = max(1, int(round((1 + 4 * amount) * scale)))
    cr = max(1, 2 * r)
    eps = (0.004 + 0.05 * amount) ** 2

    def run(part):
        y = luma(part)
        chroma = box2d(box2d(part - y[..., None], cr), cr)
        out = guided(y, r, eps)[..., None] + chroma
        return np.clip(out, 0, 1, out=out)

    return by_strips(run, p, 2 * r + 2 * cr + 2)


def detail(p: np.ndarray, clarity: float, sharpness: float, scale: float) -> np.ndarray:
    """Clarity (big-radius, midtones only) and sharpening (unsharp mask) on luma; one delta for R, G and B."""
    y = luma(p)
    delta = np.zeros_like(y)
    if abs(clarity) > 0.005:
        big = gaussian(y, max(1.0, 0.01 * max(p.shape[0], p.shape[1])))
        mask = np.clip(1 - (2 * y - 1) ** 2, 0, 1)
        delta += np.float32(0.8 * clarity) * (y - big) * mask
    sigma = (0.7 + sharpness) * scale
    if sharpness > 0.005 and sigma >= 0.25:
        hf = by_strips(lambda part: part - gaussian(part, sigma), y, int(math.ceil(3 * sigma)) + 1)
        delta += np.float32(0.5 + 1.5 * sharpness) * hf
    out = p + delta[..., None]
    return np.clip(out, 0, 1, out=out)


# ---------------------------------------------------------------- geometry

def _quarter(rotate: float) -> tuple[int, float]:
    """Clockwise rotate -> (quarter turns, leftover in (-45, 45])."""
    k = int(round(rotate / 90.0))
    fine = rotate - 90.0 * k
    return k % 4, fine


def inscribed(w: float, h: float, deg: float) -> float:
    a = math.radians(abs(deg))
    c, s = math.cos(a), math.sin(a)
    return min(w / (w * c + h * s), h / (w * s + h * c))


def frame_size(src_w: int, src_h: int, p: dict) -> tuple[int, int]:
    """Size of the developed frame at full resolution."""
    w, h = src_w, src_h
    if p.get("crop"):
        x0, y0, x1, y1 = _crop_box(p["crop"], src_w, src_h, 1.0)
        w, h = x1 - x0, y1 - y0
    k, fine = _quarter(p.get("rotate") or 0)
    if k % 2:
        w, h = h, w
    if abs(fine) > 0.01:
        s = inscribed(w, h, fine)
        w, h = max(1, int(w * s)), max(1, int(h * s))
    return w, h


def _crop_box(c: dict, w: int, h: int, scale: float):
    x0 = int(round(max(0.0, min(c["x"], w - 1)) * scale))
    y0 = int(round(max(0.0, min(c["y"], h - 1)) * scale))
    x1 = int(round(min(w, c["x"] + c["width"]) * scale))
    y1 = int(round(min(h, c["y"] + c["height"]) * scale))
    return x0, y0, max(x0 + 1, x1), max(y0 + 1, y1)


def apply_geometry(im: Image.Image, p: dict, src_size: tuple[int, int]) -> Image.Image:
    """Crop (source px), rotate (clockwise, straightened with an inscribed crop), flip. `im` may be a scaled
    proxy of a src_size image; crop coordinates are scaled to it."""
    scale = im.width / src_size[0]
    if p.get("crop"):
        im = im.crop(_crop_box(p["crop"], src_size[0], src_size[1], scale))
    k, fine = _quarter(p.get("rotate") or 0)
    if k:
        im = im.transpose({1: Image.Transpose.ROTATE_270, 2: Image.Transpose.ROTATE_180,
                           3: Image.Transpose.ROTATE_90}[k])
    if abs(fine) > 0.01:
        w, h = im.size
        s = inscribed(w, h, fine)
        im = im.rotate(-fine, resample=Image.Resampling.BICUBIC, expand=False)
        cw, ch = max(1, int(w * s)), max(1, int(h * s))
        x0, y0 = (w - cw) // 2, (h - ch) // 2
        im = im.crop((x0, y0, x0 + cw, y0 + ch))
    if p.get("flipH"):
        im = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if p.get("flipV"):
        im = im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    return im


# ---------------------------------------------------------------- the pipeline

class _Plan:
    """Everything that is per-call rather than per-pixel, worked out once."""

    def __init__(self, p: dict, src: np.ndarray, scale: float, frame: tuple[int, int], lut, profile=None):
        self.p = p
        self.h, self.w = src.shape[:2]
        self.gains = wb_gains(p) * np.float32(2.0 ** p["exposure"])
        self.calib = cl.calibration_matrix(p["calibration"])
        self.profile = profile
        self.chan_tone = None
        self.gain_on = not np.allclose(self.gains, 1.0, atol=1e-6)
        self.tone = tone_tables(p) if tone_active(p) else None
        if self.tone is not None and self.tone.ndim == 2:
            self.chan_tone, self.tone = self.tone, None
        self.refine = p["refineSat"] / 100
        self.point_color = p["pointColor"]
        self.bw = p["bw"] if p["treatment"] == "bw" else None
        self.grading = p["grading"] if cl.grading_active(p["grading"]) else None
        self.shadow_tint = p["calibration"]["shadowsTint"]
        self.grain_on = p["grainAmount"] > 0.5
        self.frame_long = float(max(frame))
        self.hsl = _hsl_tables(p) if hsl_active(p) else None
        self.palette = _palette_ctx(p["palette"])
        self.vib = p["vibrance"] / 100
        self.sat = p["saturation"] / 100
        self.srgb_stage = (self.hsl is not None or self.palette is not None or abs(self.vib) > 0.005
                           or self.profile is not None or self.chan_tone is not None or bool(self.point_color)
                           or self.bw is not None or (self.refine < 0.999 and self.tone is not None))
        self.tone_lin = None
        if self.tone is not None and not self.srgb_stage:
            # tone folded into one linear -> linear table, indexed by sqrt(lin) like enc
            t = np.interp(_ENC_SQRT, _MGRID, self.tone)
            self.tone_lin = srgb_to_linear(t).astype(np.float32)
        self.lut = lut if lut is not None and lut[1] > 0.001 else None
        self.vignette = p["vignette"] / 100
        self.points = self._points(p, src, scale, frame)

    def _points(self, p, src, scale, frame):
        pts = [pt for pt in p["lightPoints"] if abs(pt["exposure"]) > 0.5]
        if not pts:
            return None
        fw, fh = frame
        # tonal sigma from the image's own contrast (sparse grid, after WB/exposure like the pixels it weighs)
        step_y, step_x = max(1, self.h // 48), max(1, self.w // 48)
        sample = to_linear(src[::step_y, ::step_x, :3]) * self.gains
        ys = enc(luma(np.clip(sample, 0, 1)))
        sig = float(np.clip(0.6 * ys.std(), 12 / 255, 30 / 255))
        out = []
        for pt in pts:
            sx = self.w / (pt.get("refW") or fw)
            sy = self.h / (pt.get("refH") or fh)
            x, y = pt["x"] * sx, pt["y"] * sy
            fall = (pt.get("falloff") or 0.25 * max(fw, fh)) * sx
            px, py = int(min(self.w - 1, max(0, round(x)))), int(min(self.h - 1, max(0, round(y))))
            anchor = float(enc(np.clip(luma(to_linear(src[py:py + 1, px:px + 1, :3])[0, 0] * self.gains), 0, 1)))
            out.append((x, y, 1.0 / (2 * fall * fall), 1.5 * pt["exposure"] / 100, anchor))
        return out, 1.0 / (2 * sig * sig)

    def light(self, lin: np.ndarray, y0: int) -> np.ndarray:
        pts, inv2s = self.points
        rows = lin.shape[0]
        yp = enc(luma(np.clip(lin, 0, 1)))
        stops = np.zeros(yp.shape, dtype=np.float32)
        xs = np.arange(self.w, dtype=np.float32)
        ys = np.arange(y0, y0 + rows, dtype=np.float32)
        for x, y, inv2f, delta, anchor in pts:
            spatial = np.exp(-((ys - y) ** 2) * inv2f)[:, None] * np.exp(-((xs - x) ** 2) * inv2f)[None, :]
            stops += delta * spatial * np.exp(-((yp - anchor) ** 2) * inv2s)
        return lin * np.exp2(stops)[..., None]

    def vignette_mul(self, rows: int, y0: int, lin: np.ndarray) -> np.ndarray:
        u, v = self._uv(rows, y0)
        alpha = cl.vignette_alpha(u, v, self.w / max(1, self.h), self.p)
        yp = enc(np.clip(lin @ LUMA, 0, 1))
        return cl.apply_vignette(lin, alpha, self.p, yp)

    def run(self, block: np.ndarray, y0: int) -> np.ndarray:
        """block: rows x W x 3 of sRGB values (uint8/uint16 or float 0..1). Returns float32 sRGB."""
        lin = to_linear(block)
        if self.calib is not None:
            lin = np.clip(lin @ self.calib.T, 0, None)
        if self.gain_on:
            lin = lin * self.gains
        if self.points is not None:
            lin = self.light(lin, y0)
        np.clip(lin, 0, 1, out=lin)
        rows = lin.shape[0]
        bw_done = False
        if self.srgb_stage:
            pb = enc(lin).reshape(-1, 3)
            if self.profile is not None:
                table, amount = self.profile
                prof = apply_lut(pb, table)
                pb = prof if abs(amount - 1) < 1e-3 else np.clip(pb + (prof - pb) * np.float32(amount), 0, 1)
            if self.palette is not None:
                pb = apply_palette(pb, self.palette)
            if self.tone is not None or self.chan_tone is not None:
                before_tone = pb
                if self.tone is not None:
                    pb = lookup(pb, self.tone)
                else:
                    pb = np.stack([lookup(pb[:, c], self.chan_tone[:, c]) for c in range(3)], axis=1)
                if self.refine < 0.999:
                    pb = refine_saturation(before_tone, pb, self.refine)
            if self.hsl is not None:
                pb = apply_hsl(pb, self.hsl)
            if self.point_color or self.bw is not None:
                h, sv, v = rgb_to_hsv(pb)
                if self.point_color:
                    h, sv, v = cl.point_color(h, sv, v, self.point_color)
                    pb = hsv_to_rgb(h, sv, v)
                if self.bw is not None:
                    y = cl.bw_mix(dec(pb), h, sv, self.bw)
                    pb = np.repeat(enc(y)[:, None], 3, axis=1)
                    bw_done = True
            sat_p = None
            if abs(self.vib) > 0.005 and not bw_done:
                mx = pb.max(1)
                sat_p = np.where(mx > 1e-6, (mx - pb.min(1)) / np.maximum(mx, 1e-6), 0.0)
            lin = dec(pb).reshape(rows, self.w, 3)
        else:
            sat_p = None
            if self.tone_lin is not None:
                lin = lookup(np.sqrt(lin), self.tone_lin)
        if not bw_done and (sat_p is not None or abs(self.sat) > 0.005):
            f = np.float32(1 + self.sat)
            if sat_p is not None:
                f = (1 + 0.6 * self.vib * (1 - sat_p.reshape(rows, self.w))) * f
                f = f[..., None]
            y = luma(lin)[..., None]
            lin = np.clip(y + (lin - y) * f, 0, 1)
        if self.lut is not None:
            table, amount = self.lut
            pb = enc(lin)
            graded = apply_lut(pb.reshape(-1, 3), table).reshape(pb.shape)
            if amount < 0.999:
                graded = pb + (graded - pb) * np.float32(amount)
            lin = dec(graded)
        if self.grading is not None or abs(self.shadow_tint) > 0.01:
            flat = lin.reshape(-1, 3)
            yp = enc(np.clip(flat @ LUMA, 0, 1))
            if self.grading is not None:
                flat = cl.grade(flat, yp, self.grading)
            if abs(self.shadow_tint) > 0.01:
                flat = cl.shadow_tint(flat, yp, self.shadow_tint)
            lin = flat.reshape(rows, self.w, 3)
        if abs(self.vignette) > 0.005:
            lin = self.vignette_mul(rows, y0, lin)
        out = enc(lin)
        if self.grain_on:
            u, v = self._uv(rows, y0)
            out = np.clip(out + cl.grain(u, v, self.frame_long, self.p)[..., None], 0, 1)
        return out

    def _uv(self, rows: int, y0: int):
        xs = (np.arange(self.w, dtype=np.float32) + 0.5) / self.w
        ys = (np.arange(y0, y0 + rows, dtype=np.float32) + 0.5) / self.h
        return np.broadcast_to(xs[None, :], (rows, self.w)), np.broadcast_to(ys[:, None], (rows, self.w))


BLOCK_PIXELS = 1 << 18
THREADS = max(1, min(8, os.cpu_count() or 1))
_POOL: ThreadPoolExecutor | None = None


def _pool() -> ThreadPoolExecutor:
    global _POOL
    if _POOL is None:
        _POOL = ThreadPoolExecutor(THREADS, thread_name_prefix="develop")
    return _POOL


def develop(src: np.ndarray, params: dict | None, *, scale: float = 1.0, frame: tuple[int, int] | None = None,
            lut=None) -> np.ndarray:
    """Run the pipeline on an already geometry-corrected HxWx3 sRGB image (uint8, uint16 or float 0..1).

    scale: working size / full-resolution developed size (radii are defined at full resolution).
    frame: the full-resolution developed size (light point coordinates default to it).
    lut:   (table, amount 0..1) when params.lut is set; the caller resolves the look.
    Returns float32 sRGB 0..1, HxWx3."""
    p = normalise(params)
    if "look" in p["off"]:
        lut = None
    p = bypass(p)
    profile = None
    if p["profile"]:
        from app.photo import profiles

        table = profiles.table(p["profile"]["id"])
        if table is not None and p["profile"]["amount"] > 0.5:
            profile = (table, p["profile"]["amount"] / 100)
    h, w = src.shape[:2]
    src = src[..., :3]
    frame = frame or (max(1, int(round(w / scale))), max(1, int(round(h / scale))))
    if p["noiseReduction"] > 0.5:
        src = denoise(to_unit(src), p["noiseReduction"] / 100, scale)
    plan = _Plan(p, src, scale, frame, lut, profile)
    out = np.empty((h, w, 3), dtype=np.float32)
    step = max(1, BLOCK_PIXELS // max(1, w))

    def one(y0: int) -> None:
        out[y0:y0 + step] = plan.run(src[y0:y0 + step], y0)

    starts = range(0, h, step)
    if len(starts) > 1 and THREADS > 1:
        # numpy drops the GIL inside ufuncs and take(), so row blocks really do run side by side
        list(_pool().map(one, starts))
    else:
        for y0 in starts:
            one(y0)
    if abs(p["clarity"]) > 0.5 or p["sharpness"] > 0.5:
        out = detail(out, p["clarity"] / 100, p["sharpness"] / 100, scale)
    return out


# ---------------------------------------------------------------- files

_SRGB_ICC: bytes | None = None


def srgb_icc() -> bytes | None:
    global _SRGB_ICC
    if _SRGB_ICC is None:
        try:
            from PIL import ImageCms

            _SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        except Exception:  # Pillow built without littlecms
            _SRGB_ICC = b""
    return _SRGB_ICC or None


def _to_srgb(im: Image.Image) -> Image.Image:
    icc = im.info.get("icc_profile")
    if not icc or im.mode not in ("RGB", "RGBA", "CMYK"):
        return im
    try:
        from PIL import ImageCms

        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        if "srgb" in (ImageCms.getProfileDescription(src) or "").lower():
            return im
        mode = "RGBA" if im.mode == "RGBA" else "RGB"
        return ImageCms.profileToProfile(im, src, ImageCms.createProfile("sRGB"), outputMode=mode)
    except Exception:
        return im  # a broken profile shouldn't make the photo unusable


def open_image(path: Path | str, max_side: int | None = None) -> tuple[Image.Image, tuple[int, int]]:
    """Decoded, EXIF-oriented, sRGB; mode RGB, RGBA or F (16-bit greyscale sources). Returns the image and
    the full-resolution upright size. With max_side a JPEG decodes at a reduced DCT scale (much faster) and
    the result is shrunk to fit; the size returned is still the full one."""
    # TODO: Pillow reads 48-bit PNG/TIFF as 8-bit RGB, so re-editing a png16/tiff16 version loses its depth;
    # decode those ourselves (zlib + unfilter) when people start round-tripping 16-bit files
    im = Image.open(path)
    w, h = im.size
    try:
        if im.getexif().get(0x0112, 1) in (5, 6, 7, 8):
            w, h = h, w
    except Exception:
        pass
    if max_side and im.format == "JPEG" and max(w, h) > max_side:
        f = max_side / max(w, h)
        im.draft("RGB", (int(im.size[0] * f), int(im.size[1] * f)))
    im.load()
    exif = im.info.get("exif")
    im = ImageOps.exif_transpose(im)
    im = _to_srgb(im)
    if im.mode in ("I;16", "I;16B", "I;16L", "I"):
        arr = np.asarray(im, dtype=np.float32)
        im = Image.fromarray(np.clip(arr / 65535.0, 0, 1).astype(np.float32), "F")
    elif im.mode == "F":
        pass
    elif im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
    else:
        im = im.convert("RGB")
    if max_side and max(im.size) > max_side:
        f = max_side / max(im.size)
        im = im.resize((max(1, round(im.width * f)), max(1, round(im.height * f))), Image.Resampling.LANCZOS)
    if exif:
        im.info["exif"] = exif
    return im, (w, h)


def split(im: Image.Image) -> tuple[np.ndarray, np.ndarray | None]:
    """PIL image -> (HxWx3 uint8 or float32, alpha uint8 or None)."""
    if im.mode == "F":
        g = np.asarray(im, dtype=np.float32)
        return np.repeat(g[..., None], 3, axis=2), None
    arr = np.asarray(im)
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=2)
    if arr.shape[2] == 4:
        return arr[..., :3], arr[..., 3]
    return arr, None


def quantise(p: np.ndarray, bits: int = 8) -> np.ndarray:
    if bits == 16:
        return (np.clip(p, 0, 1) * 65535 + 0.5).astype(np.uint16)
    return (np.clip(p, 0, 1) * 255 + 0.5).astype(np.uint8)


FORMATS = {
    "jpeg": {"label": "JPEG", "media_type": "image/jpeg", "ext": ".jpg", "bits": 8},
    "png": {"label": "PNG", "media_type": "image/png", "ext": ".png", "bits": 8},
    "png16": {"label": "PNG 16-bit", "media_type": "image/png", "ext": ".png", "bits": 16},
    "tiff16": {"label": "TIFF 16-bit", "media_type": "image/tiff", "ext": ".tif", "bits": 16},
}


def _exif_bytes(raw: bytes | None) -> bytes | None:
    if not raw:
        return None
    try:
        ex = Image.Exif()
        ex.load(raw)
        ex[0x0112] = 1  # pixels are already upright
        ex[0x0131] = "Mix AI Cinema Studio"
        return ex.tobytes()
    except Exception:
        return None


def encode(p: np.ndarray, alpha: np.ndarray | None, fmt: str, quality: int = 95, exif: bytes | None = None) -> bytes:
    if fmt == "jpeg":
        im = Image.fromarray(quantise(p))
        buf = io.BytesIO()
        kw = {"quality": int(quality), "subsampling": 0 if quality >= 90 else 2}
        if srgb_icc():
            kw["icc_profile"] = srgb_icc()
        ex = _exif_bytes(exif)
        if ex:
            kw["exif"] = ex
        im.save(buf, "JPEG", **kw)
        return buf.getvalue()
    if fmt == "png":
        arr = quantise(p)
        if alpha is not None:
            arr = np.dstack([arr, alpha])
        buf = io.BytesIO()
        kw = {"compress_level": 3}
        if srgb_icc():
            kw["icc_profile"] = srgb_icc()
        Image.fromarray(arr).save(buf, "PNG", **kw)
        return buf.getvalue()
    arr = quantise(p, 16)
    if alpha is not None:
        arr = np.dstack([arr, alpha.astype(np.uint16) * 257])
    if fmt == "png16":
        return png16(arr)
    if fmt == "tiff16":
        return tiff16(arr)
    raise ValueError(f"unknown format {fmt}")


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png16(arr: np.ndarray) -> bytes:
    """16-bit RGB(A) PNG. Pillow can't write 48/64-bit colour, and the format is simple enough."""
    h, w, c = arr.shape
    colour = {3: 2, 4: 6}[c]
    rows = np.empty((h, 1 + w * c * 2), dtype=np.uint8)
    rows[:, 0] = 0
    rows[:, 1:] = arr.astype(">u2").view(np.uint8).reshape(h, -1)
    out = [b"\x89PNG\r\n\x1a\n", _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 16, colour, 0, 0, 0)),
           _chunk(b"sRGB", b"\x00")]
    data = zlib.compress(rows.tobytes(), 1)
    for i in range(0, len(data), 1 << 24):
        out.append(_chunk(b"IDAT", data[i:i + (1 << 24)]))
    out.append(_chunk(b"IEND", b""))
    return b"".join(out)


def tiff16(arr: np.ndarray) -> bytes:
    """Baseline little-endian TIFF, one uncompressed strip, 16 bits per sample."""
    h, w, c = arr.shape
    pixels = arr.astype("<u2").tobytes()
    tags = [(256, 4, 1, w), (257, 4, 1, h), (258, 3, c, None), (259, 3, 1, 1), (262, 3, 1, 2),
            (273, 4, 1, None), (277, 3, 1, c), (278, 4, 1, h), (279, 4, 1, len(pixels)),
            (282, 5, 1, None), (283, 5, 1, None), (284, 3, 1, 1), (296, 3, 1, 2)]
    if c == 4:
        tags.append((338, 3, 1, 2))  # unassociated alpha
    ifd_size = 2 + 12 * len(tags) + 4
    extra_at = 8 + ifd_size
    bps = struct.pack("<" + "H" * c, *([16] * c))
    res = struct.pack("<II", 72, 1)
    x_at = extra_at + len(bps)
    y_at = x_at + 8
    data_at = y_at + 8
    ifd = [struct.pack("<H", len(tags))]
    for tag, typ, count, value in tags:
        if tag == 258:
            value = extra_at
        elif tag == 273:
            value = data_at
        elif tag == 282:
            value = x_at
        elif tag == 283:
            value = y_at
        if typ == 3 and count == 1:
            ifd.append(struct.pack("<HHIHH", tag, typ, count, value, 0))
        else:
            ifd.append(struct.pack("<HHII", tag, typ, count, value))
    ifd.append(struct.pack("<I", 0))
    return b"II*\x00" + struct.pack("<I", 8) + b"".join(ifd) + bps + res + res + pixels
