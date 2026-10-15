"""Footer icons. The contact ones (phone, globe, pin, envelope, at-sign, clock, calendar) are drawn with
Pillow; the platform marks are Simple Icons SVGs (CC0, app/assets/icons/) drawn with resvg, the same in-process
renderer the brand kit uses for SVG logos. Without resvg a platform falls back to a drawn mark, so a footer
always renders.

Drawn icons are made on a 4x canvas and scaled down, so the edges come out smooth at any size.
"""
import io
import logging
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw

log = logging.getLogger("mixai.ads")

ICON_DIR = Path(__file__).resolve().parents[1] / "assets" / "icons"
KINDS = ("phone", "website", "booking", "location", "email", "social", "whatsapp", "hours")
PLATFORMS = ("instagram", "facebook", "tiktok", "linkedin", "x", "youtube", "pinterest", "snapchat", "threads",
             "whatsapp")
_SS = 4


def _canvas(px: int) -> tuple[Image.Image, ImageDraw.ImageDraw, int]:
    n = px * _SS
    im = Image.new("L", (n, n), 0)
    return im, ImageDraw.Draw(im), n


def _phone(d: ImageDraw.ImageDraw, n: int, w: int) -> None:
    # a mobile handset: a tall rounded body, a speaker slot and a home dot
    x0, x1 = n * 0.27, n * 0.73
    d.rounded_rectangle((x0, n * 0.06, x1, n * 0.94), radius=n * 0.11, outline=255, width=w)
    d.line((n * 0.43, n * 0.17, n * 0.57, n * 0.17), fill=255, width=max(1, w * 2 // 3))
    r = n * 0.05
    d.ellipse((n / 2 - r, n * 0.80 - r, n / 2 + r, n * 0.80 + r), fill=255)


def _globe(d: ImageDraw.ImageDraw, n: int, w: int) -> None:
    m = n * 0.08
    d.ellipse((m, m, n - m, n - m), outline=255, width=w)
    d.ellipse((n * 0.31, m, n * 0.69, n - m), outline=255, width=w)
    d.line((m, n / 2, n - m, n / 2), fill=255, width=w)
    for y in (0.30, 0.70):
        inset = n * 0.17
        d.line((inset, n * y, n - inset, n * y), fill=255, width=max(1, w * 3 // 4))


def _pin(d: ImageDraw.ImageDraw, n: int, w: int) -> None:
    cx, cy, r = n / 2, n * 0.38, n * 0.30
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    d.polygon([(cx - r * 0.86, cy + r * 0.5), (cx + r * 0.86, cy + r * 0.5), (cx, n * 0.95)], fill=255)
    h = r * 0.42
    d.ellipse((cx - h, cy - h, cx + h, cy + h), fill=0)


def _mail(d: ImageDraw.ImageDraw, n: int, w: int) -> None:
    box = (n * 0.06, n * 0.2, n * 0.94, n * 0.8)
    d.rounded_rectangle(box, radius=n * 0.06, outline=255, width=w)
    d.line((box[0] + w, box[1] + w, n / 2, n * 0.54, box[2] - w, box[1] + w), fill=255, width=w, joint="curve")


def _at(d: ImageDraw.ImageDraw, n: int, w: int) -> None:
    m = n * 0.08
    # the outer ring, open on the lower right like an @
    d.arc((m, m, n - m, n - m), start=20, end=330, fill=255, width=w)
    r = n * 0.18
    d.ellipse((n / 2 - r, n / 2 - r, n / 2 + r, n / 2 + r), outline=255, width=w)
    d.line((n / 2 + r, n / 2 - r * 1.1, n / 2 + r, n * 0.62), fill=255, width=w)
    d.arc((n / 2 + r - n * 0.12, n * 0.48, n / 2 + r + n * 0.26, n * 0.74), start=0, end=180, fill=255, width=w)


def _clock(d: ImageDraw.ImageDraw, n: int, w: int) -> None:
    m = n * 0.08
    d.ellipse((m, m, n - m, n - m), outline=255, width=w)
    d.line((n / 2, n * 0.24, n / 2, n / 2, n * 0.68, n * 0.62), fill=255, width=w, joint="curve")


def _calendar(d: ImageDraw.ImageDraw, n: int, w: int) -> None:
    d.rounded_rectangle((n * 0.08, n * 0.16, n * 0.92, n * 0.92), radius=n * 0.08, outline=255, width=w)
    d.rectangle((n * 0.08, n * 0.16, n * 0.92, n * 0.36), fill=255)
    for x in (0.3, 0.7):
        d.line((n * x, n * 0.06, n * x, n * 0.24), fill=255, width=w)
    r = n * 0.05
    for cx in (0.3, 0.5, 0.7):
        for cy in (0.54, 0.74):
            d.ellipse((n * cx - r, n * cy - r, n * cx + r, n * cy + r), fill=255)


def _bubble(d: ImageDraw.ImageDraw, n: int, w: int) -> None:
    # WhatsApp without resvg: a round speech bubble with a tail and a handset in it
    m = n * 0.1
    d.ellipse((m, m, n - m, n - m), outline=255, width=w)
    d.polygon([(n * 0.12, n * 0.92), (n * 0.2, n * 0.66), (n * 0.36, n * 0.84)], fill=255)
    d.rounded_rectangle((n * 0.38, n * 0.3, n * 0.62, n * 0.7), radius=n * 0.06, fill=255)


def _linkedin(d: ImageDraw.ImageDraw, n: int, w: int) -> None:
    # Simple Icons dropped LinkedIn: a plain rounded tile with "in" cut out of it
    d.rounded_rectangle((n * 0.04, n * 0.04, n * 0.96, n * 0.96), radius=n * 0.14, fill=255)
    r = n * 0.065
    d.ellipse((n * 0.27 - r, n * 0.27 - r, n * 0.27 + r, n * 0.27 + r), fill=0)
    d.rectangle((n * 0.21, n * 0.4, n * 0.33, n * 0.8), fill=0)
    d.rectangle((n * 0.42, n * 0.4, n * 0.53, n * 0.8), fill=0)
    d.pieslice((n * 0.42, n * 0.38, n * 0.8, n * 0.76), start=180, end=360, fill=0)
    d.rectangle((n * 0.69, n * 0.57, n * 0.8, n * 0.8), fill=0)
    d.pieslice((n * 0.53, n * 0.5, n * 0.69, n * 0.66), start=180, end=360, fill=255)
    d.rectangle((n * 0.53, n * 0.58, n * 0.69, n * 0.8), fill=255)


_DRAW = {"phone": _phone, "website": _globe, "location": _pin, "email": _mail, "social": _at, "hours": _clock,
         "booking": _calendar, "whatsapp": _bubble, "linkedin": _linkedin}


def _rasterise(path: Path, px: int) -> Image.Image | None:
    """The SVG's coverage as an L mask, or None when resvg can't run here."""
    try:
        import resvg_py

        png = bytes(resvg_py.svg_to_bytes(svg_string=path.read_text(encoding="utf-8"), width=px, height=px))
        with Image.open(io.BytesIO(png)) as im:
            mask = im.convert("RGBA").getchannel("A")
    except Exception as e:  # ImportError, or a DLL that App Control refuses to load
        log.info("platform icon %s drawn instead: %s", path.stem, e)
        return None
    return mask if mask.size == (px, px) else mask.resize((px, px), Image.LANCZOS)


@lru_cache(maxsize=256)
def mask(kind: str, px: int) -> Image.Image:
    svg = ICON_DIR / f"{kind}.svg"
    if svg.is_file():
        got = _rasterise(svg, px)
        if got is not None:
            return got
    canvas, d, n = _canvas(px)
    _DRAW.get(kind, _at if kind in PLATFORMS else _globe)(d, n, max(_SS, round(n * 0.085)))
    return canvas.resize((px, px), Image.LANCZOS)


def icon(kind: str, px: int, colour: tuple[int, int, int]) -> Image.Image:
    """An RGBA icon of px x px in `colour`."""
    out = Image.new("RGBA", (px, px), (*colour, 0))
    out.putalpha(mask(kind, px).copy())
    return out
