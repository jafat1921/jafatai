"""Footer icons drawn with Pillow: phone, globe, map pin, envelope, at-sign. No icon font, nothing to license.

Each is drawn on a 4x canvas and scaled down, so the edges come out smooth at any size.
"""
from PIL import Image, ImageDraw

KINDS = ("phone", "website", "location", "email", "social")
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


_DRAW = {"phone": _phone, "website": _globe, "location": _pin, "email": _mail, "social": _at}


def icon(kind: str, px: int, colour: tuple[int, int, int]) -> Image.Image:
    """An RGBA icon of px x px in `colour`."""
    mask, d, n = _canvas(px)
    _DRAW.get(kind, _globe)(d, n, max(_SS, round(n * 0.085)))
    mask = mask.resize((px, px), Image.LANCZOS)
    out = Image.new("RGBA", (px, px), (*colour, 0))
    out.putalpha(mask)
    return out
