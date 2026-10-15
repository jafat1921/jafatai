"""Smart placement (M16b): where the subject is, and how the crop, the copy and the badge keep off it.

The subject comes from the BiRefNet mask when the photo has one, else from the boxes the vision model drew
while scoring the photo. Boxes are [x0, y0, x1, y1] in 0..1 of the photo. A crop that keeps the subject (and
above all its face) clear of the copy wins; on a masked photo the subject wants the middle of the shape.

The live wave-1 run showed why: a headline set straight across a pair of boots. So the copy box also gives up
the side the subject is on when it can, and copy that still crosses the subject gets a panel.
"""
import math

import numpy as np
from PIL import Image, ImageFilter

GRID = [i / 10 for i in range(11)]


def area(b) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def inter(a, b) -> float:
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def subject_from_mask(mask: Image.Image) -> dict | None:
    small = mask.convert("L")
    small.thumbnail((256, 256))
    a = np.asarray(small, dtype=np.float32) / 255
    on = a > 0.35
    if on.mean() < 0.01:
        return None
    h, w = on.shape
    ys, xs = np.nonzero(on)
    box = [xs.min() / w, ys.min() / h, (xs.max() + 1) / w, (ys.max() + 1) / h]
    # the face, roughly: the top of the silhouette around where its mass is up there
    bh = box[3] - box[1]
    band = on[ys.min(): ys.min() + max(2, int(bh * h * 0.2))]
    cx = (np.nonzero(band)[1].mean() + 0.5) / w
    fh = bh * 0.22
    fw = min(box[2] - box[0], fh * h / w)
    face = [max(0.0, cx - fw / 2), box[1], min(1.0, cx + fw / 2), box[1] + fh]
    return {"box": [round(v, 4) for v in box], "face": [round(v, 4) for v in face], "source": "mask",
            "coverage": round(float(on.mean()), 4)}


def subject_of(spec: dict, assets) -> dict | None:
    given = spec.get("subject") or {}
    out = subject_from_mask(assets.mask) if getattr(assets, "mask", None) is not None else None
    if out is None and given.get("box"):
        out = {"box": list(given["box"]), "face": given.get("face"), "source": given.get("source") or "vision"}
    elif out is not None and given.get("face"):
        # a face the vision model saw beats the silhouette guess
        out["face"] = list(given["face"])
    return out


def crop_window(pw: int, ph: int, w: int, h: int, fx: float, fy: float) -> tuple[float, float, float, float]:
    """The part of the photo (0..1) a cover crop to w x h at focus (fx, fy) shows; the same sums as cover()."""
    sc = max(w / pw, h / ph)
    sw, sh = max(w, pw * sc), max(h, ph * sc)
    ox, oy = (sw - w) * min(1.0, max(0.0, fx)), (sh - h) * min(1.0, max(0.0, fy))
    return ox / sw, oy / sh, (ox + w) / sw, (oy + h) / sh


def to_frame(box, win, rect) -> tuple[float, float, float, float]:
    u0, v0, u1, v1 = win
    x0, y0, x1, y1 = rect
    sx, sy = (x1 - x0) / max(1e-6, u1 - u0), (y1 - y0) / max(1e-6, v1 - v0)
    return (x0 + (box[0] - u0) * sx, y0 + (box[1] - v0) * sy, x0 + (box[2] - u0) * sx, y0 + (box[3] - v0) * sy)


def photo_rect(g):
    if g.halves:
        return g.halves[1]
    if g.shape:
        return g.shape[1]
    if g.inset:
        return g.inset
    if g.ground:
        return g.blob
    return g.photo


def avoid_rects(g) -> list:
    """What the subject should stay out of: the copy over a full-bleed photo (and the badge)."""
    if g.ground or g.halves or g.shape or g.inset or g.block:
        return []
    p = g.pad
    out = [(g.copy[0] - p, g.copy[1] - p, g.copy[2] + p, g.copy[3] + p)]
    if g.badge:
        cx, cy, r = g.badge
        out.append((cx - r, cy - r, cx + r, cy + r))
    if g.footer and g.footer[0] > 0:
        # a story's footer card: the face shouldn't end up under it
        out.append(g.footer)
    return out


def place(g, photo, subject, focus) -> dict:
    """The crop focus for this layout and how much of the subject still sits under the copy."""
    rect = photo_rect(g)
    if photo is None or rect is None:
        f = (focus or {}).get("x", 0.5), (focus or {}).get("y", 0.5)
        return {"focus": f, "overlap": 0.0, "subject_frame": None, "face_frame": None}
    pw, ph = photo.size
    w, h = rect[2] - rect[0], rect[3] - rect[1]
    avoid = avoid_rects(g)
    diag = math.hypot(w, h)

    def score(fx, fy):
        if subject is None:
            return 0.0, 0.0, None, None
        win = crop_window(pw, ph, w, h, fx, fy)
        sb = to_frame(subject["box"], win, rect)
        sa = max(1.0, area(sb))
        ov = float(sum(inter(sb, a) for a in avoid) / sa)
        cost = ov
        fb = None
        if subject.get("face"):
            fb = to_frame(subject["face"], win, rect)
            fa = max(1.0, area(fb))
            cost += 5 * (1 - inter(fb, rect) / fa) + 2 * sum(inter(fb, a) for a in avoid) / fa
        else:
            cost += 1.5 * (1 - inter(sb, rect) / sa)
        if not avoid:
            cx, cy = (sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2
            cost += 1.5 * math.hypot(cx - (rect[0] + rect[2]) / 2, cy - (rect[1] + rect[3]) / 2) / diag
        cost += 0.04 * (abs(fx - 0.5) + abs(fy - 0.5))
        return cost, ov, sb, fb

    if focus is not None:
        fx, fy = focus.get("x", 0.5), focus.get("y", 0.5)
        _, ov, sb, fb = score(fx, fy)
        return {"focus": (fx, fy), "overlap": ov, "subject_frame": sb, "face_frame": fb}
    if subject is None:
        return {"focus": (0.5, 0.5), "overlap": 0.0, "subject_frame": None, "face_frame": None}
    best = min(((score(fx, fy), (fx, fy)) for fx in GRID for fy in GRID), key=lambda t: t[0][0])
    (_, ov, sb, fb), f = best
    return {"focus": f, "overlap": ov, "subject_frame": sb, "face_frame": fb}


def clear_of(box: list, subj, g) -> tuple[list, str | None]:
    """The copy box with the subject's side taken away, when what's left is still a usable column."""
    x0, y0, x1, y1 = box
    pad = g.pad
    s = g.s
    out, how = list(box), None
    if inter(box, subj) <= 0.02 * area(box):
        return out, None
    if subj[0] > x0 + (x1 - x0) * 0.35 and subj[0] - pad - x0 >= 0.36 * g.w:
        out[2], how = min(x1, subj[0] - pad), "end"
    elif subj[2] < x1 - (x1 - x0) * 0.35 and x1 - subj[2] - pad >= 0.36 * g.w:
        out[0], how = max(x0, subj[2] + pad), "start"
    elif subj[1] > y0 + 0.2 * s and subj[1] - pad - y0 >= 0.24 * s:
        out[3], how = min(y1, subj[1] - pad), "above"
    return out, how


def copy_overlap(report: dict, place: dict) -> float:
    """How much of the subject the finished copy covers (0..1), for the QA pass."""
    sb = place.get("subject_frame")
    if sb is None:
        return 0.0
    boxes = [b for role, b in (report.get("boxes") or {}).items() if role not in ("logo_slot",)]
    return float(min(1.0, sum(inter(sb, b) for b in boxes) / max(1.0, area(sb))))


def badge_spot(g, place: dict, report: dict, copy_rect=None):
    """The badge spot that covers the least of the subject (the face counts thrice) and none of the copy."""
    sb, fb = place.get("subject_frame"), place.get("face_frame")
    subj = report.get("cutout_box")
    if subj and not fb:
        # a cut-out's head is the top fifth of where it landed
        fb = (subj[0], subj[1], subj[2], subj[1] + (subj[3] - subj[1]) * 0.2)
    pad = g.pad
    keep = [(copy_rect[0] - pad, copy_rect[1] - pad, copy_rect[2] + pad, copy_rect[3] + pad)] if copy_rect else [g.copy]
    keep += [g.logo] if g.logo else []
    if g.detail:
        cx, cy, r = g.detail
        keep.append((cx - r, cy - r, cx + r, cy + r))

    def cost(spot):
        cx, cy, r = spot
        b = (cx - r, cy - r, cx + r, cy + r)
        c = sum(inter(b, k) for k in keep) * 4
        for box, wt in ((sb, 1), (fb, 3), (subj, 1)):
            if box:
                c += inter(b, box) * wt
        off = max(0, r - cx) + max(0, cx + r - g.w) + max(0, r - cy) + max(0, cy + r - g.h)
        return c + off * 1000
    return min(g.badge_spots, key=cost)


# ---------------------------------------------------------------- photo heuristics (no vision model)

def edge_density(img: Image.Image, region=None) -> float:
    """Mean edge strength in a region (0..1 boxes), 0..1: busy textures score high, calm space low."""
    small = img.convert("L")
    small.thumbnail((256, 256))
    e = np.asarray(small.filter(ImageFilter.FIND_EDGES), dtype=np.float32) / 255
    if region:
        h, w = e.shape
        x0, y0, x1, y1 = region
        e = e[int(y0 * h):max(int(y0 * h) + 1, int(y1 * h)), int(x0 * w):max(int(x0 * w) + 1, int(x1 * w))]
    return float(e.mean())


def sharpness(img: Image.Image) -> float:
    small = img.convert("L")
    small.thumbnail((512, 512))
    lap = small.filter(ImageFilter.Kernel((3, 3), [0, 1, 0, 1, -4, 1, 0, 1, 0], 1, 128))
    return float(np.asarray(lap, dtype=np.float32).std() / 128)


# the calm area each layout wants in the photo (start side = left; the caller mirrors for RTL)
COPY_REGION = {"frosted": (0, 0, 0.6, 0.5), "badge": (0, 0, 0.6, 0.5), "side_wash": (0, 0, 0.5, 1),
               "big_price": (0, 0, 0.55, 1), "bottom_bar": (0, 0.66, 1, 1), "minimal": (0, 0, 1, 0.5)}


def heuristic_score(img: Image.Image, style: str, rtl: bool = False) -> float:
    """0..10 without a vision model: a calm copy area and a sharp picture."""
    region = COPY_REGION.get(style)
    if region and rtl:
        region = (1 - region[2], region[1], 1 - region[0], region[3])
    calm = 1 - min(1.0, edge_density(img, region) * 6) if region else 0.5
    return round(10 * (0.75 * calm + 0.25 * min(1.0, sharpness(img) * 4)), 2)
