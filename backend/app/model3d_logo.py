"""Logo / flat art to a 3D badge (contract v40 §8).

No GPU and no model: the picture's outline, holes and all, is traced, extruded and bevelled. The artwork goes
on the front at full size and the sides get a metal finish. Plain numpy and Pillow, so the server needs
nothing new.

params["model3d"] for these holds start "logo", source_id (the picture, which is also the thumbnail),
logo {depth, bevel, finish, back} and alpha: "own" (the picture is see-through already), "cutout" or "key".
For "cutout" there is cutout {generation_id, media_id, status}: Photo Studio's BiRefNet cut-out on the image
GPU, which the job waits for the way a text start waits for its picture.
"""
import io
import json
import logging
import math
import struct
import time

import numpy as np
from PIL import Image, ImageFilter, ImageOps

JOB = "model3d_logo"
DEPTHS = {"thin": 0.03, "medium": 0.06, "thick": 0.12}  # of the logo's width
BEVELS = ("none", "soft", "round")
BACKS = ("mirror", "plain")
# linear base colour, metallic, roughness; "colour" takes the logo's own main colour
FINISHES = {
    "gold": ((1.0, 0.766, 0.336), 1.0, 0.28),
    "chrome": ((0.62, 0.62, 0.64), 1.0, 0.08),
    "steel": ((0.56, 0.57, 0.58), 1.0, 0.38),
    "colour": (None, 0.15, 0.45),
}
FINISH_LABELS = {"gold": "Gold", "chrome": "Chrome", "steel": "Brushed steel", "colour": "Logo colour"}
DEFAULTS = {"depth": "medium", "bevel": "soft", "finish": "gold", "back": "mirror"}

GEOM_PX = 1024  # the outline is traced at this size; the texture keeps the picture's own
TEXTURE_MAX = 4096
SIMPLIFY_PX = 0.5
SPECK_PX = 12.0  # outlines smaller than this many square pixels are dust, not part of the logo
SMOOTH_COS = math.cos(math.radians(35))  # corners sharper than this keep a hard edge
ROOM = 0.25  # of a stroke's width the bevel may take from each side

log = logging.getLogger("mixai.model3d_logo")


class LogoError(ValueError):
    pass


# ---------------------------------------------------------------- the shape's alpha

def open_rgba(path) -> Image.Image:
    with Image.open(path) as im:
        return ImageOps.exif_transpose(im).convert("RGBA")


def key_out(rgba: Image.Image) -> Image.Image:
    """No transparency and no cut-out wanted: take away the plain colour around the edges."""
    a = np.asarray(rgba.convert("RGB"), dtype=np.int16)
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.abs(a - bg).max(-1)
    alpha = np.clip((dist - 20) * (255 / 30), 0, 255).astype(np.uint8)
    out = rgba.convert("RGB")
    out.putalpha(Image.fromarray(alpha, "L"))
    return out


def crop_to_art(rgba: Image.Image) -> Image.Image:
    a = np.asarray(rgba.getchannel("A"))
    ys, xs = np.nonzero(a > 127)
    if xs.size == 0:
        raise LogoError("There's no shape to trace: the picture is see-through all over.")
    w, h = rgba.size
    pad = max(2, round(max(w, h) * 0.01))
    return rgba.crop((max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
                      min(w, int(xs.max()) + 1 + pad), min(h, int(ys.max()) + 1 + pad)))


# TODO: an SVG logo could skip the tracing and use its own paths
def field(art: Image.Image) -> np.ndarray:
    """The alpha at tracing size, 0..1. Small logos are scaled up first so their curves trace smoothly."""
    w, h = art.size
    sc = GEOM_PX / max(w, h)
    size = (max(2, round(w * sc)), max(2, round(h * sc)))
    a = art.getchannel("A").resize(size, Image.BICUBIC if sc > 1 else Image.LANCZOS)
    # blur with the scale, or an upscaled logo's pixel steps come through as wobbles
    a = a.filter(ImageFilter.GaussianBlur(max(0.7, 0.5 * sc)))
    return np.asarray(a, dtype=np.float32) / 255.0


# ---------------------------------------------------------------- outlines

def trace(f: np.ndarray, level: float = 0.5) -> list[np.ndarray]:
    """Marching squares: every closed outline of f >= level in pixel coordinates, the inside always on the
    same side, so outlines and holes come out wound opposite ways. Saddles go by the cell's centre."""
    g = np.pad(f, 1)
    b = (g >= level).astype(np.uint8)
    W = g.shape[1]
    case = b[:-1, :-1] | (b[:-1, 1:] << 1) | (b[1:, 1:] << 2) | (b[1:, :-1] << 3)
    ii, jj = np.nonzero((case != 0) & (case != 15))
    nxt: dict[int, int] = {}
    for i, j in zip(ii.tolist(), jj.tolist()):
        c = int(case[i, j])
        inside = (c & 1, c & 2, c & 4, c & 8)  # corners clockwise from top left
        # edge keys: (cell index * 2) for a horizontal edge, + 1 for a vertical one
        sides = ((i * W + j) * 2, (i * W + j + 1) * 2 + 1, ((i + 1) * W + j) * 2, (i * W + j) * 2 + 1)
        cross = [(sides[k], bool(inside[(k + 1) % 4])) for k in range(4)
                 if bool(inside[k]) != bool(inside[(k + 1) % 4])]
        if len(cross) == 2:
            (k0, in0), (k1, _) = cross
            if in0:
                nxt[k0] = k1
            else:
                nxt[k1] = k0
            continue
        joined = (g[i, j] + g[i, j + 1] + g[i + 1, j + 1] + g[i + 1, j]) / 4 >= level
        for n, (k, entering) in enumerate(cross):
            if entering:
                nxt[k] = cross[(n - 1) % 4 if joined else (n + 1) % 4][0]

    rings, seen = [], set()
    for start in nxt:
        if start in seen:
            continue
        ring, k = [], start
        while k is not None and k not in seen:
            seen.add(k)
            ring.append(k)
            k = nxt.get(k)
        if k == start and len(ring) >= 3:
            rings.append(_points(np.asarray(ring), g, W, level))
    return rings


def _points(keys: np.ndarray, g: np.ndarray, W: int, level: float) -> np.ndarray:
    vert = keys & 1
    cell = keys >> 1
    i, j = cell // W, cell % W
    f0, f1 = g[i, j], g[i + vert, j + 1 - vert]
    t = np.clip((level - f0) / np.where(f1 == f0, 1, f1 - f0), 0, 1)
    # the pad is one pixel, and a value sits at its pixel's centre
    return np.stack([j + t * (1 - vert) - 0.5, i + t * vert - 0.5], 1).astype(np.float64)


def _dp(pts: np.ndarray, eps: float) -> np.ndarray:
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = pts[b] - pts[a]
        rel = pts[a + 1:b] - pts[a]
        n = math.hypot(seg[0], seg[1])
        d = np.hypot(rel[:, 0], rel[:, 1]) if n < 1e-9 else np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / n
        m = int(np.argmax(d))
        if d[m] > eps:
            m += a + 1
            keep[m] = True
            stack += [(a, m), (m, b)]
    return pts[keep]


def simplify(ring: np.ndarray, eps: float = SIMPLIFY_PX) -> np.ndarray:
    """Douglas-Peucker on a closed outline, split at its two furthest-apart points."""
    if len(ring) < 8:
        return ring
    far = int(np.argmax(((ring - ring[0]) ** 2).sum(1)))
    a = _dp(ring[:far + 1], eps)
    b = _dp(np.vstack([ring[far:], ring[:1]]), eps)
    return np.vstack([a[:-1], b[:-1]])


def area(ring: np.ndarray) -> float:
    x, y = ring[:, 0], ring[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))


def _contains(poly: np.ndarray, pt) -> bool:
    x, y = pt
    xs, ys = poly[:, 0], poly[:, 1]
    xn, yn = np.roll(xs, -1), np.roll(ys, -1)
    span = (ys > y) != (yn > y)
    xi = xs + (y - ys) * (xn - xs) / np.where(yn == ys, 1, yn - ys)
    return bool(np.count_nonzero(span & (x < xi)) % 2)


def group(rings: list[np.ndarray]) -> list[tuple[np.ndarray, list[np.ndarray]]]:
    """(outline, holes) pairs: outlines counter-clockwise, holes clockwise, each hole with the smallest
    outline around it. An island inside a hole (the dot in a target) is an outline of its own."""
    rings = [r for r in rings if len(r) >= 3 and abs(area(r)) >= SPECK_PX]
    if not rings:
        return []
    areas = [area(r) for r in rings]
    # the biggest outline can't be a hole, so its winding says which way outlines go
    sign = 1.0 if areas[int(np.argmax(np.abs(areas)))] > 0 else -1.0
    outers = [r if a > 0 else r[::-1].copy() for r, a in zip(rings, areas) if a * sign > 0]
    holes = [r if a < 0 else r[::-1].copy() for r, a in zip(rings, areas) if a * sign < 0]
    out = [(o, []) for o in outers]
    boxes = [(o.min(0), o.max(0), area(o)) for o in outers]
    for h in holes:
        p = h[0]
        best = None
        for n, (lo, hi, a) in enumerate(boxes):
            if lo[0] <= p[0] <= hi[0] and lo[1] <= p[1] <= hi[1] and _contains(outers[n], p):
                if best is None or a < boxes[best][2]:
                    best = n
        if best is not None:
            out[best][1].append(h)
    return out


# ---------------------------------------------------------------- triangles

def _cross(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _in_triangle(a, b, c, q: np.ndarray) -> np.ndarray:
    d1 = (b[0] - a[0]) * (q[:, 1] - a[1]) - (b[1] - a[1]) * (q[:, 0] - a[0])
    d2 = (c[0] - b[0]) * (q[:, 1] - b[1]) - (c[1] - b[1]) * (q[:, 0] - b[0])
    d3 = (a[0] - c[0]) * (q[:, 1] - c[1]) - (a[1] - c[1]) * (q[:, 0] - c[0])
    neg = (d1 < 0) | (d2 < 0) | (d3 < 0)
    pos = (d1 > 0) | (d2 > 0) | (d3 > 0)
    return ~(neg & pos)


def _bridge(pts: np.ndarray, poly: list[int], hole: list[int]) -> list[int]:
    """Join a hole to the outline through a vertex both can see (Eberly), so one loop goes round both."""
    h = pts[hole]
    m = int(np.argmax(h[:, 0]))
    M = h[m]
    P = pts[poly]
    Q = np.roll(P, -1, 0)
    span = ((P[:, 1] <= M[1]) & (Q[:, 1] > M[1])) | ((Q[:, 1] <= M[1]) & (P[:, 1] > M[1]))
    dy = Q[:, 1] - P[:, 1]
    xi = P[:, 0] + (M[1] - P[:, 1]) * (Q[:, 0] - P[:, 0]) / np.where(dy == 0, 1, dy)
    hit = span & (xi >= M[0])
    n = len(poly)
    if hit.any():
        e = int(np.argmin(np.where(hit, xi, np.inf)))
        I = (float(xi[e]), float(M[1]))
        v = e if P[e, 0] >= Q[e, 0] else (e + 1) % n
        cand = P[v]
        prev, nxt = np.roll(P, 1, 0), Q
        reflex = ((P[:, 0] - prev[:, 0]) * (nxt[:, 1] - P[:, 1]) - (P[:, 1] - prev[:, 1]) * (nxt[:, 0] - P[:, 0])) < 0
        inside = reflex & _in_triangle(M, I, cand, P) & ~((P == cand).all(1))
        inside[v] = False
        if inside.any():
            idx = np.nonzero(inside)[0]
            ang = np.abs(P[idx, 1] - M[1]) / np.maximum(P[idx, 0] - M[0], 1e-12)
            dist = np.hypot(P[idx, 0] - M[0], P[idx, 1] - M[1])
            v = int(idx[np.lexsort((dist, ang))[0]])
    else:
        # nothing to the right (it shouldn't happen for a real hole); the nearest vertex will do
        v = int(np.argmin(np.hypot(P[:, 0] - M[0], P[:, 1] - M[1])))
    return poly[:v + 1] + hole[m:] + hole[:m + 1] + [poly[v]] + poly[v + 1:]


def _earclip(pts: np.ndarray, poly: list[int]) -> tuple[list[tuple[int, int, int]], int]:
    n = len(poly)
    if n < 3:
        return [], 0
    xy = pts[poly]
    prev = [(i - 1) % n for i in range(n)]
    nxt = [(i + 1) % n for i in range(n)]
    alive = np.ones(n, bool)
    pp, nn = np.roll(xy, 1, 0), np.roll(xy, -1, 0)
    reflex = ((xy[:, 0] - pp[:, 0]) * (nn[:, 1] - xy[:, 1]) - (xy[:, 1] - pp[:, 1]) * (nn[:, 0] - xy[:, 0])) <= 0

    def ear(a: int, b: int, c: int) -> bool:
        A, B, C = xy[a], xy[b], xy[c]
        if (A == B).all() or (B == C).all():
            return True  # a corner folded onto its neighbour: a flat triangle, but the loop stays closed
        if _cross(A, B, C) <= 1e-12:
            return False
        test = alive & reflex
        test[[a, b, c]] = False
        if not test.any():
            return True
        q = xy[test]
        # the bridge doubles two vertices; a copy of a corner doesn't block its own ear
        q = q[~((q == A).all(1) | (q == B).all(1) | (q == C).all(1))]
        return not _in_triangle(A, B, C, q).any()

    tris = []
    i, left, misses, stuck = 0, n, 0, 0
    while left > 3:
        a, c = prev[i], nxt[i]
        forced = misses >= left
        if forced or ear(a, i, c):
            # forced: nothing clips cleanly (a tangle in the input); take this corner anyway rather than stall
            tris.append((poly[a], poly[i], poly[c]))
            alive[i] = False
            nxt[a], prev[c] = c, a
            left -= 1
            for k in (a, c):
                reflex[k] = _cross(xy[prev[k]], xy[k], xy[nxt[k]]) <= 0
            i, misses = c, 0
            stuck += forced
        else:
            i = c
            misses += 1
    tris.append((poly[prev[i]], poly[i], poly[nxt[i]]))
    return tris, stuck


def triangulate(outer: np.ndarray, holes: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray, bool]:
    """The flat face of one outline with its holes: (points = outer then each hole in order, triangles, and
    whether it came out clean: no corner had to be forced and every triangle faces the same way)."""
    pts = np.vstack([outer, *holes]) if holes else outer
    poly = list(range(len(outer)))
    at, idx = len(outer), []
    for h in holes:
        idx.append(list(range(at, at + len(h))))
        at += len(h)
    for k in sorted(range(len(holes)), key=lambda k: -float(holes[k][:, 0].max())):
        poly = _bridge(pts, poly, idx[k])
    tris, stuck = _earclip(pts, poly)
    tri = np.asarray(tris, dtype=np.int64).reshape(-1, 3)
    u, v = pts[tri[:, 1]] - pts[tri[:, 0]], pts[tri[:, 2]] - pts[tri[:, 0]]
    flipped = (u[:, 0] * v[:, 1] - u[:, 1] * v[:, 0]) < -1e-6  # pixels²: rounding on a folded corner is no flip
    return pts, tri, not stuck and not flipped.any()


# ---------------------------------------------------------------- the solid

def _profile(bevel: str, half: float, b: float):
    """Strips from the back cap round to the front one: ((inset share, z), (inset share, z), angle, angle).
    The angle tilts a strip's normal from straight out (0) towards the face it meets (90)."""
    if bevel == "none" or b <= 0:
        return [((0.0, half), (0.0, -half), 0.0, 0.0)]
    if bevel == "soft":
        front = [((0.0, -(half - b)), (1.0, -half), 45.0, 45.0)]
    else:
        k = 4
        rings = [(1 - math.cos(math.radians(90 * s / k)), -(half - b + b * math.sin(math.radians(90 * s / k))),
                  90 * s / k) for s in range(k + 1)]
        front = [((r0[0], r0[1]), (r1[0], r1[1]), r0[2], r1[2]) for r0, r1 in zip(rings, rings[1:])]
    back = [((b1[0], -b1[1]), (a1[0], -a1[1]), t1, t0) for (a1, b1, t0, t1) in reversed(front)]
    return back + [((0.0, half - b), (0.0, -(half - b)), 0.0, 0.0)] + front


def _ring_frame(ring: np.ndarray):
    """Per edge outward normals (edge i runs from vertex i to i + 1), per vertex mitred normals, and which
    corners are smooth enough to share a normal."""
    d = np.roll(ring, -1, 0) - ring
    ln = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-12)
    ne = np.stack([d[:, 1] / ln, -d[:, 0] / ln], 1)
    before = np.roll(ne, 1, 0)
    nv = before + ne
    nl = np.hypot(nv[:, 0], nv[:, 1])
    nv = np.where(nl[:, None] > 1e-6, nv / np.maximum(nl, 1e-12)[:, None], ne)
    miter = 1 / np.maximum((nv * ne).sum(1), 0.35)
    smooth = (before * ne).sum(1) > SMOOTH_COS
    return ne, nv, miter, smooth


def _room(ring: np.ndarray, nv: np.ndarray, inside, reach: float) -> np.ndarray:
    """How far each vertex can move inwards: a quarter of the way to the stroke's far side (found by stepping
    along the normal through the tracing mask), so a thin letter keeps half its face."""
    hit = np.full(len(ring), np.inf)
    # from 2 px in: a vertex sits right on the 0.5 contour, so the first pixel either side is a coin toss
    for t in np.arange(2.0, reach + 2.0, 0.5):
        q = ring - nv * t
        out = ~inside(q)
        hit = np.where(np.isinf(hit) & out, t, hit)
    return ROOM * np.minimum(hit, reach + 2.0)  # never reached the far side: all the room asked for


def _bevelled(r: np.ndarray, nv: np.ndarray, miter: np.ndarray, inside, b: float) -> np.ndarray:
    """The outline moved in by the bevel's width. One width all round, so the bevel reads as one piece; only
    a thin spot (a serif, a tip) takes less."""
    room = _room(r, nv, inside, b * 2.5 / ROOM) / miter
    d = np.minimum(min(b, float(np.percentile(room, 10))), room)
    return _untangle(r, r - nv * (d * miter)[:, None])


def _untangle(r: np.ndarray, moved: np.ndarray, rounds: int = 24) -> np.ndarray:
    """Fold out the swallowtails: where the bevelled outline runs backwards along an edge (a curve tighter
    than the bevel, like a letter's rounded corner), both ends of that edge go to the point where the edges
    either side of it meet, as a sharp mitred corner would."""
    moved = moved.copy()
    n = len(r)
    e0 = np.roll(r, -1, 0) - r
    for _ in range(rounds):
        e1 = np.roll(moved, -1, 0) - moved
        bad = np.nonzero((e0 * e1).sum(1) < -1e-9)[0]
        if not len(bad):
            break
        for i in bad.tolist():
            a, j, c = (i - 1) % n, (i + 1) % n, (i + 2) % n
            p, u = moved[a], e0[a]
            q, v = moved[c], e0[j]
            den = u[0] * v[1] - u[1] * v[0]
            mid = (moved[i] + moved[j]) / 2
            x = mid
            if abs(den) > 1e-9:
                t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / den
                x = p + u * t
                if np.hypot(*(x - mid)) > 3 * max(np.hypot(*(r[i] - moved[i])), 1.0):
                    x = mid  # near-parallel neighbours: a far-off meeting point is no corner
            moved[i] = moved[j] = x
    return _snip(moved)


def _snip(ring: np.ndarray, reach: int = 8, rounds: int = 24) -> np.ndarray:
    """Cut small loops out: when an edge crosses one a few edges further on (a bevel squeezed through a
    narrow notch), the vertices between go to the crossing."""
    ring = ring.copy()
    n = len(ring)
    if n < 6:
        return ring
    for _ in range(rounds):
        found = False
        a, b = ring, np.roll(ring, -1, 0)
        for k in range(2, min(reach, n - 2) + 1):
            c, d = np.roll(a, -k, 0), np.roll(b, -k, 0)
            r, s = b - a, d - c
            den = r[:, 0] * s[:, 1] - r[:, 1] * s[:, 0]
            qp = c - a
            with np.errstate(divide="ignore", invalid="ignore"):
                t = (qp[:, 0] * s[:, 1] - qp[:, 1] * s[:, 0]) / den
                u = (qp[:, 0] * r[:, 1] - qp[:, 1] * r[:, 0]) / den
            hit = np.nonzero((np.abs(den) > 1e-12) & (t > 1e-6) & (t < 1 - 1e-6) & (u > 1e-6) & (u < 1 - 1e-6))[0]
            for i in hit.tolist():
                x = a[i] + r[i] * t[i]
                for m in range(1, k + 1):
                    ring[(i + m) % n] = x
                found = True
            if found:
                break
        if not found:
            break
    return ring


def _orient(pos: np.ndarray, tri: np.ndarray, want: np.ndarray) -> np.ndarray:
    a, b, c = pos[tri[:, 0]], pos[tri[:, 1]], pos[tri[:, 2]]
    flip = (np.cross(b - a, c - a) * want).sum(1) < 0
    tri = tri.copy()
    tri[flip] = tri[flip][:, [0, 2, 1]]
    return tri


class Part:
    def __init__(self):
        self.pos, self.nrm, self.uv, self.tri, self.n = [], [], [], [], 0

    def add(self, pos, nrm, uv, tri):
        self.pos.append(pos)
        self.nrm.append(nrm)
        self.uv.append(uv)
        self.tri.append(tri + self.n)
        self.n += len(pos)

    def arrays(self):
        if not self.pos:
            return None
        return (np.vstack(self.pos).astype(np.float32), np.vstack(self.nrm).astype(np.float32),
                np.vstack(self.uv).astype(np.float32), np.vstack(self.tri).astype(np.uint32))


def solid(shapes, f: np.ndarray, centre, opts: dict):
    """The three parts of the badge (front, back, sides) in world units: the logo is 1 wide or tall at most,
    faces front on -Z (where the viewer's camera starts), and reads the right way round from there."""
    hgt, wid = f.shape
    inside_mask = f >= 0.5
    cx, cy = centre
    all_pts = np.vstack([np.vstack([o, *hs]) for o, hs in shapes])
    width_px = float(np.ptp(all_pts[:, 0]))
    depth_px = DEPTHS[opts["depth"]] * width_px
    half = depth_px / 2
    b = {"none": 0.0, "soft": 0.3, "round": 0.45}[opts["bevel"]] * depth_px
    b = min(b, 0.03 * width_px)
    s = 1.0 / max(np.ptp(all_pts[:, 0]), np.ptp(all_pts[:, 1]))

    def inside(q):
        # q is in the plane frame; back to tracing pixels
        x = np.floor(cx - q[:, 0]).astype(int)
        y = np.floor(cy - q[:, 1]).astype(int)
        ok = (x >= 0) & (x < wid) & (y >= 0) & (y < hgt)
        res = np.zeros(len(q), bool)
        res[ok] = inside_mask[y[ok], x[ok]]
        return res

    def uv_of(q):
        # pixel k spans k..k+1 in the tracing frame
        return np.stack([(cx - q[:, 0]) / wid, (cy - q[:, 1]) / hgt], 1)

    front, back, sides = Part(), Part(), Part()
    strips = _profile(opts["bevel"], half, b)
    for outer, holes in shapes:
        rings = [outer, *holes]
        frames = [_ring_frame(r) for r in rings]
        inner = rings
        if b > 0:
            inner = [_bevelled(r, nv, miter, inside, b) for r, (ne, nv, miter, smooth) in zip(rings, frames)]
        # the face is cut from the bevelled outline itself: the flat outline's long fans would cross a hole
        # the bevel has made bigger. If the bevelled outline still tangles, this shape goes without a bevel.
        cap, tri, clean = triangulate(inner[0], inner[1:])
        if not clean and b > 0:
            log.info("bevel dropped on a %d-point outline: it tangles", len(outer))
            inner = rings
            cap, tri, _ = triangulate(outer, holes)
        for r, (ne, nv, miter, smooth), inn in zip(rings, frames, inner):
            n = len(r)
            nxt = np.roll(np.arange(n), -1)
            # the normal at each end of each edge: shared across a smooth corner, the edge's own at a sharp one
            n0 = np.where(smooth[:, None], nv, ne)
            n1 = np.where(smooth[nxt][:, None], nv[nxt], ne)
            for (fa, za), (fb, zb), ta, tb in strips:
                pa, pb = r + (inn - r) * fa, r + (inn - r) * fb
                quad = [(pa, za, n0, ta), (pa[nxt], za, n1, ta), (pb[nxt], zb, n1, tb), (pb, zb, n0, tb)]
                pos, nrm = [], []
                for p2, z, n2, t in quad:
                    tr = math.radians(t)
                    pos.append(np.column_stack([p2, np.full(n, z)]))
                    zn = math.copysign(math.sin(tr), z) if t else 0.0
                    nrm.append(np.column_stack([n2 * math.cos(tr), np.full(n, zn)]))
                P = np.stack(pos, 1).reshape(-1, 3)
                N = np.stack(nrm, 1).reshape(-1, 3)
                N /= np.maximum(np.linalg.norm(N, axis=1), 1e-12)[:, None]
                base = (np.arange(n) * 4)[:, None]
                quads = np.vstack([base + [0, 1, 2], base + [0, 2, 3]])
                want = N[quads[:, 0]] + N[quads[:, 1]] + N[quads[:, 2]]
                sides.add(P, N, np.zeros((len(P), 2)), _orient(P, quads, want))

        uv = uv_of(np.vstack(rings))  # the original outline: the whole artwork shows, a touch squeezed into the bevel
        for part, z in ((front, -half), (back, half)):
            P = np.column_stack([cap, np.full(len(cap), z)])
            N = np.tile([0.0, 0.0, math.copysign(1.0, z)], (len(cap), 1))
            part.add(P, N, uv, _orient(P, tri, N[0][None, :]))

    out = []
    for part in (front, back, sides):
        arr = part.arrays()
        if arr is not None:
            pos, nrm, uv, tri = arr
            out.append(((pos * s).astype(np.float32), nrm, uv, tri))
        else:
            out.append(None)
    return out, {"width": width_px * s, "depth": depth_px * s}


# ---------------------------------------------------------------- texture, colour, GLB

def texture(art: Image.Image) -> Image.Image:
    """The cut-out art on solid colour: its own colours spread out under the soft edge, so a cap's rim and
    the texture's mipmaps never pick up the black of empty pixels."""
    if max(art.size) > TEXTURE_MAX:
        sc = TEXTURE_MAX / max(art.size)
        art = art.resize((max(1, round(art.width * sc)), max(1, round(art.height * sc))), Image.LANCZOS)
    wide = art.convert("RGBa").filter(ImageFilter.GaussianBlur(max(8, max(art.size) // 64))).convert("RGBA")
    near = art.convert("RGBa").filter(ImageFilter.GaussianBlur(3)).convert("RGBA")
    wide.putalpha(255)
    out = Image.alpha_composite(Image.alpha_composite(wide, near), art)
    return out.convert("RGB")


def main_colour(art: Image.Image) -> tuple[int, int, int]:
    small = art.copy()
    small.thumbnail((160, 160))
    px = np.asarray(small)
    solid_px = px[px[..., 3] > 230][:, :3]
    if not len(solid_px):
        return (180, 140, 60)
    pal = Image.fromarray(solid_px.reshape(-1, 1, 3).astype(np.uint8), "RGB").quantize(6)
    count, idx = max(pal.getcolors())
    rgb = pal.getpalette()[idx * 3: idx * 3 + 3]
    return tuple(int(v) for v in rgb)


def _linear(c: int) -> float:
    v = c / 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def materials(finish: str, colour: tuple[int, int, int]) -> list[dict]:
    base, metal, rough = FINISHES[finish]
    if base is None:
        base = tuple(round(_linear(c), 4) for c in colour)
    return [
        {"name": "Artwork", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0,
                                                     "roughnessFactor": 0.55}},
        {"name": FINISH_LABELS[finish], "pbrMetallicRoughness": {"baseColorFactor": [*base, 1.0],
                                                                 "metallicFactor": metal, "roughnessFactor": rough}},
    ]


def glb(prims: list[tuple], mats: list[dict], png: bytes, name: str = "Logo") -> bytes:
    """prims: (positions, normals, uvs or None, triangles, material index). One mesh, embedded texture."""
    blob = bytearray()
    views, accessors = [], []

    def put(data: bytes, target: int | None = None) -> int:
        blob.extend(b"\0" * (-len(blob) % 4))
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data),
                      **({"target": target} if target else {})})
        blob.extend(data)
        return len(views) - 1

    def acc(arr: np.ndarray, typ: str, comp: int, target: int, bounds: bool = False) -> int:
        a = {"bufferView": put(arr.tobytes(), target), "componentType": comp, "count": int(len(arr)), "type": typ}
        if bounds:
            a.update(min=[float(v) for v in arr.min(0)], max=[float(v) for v in arr.max(0)])
        accessors.append(a)
        return len(accessors) - 1

    primitives = []
    for pos, nrm, uv, tri, mat in prims:
        attrs = {"POSITION": acc(pos, "VEC3", 5126, 34962, True), "NORMAL": acc(nrm, "VEC3", 5126, 34962)}
        if uv is not None:
            attrs["TEXCOORD_0"] = acc(uv, "VEC2", 5126, 34962)
        primitives.append({"attributes": attrs, "indices": acc(tri.reshape(-1), "SCALAR", 5125, 34963),
                           "material": mat})
    image_view = put(png)
    doc = {
        "asset": {"version": "2.0", "generator": "mixai logo"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": primitives}],
        "materials": mats,
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": image_view, "mimeType": "image/png"}],
        "textures": [{"sampler": 0, "source": 0}],
        "buffers": [{"byteLength": 0}],
        "bufferViews": views, "accessors": accessors,
    }
    blob.extend(b"\0" * (-len(blob) % 4))
    doc["buffers"][0]["byteLength"] = len(blob)
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob)
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def make(rgba: Image.Image, opts: dict | None = None, progress=None) -> tuple[bytes, dict]:
    """A see-through picture of the logo in, a GLB and a few facts about it out."""
    opts = {**DEFAULTS, **{k: v for k, v in (opts or {}).items() if v}}
    tick = progress or (lambda _p, _m: None)
    art = crop_to_art(rgba)
    f = field(art)
    tick(0.2, "Tracing the outline")
    rings = [simplify(r) for r in trace(f)]
    hgt, wid = f.shape
    # the plane frame: tracing pixels turned half a turn about the centre, so +y is up and the art reads
    # the right way round from -Z
    pts = np.vstack(rings) if rings else np.zeros((0, 2))
    if not len(pts):
        raise LogoError("There's no shape to trace in this picture.")
    cx, cy = (pts.min(0) + pts.max(0)) / 2
    plane = [np.column_stack([cx - r[:, 0], cy - r[:, 1]]) for r in rings]
    shapes = group(plane)
    if not shapes:
        raise LogoError("The shape in this picture is too small to trace.")
    tick(0.5, "Extruding")
    parts, size = solid(shapes, f, (cx, cy), opts)
    tick(0.8, "Painting the front")
    colour = main_colour(art)
    tex = texture(art)
    buf = io.BytesIO()
    tex.save(buf, "PNG", compress_level=6)
    front, back, sides = parts
    prims = [(*front, 0), (back[0], back[1], back[2] if opts["back"] == "mirror" else None, back[3],
                         0 if opts["back"] == "mirror" else 1), (sides[0], sides[1], None, sides[3], 1)]
    data = glb(prims, materials(opts["finish"], colour), buf.getvalue())
    info = {"outlines": len(shapes), "holes": sum(len(h) for _, h in shapes),
            "vertices": int(sum(p[0].shape[0] for p in parts)), "triangles": int(sum(p[3].shape[0] for p in parts)),
            "texture": list(tex.size), "size": {k: round(float(v), 4) for k, v in size.items()},
            "colour": "#%02x%02x%02x" % colour, **opts}
    return data, info


# ---------------------------------------------------------------- the job (general lane)

def handle(ctx) -> dict:
    from app import model3d as m3
    from app.config import get_settings
    from app.models import Generation, Job
    from app.worker import _out_path

    db, job = ctx.db, ctx.job
    gen = db.get(Generation, job.generation_id) if job.generation_id else None
    if gen is None:
        raise RuntimeError("Generation for this job no longer exists")
    rec = dict((gen.params or {}).get("model3d") or {})
    root = get_settings().data_dir
    picture = db.get(Generation, rec.get("source_id") or "")
    cut = dict(rec.get("cutout") or {})
    if cut:
        child = db.get(Generation, cut.get("generation_id") or "")
        m3.wait_on(ctx, [child], "Cutting the logo out first")
        if child is None or child.status not in m3.READY or not child.file_path:
            cj = db.get(Job, child.job_id) if child is not None and child.job_id else None
            why = f" ({cj.error})" if cj is not None and cj.error else ""
            gen.params = {**gen.params, "model3d": {**rec, "cutout": {**cut, "status": "failed"}}}
            db.commit()
            raise m3.PictureFailed(f"The logo couldn't be cut out of its background{why}. Try a picture with a "
                                   "transparent background.")
        if cut.get("status") != "done":
            rec["cutout"] = {**cut, "status": "done"}
            gen.params = {**gen.params, "model3d": rec}
        picture = child
        job.result = None
    if picture is None or not picture.file_path:
        raise LogoError("The logo's picture is gone")

    gen.status = "generating"
    db.commit()
    t0 = time.monotonic()
    ctx.progress(0.05, "Reading the logo")
    rgba = open_rgba(root / picture.file_path)
    if rec.get("alpha") == "key":
        rgba = key_out(rgba)
    data, info = make(rgba, rec.get("logo"), ctx.progress)
    abs_path, rel = _out_path(gen, ".glb")
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = abs_path.with_name(abs_path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(abs_path)
    db.refresh(gen)
    gen.params = {**gen.params, "model3d": {**gen.params.get("model3d", {}), "mesh": info}}
    gen.file_path, gen.media_type, gen.status = rel, m3.MEDIA_TYPE, "ready"
    return {"file_path": rel, "media_type": m3.MEDIA_TYPE, "bytes": len(data),
            "seconds": round(time.monotonic() - t0, 3), **{k: info[k] for k in ("vertices", "triangles", "holes")}}
