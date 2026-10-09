"""Develop D2 per-pixel tools (params v2): calibration, curves, Point Color, B&W mix, colour grading,
shadow tint, post-crop vignette and grain.

Everything here is a point operation with a plain formula, because lib/photo/maths.ts and the WebGL shader
repeat it line for line (the preview has to match the render). Spatial tools live in develop.py.
"""
import math

import numpy as np

BANDS = ("red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta")
BAND_HUES = (0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0)
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
MAX_POINT_COLORS = 8
MAX_CURVE_POINTS = 16


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- calibration (camera primaries)

def calibration_matrix(c: dict) -> np.ndarray | None:
    """3x3 matrix in linear light: each primary's hue turned (±20°) about the grey axis and its
    saturation scaled (±50%), rows renormalised so white stays white."""
    if not any(abs(c[k]) > 0.01 for k in ("redHue", "redSat", "greenHue", "greenSat", "blueHue", "blueSat")):
        return None
    axis = np.ones(3) / math.sqrt(3)
    cols = []
    for i, name in enumerate(("red", "green", "blue")):
        v = np.zeros(3)
        v[i] = 1.0
        g = np.full(3, v.mean())
        ch = v - g
        th = math.radians(20.0 * c[f"{name}Hue"] / 100)
        # Rodrigues; ch is perpendicular to the grey axis, so the last term is 0
        ch = ch * math.cos(th) + np.cross(axis, ch) * math.sin(th)
        cols.append(g + ch * (1 + 0.5 * c[f"{name}Sat"] / 100))
    m = np.stack(cols, axis=1)
    m = m / m.sum(axis=1, keepdims=True)
    return m.astype(np.float32)


# ---------------------------------------------------------------- curves

def _bump(x, c, half):
    t = (x - c) / (half * 1.5)
    return np.maximum(0.0, 1 - t * t) ** 2


def parametric(x: np.ndarray, pc: dict) -> np.ndarray:
    """Lightroom's region curve: four soft bumps between the split points."""
    s1, s2, s3 = sorted((pc["s1"] / 100, pc["s2"] / 100, pc["s3"] / 100))
    regions = (("shadows", s1 / 2, s1 / 2), ("darks", (s1 + s2) / 2, (s2 - s1) / 2),
               ("lights", (s2 + s3) / 2, (s3 - s2) / 2), ("highlights", (s3 + 1) / 2, (1 - s3) / 2))
    out = np.zeros_like(x)
    for key, c, half in regions:
        if abs(pc[key]) > 0.01:
            out = out + 0.15 * pc[key] / 100 * _bump(x, c, max(half, 0.02))
    return out


def parametric_active(pc: dict) -> bool:
    return any(abs(pc[k]) > 0.01 for k in ("highlights", "lights", "darks", "shadows"))


def monotone(points: list, x: np.ndarray) -> np.ndarray:
    """Fritsch–Carlson monotone cubic through points (0..255 each axis), sampled at x (0..1)."""
    pts = sorted({int(round(px)): float(py) for px, py in points}.items())
    if not pts or pts[0][0] > 0:
        pts.insert(0, (0, 0.0))
    if pts[-1][0] < 255:
        pts.append((255, 255.0))
    xs = np.array([p[0] for p in pts], dtype=np.float64) / 255
    ys = np.array([p[1] for p in pts], dtype=np.float64) / 255
    n = len(xs)
    if n == 2:
        return np.interp(x, xs, ys)
    d = np.diff(ys) / np.diff(xs)
    m = np.empty(n)
    m[0], m[-1] = d[0], d[-1]
    m[1:-1] = np.where(d[:-1] * d[1:] <= 0, 0.0, (d[:-1] + d[1:]) / 2)
    for i in range(n - 1):
        if d[i] == 0:
            m[i] = m[i + 1] = 0.0
        else:
            a, b = m[i] / d[i], m[i + 1] / d[i]
            r = a * a + b * b
            if r > 9:
                t = 3 / math.sqrt(r)
                m[i], m[i + 1] = t * a * d[i], t * b * d[i]
    i = np.clip(np.searchsorted(xs, x, side="right") - 1, 0, n - 2)
    h = xs[i + 1] - xs[i]
    t = (x - xs[i]) / h
    t2, t3 = t * t, t * t * t
    y = ((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
         + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1])
    return np.clip(y, 0.0, 1.0)


def points_active(pts: list) -> bool:
    return any(abs(px - py) > 0.5 for px, py in pts)


CURVE_PRESETS = {
    "linear": [],
    "medium": [[0, 0], [64, 56], [128, 128], [192, 202], [255, 255]],
    "strong": [[0, 0], [64, 48], [128, 128], [192, 210], [255, 255]],
}


# ---------------------------------------------------------------- HSV-space tools on (N, 3) sRGB

def _hue_dist(h, c):
    d = np.abs(h - c) % 360
    return np.minimum(d, 360 - d)


def point_color(h, s, v, entries: list[dict]):
    """Point Color: each sampled colour moves the pixels near it (hue, sat and brightness ranges)."""
    for e in entries:
        wh_w = 6 + 84 * e["hueRange"] / 100
        ws_w = 0.05 + 0.95 * e["satRange"] / 100
        wv_w = 0.05 + 0.95 * e["lumRange"] / 100
        w = (1 - smoothstep(0.5 * wh_w, wh_w, _hue_dist(h, e["hue"])))
        w = w * (1 - smoothstep(0.5 * ws_w, ws_w, np.abs(s - e["sat"])))
        w = w * (1 - smoothstep(0.5 * wv_w, wv_w, np.abs(v - e["val"])))
        w = w * smoothstep(0.02, 0.10, s)
        h = h + w * 30.0 * e["dh"] / 100
        s = np.clip(s * (1 + w * e["ds"] / 100), 0, 1)
        v = np.clip(v * (1 + 0.5 * w * e["dl"] / 100), 0, 1)
    return h, s, v


def band_weights(h: np.ndarray, mix: dict) -> np.ndarray:
    """Per-pixel value of an 8-band setting, blended linearly between neighbouring band hues."""
    hues = list(BAND_HUES) + [360.0]
    vals = [mix[b] for b in BANDS] + [mix[BANDS[0]]]
    return np.interp(h % 360, hues, vals)


def bw_mix(lin: np.ndarray, h: np.ndarray, s: np.ndarray, mix: dict) -> np.ndarray:
    """B&W: luminance of the linear pixel, brightened or darkened by the band its colour falls in."""
    y = lin @ LUMA
    f = 1 + s * band_weights(h, mix) / 100 * 0.6
    return np.clip(y * f, 0, 1)


def bw_active(p: dict) -> bool:
    return p["treatment"] == "bw"


# ---------------------------------------------------------------- colour grading

def hue_rgb_linear(hue: float) -> np.ndarray:
    """A fully saturated hue in linear light, scaled to luminance 1."""
    h6 = (hue % 360) / 60
    out = np.array([min(1.0, max(0.0, abs(h6 - 3) - 1)), min(1.0, max(0.0, 2 - abs(h6 - 2))),
                    min(1.0, max(0.0, 2 - abs(h6 - 4)))])
    lin = np.where(out <= 0.04045, out / 12.92, ((out + 0.055) / 1.055) ** 2.4)
    return (lin / float(lin @ LUMA.astype(np.float64))).astype(np.float32)


def grading_active(g: dict) -> bool:
    return any(abs(g[z]["s"]) > 0.01 or abs(g[z]["l"]) > 0.01 for z in ("shadows", "midtones", "highlights", "global"))


def grade(lin: np.ndarray, yp: np.ndarray, g: dict) -> np.ndarray:
    """yp: perceptual luminance 0..1 (sRGB-encoded luma). Zones overlap by Blending, split by Balance."""
    m = 0.5 - 0.25 * g["balance"] / 100
    k = 1.0 / (0.5 + g["blending"] / 100)
    ws = np.clip(1 - yp / m, 0, 1) ** k
    wh = np.clip((yp - m) / (1 - m), 0, 1) ** k
    wm = np.clip(1 - ws - wh, 0, 1)
    for zone, w in (("global", None), ("shadows", ws), ("midtones", wm), ("highlights", wh)):
        z = g[zone]
        if abs(z["s"]) < 0.01 and abs(z["l"]) < 0.01:
            continue
        wz = np.ones(yp.shape, np.float32) if w is None else w
        if abs(z["s"]) > 0.01:
            t = hue_rgb_linear(z["h"])
            lin = lin * (1 + (t - 1) * (0.6 * z["s"] / 100) * wz[:, None])
        if abs(z["l"]) > 0.01:
            lin = lin * np.exp2(0.5 * z["l"] / 100 * wz)[:, None]
    return np.clip(lin, 0, 1)


def shadow_tint(lin: np.ndarray, yp: np.ndarray, tint: float) -> np.ndarray:
    v = 0.15 * tint / 100 * np.array([1.0, -1.0, 1.0], dtype=np.float32)
    return np.clip(lin * (1 + v * ((1 - yp) ** 2)[:, None]), 0, 1)


# ---------------------------------------------------------------- post-crop vignette

def vignette_alpha(u: np.ndarray, v: np.ndarray, aspect: float, p: dict) -> np.ndarray:
    """u, v: 0..1 across the developed frame. Midpoint, roundness and feather shape the falloff;
    with the defaults this is exactly the v1 vignette."""
    dx, dy = u - 0.5, v - 0.5
    r = p["vignetteRoundness"] / 100
    if r > 0:
        # towards a true circle in pixels: the long side counts more
        sx, sy = (1 + r * (aspect - 1), 1.0) if aspect >= 1 else (1.0, 1 + r * (1 / aspect - 1))
        dx, dy = dx * sx / max(sx, sy), dy * sy / max(sx, sy)
    pw = 2.0 + 6.0 * max(0.0, -r)
    d = (np.abs(dx) ** pw + np.abs(dy) ** pw) ** (1 / pw) / 0.75
    e0 = 0.1 + 0.8 * p["vignetteMidpoint"] / 100
    e1 = e0 + 0.05 + 0.9 * p["vignetteFeather"] / 100
    return 0.8 * abs(p["vignette"]) / 100 * smoothstep(e0, e1, d)


def apply_vignette(lin: np.ndarray, alpha: np.ndarray, p: dict, yp: np.ndarray) -> np.ndarray:
    a = alpha[..., None]
    if p["vignette"] < 0:
        style = p["vignetteStyle"]
        if style == "paint":
            return lin * (1 - a)
        # highlight priority keeps bright things bright in the dark corners
        hl = p["vignetteHighlights"] / 100
        if hl > 0:
            a = a * (1 - hl * smoothstep(0.6, 1.0, yp)[..., None])
        if style == "color":
            y = np.maximum(lin @ LUMA, 1e-6)[..., None]
            return lin * ((y * (1 - a)) / y)
        return lin * (1 - a)
    return lin + (1 - lin) * a


# ---------------------------------------------------------------- grain

def _hash(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Integer hash -> -1..1; the shader does the same uint maths."""
    with np.errstate(over="ignore"):
        h = x.astype(np.uint32) * np.uint32(374761393) + y.astype(np.uint32) * np.uint32(668265263)
        h = (h ^ (h >> np.uint32(13))) * np.uint32(1274126177)
        h = h ^ (h >> np.uint32(16))
    return (h & np.uint32(0xFFFFFF)).astype(np.float32) / 16777215.0 * 2 - 1


def _value_noise(fx: np.ndarray, fy: np.ndarray) -> np.ndarray:
    x0, y0 = np.floor(fx), np.floor(fy)
    tx, ty = fx - x0, fy - y0
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    xi, yi = x0.astype(np.int64) & 0xFFFF, y0.astype(np.int64) & 0xFFFF
    a, b = _hash(xi, yi), _hash(xi + 1, yi)
    c, d = _hash(xi, yi + 1), _hash(xi + 1, yi + 1)
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def grain(u: np.ndarray, v: np.ndarray, frame_long: float, p: dict) -> np.ndarray:
    """Film grain in sRGB units for each pixel at u, v (0..1 of the frame); cells are measured in
    full-resolution pixels so a small preview shows the same grain, only finer."""
    cell = 1 + 3 * p["grainSize"] / 100
    fx, fy = u * frame_long / cell, v * frame_long / cell
    n = _value_noise(fx, fy)
    rough = p["grainRoughness"] / 100
    if rough > 0.01:
        n = n * (1 - 0.5 * rough) + 0.5 * rough * _value_noise(fx * 2.3 + 17.0, fy * 2.3 + 31.0)
    return 0.12 * p["grainAmount"] / 100 * n
