"""Kit logos for print: an opaque logo never goes on a coloured panel as a white (or any colour) square.

A logo uploaded on a plain backdrop has that backdrop keyed out: the border colour is flood-filled in from the
edges, so whites inside the mark (a badge's cream disc, the counter of an O) stay, and the rim gets its alpha
from how far each pixel is from the backdrop colour, which keeps the original anti-aliasing. When the border
isn't one plain colour the stage asks Photo Studio's BiRefNet cut-out for a mask instead. Either way the cut
logo is cached per kit and file content, so it is worked out once.
"""
import hashlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

TOL = 16.0  # RGB distance that still counts as the backdrop colour
VERSION = "1"


def _spread_rows(reach: np.ndarray, cand: np.ndarray) -> np.ndarray:
    # every run of candidate pixels along a row that holds a reached pixel is reached as a whole
    h, w = cand.shape
    start = cand.copy()
    start[:, 1:] &= ~cand[:, :-1]
    ids = (np.cumsum(start.ravel()) * cand.ravel()).astype(np.int64)
    hit = np.bincount(ids, weights=(reach & cand).ravel().astype(np.float64), minlength=int(ids.max()) + 1) > 0
    hit[0] = False
    return hit[ids].reshape(h, w)


def flood(cand: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    """The candidate pixels 4-connected to a seed. Row and column sweeps in turn instead of a pixel queue, so a
    4000 px logo takes a few numpy passes, not millions of Python steps."""
    reach = seeds & cand
    for _ in range(200):
        nxt = _spread_rows(reach, cand)
        nxt = _spread_rows(nxt.T.copy(), cand.T.copy()).T
        if np.array_equal(nxt, reach):
            break
        reach = nxt
    return reach


def _edges(a: np.ndarray) -> np.ndarray:
    return np.concatenate([a[0], a[-1], a[1:-1, 0], a[1:-1, -1]])


def _box(a: np.ndarray, r: int = 2) -> np.ndarray:
    # a (2r+1)-square mean from summed-area tables (Pillow's box blur is 8-bit only)
    p = np.pad(a.astype(np.float64), r + 1, mode="edge")
    s = p.cumsum(0).cumsum(1)
    n = 2 * r + 1
    h, w = a.shape
    t = s[n:n + h, n:n + w] - s[0:h, n:n + w] - s[n:n + h, 0:w] + s[0:h, 0:w]
    return t / (n * n)


def _crop(im: Image.Image) -> Image.Image | None:
    box = im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    return im.crop(box) if box else None


def opaque(im: Image.Image) -> bool:
    """Whether the logo sits on a backdrop of its own (most of its border solid)."""
    a = np.asarray(im.convert("RGBA").getchannel("A"))
    return bool((_edges(a) >= 128).mean() > 0.5)


def key(im: Image.Image, tol: float = TOL) -> Image.Image | None:
    """The logo on transparency, cropped to the mark; None when the backdrop isn't one plain colour or keying it
    would leave nothing (or everything) standing."""
    im = im.convert("RGBA")
    if not opaque(im):
        return _crop(im)
    a = np.asarray(im)
    rgb = a[..., :3].astype(np.float32)
    alpha = a[..., 3]
    border, ba = _edges(rgb), _edges(alpha)
    bg = np.median(border[ba >= 128], axis=0)
    if (np.sqrt(((border - bg) ** 2).sum(-1)) <= tol).mean() < 0.85:
        return None
    dist = np.sqrt(((rgb - bg) ** 2).sum(-1))
    cand = (dist <= tol) | (alpha < 128)
    seeds = np.zeros_like(cand)
    seeds[0, :] = seeds[-1, :] = seeds[:, 0] = seeds[:, -1] = True
    back = flood(cand, seeds)
    share = float(back.mean())
    if share < 0.02 or share > 0.97:
        return None
    # the rim: mark pixels within two of the backdrop, part backdrop colour where the original was anti-aliased
    near = np.asarray(Image.fromarray(back.astype(np.uint8) * 255, "L").filter(ImageFilter.MaxFilter(5))) > 0
    rim = near & ~back
    soft = np.clip((dist - tol * 0.5) / (tol * 3.5), 0.0, 1.0)
    al = np.where(back, 0.0, np.where(rim, soft, 1.0)) * (alpha / 255.0)
    # a hard-stepped edge (a logo saved without anti-aliasing) gets a slight blur
    a8 = Image.fromarray((al * 255 + 0.5).astype(np.uint8), "L")
    blur = np.asarray(a8.filter(ImageFilter.GaussianBlur(0.6)), dtype=np.float32) / 255.0
    al2 = np.where(near, np.maximum(np.minimum(blur, 1.0), al * 0.85), al)
    # the rim and the fringe take the colour of the mark just inside them: the original edge pixels are part
    # backdrop, and any of that left in would show as a light halo on a dark panel. Fully clear pixels get it
    # too, so a resize can't pull the old backdrop colour back in.
    col = rgb.copy()
    trust = np.where(near, 0.0, al)
    pm = [_box(col[..., i] * trust, 3) for i in range(3)]
    wsum = _box(trust, 3)
    edge = near & (wsum > 1e-3)
    for i in range(3):
        col[..., i] = np.where(edge, pm[i] / np.maximum(wsum, 1e-4), col[..., i])
    al2 = np.where(near & ~edge, 0.0, al2)
    out = np.dstack([np.clip(col, 0, 255), np.clip(al2 * 255 + 0.5, 0, 255)]).astype(np.uint8)
    return _crop(Image.fromarray(out, "RGBA"))


def with_mask(im: Image.Image, mask: Image.Image) -> Image.Image | None:
    """The logo cut by a BiRefNet mask (any size; it is scaled to the logo)."""
    im = im.convert("RGBA")
    m = mask.convert("L").resize(im.size, Image.BILINEAR)  # Lanczos rings a hard mask edge into a grey halo
    a = np.minimum(np.asarray(im.getchannel("A")), np.asarray(m))
    im.putalpha(Image.fromarray(a.astype(np.uint8), "L"))
    return _crop(im)


def roundish(im: Image.Image) -> bool:
    """A badge or emblem: a near-square mark that fills the ellipse of its box."""
    m = im.convert("RGBA").getchannel("A")
    m.thumbnail((256, 256))
    a = np.asarray(m) > 128
    h, w = a.shape
    if not h or not w or not 0.85 <= w / h <= 1.18:
        return False
    ys, xs = np.mgrid[0:h, 0:w]
    e = ((xs + 0.5 - w / 2) / (w / 2)) ** 2 + ((ys + 0.5 - h / 2) / (h / 2)) ** 2 <= 1.0
    union = (a | e).sum()
    return bool(union and (a & e).sum() / union >= 0.85)


def cache_file(root: Path, kit_id: str, path: Path) -> Path:
    h = hashlib.sha1(f"{VERSION}:{kit_id}:".encode())
    h.update(Path(path).read_bytes())
    return Path(root) / f"{h.hexdigest()[:24]}.png"


def cut(root: Path, kit_id: str, path: Path | None, mask: Path | None = None) -> Path | None:
    """The cached transparent PNG of a kit logo, made on first use: keyed, else cut by the BiRefNet mask when
    one is given. None while neither works (the logo then stays off the design rather than go on as a box)."""
    if path is None or not Path(path).is_file():
        return None
    out = cache_file(root, kit_id, path)
    if out.is_file():
        return out
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGBA")
    except OSError:
        return None
    got = key(im)
    if got is None and mask is not None and Path(mask).is_file():
        with Image.open(mask) as m:
            got = with_mask(im, m)
    if got is None:
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    got.save(out, "PNG")
    return out
