"""Organic shapes and photo masks for the M16b layouts: blobs, arches, circles, teardrops and confetti dots.

Everything is drawn four times larger and scaled down with Lanczos, so the edges are anti-aliased the way a
vector tool would draw them. A blob is a closed Catmull-Rom curve through jittered radii; the jitter comes from
a seeded generator, so the same seed always gives the same blob (an edit re-render must not reshuffle it).
"""
import math

import numpy as np
from PIL import Image, ImageDraw

SS = 4
MASKS = ("arch", "circle", "teardrop", "blob")


def _rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(abs(int(seed)) % (2 ** 32))


def catmull_rom(points: list[tuple[float, float]], steps: int = 24) -> list[tuple[float, float]]:
    """A closed centripetal-ish (uniform) Catmull-Rom spline through the points."""
    n = len(points)
    out = []
    for i in range(n):
        p0, p1, p2, p3 = (points[(i + k) % n] for k in (-1, 0, 1, 2))
        for s in range(steps):
            t = s / steps
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
                                    + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in (0, 1)))
    return out


def blob_points(seed: int, cx: float, cy: float, rx: float, ry: float, lobes: int = 7,
                wobble: float = 0.16) -> list[tuple[float, float]]:
    """The outline of an organic blob centred on (cx, cy). Radii stay within (1 - wobble, 1 + wobble/2) so it
    never pokes far outside its box."""
    g = _rng(seed)
    turn = g.uniform(0, 2 * math.pi)
    radii = 1 - wobble + g.random(lobes) * wobble * 1.5
    angles = [turn + 2 * math.pi * i / lobes + g.uniform(-0.18, 0.18) for i in range(lobes)]
    ctrl = [(cx + rx * r * math.cos(a), cy + ry * r * math.sin(a)) for r, a in zip(radii, angles)]
    return catmull_rom(ctrl)


def _down(big: Image.Image, size: tuple[int, int]) -> Image.Image:
    return big.resize(size, Image.LANCZOS)


def mask(kind: str, size: tuple[int, int], seed: int = 0) -> Image.Image:
    """An L mask filling `size` with the shape, anti-aliased."""
    w, h = size
    W, H = w * SS, h * SS
    big = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(big)
    if kind == "circle":
        r = min(W, H) / 2
        d.ellipse((W / 2 - r, H / 2 - r, W / 2 + r, H / 2 + r), fill=255)
    elif kind == "arch":
        r = W / 2
        d.ellipse((0, 0, W - 1, min(H, 2 * r)), fill=255)
        d.rectangle((0, r, W - 1, H - 1), fill=255)
    elif kind == "teardrop":
        # an oval with one pointed corner (top, towards the start side): the leaf shape of the reference
        d.ellipse((0, 0, W - 1, H - 1), fill=255)
        d.rectangle((0, 0, W / 2, H / 2), fill=255)
    elif kind == "blob":
        d.polygon(blob_points(seed, W / 2, H / 2, W / 2 * 0.97, H / 2 * 0.97), fill=255)
    else:
        raise ValueError(f"Unknown mask shape '{kind}'")
    return _down(big, size)


def blob_layer(size: tuple[int, int], box, colour, seed: int, lobes: int = 7) -> Image.Image:
    """An RGBA layer the size of the frame with a filled blob inside `box`."""
    x0, y0, x1, y1 = box
    m = Image.new("L", (size[0] * SS, size[1] * SS), 0)
    pts = blob_points(seed, (x0 + x1) / 2 * SS, (y0 + y1) / 2 * SS, (x1 - x0) / 2 * SS, (y1 - y0) / 2 * SS, lobes)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    layer = Image.new("RGBA", size, (*colour[:3], 0))
    layer.putalpha(_down(m, size))
    return layer


def dots(seed: int, box, count: int, r_min: float, r_max: float, avoid=None) -> list[tuple[float, float, float]]:
    """(cx, cy, r) for small confetti dots around a box: on a ring just outside it, never inside `avoid` boxes."""
    g = _rng(seed + 7919)
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
    out: list[tuple[float, float, float]] = []
    tries = 0
    while len(out) < count and tries < count * 40:
        tries += 1
        a = g.uniform(0, 2 * math.pi)
        k = g.uniform(1.04, 1.22)
        r = g.uniform(r_min, r_max)
        x, y = cx + rx * k * math.cos(a), cy + ry * k * math.sin(a)
        if any(b[0] - r <= x <= b[2] + r and b[1] - r <= y <= b[3] + r for b in avoid or []):
            continue
        if any(math.hypot(x - ox, y - oy) < (r + orr) * 2.2 for ox, oy, orr in out):
            continue
        out.append((x, y, r))
    return out


def draw_dots(img: Image.Image, spots, colour) -> None:
    if not spots:
        return
    w, h = img.size
    m = Image.new("L", (w * SS, h * SS), 0)
    d = ImageDraw.Draw(m)
    for x, y, r in spots:
        d.ellipse(((x - r) * SS, (y - r) * SS, (x + r) * SS, (y + r) * SS), fill=255)
    img.paste(Image.new("RGB", img.size, tuple(colour[:3])), (0, 0), _down(m, img.size))


def paste_masked(img: Image.Image, photo: Image.Image, box, kind: str, seed: int = 0) -> Image.Image:
    """The photo (already cropped to the box) pasted through a shape mask. Returns the mask used."""
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    m = mask(kind, (x1 - x0, y1 - y0), seed)
    img.paste(photo.convert("RGB"), (x0, y0), m)
    return m


def circle_ring(img: Image.Image, cx: float, cy: float, r: float, width: float, colour) -> None:
    """A clean ring (the white border round a detail circle), anti-aliased."""
    w, h = img.size
    m = Image.new("L", (w * SS, h * SS), 0)
    d = ImageDraw.Draw(m)
    R = (r + width) * SS
    d.ellipse((cx * SS - R, cy * SS - R, cx * SS + R, cy * SS + R), fill=255)
    R = r * SS
    d.ellipse((cx * SS - R, cy * SS - R, cx * SS + R, cy * SS + R), fill=0)
    img.paste(Image.new("RGB", img.size, tuple(colour[:3])), (0, 0), _down(m, img.size))


def wave_edge(size: tuple[int, int], vertical: bool, at: float, depth: float, seed: int = 0) -> Image.Image:
    """A mask that is 255 on one side of a gently curved line: the refined split's soft edge between the photo
    and the colour block. vertical: the line runs top to bottom at x = at (255 to the left)."""
    w, h = size
    W, H = w * SS, h * SS
    g = _rng(seed + 31)
    phase = g.uniform(0, 2 * math.pi)
    big = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(big)
    n = 64
    if vertical:
        pts = [(at * SS + depth * SS * math.sin(phase + math.pi * 1.3 * i / n), H * i / n) for i in range(n + 1)]
        d.polygon([(0, 0), *pts, (0, H)], fill=255)
    else:
        pts = [(W * i / n, at * SS + depth * SS * math.sin(phase + math.pi * 1.3 * i / n)) for i in range(n + 1)]
        d.polygon([(0, 0), *[(x, y) for x, y in pts], (W, 0)], fill=255)
    return _down(big, size)
