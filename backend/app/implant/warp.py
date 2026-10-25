"""The shape warp: the patient's own photo, reshaped by measurement instead of redrawn by a model.

Around each breast a smooth radial bulge enlarges what is already there by the implant's volume (a linear scale of
((V0 + cc) / V0)^(1/3), V0 her present volume from the cup). Nothing is invented: every output pixel is a pixel of
her photo, nothing outside the bulge moves, and clothing stays exactly the clothing she wore. Deterministic, so the
same option always gives the same picture, and a bigger implant always a bigger change."""
from pathlib import Path

import numpy as np
from PIL import Image

from app.implant import planning

# rough present volume per breast by cup, AA..G; enough to make 300 cc on an A look bigger than on a D
CUP_VOLUME = (150, 250, 350, 450, 550, 650, 750, 850, 950)
DEFAULT_VOLUME = 300
# higher profiles push the fullness to the centre of the breast; low ones spread it to the edges
FALLOFF = {"low": 1.2, "moderate": 1.6, "moderate_plus": 2.0, "high": 2.4, "extra_high": 2.8}
MAX_SCALE = 1.5


def present_volume(bra_size: str | None) -> int:
    cup = planning.cup_of(bra_size)
    return CUP_VOLUME[cup] if cup is not None else DEFAULT_VOLUME


def scale_for(cc: float, bra_size: str | None) -> float:
    v0 = present_volume(bra_size)
    return min(MAX_SCALE, ((v0 + cc) / v0) ** (1 / 3))


def default_points(view: str, box: list[int]) -> list[dict]:
    """Where the breasts usually sit inside the chest box, for when the vision model can't say. The patient's
    left breast is on the right of a front photo."""
    y1, x1, y2, x2 = box
    h, w = y2 - y1, x2 - x1
    y = y1 + 0.58 * h
    if view in ("front", "own"):
        return [{"side": "right", "y": y, "x": x1 + 0.32 * w}, {"side": "left", "y": y, "x": x1 + 0.68 * w}]
    return [{"side": "left" if view.startswith("left") else "right", "y": y, "x": x1 + 0.5 * w}]


def _sample(img: np.ndarray, sy: np.ndarray, sx: np.ndarray) -> np.ndarray:
    """Bilinear sampling of img at (sy, sx); coordinates are clamped to the picture."""
    h, w = img.shape[:2]
    sy = np.clip(sy, 0, h - 1.001)
    sx = np.clip(sx, 0, w - 1.001)
    y0, x0 = np.floor(sy).astype(int), np.floor(sx).astype(int)
    fy, fx = (sy - y0)[..., None], (sx - x0)[..., None]
    a, b = img[y0, x0], img[y0, x0 + 1]
    c, d = img[y0 + 1, x0], img[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def render(photo: Path, out: Path, opt: dict, measurements: dict | None, view: str, box: list[int],
           points: list[dict] | None = None) -> dict:
    """Writes the warped photo to `out`; returns what was used, for the record."""
    m = measurements or {}
    with Image.open(photo) as src:
        img = np.asarray(src.convert("RGB"), dtype=np.float32)
    h, w = img.shape[:2]
    y1, x1, y2, x2 = (v / 1000 for v in box)
    bw, bh = (x2 - x1) * w, (y2 - y1) * h
    pts = points or default_points(view, box)
    # one breast in the box (obliques, laterals) gets a bigger share of it than each of two
    radius = min(bh * 0.42, bw * (0.21 if len(pts) > 1 else 0.33))
    k = FALLOFF.get(opt.get("profile"), 2.0)
    lift = opt.get("procedure") == "augmentation_lift"

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dy = np.zeros((h, w), np.float32)
    dx = np.zeros((h, w), np.float32)
    used = []
    for p in pts:
        cc = float(opt.get(f"{p['side']}_cc") or opt.get("left_cc") or 0)
        s = scale_for(cc, m.get("bra_size"))
        cy, cx = p["y"] / 1000 * h, p["x"] / 1000 * w
        oy, ox = yy - cy, xx - cx
        # a little taller than wide, as a breast's footprint is
        r = np.sqrt((ox / radius) ** 2 + (oy / (radius * 1.08)) ** 2)
        wgt = np.where(r < 1, (1 - np.minimum(r, 1) ** 2) ** k, 0).astype(np.float32)
        grow = 1 + (s - 1) * wgt
        # an inverse map: each output pixel looks closer to the centre, so the breast appears larger
        dy += oy / grow - oy
        dx += ox / grow - ox
        # fullness settles into the lower pole; a lift raises the whole breast instead
        dy += (radius * 0.14 if lift else -radius * 0.12 * (s - 1)) * wgt
        used.append({"side": p["side"], "cc": cc, "scale": round(s, 3)})
    # only what the bulge moves is resampled; everything else stays her exact pixels
    moved = (dy != 0) | (dx != 0)
    out_img = img.copy()
    out_img[moved] = _sample(img, (yy + dy)[moved], (xx + dx)[moved])
    Image.fromarray(np.clip(np.rint(out_img), 0, 255).astype(np.uint8)).save(out, "PNG")
    return {"engine": "warp", "radius_px": round(float(radius), 1), "sides": used}
