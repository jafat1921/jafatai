"""A print scene to pixels at any scale: the working preview, the print-size file, or one layer of it.

Shapes are anti-aliased from a signed distance, worked out a band of rows at a time, instead of Ad Studio's 4x
supersampling: at 6300 x 9500 px a supersampled mask alone would be about a gigabyte. Text is set by FreeType
at the final size, so its edges are as crisp as the file allows. Only the element's own box is ever allocated
besides the page itself.
"""
from contextlib import contextmanager

import numpy as np
from PIL import Image, ImageDraw

from app.ads import icons
from app.ads import layout as lay
from app.print_studio import fonts as pf
from app.print_studio.layout import Assets, El, Scene

TILE = 512
LAYERS = ("background", "photo", "logo", "text")


@contextmanager
def big_images(limit: int = 400_000_000):
    """Pillow's decompression-bomb guard raised for our own files only (an upscaled photo, a print render)."""
    old = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = max(old or 0, limit)
    try:
        yield
    finally:
        Image.MAX_IMAGE_PIXELS = old


# ---------------------------------------------------------------- masks

def _sdf(shape: str, x, y, w: float, h: float, r: float):
    if shape == "circle":
        rx, ry = w / 2, h / 2
        nx, ny = (x - rx) / rx, (y - ry) / ry
        return (np.sqrt(nx * nx + ny * ny) - 1.0) * min(rx, ry)
    if shape == "arch":
        rad = w / 2
        dc = np.sqrt((x - rad) ** 2 + (y - rad) ** 2) - rad
        return np.minimum(dc, _box(x, y, 0, rad, w, h, 0))
    return _box(x, y, 0, 0, w, h, r)


def _box(x, y, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    qx, qy = np.abs(x - cx) - hx, np.abs(y - cy) - hy
    out = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2) + np.minimum(np.maximum(qx, qy), 0)
    return out - r


def shape_mask(w: int, h: int, shape: str, radius: float = 0.0, stroke: float = 0.0) -> Image.Image:
    """Coverage (L) of a shape filling a w x h box; with stroke, a ring of that width on its outline."""
    out = np.empty((h, w), np.uint8)
    xs = (np.arange(w, dtype=np.float32) + 0.5)[None, :]
    r = max(0.0, min(radius, w / 2, h / 2))
    for y0 in range(0, h, TILE):
        y1 = min(h, y0 + TILE)
        ys = (np.arange(y0, y1, dtype=np.float32) + 0.5)[:, None]
        d = _sdf(shape, xs, ys, w, h, r)
        cov = np.clip(stroke / 2 - np.abs(d + stroke / 2) + 0.5, 0, 1) if stroke else np.clip(0.5 - d, 0, 1)
        out[y0:y1] = (cov * 255 + 0.5).astype(np.uint8)
    return Image.fromarray(out, "L")


def crop_box(sw: int, sh: int, bw: float, bh: float, fx: float, fy: float) -> tuple[float, float, float, float]:
    """The part of a sw x sh picture a cover fit shows in a bw x bh box, the focus point kept in view."""
    s = max(bw / sw, bh / sh)
    cw, ch = bw / s, bh / s
    x = (sw - cw) * min(1.0, max(0.0, fx))
    y = (sh - ch) * min(1.0, max(0.0, fy))
    return x, y, x + cw, y + ch


def contain_box(sw: int, sh: int, box) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = box
    s = min((x1 - x0) / sw, (y1 - y0) / sh)
    w, h = sw * s, sh * s
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2


# ---------------------------------------------------------------- painting

class Painter:
    def __init__(self, size: tuple[int, int], transparent: bool):
        self.transparent = transparent
        self.img = Image.new("RGBA", size, (0, 0, 0, 0)) if transparent else Image.new("RGB", size, (255, 255, 255))
        self.d = ImageDraw.Draw(self.img)

    def fill(self, box: tuple[int, int, int, int], colour, mask: Image.Image | None = None) -> None:
        x0, y0, x1, y1 = box
        if x1 <= x0 or y1 <= y0:
            return
        c = lay.rgb(colour) if isinstance(colour, str) else tuple(colour)
        if mask is None and not self.transparent:
            self.d.rectangle((x0, y0, x1 - 1, y1 - 1), fill=c)
            return
        if not self.transparent:
            self.img.paste(c, (x0, y0, x1, y1), mask)
            return
        tile = Image.new("RGBA", (x1 - x0, y1 - y0), (*c, 255))
        if mask is not None:
            tile.putalpha(mask)
        self.img.alpha_composite(tile, (x0, y0))

    def paste(self, im: Image.Image, xy: tuple[int, int], mask: Image.Image | None = None) -> None:
        if im.mode == "RGBA" and mask is not None:
            a = np.asarray(im.getchannel("A"), dtype=np.uint16) * np.asarray(mask, dtype=np.uint16) // 255
            im = im.copy()
            im.putalpha(Image.fromarray(a.astype(np.uint8), "L"))
            mask = None
        if not self.transparent:
            self.img.paste(im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im, xy,
                           mask if mask is not None else (im if im.mode == "RGBA" else None))
            return
        im = im.convert("RGBA")
        if mask is not None:
            im.putalpha(mask)
        self.img.alpha_composite(im, xy)

    def text(self, xy, s: str, font, colour: str, kw: dict) -> None:
        c = lay.rgb(colour)
        if not self.transparent:
            try:
                self.d.text(xy, s, font=font, fill=c, anchor="ls", **kw)
            except (KeyError, ValueError, OSError):
                self.d.text(xy, s, font=font, fill=c, anchor="ls")
            return
        # on a transparent layer the glyph coverage becomes the alpha; drawing straight on it would darken
        # every anti-aliased edge
        try:
            l, t, r, b = font.getbbox(s, anchor="ls", **kw)
        except (KeyError, ValueError, OSError):
            kw = {}
            l, t, r, b = font.getbbox(s, anchor="ls")
        w, h = int(r - l) + 4, int(b - t) + 4
        if w <= 0 or h <= 0:
            return
        m = Image.new("L", (w, h), 0)
        ImageDraw.Draw(m).text((2 - l, 2 - t), s, font=font, fill=255, anchor="ls", **kw)
        x, y = round(xy[0] + l - 2), round(xy[1] + t - 2)
        self.fill((x, y, x + w, y + h), c, m)


def _px(box, k: float, bleed: float) -> tuple[int, int, int, int]:
    return tuple(int(round((v + bleed) * k)) for v in box)


def size_px(scene: Scene, k: float) -> tuple[int, int]:
    fw, fh = scene.canvas.full_mm
    return max(1, round(fw * k)), max(1, round(fh * k))


def k_for(scene: Scene, long_px: int) -> float:
    fw, fh = scene.canvas.full_mm
    return long_px / max(fw, fh)


def _image(p: Painter, e: El, assets: Assets, k: float, bleed: float) -> None:
    src = getattr(assets, e.src or "", None)
    if src is None:
        return
    x0, y0, x1, y1 = _px(e.box, k, bleed)
    bw, bh = x1 - x0, y1 - y0
    if bw < 1 or bh < 1:
        return
    if e.fit == "contain":
        cx0, cy0, cx1, cy1 = (int(round(v)) for v in contain_box(src.width, src.height, (x0, y0, x1, y1)))
        w, h = max(1, cx1 - cx0), max(1, cy1 - cy0)
        p.paste(src.resize((w, h), Image.LANCZOS), (cx0, cy0))
        return
    region = crop_box(src.width, src.height, bw, bh, *e.focus)
    im = src.convert("RGB") if src.mode not in ("RGB", "RGBA") else src
    im = im.resize((bw, bh), Image.LANCZOS, box=region)
    mask = None
    if e.shape in ("rounded", "circle", "arch"):
        mask = shape_mask(bw, bh, e.shape, e.radius * k)
    p.paste(im, (x0, y0), mask)


def _text(p: Painter, e: El, k: float, bleed: float, lang) -> None:
    font = pf.font(e.face, e.em * k)
    x0, _, x1, _ = ((v + bleed) * k for v in e.box)
    for i, line in enumerate(e.lines):
        s, kw = lay._shape(line, lang)
        w = lay._width(p.d, line, font, lang)
        x = x0 if e.align == "left" else (x1 - w if e.align == "right" else (x0 + x1 - w) / 2)
        y = (e.baseline + i * e.advance + bleed) * k
        p.text((x, y), s, font, e.fill, kw)


def render(scene: Scene, assets: Assets, k: float, layers: tuple[str, ...] | None = None) -> Image.Image:
    """The scene at k pixels per millimetre: the whole page (RGB), or only some layers on transparency."""
    transparent = layers is not None and "background" not in layers
    p = Painter(size_px(scene, k), transparent)
    b = scene.canvas.bleed_mm
    for e in scene.els:
        if layers is not None and e.layer not in layers:
            continue
        if e.kind == "rect":
            box = _px(e.box, k, b)
            mask = shape_mask(box[2] - box[0], box[3] - box[1], "rect", e.radius * k) if e.radius > 0 else None
            p.fill(box, e.fill, mask)
        elif e.kind == "circle":
            box = _px(e.box, k, b)
            p.fill(box, e.fill, shape_mask(box[2] - box[0], box[3] - box[1], "circle"))
        elif e.kind == "frame":
            box = _px(e.box, k, b)
            shape = "circle" if e.role == "ring" else "rect"
            p.fill(box, e.fill, shape_mask(box[2] - box[0], box[3] - box[1], shape, e.radius * k, e.stroke * k))
        elif e.kind == "image":
            _image(p, e, assets, k, b)
        elif e.kind == "icon":
            x0, y0, x1, y1 = _px(e.box, k, b)
            n = max(4, x1 - x0)
            p.paste(icons.icon(e.icon, n, lay.rgb(e.fill)), (x0, y0))
        elif e.kind == "text":
            _text(p, e, k, b, scene.lang)
    return p.img
