"""Upright and automatic CA removal (D2b): measurements on the picture that fill in Transform and Lens values.

Upright finds straight lines with a gradient-steered Hough transform (numpy only: no OpenCV on the
server), then levels the horizon (Level), makes verticals parallel by turning the virtual camera
(Vertical), does both directions (Full), or picks the gentler of Level and Vertical (Auto). The result is a
homography stored in params.transform.uprightMatrix, so every render and the WebGL preview use the same one.

CA removal compares the red and blue channels with green along strong edges and finds the radial scale
that lines them up best.
"""
import math

import numpy as np

from app.photo import develop as dv
from app.photo import geometry as gm

SIDE = 640


def _grey(rgb: np.ndarray, side: int) -> np.ndarray:
    y = dv.luma(dv.to_unit(rgb[..., :3]))
    h, w = y.shape
    if max(h, w) > side:
        f = side / max(h, w)
        y = dv._resize_f(y, (max(8, round(w * f)), max(8, round(h * f))), dv.Image.Resampling.BOX)
    return y.astype(np.float32)


def lines(rgb: np.ndarray, side: int = SIDE, top: int = 80) -> tuple[list[tuple[float, float, float]], tuple[int, int]]:
    """Straight lines as (theta, rho, votes): x cos(theta) + y sin(theta) = rho in pixels about the centre of a
    copy at most `side` long (its size is returned)."""
    y = dv.gaussian(_grey(rgb, side), 1.0)
    h, w = y.shape
    gy, gx = np.gradient(y)
    mag = np.hypot(gx, gy)
    # thin the edges: keep a pixel only if it beats its neighbours across the edge
    horiz = np.abs(gx) >= np.abs(gy)
    pad = np.pad(mag, 1, mode="edge")
    left, right = pad[1:-1, :-2], pad[1:-1, 2:]
    up, down = pad[:-2, 1:-1], pad[2:, 1:-1]
    peak = np.where(horiz, (mag >= left) & (mag >= right), (mag >= up) & (mag >= down))
    thr = max(0.02, float(np.percentile(mag, 90)))
    ys, xs = np.nonzero(peak & (mag > thr))
    if len(xs) < 20:
        return [], (w, h)
    if len(xs) > 60000:
        pick = np.random.default_rng(0).choice(len(xs), 60000, replace=False)
        ys, xs = ys[pick], xs[pick]
    theta_g = np.mod(np.arctan2(gy[ys, xs], gx[ys, xs]), np.pi)
    px, py = xs - (w - 1) / 2, ys - (h - 1) / 2
    n_t = 720  # quarter degrees
    diag = int(math.ceil(math.hypot(w, h) / 2)) + 1
    n_r = 2 * diag + 1
    acc = np.zeros(n_t * n_r, dtype=np.float32)
    base = np.round(theta_g / np.pi * n_t).astype(np.int32)
    weight = mag[ys, xs].astype(np.float32)
    for off in range(-8, 9):  # each pixel votes within 2° of its own gradient direction
        ti = (base + off) % n_t
        th = ti * (np.pi / n_t)
        rho = np.round(px * np.cos(th) + py * np.sin(th)).astype(np.int32) + diag
        acc += np.bincount(ti * n_r + rho, weights=weight, minlength=n_t * n_r).astype(np.float32)
    acc = acc.reshape(n_t, n_r)
    # local maxima in a 9x9 window (wrapping in theta), strongest first
    from app.photo.spatial import max_filter

    wrapped = np.concatenate([acc[-4:], acc, acc[:4]], axis=0)
    mx = max_filter(wrapped, 4)[4:-4]
    cand = np.argwhere((acc >= mx) & (acc > 0))
    votes = acc[cand[:, 0], cand[:, 1]]
    order = np.argsort(-votes)[:top]
    min_votes = 0.04 * max(w, h) * thr
    out = []
    for i in order:
        if votes[i] < min_votes:
            break
        ti, ri = cand[i]
        out.append((float(ti * np.pi / n_t), float(ri - diag), float(votes[i])))
    return out, (w, h)


def tilt(theta: float) -> tuple[str, float]:
    """('h' | 'v' | '-', clockwise tilt in degrees) of a line with normal angle theta."""
    d = math.degrees(theta)
    if abs(d - 90) <= 25:
        return "h", d - 90
    if d <= 25:
        return "v", d
    if d >= 155:
        return "v", d - 180
    return "-", 0.0


def _wmedian(vals, weights) -> float:
    o = np.argsort(vals)
    v, w = np.asarray(vals)[o], np.asarray(weights)[o]
    c = np.cumsum(w)
    return float(v[np.searchsorted(c, c[-1] / 2)])


def level_angle(found: list) -> float | None:
    """The picture's clockwise tilt from its near-horizontal and near-vertical lines (verticals count half:
    perspective makes them lean even in a level shot)."""
    vals, ws = [], []
    for th, _, votes in found:
        kind, t = tilt(th)
        if kind == "h":
            vals.append(t)
            ws.append(votes)
        elif kind == "v":
            vals.append(t)
            ws.append(votes * 0.5)
    if not vals:
        return None
    return _wmedian(vals, ws)


def vanishing(found: list, kind: str, size: tuple[int, int]) -> np.ndarray | None:
    """Least-squares vanishing point of the lines of one kind, homogeneous, in units of the long side."""
    w, h = size
    s = float(max(w, h))
    rows, ws = [], []
    for th, rho, votes in found:
        k, _ = tilt(th)
        if k == kind:
            rows.append([math.cos(th), math.sin(th), -rho / s])
            ws.append(votes)
    if len(rows) < 2:
        return None
    a = np.array(rows)
    wt = np.array(ws) / max(ws)
    for _ in range(2):
        m = (a * wt[:, None]).T @ a
        vals, vecs = np.linalg.eigh(m)
        v = vecs[:, 0]
        res = np.abs(a @ v) / np.linalg.norm(v)
        keep = res <= max(0.02, 3 * float(np.median(res)))
        if keep.sum() < 2 or keep.all():
            break
        a, wt = a[keep], wt[keep]
    if len({round(math.degrees(math.atan2(r[1], r[0])), 1) for r in a}) < 2 and abs(v[2]) > 1e-6:
        return None
    return v


def _towards(d: np.ndarray, axis: np.ndarray) -> np.ndarray:
    d = d / np.linalg.norm(d)
    return -d if d @ axis < 0 else d


def upright(rgb: np.ndarray, mode: str) -> dict:
    """-> {mode, matrix (row-major forward uv, or None), angle, lines, note}."""
    found, size = lines(rgb)
    w, h = size
    out = {"mode": mode, "matrix": None, "angle": 0.0, "lines": len(found), "note": None}
    if mode == "off":
        return out
    ang = level_angle(found)
    if ang is None:
        out["note"] = "No straight lines to go by: left as it is."
        return out
    out["angle"] = round(-ang, 2)
    level = gm.to_uv(gm._rz(math.radians(-ang)), w, h)
    if mode == "level":
        out["matrix"] = level.ravel().tolist()
        return out
    # direction vectors live in camera space: K^-1 v with the focal length in long sides
    vv = vanishing(found, "v", size)
    rot = None
    if vv is not None:
        d = _towards(np.array([vv[0] / gm.F_LONG, vv[1] / gm.F_LONG, vv[2]]), np.array([0.0, 1.0, 0.0]))
        rot = gm.rotation_between(d, [0.0, 1.0, 0.0])
        tilt_deg = math.degrees(math.acos(min(1.0, abs(float(d[1])))))
        if mode == "auto" and tilt_deg > 15:
            rot = None
            out["note"] = "Verticals lean too far for Auto; levelled instead."
        if mode == "full":
            vh = vanishing(found, "h", size)
            if vh is not None:
                dh = rot @ np.array([vh[0] / gm.F_LONG, vh[1] / gm.F_LONG, vh[2]])
                dh = _towards(dh, np.array([1.0, 0.0, 0.0]))
                # turn about the (now true) vertical until the horizontal direction lies in the picture plane
                rot = gm._ry(math.atan2(dh[2], dh[0])) @ rot
    if rot is None:
        if mode in ("vertical", "full") and out["note"] is None:
            out["note"] = "Not enough vertical lines: levelled instead."
        out["matrix"] = level.ravel().tolist()
        return out
    hp = gm.recentre(gm.camera(rot, w, h), w, h)
    m = gm.to_uv(hp, w, h)
    out["matrix"] = (m / m[2, 2]).ravel().tolist()
    return out


# ---------------------------------------------------------------- lateral chromatic aberration

def _sample(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = img.shape
    x = np.clip(x, 0, w - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0, y0 = x.astype(np.int32), y.astype(np.int32)
    tx, ty = x - x0, y - y0
    return ((img[y0, x0] * (1 - tx) + img[y0, x0 + 1] * tx) * (1 - ty)
            + (img[y0 + 1, x0] * (1 - tx) + img[y0 + 1, x0 + 1] * tx) * ty)


def chromatic(rgb: np.ndarray, side: int = 2048) -> dict:
    """Red and blue radial scales against green -> {caRed, caBlue} slider values (-100..100)."""
    a = dv.to_unit(rgb[..., :3])
    h, w = a.shape[:2]
    if max(h, w) > side:
        f = side / max(h, w)
        size = (max(8, round(w * f)), max(8, round(h * f)))
        a = np.stack([dv._resize_f(a[..., c], size, dv.Image.Resampling.BOX) for c in range(3)], axis=2)
        h, w = a.shape[:2]
    hp = [a[..., c] - dv.gaussian(a[..., c], 2.0) for c in range(3)]
    gy, gx = np.gradient(dv.gaussian(a[..., 1], 1.0))
    mag = np.hypot(gx, gy)
    cy, cx = (h - 1) / 2, (w - 1) / 2
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - cx, yy - cy) / math.hypot(cx, cy)
    sel = (r > 0.3) & (mag > max(0.02, float(np.percentile(mag, 96))))
    ys, xs = np.nonzero(sel)
    out = {"caRed": 0.0, "caBlue": 0.0, "edges": int(len(xs))}
    if len(xs) < 50:
        return out
    if len(xs) > 40000:
        pick = np.random.default_rng(0).choice(len(xs), 40000, replace=False)
        ys, xs = ys[pick], xs[pick]
    g = hp[1][ys, xs]
    g = (g - g.mean()) / (g.std() + 1e-9)
    scales = np.linspace(-1.5 * gm.CA_UNIT, 1.5 * gm.CA_UNIT, 61)
    for ch, key in ((0, "caRed"), (2, "caBlue")):
        score = []
        for s in scales:
            v = _sample(hp[ch], cx + (xs - cx) * (1 + s), cy + (ys - cy) * (1 + s))
            v = (v - v.mean()) / (v.std() + 1e-9)
            score.append(float((v * g).mean()))
        i = int(np.argmax(score))
        best = scales[i]
        if 0 < i < len(scales) - 1:
            # parabola through the three best for a sub-step answer
            a0, a1, a2 = score[i - 1], score[i], score[i + 1]
            den = a0 - 2 * a1 + a2
            if abs(den) > 1e-12:
                best += 0.5 * (a0 - a2) / den * (scales[1] - scales[0])
        out[key] = round(float(np.clip(best / gm.CA_UNIT * 100, -100, 100)), 1)
    return out
