"""Develop geometry (D2b): lens distortion and lateral CA, perspective Transform and Upright, and the one
resampling pass that applies them together with crop, straighten and flip.

For an output pixel the chain runs backwards, from the developed frame to the captured picture:
  frame uv -(crop, rotate, flip, constrain zoom: affine)-> canvas uv -(transform: homography)->
  lens-corrected source uv -(distortion: radial)-> captured uv -(CA: per-channel radial scale)-> sample.
uv is 0..1 with the origin top-left. The canvas is the transformed picture at the source's own size, so a
crop box stays in source pixels. lib/photo/geometry.ts repeats every formula (the WebGL preview warps the
same way); tests/test_develop_geometry.py writes mapped points into the parity fixture to keep them equal.
"""
import math

import numpy as np

# perspective tilts are camera rotations seen through a lens this long (in long sides: a normal lens)
F_LONG = 1.0
TILT_DEG = 20.0
CA_UNIT = 0.005  # lens.caRed / caBlue at 100 scale that channel by 0.5 % about the centre
DIST_UNIT = 0.25
UPRIGHT_MODES = ("off", "auto", "level", "vertical", "full")


def _rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)


def _ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def _rz(a):
    # x right, y down: a positive angle turns the picture clockwise, like params.rotate
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def rotation_between(a, b) -> np.ndarray:
    """The smallest rotation taking direction a onto direction b (Rodrigues)."""
    a = np.asarray(a, np.float64) / np.linalg.norm(a)
    b = np.asarray(b, np.float64) / np.linalg.norm(b)
    v = np.cross(a, b)
    s, c = np.linalg.norm(v), float(a @ b)
    if s < 1e-12:
        return np.eye(3)
    k = v / s
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    ang = math.atan2(s, c)
    return np.eye(3) + math.sin(ang) * kx + (1 - math.cos(ang)) * kx @ kx


def _translate(x, y):
    return np.array([[1, 0, x], [0, 1, y], [0, 0, 1]], dtype=np.float64)


def camera(r: np.ndarray, w: float, h: float) -> np.ndarray:
    """K R K^-1 on centred pixels: what turning the camera by r does to the picture."""
    f = F_LONG * max(w, h)
    k = np.diag([f, f, 1.0])
    return k @ r @ np.diag([1 / f, 1 / f, 1.0])


def _apply(m, x, y):
    q = m @ np.array([x, y, 1.0])
    return q[0] / q[2], q[1] / q[2]


def recentre(hp: np.ndarray, w: float, h: float) -> np.ndarray:
    """Keep the picture's centre where it was and its size there unchanged."""
    cx, cy = _apply(hp, 0.0, 0.0)
    t = _translate(-cx, -cy) @ hp
    e = 0.05 * max(w, h)
    px, mx = _apply(t, e, 0.0), _apply(t, -e, 0.0)
    py, my = _apply(t, 0.0, e), _apply(t, 0.0, -e)
    jx = ((px[0] - mx[0]) / (2 * e), (px[1] - mx[1]) / (2 * e))
    jy = ((py[0] - my[0]) / (2 * e), (py[1] - my[1]) / (2 * e))
    det = abs(jx[0] * jy[1] - jx[1] * jy[0])
    s = 1 / math.sqrt(det) if det > 1e-9 else 1.0
    return np.diag([s, s, 1.0]) @ t


def to_uv(hp: np.ndarray, w: float, h: float) -> np.ndarray:
    """A centred-pixel homography as a uv one."""
    c = np.array([[w, 0, -w / 2], [0, h, -h / 2], [0, 0, 1]], dtype=np.float64)
    return np.linalg.inv(c) @ hp @ c


def manual(t: dict, w: float, h: float) -> np.ndarray | None:
    """Transform's sliders as a forward uv homography (source -> canvas), or None when they're all neutral."""
    if not any(abs(t[k]) > 1e-6 for k in ("vertical", "horizontal", "rotate", "aspect", "offsetX", "offsetY")) \
            and abs(t["scale"] - 100) < 1e-6:
        return None
    # negative Vertical widens the top (a camera tilted up), as in Lightroom
    r = _rz(math.radians(t["rotate"])) @ _rx(math.radians(-TILT_DEG * t["vertical"] / 100)) \
        @ _ry(math.radians(TILT_DEG * t["horizontal"] / 100))
    hp = recentre(camera(r, w, h), w, h)
    a = 2.0 ** (t["aspect"] / 200)
    sc = t["scale"] / 100
    hp = _translate(0.25 * w * t["offsetX"] / 100, 0.25 * h * t["offsetY"] / 100) @ np.diag([sc * a, sc / a, 1.0]) @ hp
    return to_uv(hp, w, h)


def forward(t: dict, w: float, h: float) -> np.ndarray | None:
    """Upright, then the manual sliders: the whole Transform, source uv -> canvas uv."""
    up = None
    if t.get("upright", "off") != "off" and t.get("uprightMatrix"):
        up = np.asarray(t["uprightMatrix"], dtype=np.float64).reshape(3, 3)
    m = manual(t, w, h)
    if up is None:
        return m
    return up if m is None else m @ up


def frame_affine(src_w: float, src_h: float, p: dict) -> np.ndarray:
    """frame uv -> canvas uv for crop, rotate and flip (geometry.ts geometryFor, as a row-major 3x3)."""
    c = p.get("crop") or {"x": 0, "y": 0, "width": src_w, "height": src_h}
    rot = p.get("rotate") or 0.0
    # round() as frame_size does (half to even), so a 45° straighten frames the same everywhere
    quarters = round(rot / 90.0)
    rest = rot - quarters * 90
    turned = abs(quarters) % 2 == 1
    w, h = (c["height"], c["width"]) if turned else (c["width"], c["height"])
    cs, sn = abs(math.cos(math.radians(rest))), abs(math.sin(math.radians(rest)))
    s = min(w / (w * cs + h * sn), h / (w * sn + h * cs)) if rest else 1.0
    ow, oh = w * s, h * s
    th = math.radians(rot)
    cos, sin = math.cos(th), math.sin(th)
    fx = -1.0 if p.get("flipH") else 1.0
    fy = -1.0 if p.get("flipV") else 1.0
    cx, cy = c["x"] + c["width"] / 2, c["y"] + c["height"] / 2
    a = fx * ow * cos / src_w
    b = fy * oh * sin / src_w
    d = -fx * ow * sin / src_h
    e = fy * oh * cos / src_h
    return np.array([[a, b, cx / src_w - 0.5 * (a + b)], [d, e, cy / src_h - 0.5 * (d + e)], [0, 0, 1]])


class Warp:
    """The whole output -> source mapping for one set of params and one full-resolution source size."""

    def __init__(self, p: dict, src_w: int, src_h: int):
        self.w, self.h = float(src_w), float(src_h)
        self.aspect = self.w / max(1.0, self.h)
        lens, t = p["lens"], p["transform"]
        f = forward(t, self.w, self.h)
        self.inv = np.linalg.inv(f) if f is not None else None
        self.k = -DIST_UNIT * lens["distortion"] / 100
        self.ca = (CA_UNIT * lens["caRed"] / 100, CA_UNIT * lens["caBlue"] / 100)
        self.zoom = 1.0
        self.affine = frame_affine(self.w, self.h, p)
        if t["constrain"] and (self.inv is not None or abs(self.k) > 1e-9):
            self.zoom = self._constrain()
            z = self.zoom
            self.affine = np.array([[z, 0, 0.5 - 0.5 * z], [0, z, 0.5 - 0.5 * z], [0, 0, 1]]) @ self.affine

    @property
    def active(self) -> bool:
        """Needs the resampling pass (crop, straighten and flip alone don't)."""
        return self.inv is not None or abs(self.k) > 1e-9 or any(abs(c) > 1e-9 for c in self.ca)

    def canvas_to_lens(self, cu, cv):
        """canvas uv -> captured uv (transform undone, then the lens's own distortion put back)."""
        if self.inv is not None:
            m = self.inv
            z = m[2, 0] * cu + m[2, 1] * cv + m[2, 2]
            # behind the camera: nothing to show
            z = np.where(np.abs(z) < 1e-9, 1e-9, z)
            su = (m[0, 0] * cu + m[0, 1] * cv + m[0, 2]) / z
            sv = (m[1, 0] * cu + m[1, 1] * cv + m[1, 2]) / z
            su = np.where(z > 0, su, -1.0)
        else:
            su, sv = cu, cv
        if abs(self.k) > 1e-9:
            dx, dy = (su - 0.5) * self.aspect, sv - 0.5
            f = 1 + self.k * (dx * dx + dy * dy) / (0.25 * (self.aspect * self.aspect + 1))
            su, sv = 0.5 + (su - 0.5) * f, 0.5 + (sv - 0.5) * f
        return su, sv

    def frame_to_canvas(self, u, v):
        a = self.affine
        return a[0, 0] * u + a[0, 1] * v + a[0, 2], a[1, 0] * u + a[1, 1] * v + a[1, 2]

    def source_uv(self, u, v):
        """frame uv -> captured uv (the green channel's position; lens vignetting is measured here)."""
        return self.canvas_to_lens(*self.frame_to_canvas(u, v))

    def _constrain(self) -> float:
        """Largest zoom (<= 1) of the canvas about its centre that keeps every edge on picture."""
        n = 32
        t = np.linspace(0.0, 1.0, n)
        cu = np.concatenate([t, t, np.zeros(n), np.ones(n)])
        cv = np.concatenate([np.zeros(n), np.ones(n), t, t])

        def inside(z):
            su, sv = self.canvas_to_lens(0.5 + (cu - 0.5) * z, 0.5 + (cv - 0.5) * z)
            e = 1e-6
            return bool(np.all((su >= -e) & (su <= 1 + e) & (sv >= -e) & (sv <= 1 + e)))

        if inside(1.0):
            return 1.0
        lo, hi = 0.2, 1.0
        for _ in range(30):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if inside(mid) else (lo, mid)
        return lo


# ---------------------------------------------------------------- resampling

def _bilinear(flat: np.ndarray, w: int, h: int, su, sv, chans) -> np.ndarray:
    """flat: (h*w, C). Bilinear taps at uv su, sv for the given channels; 0 outside the picture."""
    ok = (su >= 0) & (su <= 1) & (sv >= 0) & (sv <= 1)
    x = np.clip(su * w - 0.5, 0, w - 1).astype(np.float32)
    y = np.clip(sv * h - 0.5, 0, h - 1).astype(np.float32)
    x0 = np.minimum(np.floor(x).astype(np.int32), max(0, w - 2))
    y0 = np.minimum(np.floor(y).astype(np.int32), max(0, h - 2))
    tx = (x - x0)[..., None] if w > 1 else np.zeros(x.shape + (1,), np.float32)
    ty = (y - y0)[..., None] if h > 1 else np.zeros(y.shape + (1,), np.float32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    sub = flat[:, chans]

    def tap(yy, xx):
        return sub.take((yy * w + xx).ravel(), axis=0).reshape(yy.shape + (len(chans),)).astype(np.float32)

    top = tap(y0, x0) * (1 - tx) + tap(y0, x1) * tx
    bot = tap(y1, x0) * (1 - tx) + tap(y1, x1) * tx
    return (top * (1 - ty) + bot * ty) * ok[..., None]


def remap(img: np.ndarray, warp: Warp, out_w: int, out_h: int, pool=None) -> np.ndarray:
    """The developed frame at out_w x out_h sampled from img (any size: a proxy works, uv is relative).
    uint8 / uint16 come back as float 0..1; floats keep their values (a linear master keeps its headroom)."""
    if img.ndim == 2:
        img = img[..., None]
    h, w, c = img.shape
    div = {np.dtype(np.uint8): 255.0, np.dtype(np.uint16): 65535.0}.get(img.dtype, 1.0)
    flat = img.reshape(-1, c)
    out = np.empty((out_h, out_w, c), dtype=np.float32)
    rows = max(1, (1 << 17) // max(1, out_w))
    xs = (np.arange(out_w, dtype=np.float64) + 0.5) / out_w
    ca = any(abs(x) > 1e-9 for x in warp.ca)

    def one(y0: int) -> None:
        ys = (np.arange(y0, min(out_h, y0 + rows), dtype=np.float64) + 0.5) / out_h
        u, v = np.meshgrid(xs, ys)
        su, sv = warp.source_uv(u, v)
        if not ca:
            out[y0:y0 + len(ys)] = _bilinear(flat, w, h, su, sv, list(range(c)))
            return
        block = np.empty((len(ys), out_w, c), np.float32)
        rest = [i for i in range(c) if i not in (0, 2)]
        block[..., rest] = _bilinear(flat, w, h, su, sv, rest)
        for ch, k in ((0, warp.ca[0]), (2, warp.ca[1])):
            block[..., ch] = _bilinear(flat, w, h, 0.5 + (su - 0.5) * (1 + k), 0.5 + (sv - 0.5) * (1 + k), [ch])[..., 0]
        out[y0:y0 + len(ys)] = block

    starts = range(0, out_h, rows)
    if pool is not None and len(starts) > 1:
        list(pool.map(one, starts))
    else:
        for y0 in starts:
            one(y0)
    if div != 1.0:
        out *= np.float32(1 / div)
    return out
