"""One-click effects (port of NoorViz local-effects.js), on float sRGB arrays.

The originals were sharp chains tuned by eye; the constants are kept, the maths moved to where it belongs
(greys and sepia from linear luminance, smoothing with an edge-preserving filter instead of a median).
"""
import math

import numpy as np

from app.photo import develop as dv

EFFECTS = [
    {"id": "auto_restore", "label": "Auto restore", "hint": "Old photos: fade, dull colour, light noise"},
    {"id": "deyellow", "label": "De-yellow", "hint": "Cool down a yellow cast"},
    {"id": "pop", "label": "Pop", "hint": "Colour and punch; landscapes and food"},
    {"id": "bw", "label": "Black & white", "hint": "Tone-mapped monochrome"},
    {"id": "sepia", "label": "Sepia", "hint": "Warm antique tone"},
    {"id": "warm", "label": "Warm", "hint": "A touch warmer"},
    {"id": "cool", "label": "Cool", "hint": "A touch cooler"},
    {"id": "soften_skin", "label": "Soften skin", "hint": "Gentle smoothing that keeps edges"},
    {"id": "denoise", "label": "Denoise", "hint": "High-ISO grain cleanup"},
]
NAMES = tuple(e["id"] for e in EFFECTS)


def levels(p: np.ndarray, lo: float = 1.0, hi: float = 99.0) -> np.ndarray:
    """sharp.normalize(): stretch luma percentiles to 0..1, same stretch on every channel."""
    y = dv.luma(p[::4, ::4])
    a, b = np.percentile(y, [lo, hi])
    if b - a < 1e-3:
        return p
    return np.clip((p - a) / (b - a), 0, 1)


def saturate(p: np.ndarray, f: float) -> np.ndarray:
    lin = dv.dec(p)
    y = dv.luma(lin)[..., None]
    return dv.enc(np.clip(y + (lin - y) * np.float32(f), 0, 1))


def brighten(p: np.ndarray, f: float) -> np.ndarray:
    return np.clip(p * np.float32(f), 0, 1)


def channel_mul(p: np.ndarray, m) -> np.ndarray:
    return np.clip(p * np.asarray(m, dtype=np.float32), 0, 1)


def sharpen(p: np.ndarray, sigma: float, scale: float, amount: float = 1.0) -> np.ndarray:
    s = sigma * scale
    if s < 0.25:
        return p
    y = dv.luma(p)
    hf = dv.by_strips(lambda part: part - dv.gaussian(part, s), y, int(math.ceil(3 * s)) + 1)
    return np.clip(p + np.float32(amount) * hf[..., None], 0, 1)


def grey(p: np.ndarray) -> np.ndarray:
    y = dv.enc(dv.luma(dv.dec(p)))
    return np.repeat(y[..., None], 3, axis=2)


def _auto_restore(p, scale):
    p = levels(p)
    p = dv.denoise(p, 0.3, scale)
    p = saturate(p, 1.25)
    p = brighten(p, 1.04)
    p = np.clip(p * 1.05 - 3 / 255, 0, 1)
    return sharpen(p, 1.2, scale)


def _deyellow(p, scale):
    return saturate(channel_mul(levels(p), [0.94, 1.0, 1.10]), 1.05)


def _pop(p, scale):
    p = brighten(saturate(levels(p), 1.35), 1.03)
    p = np.power(p, np.float32(1 / 1.05))  # a small midtone lift
    return sharpen(p, 1.0, scale)


def _bw(p, scale):
    return sharpen(brighten(levels(grey(p)), 1.02), 0.5, scale)


def _sepia(p, scale):
    tone = dv.srgb_to_linear(np.array([250, 218, 173]) / 255.0)
    tone = (tone / float(tone @ dv.LUMA.astype(np.float64))).astype(np.float32)
    y = dv.luma(dv.dec(p))[..., None]
    return brighten(dv.enc(np.clip(y * tone, 0, 1)), 1.03)


def _warm(p, scale):
    return channel_mul(p, [1.06, 1.0, 0.94])


def _cool(p, scale):
    return channel_mul(p, [0.94, 1.0, 1.06])


def _soften(p, scale):
    r = max(2, int(round(0.004 * max(p.shape[:2]))))
    y = dv.luma(p)
    smooth = dv.by_strips(lambda part: dv.guided(part, r, 0.003 ** 2), y, 2 * r + 2)
    p = np.clip(p + (smooth - y)[..., None], 0, 1)
    return saturate(sharpen(p, 0.4, scale), 1.05)


def _denoise(p, scale):
    return sharpen(dv.denoise(p, 0.6, scale), 0.3, scale)


_FX = {"auto_restore": _auto_restore, "deyellow": _deyellow, "pop": _pop, "bw": _bw, "sepia": _sepia,
       "warm": _warm, "cool": _cool, "soften_skin": _soften, "denoise": _denoise}


def apply(src: np.ndarray, name: str, strength: float = 1.0, scale: float = 1.0) -> np.ndarray:
    """src: HxWx3 sRGB (uint8/uint16/float). Returns float32 sRGB."""
    if name not in _FX:
        raise ValueError(f"Unknown effect '{name}'")
    p = dv.to_unit(src[..., :3]).copy()
    out = _FX[name](p, scale)
    s = max(0.0, min(1.0, float(strength)))
    if s < 0.999:
        out = p + (out - p) * np.float32(s)
    return out.astype(np.float32, copy=False)
