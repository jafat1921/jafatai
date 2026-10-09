"""Image statistics, Smart Auto, histogram and palette (ports of NoorViz image-analysis.js, local-effects.js
smartAuto and palette.js), plus the CIE Lab / delta E helpers the tests and consistency checks use.

Everything takes an sRGB HxWx3 array (uint8, or float 0..1) that is already small: callers pass the
preview proxy, so none of this ever decodes a full-size photo.
"""
import math

import numpy as np

from app.photo import develop as dv

PROBE = 256


def _small(rgb: np.ndarray, side: int = PROBE) -> np.ndarray:
    h, w = rgb.shape[:2]
    step = max(1, int(math.ceil(max(h, w) / side)))
    return rgb[::step, ::step, :3]


def _unit(rgb: np.ndarray) -> np.ndarray:
    return dv.to_unit(rgb[..., :3])


def analyse(rgb: np.ndarray, size: tuple[int, int] | None = None) -> dict:
    """size: the full image's (w, h) when rgb is a proxy."""
    h, w = rgb.shape[:2]
    fw, fh = size or (w, h)
    p = _unit(_small(rgb, 512))
    y = dv.luma(p)
    means = p.reshape(-1, 3).mean(0) * 255
    brightness = float(means.mean())
    contrast = float((p.reshape(-1, 3).std(0) * 255).mean())
    spread = float(max(abs(means[0] - means[1]), abs(means[1] - means[2]), abs(means[0] - means[2])))
    grey = spread < 4
    cast, strength = None, 0.0
    if not grey:
        avg = means.mean()
        dr, dg, db = (means - avg) / 255
        big = max(abs(dr), abs(dg), abs(db))
        if big > 0.04:
            strength = float(min(1.0, big * 2))
            if dr > 0.04 and dg > 0.04 and db < 0:
                cast = "yellow"
            elif db > 0.04 and dg > 0.04 and dr < 0:
                cast = "cyan"
            elif dr > 0.04 and db > 0.04 and dg < 0:
                cast = "magenta"
            elif dr > abs(dg) and dr > abs(db):
                cast = "red"
            elif dg > abs(dr) and dg > abs(db):
                cast = "green"
            elif db > abs(dr) and db > abs(dg):
                cast = "blue"
            # with two channels pulling the same way the one left behind can still win; yellow (low blue) is the
            # common real-world case (old prints, tungsten), so check it on its own
            if cast is None and db < -0.04:
                cast = "yellow"

    # NoorViz sharpness proxy: mean |neighbour difference| of a contrast-stretched 256 px grey probe
    g = dv.luma(_unit(_small(rgb, 256))) * 255
    lo, hi = np.percentile(g, [0.5, 99.5]) if g.size else (0, 255)
    if hi - lo > 1:
        g = np.clip((g - lo) * 255 / (hi - lo), 0, 255)
    edges = (np.abs(np.diff(g, axis=1))[:-1, :].mean() + np.abs(np.diff(g, axis=0))[:, :-1].mean()) / 2 \
        if min(g.shape) > 2 else 0.0
    sharpness = float(edges / 16)

    low_contrast = contrast < 35
    signals = int(grey or cast in ("yellow", "magenta")) + int(low_contrast) + int(0.4 < sharpness < 1.0)
    flat = (p * 255).reshape(-1, 3)
    return {
        "width": int(fw), "height": int(fh), "megapixels": round(fw * fh / 1e6, 2),
        "aspect_ratio": round(fw / fh, 4) if fh else 1.0,
        "brightness": round(brightness, 2), "contrast": round(contrast, 2),
        "median_luma": round(float(np.median(y)), 4), "luma_std": round(float(y.std()), 4),
        "luma_p01": round(float(np.percentile(y, 1)), 4), "luma_p99": round(float(np.percentile(y, 99)), 4),
        "channel_means": [round(float(v), 2) for v in means],
        "is_grayscale": grey, "color_cast": cast, "cast_strength": round(strength, 3),
        "is_underexposed": brightness < 80, "is_overexposed": brightness > 200, "is_low_contrast": low_contrast,
        "sharpness": round(sharpness, 3), "is_likely_blurry": sharpness < 0.5,
        "is_likely_damaged": signals >= 2,
        "clipped": {"shadows": round(float((flat.min(1) <= 0.5).mean()), 4),
                    "highlights": round(float((flat.max(1) >= 254.5).mean()), 4)},
        "face_count": None,
    }


def _slider(stops: float) -> int:
    return int(round(stops / 1.5 * 100))


def _ev(stops: float) -> float:
    # params v2 exposure is in EV already
    return round(stops, 2)


def suggest(a: dict, rgb: np.ndarray) -> tuple[dict, list[str]]:
    """Smart Auto: NoorViz suggestDevelopParams + smartAuto, expressed as develop sliders. Conservative:
    it aims for a balanced exposure and neutral grey, not for a look."""
    out: dict = {"version": 2}
    notes: list[str] = []
    faces = bool(a.get("face_count"))

    # exposure in stops, toward a mid-grey median (0.45 sRGB ~ NoorViz's 115/255), closing 60% of the gap
    med = max(a["median_luma"], 0.02)
    stops = math.log2(float(dv.srgb_to_linear(0.45)) / float(dv.srgb_to_linear(med))) * 0.6
    if a["clipped"]["highlights"] > 0.02 and stops > 0:
        stops *= 0.5  # brightening would clip more
    stops = max(-1.0, min(1.2, stops))
    if abs(_slider(stops)) >= 3:
        out["exposure"] = _ev(stops)
        notes.append(f"{'Underexposed' if stops > 0 else 'Overexposed'}: {stops:+.1f} stops")

    # white balance: grey world on the mid-tones, half strength so sunsets stay sunsets
    if not a["is_grayscale"]:
        p = _unit(_small(rgb, 256)).reshape(-1, 3)
        lin = dv.srgb_to_linear(p)
        y = lin @ dv.LUMA.astype(np.float64)
        keep = (y > 0.02) & (y < 0.8)
        if keep.sum() > 50:
            mr, mg, mb = lin[keep].mean(0)
            q = (mb / max(mr, 1e-6)) ** (0.5 / 2.2)
            t = (q - 1) / (0.3 * (q + 1))
            wv = (math.sqrt(mr * mb) / max(mg, 1e-6)) ** (0.5 / 2.2)
            m = (1 - wv) / (0.15 * (1 + wv))
            temp = int(round(max(-30, min(30, t * 100))))
            tint = int(round(max(-20, min(20, m * 100))))
            if abs(temp) >= 3:
                out["temperature"] = temp
                notes.append(f"{'Cool' if temp > 0 else 'Warm'} cast: {'warmer' if temp > 0 else 'cooler'} by {abs(temp)}")
            if abs(tint) >= 3:
                out["tint"] = tint
                notes.append(f"Tint {tint:+d}")

    c = a["contrast"]
    if c < 35:
        out["contrast"] = int(min(12 if faces else 22, round((35 - c) * 0.6)))
        notes.append(f"Flat: contrast +{out['contrast']}")
    elif c > 80:
        out["contrast"] = -int(min(15, round((c - 80) * 0.4)))
        notes.append(f"Harsh: contrast {out['contrast']}")
    # black / white points for a washed-out histogram (NoorViz's percentile normalise, gentler)
    if a["luma_p01"] > 0.06:
        out["blacks"] = -int(min(40, round(a["luma_p01"] * 200)))
        notes.append("Lifted blacks pulled down")
    if a["luma_p99"] < 0.9:
        out["whites"] = int(min(40, round((1 - a["luma_p99"]) * 200)))
        notes.append("Dull whites lifted")

    if a["brightness"] < 90:
        out["shadows"] = 20
    if a["brightness"] > 180 or a["clipped"]["highlights"] > 0.01:
        out["highlights"] = -25
        notes.append("Highlights recovered")

    if not a["is_grayscale"]:
        out["vibrance"] = 8 if faces else 14
    if a["sharpness"] < 0.7:
        out["sharpness"] = 10 if faces else 18
        if a["sharpness"] < 0.5:
            out["clarity"] = 6 if faces else 12
        notes.append("Soft: a little sharpening")
    return out, notes


def histogram(p: np.ndarray) -> dict:
    """p: developed float sRGB (or uint8). 256 bins per channel and luma, scaled so the tallest bin is 1."""
    q = dv.quantise(p) if p.dtype != np.uint8 else p
    flat = q.reshape(-1, 3)
    y = np.clip(np.rint(flat @ dv.LUMA), 0, 255).astype(np.intp)
    hs = [np.bincount(flat[:, i], minlength=256) for i in range(3)] + [np.bincount(y, minlength=256)]
    top = max(1, max(int(h.max()) for h in hs))
    n = max(1, flat.shape[0])
    return {
        "r": [round(v / top, 5) for v in hs[0].tolist()],
        "g": [round(v / top, 5) for v in hs[1].tolist()],
        "b": [round(v / top, 5) for v in hs[2].tolist()],
        "luma": [round(v / top, 5) for v in hs[3].tolist()],
        "clipped": {"shadows": round(float((flat.min(1) == 0).sum()) / n, 5),
                    "highlights": round(float((flat.max(1) == 255).sum()) / n, 5)},
    }


def palette(rgb: np.ndarray, k: int = 8, iterations: int = 10, seed: int = 7) -> list[dict]:
    """Dominant colours by k-means++ on a 128 px probe. Seeded, so the same photo gives the same clusters."""
    px = (_unit(_small(rgb, 128)).reshape(-1, 3) * 255).astype(np.float32)
    n = px.shape[0]
    k = max(1, min(k, n))
    rng = np.random.default_rng(seed)
    centres = [px[rng.integers(n)]]
    d2 = ((px - centres[0]) ** 2).sum(1)
    for _ in range(1, k):
        tot = float(d2.sum())
        if tot <= 0:
            break
        c = px[rng.choice(n, p=d2 / tot)]
        centres.append(c)
        d2 = np.minimum(d2, ((px - c) ** 2).sum(1))
    cen = np.array(centres, dtype=np.float32)
    for _ in range(iterations):
        lab = ((px[:, None, :] - cen[None]) ** 2).sum(-1).argmin(1)
        new = np.array([px[lab == i].mean(0) if np.any(lab == i) else cen[i] for i in range(len(cen))])
        if np.allclose(new, cen, atol=0.5):
            cen = new.astype(np.float32)
            break
        cen = new.astype(np.float32)
    lab = ((px[:, None, :] - cen[None]) ** 2).sum(-1).argmin(1)
    counts = np.bincount(lab, minlength=len(cen))
    out = []
    for i in np.argsort(-counts):
        if counts[i] == 0:
            continue
        r, g, b = (int(round(float(v))) for v in cen[i])
        out.append({"centerR": r, "centerG": g, "centerB": b, "hex": f"#{r:02x}{g:02x}{b:02x}",
                    "coverage": round(float(counts[i]) / n, 4), "enabled": True, "h": 0, "s": 0, "l": 0})
    return out


# ---------------------------------------------------------------- Lab / delta E

_M = np.array([[0.4124564, 0.3575761, 0.1804375],
               [0.2126729, 0.7151522, 0.0721750],
               [0.0193339, 0.1191920, 0.9503041]])
_WHITE = np.array([0.95047, 1.0, 1.08883])


def srgb_to_lab(p: np.ndarray) -> np.ndarray:
    lin = dv.srgb_to_linear(dv.to_unit(np.asarray(p)[..., :3]).astype(np.float64))
    xyz = lin @ _M.T / _WHITE
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def delta_e(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """CIE76 per pixel between two sRGB images (uint8 or float)."""
    return np.sqrt(((srgb_to_lab(a) - srgb_to_lab(b)) ** 2).sum(-1))
