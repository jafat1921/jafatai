"""Develop D2b spatial tools: noise reduction, dehaze, texture / clarity / sharpening, and the edge mask that
keeps defringe on edges. Server only: the WebGL preview marks these "exact on release".

NR and dehaze run on the source before the point operations, in a gamma-2.2-ish "work" encoding (an sRGB
source is already in it; a linear RAW master is lifted to it with its headroom intact). Texture, clarity
and sharpening run on the developed sRGB result, all from one luma so a single clip follows.
"""
import math

import numpy as np

from app.photo import develop as dv


def to_work(src: np.ndarray, linear: bool) -> np.ndarray:
    if not linear:
        return dv.to_unit(src)
    return np.power(np.maximum(src, 0, dtype=np.float32), np.float32(1 / 2.2))


def from_work(work: np.ndarray, linear: bool) -> np.ndarray:
    return np.power(np.maximum(work, 0), np.float32(2.2)) if linear else work


def _shift_reduce(a: np.ndarray, r: int, axis: int, fn) -> np.ndarray:
    if r < 1:
        return a
    n = a.shape[axis]
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r, r)
    pa = np.pad(a, pad, mode="edge")
    out = pa[dv._sl(axis, 0, n, a.ndim)].copy()
    for i in range(1, 2 * r + 1):
        fn(out, pa[dv._sl(axis, i, i + n, a.ndim)], out=out)
    return out


def min_filter(a: np.ndarray, r: int) -> np.ndarray:
    return _shift_reduce(_shift_reduce(a, r, 0, np.minimum), r, 1, np.minimum)


def max_filter(a: np.ndarray, r: int) -> np.ndarray:
    return _shift_reduce(_shift_reduce(a, r, 0, np.maximum), r, 1, np.maximum)


def guided_by(guide: np.ndarray, src: np.ndarray, r: int, eps: float) -> np.ndarray:
    """Guided filter (He et al.) of src steered by guide's edges."""
    mi, mp = dv.box2d(guide, r), dv.box2d(src, r)
    cov = dv.box2d(guide * src, r) - mi * mp
    var = dv.box2d(guide * guide, r) - mi * mi
    a = cov / (var + eps)
    b = mp - a * mi
    return dv.box2d(a, r) * guide + dv.box2d(b, r)


# ---------------------------------------------------------------- noise reduction

def nr_active(nr: dict) -> bool:
    return nr["luminance"] > 0.5 or nr["color"] > 0.5


def reduce_noise(work: np.ndarray, nr: dict, scale: float, clip: bool = True) -> np.ndarray:
    """Lightroom's six NR sliders. Luminance: guided filter on luma (Detail sets the edge threshold,
    Contrast brings back the mid-scale shape it flattened). Colour: box blurs on chroma (Detail keeps chroma
    on strong edges, Smoothness reaches out to blotchy low-frequency colour). At Detail 50, Contrast 0,
    Colour detail 50 and Smoothness 50 this is exactly the v1 one-slider denoise."""
    lum, col = nr["luminance"] / 100, nr["color"] / 100
    r = max(1, int(round((1 + 4 * lum) * scale)))
    eps = (0.004 + 0.05 * lum) ** 2 * 4.0 ** ((50 - nr["detail"]) / 50)
    cr = 2 * max(1, int(round((1 + 4 * col) * scale)))
    smooth = (nr["smoothness"] - 50) / 50
    cdetail = (nr["colorDetail"] - 50) / 50
    contrast = nr["contrast"] / 100
    big = 3 * cr if smooth > 0.01 else 0

    def run(part):
        y = dv.luma(part)
        if col > 0.005:
            chroma = dv.box2d(dv.box2d(part - y[..., None], cr), cr)
            if big:
                chroma = chroma + (dv.box2d(chroma, big) - chroma) * np.float32(smooth)
            elif smooth < -0.01:
                chroma = chroma + ((part - y[..., None]) - chroma) * np.float32(-0.5 * smooth)
            if cdetail > 0.01:
                # colour detail: hold the original chroma where the luma has a real edge
                g = np.abs(np.gradient(y, axis=0)) + np.abs(np.gradient(y, axis=1))
                keep = np.clip(g * np.float32(8 / max(scale, 1e-3)), 0, 1) * np.float32(cdetail)
                chroma = chroma + ((part - y[..., None]) - chroma) * keep[..., None]
        else:
            chroma = part - y[..., None]
        yo = dv.guided(y, r, eps) if lum > 0.005 else y
        if contrast > 0.005 and lum > 0.005:
            yo = yo + np.float32(0.6 * contrast) * dv.gaussian(y - yo, max(1.0, r / 2))
        out = yo[..., None] + chroma
        return np.clip(out, 0, 1, out=out) if clip else np.maximum(out, 0, out=out)

    # the v1 halo when only the v1 knobs are in use: strips cut in the same place give the same sums
    extra = 2 * big + (2 * r if contrast > 0.005 else 0) + (2 if cdetail > 0.01 else 0)
    return dv.by_strips(run, work, 2 * r + 2 * cr + 2 + extra)


# ---------------------------------------------------------------- dehaze

def dehaze(work: np.ndarray, amount: float, clip: bool = True) -> np.ndarray:
    """Dark-channel prior (He, Sun, Tang 2009) estimated on a small copy: airlight A from the haziest
    pixels, transmission t from the dark channel, refined with a guided filter and scaled back up.
    amount > 0 removes haze, < 0 lays more of it on, most where the scene was already far away."""
    h, w = work.shape[:2]
    f = max(1, int(math.ceil(max(h, w) / 400)))
    small = work[: h - h % f or h, : w - w % f or w]
    if f > 1:
        sh, sw = small.shape[0] // f, small.shape[1] // f
        small = small[: sh * f, : sw * f].reshape(sh, f, sw, f, 3).mean(axis=(1, 3))
    small = np.clip(small, 0, None).astype(np.float32)
    r = max(2, int(round(0.015 * max(small.shape[:2]))))
    dark = min_filter(small.min(axis=2), r)
    n = max(1, dark.size // 1000)
    idx = np.argpartition(dark.ravel(), -n)[-n:]
    air = np.maximum(small.reshape(-1, 3)[idx].mean(axis=0), 0.05).astype(np.float32)
    t = 1 - 0.95 * min_filter((small / air).min(axis=2), r)
    t = np.clip(guided_by(dv.luma(np.clip(small, 0, 1)), t.astype(np.float32), 4 * r, 1e-3), 0.05, 1)
    t = dv._resize_f(t, (w, h), dv.Image.Resampling.BILINEAR)[..., None]
    if amount > 0:
        tt = 1 - amount * (1 - t)
        out = (work - air) / np.maximum(tt, 0.1) + air
    else:
        tt = 1 + amount * (0.35 + 0.5 * (1 - t))
        out = work * tt + air * (1 - tt)
    out = out.astype(np.float32, copy=False)
    return np.clip(out, 0, 1, out=out) if clip else np.maximum(out, 0, out=out)


# ---------------------------------------------------------------- defringe edge mask

def fringe_edges(srgb: np.ndarray, scale: float) -> np.ndarray:
    """1 near high-contrast edges, 0 in flat areas: purple and green fringes only live there, so a purple
    flower in the middle of nowhere is left alone."""
    y = dv.luma(dv.to_unit(srgb))
    r = max(1, int(round(2 * scale)))
    rng = max_filter(y, r) - min_filter(y, r)
    e = dv._smoothstep(0.12, 0.3, rng).astype(np.float32)
    return np.clip(dv.box2d(e, max(1, int(round(3 * scale)))) * 2, 0, 1)


# ---------------------------------------------------------------- texture, clarity, sharpening

def detail_active(p: dict) -> bool:
    return abs(p["clarity"]) > 0.5 or abs(p["texture"]) > 0.5 or p["sharpen"]["amount"] > 0.5


def sharpen_mask(y: np.ndarray, masking: float, scale: float) -> np.ndarray | None:
    """Lightroom's Masking: 0 sharpens everything, 100 only the strongest edges. None means everywhere."""
    if masking < 0.5:
        return None
    soft = dv.gaussian(y, max(0.7, scale))
    g = np.hypot(np.gradient(soft, axis=0), np.gradient(soft, axis=1)) * np.float32(scale)
    t = 0.004 + 0.09 * (masking / 100) ** 1.5
    return dv.gaussian(dv._smoothstep(0.4 * t, t, g).astype(np.float32), max(0.5, scale))


def detail(p_img: np.ndarray, p: dict, scale: float, debug: str | None = None) -> np.ndarray:
    """Texture (mid frequencies), clarity (big radius, midtones) and sharpening (unsharp mask with Detail
    and Masking) on luma; one delta for R, G and B. With Detail 100 and Masking 0, sharpening is exactly
    the v1 one-slider version."""
    y = dv.luma(p_img)
    delta = np.zeros_like(y)
    long = max(p_img.shape[0], p_img.shape[1])
    clarity, texture = p["clarity"] / 100, p["texture"] / 100
    if abs(clarity) > 0.005:
        big = dv.gaussian(y, max(1.0, 0.01 * long))
        mask = np.clip(1 - (2 * y - 1) ** 2, 0, 1)
        delta += np.float32(0.8 * clarity) * (y - big) * mask
    if abs(texture) > 0.005:
        # a few full-resolution pixels (pores, fabric, foliage): between sharpening's radius and clarity's
        s_mid = max(1.0, 4.0 * scale)
        s_small = max(0.5, 1.2 * scale)
        band = dv.by_strips(lambda part: dv.gaussian(part, s_small) - dv.gaussian(part, s_mid), y,
                            int(math.ceil(3 * s_mid)) + 1)
        delta += np.float32(1.5 * texture if texture > 0 else texture) * band
    s = p["sharpen"]
    mask = sharpen_mask(y, s["masking"], scale)
    if debug == "sharpen_mask":
        m = np.ones_like(y) if mask is None else mask
        return np.repeat(m[..., None], 3, axis=2)
    sigma = s["radius"] * scale
    if s["amount"] > 0.5 and sigma >= 0.25:
        hf = dv.by_strips(lambda part: part - dv.gaussian(part, sigma), y, int(math.ceil(3 * sigma)) + 1)
        if s["detail"] < 99.95:
            # low Detail holds halos back: big swings are soft-clipped, fine texture passes as is
            t = np.float32(0.01 * 2.0 ** (8 * s["detail"] / 100))
            hf = t * np.tanh(hf / t)
        if mask is not None:
            hf = hf * mask
        delta += np.float32(s["amount"] / 75) * hf
    out = p_img + delta[..., None]
    return np.clip(out, 0, 1, out=out)
