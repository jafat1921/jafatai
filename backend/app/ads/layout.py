"""The advert layout engine (contract v36): exact typography over an AI photo, Pillow only, CPU only.

The iXperts prototype, generalised: the photo cover-cropped to the format, a treatment that gives the copy
somewhere to sit (frosted panel, side wash, bottom bar, split colour block, price badge, or nothing at all),
the logo with its white background keyed out, the copy fitted to its box in size steps so nothing ever
overflows, a CTA pill, and the contact and social footer (app/ads/footer.py).

Every text element is checked against the pixels it sits on (WCAG AA: 4.5:1 for copy, 3:1 for the big
headline and the CTA). When a check fails, the engine adds a panel behind the copy, then makes it more
opaque, until it passes. Arabic-script copy is right-aligned and shaped (raqm, or reshaper + bidi) and the
whole layout mirrors.

render(spec, assets) is pure: the same spec and pictures give the same image, so an edit is a re-render.

M16b adds the layouts modelled on the owner's own adverts (app/ads/designs.py: cut-outs on blobs, photos in
arches and circles, a big price band, editorial type, before/after, quote cards), smart placement around the
subject (app/ads/placement.py), tracked headlines with an accent key word, and an 8-pt grid.
"""
import logging
import re
from dataclasses import dataclass, field, replace as dc_replace
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

from app import brand_render as br
from app.ads import fonts as fz
from app.ads import footer as ft

log = logging.getLogger("mixai.ads")

FORMATS = {"4:5": (1080, 1350), "9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080),
           "1.91:1": (1200, 628), "2:3": (1000, 1500), "yt": (1280, 720)}
FORMAT_LABELS = {"4:5": "Feed 4:5", "9:16": "Story 9:16", "1:1": "Square 1:1", "16:9": "Banner 16:9",
                 "1.91:1": "Link ad 1.91:1", "2:3": "Pinterest 2:3", "yt": "YouTube thumbnail"}
# the newer digital sizes borrow the proportions of the nearest original layout
LAYOUT_OF = {"1.91:1": "16:9", "yt": "16:9", "2:3": "4:5"}
STYLES = ("frosted", "side_wash", "bottom_bar", "split", "badge", "minimal", "cutout_blob", "arch_mask",
          "circle_mask", "big_price", "editorial", "before_after", "quote")
STYLE_LABELS = {"frosted": "Frosted panel", "side_wash": "Side wash", "bottom_bar": "Bottom bar",
                "split": "Split colour block", "badge": "Price badge", "minimal": "Minimal centred",
                "cutout_blob": "Cut-out on a shape", "arch_mask": "Photo in an arch", "circle_mask": "Photo in a circle",
                "big_price": "Big price", "editorial": "Editorial", "before_after": "Before / after",
                "quote": "Quote card"}
# what a layout can't do without; the copywriter is never offered one the brief can't fill
STYLE_NEEDS = {"badge": "offer_number", "big_price": "offer_number", "quote": "quote", "before_after": "before_photo"}
# "stack": the logo sits in the copy column, above the CTA (the big price layout's own place for it)
LOGO_POSITIONS = ("tl", "tr", "tc", "bl", "br", "stack", "none")
# big_price keeps its logo in a fixed corner slot outside the copy flow ("stack" stays an explicit choice)
LOGO_DEFAULT = {"minimal": "tc", "cutout_blob": "tc", "arch_mask": "bl", "circle_mask": "bl"}
# the type pairing a layout gets when nobody picked a preset
LAYOUT_FONTS = {"editorial": "editorial", "quote": "editorial", "arch_mask": "elegant", "circle_mask": "elegant"}
# the top and bottom of a story are under the app's own header and reply bar
SAFE = {"9:16": (0.13, 0.18)}
AA_TEXT, AA_LARGE = 4.5, 3.0
NEED = {"headline": AA_LARGE, "cta": AA_LARGE, "badge": AA_LARGE}  # everything else needs AA_TEXT

DEFAULT_TEXT, DEFAULT_ACCENT = "#22223B", "#E2685C"
PAPER = "#F7F4EF"
WHITE = (255, 255, 255)
CONTACT_ORDER = ft.CONTACT_KEYS

# sizes as a share of the frame's short side, before fitting
BASE = {"headline": 0.080, "kicker": 0.027, "body": 0.031, "offer": 0.032, "cta": 0.035, "footer": 0.025,
        "quote": 0.050, "quote_by": 0.026, "plain": 0.031}
FLOOR = {"headline": 28, "kicker": 16, "body": 17, "offer": 18, "cta": 22, "footer": 22, "quote": 22, "quote_by": 16,
         "plain": 17}
LEADING = {"headline": 0.98, "kicker": 1.2, "body": 1.3, "offer": 1.2, "cta": 1.1, "quote": 1.18, "plain": 1.3}
# headline tracking as a share of the size: big sans type set loose looks amateur
TRACK = {"sans": -0.018, "serif": -0.006}
STEPS = [round(1.0 * 0.93 ** i, 4) for i in range(16)]
# the smallest anything is set, as a share of the short side: read on a phone, 1080 px wide (headline 72 px,
# body 30, the offer pill 34); the fitter trims optional lines rather than going below these
MIN_K = {"headline": 0.0667, "body": 0.0278, "plain": 0.0278, "offer_line": 0.0278, "offer": 0.0315,
         "kicker": 0.0222, "cta": 0.03, "quote": 0.04, "quote_by": 0.0241}


def floor(role: str, s: int) -> int:
    return max(FLOOR.get(role, 16), round(MIN_K.get(role, 0) * s))


class LayoutError(ValueError):
    pass


@dataclass
class AdAssets:
    photo: Image.Image | None = None
    # the subject mask (BiRefNet), any size: it is scaled to the photo
    mask: Image.Image | None = None
    # before_after: the same place before the work was done
    before: Image.Image | None = None
    logo: Path | None = None
    logo_light: Path | None = None
    logo_dark: Path | None = None
    brand_fonts: list[Path] = field(default_factory=list)


# ---------------------------------------------------------------- colour

def rgb(h: str) -> tuple[int, int, int]:
    h = (h or "").lstrip("#")
    try:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except (ValueError, IndexError):
        return 0, 0, 0


def hexs(c) -> str:
    return "#%02X%02X%02X" % tuple(int(v) for v in c[:3])


def _lin(v: float) -> float:
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def lum(c) -> float:
    r, g, b = (x / 255 for x in (rgb(c) if isinstance(c, str) else c[:3]))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def ratio(a: float, b: float) -> float:
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def mix(c, d, t: float) -> tuple[int, int, int]:
    c, d = (rgb(x) if isinstance(x, str) else x for x in (c, d))
    return tuple(round(c[i] + (d[i] - c[i]) * t) for i in range(3))


def ensure_contrast(colour: str, bg_lum: float, need: float) -> str:
    """`colour`, nudged toward black or white just far enough to reach `need` against bg_lum."""
    if ratio(lum(colour), bg_lum) >= need:
        return colour
    best = None
    for t in (i / 10 for i in range(1, 11)):
        for target in ((0, 0, 0), WHITE):
            c = mix(colour, target, t)
            if ratio(lum(c), bg_lum) >= need:
                best = c
                break
        if best:
            break
    return hexs(best or ((0, 0, 0) if bg_lum > 0.18 else WHITE))


def _sat(c: str) -> float:
    r, g, b = rgb(c)
    return (max(r, g, b) - min(r, g, b)) / 255


def roles(palette: list[dict] | None) -> dict[str, str]:
    """Colour roles from a kit palette, used the same way in every layout:

    text / footer   the darkest colour (the ink)
    primary         the brand's main colour: the first palette colour deep enough to carry white type, else the
                    ink. The CTA is a solid button in it with white text and an arrow
    accent          the liveliest colour: the kicker, the badge and the offer pill (a tint of it)

    Falls back to the prototype's navy and coral."""
    cols = [p["hex"] for p in palette or [] if p.get("hex")]
    dark = min(cols, key=lum) if cols and lum(min(cols, key=lum)) < 0.2 else DEFAULT_TEXT
    rest = [c for c in cols if c != dark and 0.03 < lum(c) < 0.8]
    accent = max(rest, key=_sat) if rest and _sat(max(rest, key=_sat)) > 0.15 else DEFAULT_ACCENT
    primary = next((c for c in cols if c != accent and lum(c) < 0.3), dark)
    # white type on the button has to read; a mid-tone primary is deepened just enough
    primary = ensure_contrast(primary, 1.0, AA_TEXT)
    # the off-white ground of the arch, editorial and cut-out layouts: the kit's own pale colour when it has one
    paper = next((c for c in cols if lum(c) > 0.78), PAPER)
    return {"text": dark, "accent": accent, "primary": primary, "button": primary, "button_text": "#FFFFFF",
            "footer": dark, "footer_text": "#FFFFFF", "pill": hexs(mix(accent, WHITE, 0.18)), "light": "#FFFFFF",
            # the split layout's block: a pale wash of the accent, so the logo's own accent never vanishes on it
            "block": hexs(mix(accent, WHITE, 0.84)), "paper": paper, "muted": hexs(mix(dark, WHITE, 0.38))}


# ---------------------------------------------------------------- pixels

def cover(img: Image.Image, w: int, h: int, fx: float = 0.5, fy: float = 0.5) -> Image.Image:
    s = max(w / img.width, h / img.height)
    img = img.resize((max(w, round(img.width * s)), max(h, round(img.height * s))), Image.LANCZOS)
    x = int((img.width - w) * min(1.0, max(0.0, fx)))
    y = int((img.height - h) * min(1.0, max(0.0, fy)))
    return img.crop((x, y, x + w, y + h))


def _placeholder(w: int, h: int, colours: dict) -> Image.Image:
    # no photo yet: a soft wash of the brand colours, so a preview still shows the layout
    top, bottom = mix(colours["pill"], WHITE, 0.55), mix(colours["accent"], WHITE, 0.35)
    col = np.linspace(0, 1, h)[:, None, None]
    arr = np.array(top)[None, None, :] * (1 - col) + np.array(bottom)[None, None, :] * col
    return Image.fromarray(np.broadcast_to(arr, (h, w, 3)).astype("uint8"), "RGB")


def _region(img: Image.Image, box) -> np.ndarray:
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(img.width, max(x0 + 1, x1)), min(img.height, max(y0 + 1, y1))
    crop = img.crop((x0, y0, x1, y1)).convert("RGB")
    if crop.width > 96:
        crop = crop.resize((96, max(1, round(crop.height * 96 / crop.width))), Image.BILINEAR)
    a = np.asarray(crop, dtype=np.float64) / 255.0
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    return 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]


def worst_lum(img: Image.Image, box, text_lum: float) -> float:
    """The background luminance a text colour has to beat: the darker tail under dark text, the lighter
    tail under light text."""
    lums = _region(img, box)
    return float(np.percentile(lums, 10 if text_lum < 0.4 else 90))


def mean_lum(img: Image.Image, box) -> float:
    return float(_region(img, box).mean())


def veil(img: Image.Image, kind: str, frac: float, strength: float, colour=WHITE, rtl: bool = False) -> Image.Image:
    """A soft wash from one edge: kind top / bottom / side (the copy's side)."""
    w, h = img.size
    if kind == "side":
        ramp = np.clip(1 - np.arange(w) / (w * frac), 0, 1)
        ramp = ramp[::-1] if rtl else ramp
        mask = np.tile((np.minimum(1, ramp * 1.5) * 255 * strength)[None, :], (h, 1))
    else:
        n = max(1, int(h * frac))
        ramp = np.zeros(h)
        ramp[:n] = np.minimum(1, (1 - np.arange(n) / n) * 1.6) * strength
        ramp = ramp[::-1] if kind == "bottom" else ramp
        mask = np.tile((ramp * 255)[:, None], (1, w))
    solid = Image.new("RGB", img.size, colour)
    return Image.composite(solid, img, Image.fromarray(mask.astype("uint8"), "L"))


def frosted(img: Image.Image, box, radius: int, alpha: int, colour=WHITE) -> None:
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(img.width, x1), min(img.height, y1)
    if x1 <= x0 or y1 <= y0:
        return
    region = img.crop((x0, y0, x1, y1)).filter(ImageFilter.GaussianBlur(18))
    over = Image.new("RGBA", region.size, (*colour, alpha))
    region = Image.alpha_composite(region.convert("RGBA"), over).convert("RGB")
    mask = Image.new("L", region.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, x1 - x0 - 1, y1 - y0 - 1), radius=radius, fill=255)
    img.paste(region, (x0, y0), mask)


def prepare_logo(path: Path | None) -> Image.Image | None:
    """The logo as RGBA, cropped to its ink. A logo saved on a white square gets the white keyed out, soft
    edges kept, the way the prototype did it."""
    if path is None or not Path(path).is_file():
        return None
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im).convert("RGBA")
    except OSError:
        return None
    a = np.array(im)
    corners = a[[0, 0, -1, -1], [0, -1, 0, -1], :3]
    if a[..., 3].min() == 255 and corners.min() > 225:
        light = a[..., :3].min(axis=2).astype(np.float64)
        keep = np.clip((255 - light) / 55, 0, 1)
        a[..., 3] = np.where(light > 200, a[..., 3] * keep, a[..., 3]).astype("uint8")
        im = Image.fromarray(a, "RGBA")
    box = im.getchannel("A").getbbox()
    return im.crop(box) if box else None


def _ink_lum(logo: Image.Image) -> float:
    a = np.asarray(logo.convert("RGBA"), dtype=np.float64)
    w = a[..., 3] / 255
    if w.sum() < 1:
        return 0.5
    rgbm = (a[..., :3] * w[..., None]).sum(axis=(0, 1)) / w.sum()
    return lum(tuple(int(v) for v in rgbm))


def light_ink(logo: Image.Image, threshold: float = 0.35) -> Image.Image:
    """The logo for a dark background when the kit has no light version: the dark ink (luminance under
    `threshold`, not saturated) turns white, saturated accents such as a coral X stay as they are, the
    transparency is kept."""
    a = np.array(logo.convert("RGBA"))
    f = a[..., :3].astype(np.float64) / 255.0
    lin = np.where(f <= 0.04045, f / 12.92, ((f + 0.055) / 1.055) ** 2.4)
    lu = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    sat = f.max(axis=2) - f.min(axis=2)
    accent = (sat >= 0.3) & (lu >= 0.1)
    ink = (lu < threshold) & ~accent
    a[ink, :3] = 255
    return Image.fromarray(a, "RGBA")


# ---------------------------------------------------------------- text

def _shape(text: str, lang: str | None) -> tuple[str, dict]:
    s, kw = br.shaped(text)
    if kw.get("language") and lang:
        kw = {**kw, "language": lang}
    return s, kw


def _width(d: ImageDraw.ImageDraw, text: str, font, lang: str | None, track: float = 0) -> float:
    s, kw = _shape(text, lang)
    try:
        base = d.textlength(s, font=font, **kw)
    except (KeyError, ValueError, OSError):
        base = d.textlength(s, font=font)
    return base + track * max(0, len(text) - 1) if track else base


def _draw(d: ImageDraw.ImageDraw, xy, text: str, font, fill, lang: str | None, track: float = 0) -> None:
    if track:
        # letter by letter at the kerned prefix widths, so the pairs keep their kerning; Latin only (no shaping)
        x, y = xy
        for i, ch in enumerate(text):
            if not ch.isspace():
                d.text((x + d.textlength(text[:i], font=font) + track * i, y), ch, font=font, fill=fill, anchor="la")
        return
    s, kw = _shape(text, lang)
    try:
        d.text(xy, s, font=font, fill=fill, anchor="la", **kw)
    except (KeyError, ValueError, OSError):
        d.text(xy, s, font=font, fill=fill, anchor="la")


def _break_word(d, word: str, font, maxw: float, lang, track: float = 0) -> list[str]:
    # last resort for a word wider than the box at the smallest size: hyphenate wherever it has to
    parts, cur = [], ""
    for ch in word:
        if cur and _width(d, cur + ch + "-", font, lang, track) > maxw:
            parts.append(cur + "-")
            cur = ch
        else:
            cur += ch
    return parts + [cur] if cur else parts


def wrap(d, text: str, font, maxw: float, lang: str | None, hard: bool = False,
         track: float = 0) -> tuple[list[str], bool]:
    """Greedy word wrap; a "\\n" in the text is a wanted line break. (lines, every word fitted)."""
    lines, ok = [], True
    for para in (text or "").split("\n"):
        words = para.split()
        cur = ""
        for w in words:
            if _width(d, w, font, lang, track) > maxw:
                ok = False
                if hard:
                    if cur:
                        lines.append(cur)
                    *head, cur = _break_word(d, w, font, maxw, lang, track)
                    lines.extend(head)
                    continue
            trial = f"{cur} {w}" if cur else w
            if cur and _width(d, trial, font, lang, track) > maxw:
                lines.append(cur)
                cur = w
            else:
                cur = trial
        if cur:
            lines.append(cur)
    return lines, ok


@dataclass
class Block:
    role: str
    lines: list[str]
    font: object
    size: int
    advance: int
    gap: int  # space above this block
    pill: tuple[int, int] | None = None  # (pad_x, pad_y) for the offer pill and the CTA button
    arrow: int = 0  # the CTA's arrow, px wide (its gap to the label comes on top)
    width: float = 0
    height: int = 0
    track: float = 0  # headline tracking, px per letter (Latin only)
    parts: dict | None = None  # the big price band: its three pieces, their fonts and padding


def _advance(font, size: int, role: str, script: str) -> int:
    if script != "latin":
        asc, desc = font.getmetrics()
        return round((asc + desc) * (0.92 if role in ("headline", "quote") else 1.0))
    return round(size * LEADING.get(role, 1.2))


def g8(v: float) -> int:
    """v on the 8-pt grid. Formats are drawn at their real pixel size, so one step is 8 px."""
    return int(round(v / 8.0)) * 8 if v >= 8 else max(0, int(round(v)))


def _serif(face) -> bool:
    name = Path(str(face.path)).name.lower()
    return "serif" in name and "sans" not in name or "playfair" in name


# ---------------------------------------------------------------- geometry

@dataclass
class Geo:
    w: int
    h: int
    s: int
    m: int
    top: int  # first usable y (story safe zone and margin applied)
    bottom: int  # last usable y above the footer
    footer: tuple[int, int, int, int] | None
    footer_band: tuple[int, int] | None  # where the footer's items sit (above a story's reply bar)
    photo: tuple[int, int, int, int]
    copy: list[int]  # x0, y0, x1, y1
    align: str = "start"  # start | center
    valign: str = "top"  # top | upper | center | bottom
    panel: str | None = None  # fixed (the panel's width is the copy box) | hug | bar | None
    block: tuple[int, int, int, int] | None = None  # split colour block
    block_role: str = "block"  # which colour role fills it
    tone: str = "light"  # what the copy sits on: light (dark ink) or dark (light ink)
    veil: tuple | None = None  # (kind, frac, strength)
    cta: str = "stack"  # stack | anchor | beside (anchored next to an inset photo; the copy box stays)
    cta_w: float = 0  # how wide an anchored CTA may get
    badge: tuple[int, int, int] | None = None
    badge_spots: list = field(default_factory=list)  # where else the badge may go if the subject is there
    logo: tuple[int, int, int, int] | None = None
    pad: int = 0
    mirror: bool = False  # right to left, or flipped
    flip: bool = False
    # M16b layouts (app/ads/designs.py)
    ground: str | None = None  # a colour role under everything instead of a full-bleed photo
    shape: tuple | None = None  # (mask kind, box): the photo through an arch, circle, teardrop or blob
    detail: tuple | None = None  # (cx, cy, r): a small circle with a closer crop of the subject
    blob: tuple | None = None  # box of the organic blob in the shape colour, with dots round it
    cutout: tuple | None = None  # the region the cut-out subject stands in
    halves: tuple | None = None  # before_after: (before box, after box)
    inset: tuple | None = None  # editorial: the small rounded photo
    wave: tuple | None = None  # split: (vertical, at, depth), the soft edge between photo and block
    rule: bool = False  # a short accent rule above the copy
    head_scale: float = 1.0
    price: bool = False  # the big price band goes in the copy stack
    quote: bool = False
    footer_light: bool = False
    logo_in_stack: bool = False
    logo_size: tuple[int, int] = (0, 0)
    comfort: float = 0.66  # a layout built round a big headline drops optional lines sooner


def _mirror_box(box, w):
    x0, y0, x1, y1 = box
    return (w - x1, y0, w - x0, y1)


def geometry(style: str, fmt: str, *, footer_h: int, logo_pos: str, rtl: bool, flip: bool = False,
             density: float = 1.0, mask: str | None = None) -> Geo:
    """Where everything goes. footer_h is the planned footer's height, 0 for none. flip mirrors the layout
    (the copy to the other side); in a right-to-left ad it un-mirrors it."""
    from app.ads import designs

    w, h = FORMATS[fmt]
    s = min(w, h)
    m = g8(0.065 * s * density)
    st, sb = (round(h * f) for f in SAFE.get(fmt, (0, 0)))
    fh = footer_h
    footer = fh > 0
    top, bottom = st + m, h - sb - fh - m
    # a story's footer is a floating card inside the safe zones, not a bar cut across the middle of the screen
    inset = ft.card_inset(fmt, s)
    foot = (inset, h - sb - fh, w - inset, h - sb) if footer else None
    band = (h - sb - fh, h - sb) if footer else None
    fam = LAYOUT_OF.get(fmt, fmt)
    wide, tall = fam == "16:9", fam == "9:16"
    logo_h, logo_w = round(0.085 * s), round(0.25 * s)
    pos = logo_pos if logo_pos in LOGO_POSITIONS else "tl"
    mirror = rtl != flip
    in_stack = pos == "stack"
    # logo positions are written for left-to-right; mirrored below for RTL (and for a flipped layout)
    lp = "none" if in_stack else pos
    if mirror and lp in ("tl", "tr", "bl", "br"):
        lp = {"tl": "tr", "tr": "tl", "bl": "br", "br": "bl"}[lp]
    logo = None
    if lp != "none":
        x0 = {"l": m, "r": w - m - logo_w, "c": (w - logo_w) // 2}[lp[1]]
        y0 = top if lp[0] == "t" else bottom - logo_h
        logo = (x0, y0, x0 + logo_w, y0 + logo_h)
    # the logo's clear space: at least half its height between it and the copy
    gap = g8(max(0.045 * s, logo_h * 0.5))
    cy0 = top + (logo_h + gap if lp[0] == "t" else 0)
    cy1 = bottom - (logo_h + gap if lp[0] == "b" else 0)
    g = Geo(w, h, s, m, top, bottom, foot, band, (0, 0, w, h), [m, cy0, w - m, cy1], pad=g8(0.037 * s),
            mirror=mirror, flip=flip, logo_in_stack=in_stack, logo_size=(round(0.2 * s), round(0.066 * s)))

    if style in ("frosted", "badge"):
        x0 = round(m * 0.63)
        x1 = {"4:5": 0.74, "1:1": 0.66, "9:16": 1.0, "16:9": 0.5}[fam] * w
        x1 = w - x0 if tall else round(x1)
        g.veil = ("top", min(0.5, (cy0 + 0.04 * h) / h), 0.75)
        g.copy = [x0 + g.pad, cy0, x1 - g.pad, cy1]
        g.panel, g.cta = "fixed", "anchor"
        # a story's copy sits in the middle-lower safe area, over the photo, not up under the status bar
        g.valign = "center" if wide else ("lower" if tall else "top")
        if style == "badge":
            r = round(0.104 * s)
            cx, cy = w - m - r, top + r
            if logo is not None and logo[2] > w - m - 2 * r and logo[1] < cy + r:
                cy = logo[3] + gap + r  # the logo has the corner; the badge goes under it
            g.badge = (cx, cy, r)
            # lower down the same side, when the subject's face is in the corner
            g.badge_spots = [g.badge, (cx, max(cy, bottom - r - gap), r)]
            if tall:
                # a story is narrow: the copy starts below the badge instead of beside it
                g.copy[1] = max(g.copy[1], cy + r + gap)
    elif style == "side_wash":
        frac = {"4:5": 0.62, "1:1": 0.66, "9:16": 0.85, "16:9": 0.55}[fam]
        g.veil = ("side", frac, 0.9)
        x1 = {"4:5": 0.58, "1:1": 0.6, "9:16": 0.8, "16:9": 0.45}[fam] * w
        g.copy = [m, cy0, round(x1), cy1]
        g.valign = "lower" if tall else "upper"
    elif style == "bottom_bar":
        g.panel, g.tone, g.valign = "bar", "dark", "bottom"
        g.copy = [m, max(cy0, round(h * (0.42 if tall else 0.4))), w - m, bottom]
        if wide:
            # a full-width bar on a banner would set the copy tiny; it takes the start side instead
            g.copy = [m, max(cy0, round(h * 0.3)), round(w * 0.62), bottom]
    elif style == "split":
        g.tone, g.rule = "dark", True
        depth = round(0.016 * s)
        if fam in ("4:5", "9:16"):
            bt = round(h * (0.5 if fam == "4:5" else 0.45))
            # under a story's card the block runs on to the bottom edge
            g.block = (0, bt, w, foot[1] if foot and not inset else h)
            g.photo = (0, 0, w, bt + depth + 2)
            g.copy = [m, bt + m + depth, w - m, (foot[1] if foot else h - sb) - m]
            g.wave = (False, bt, depth)
        else:
            bw = round(w * (0.5 if fam == "1:1" else 0.42))
            g.block = (0, 0, bw, foot[1] if foot else h)
            g.photo = (bw - depth - 2, 0, w, foot[1] if foot else h)
            g.copy = [m, cy0, bw - m - depth, cy1]
            g.valign = "center"
            g.wave = (True, bw, depth)
    elif style == "minimal":
        side = round(m * 1.4)
        g.copy = [side, cy0, w - side, cy0 + round((cy1 - cy0) * (0.62 if tall else 0.58))]
        g.align, g.panel = "center", None
    elif style in designs.STYLES:
        designs.geometry(g, style, fam, cy0=cy0, cy1=cy1, gap=gap, sb=sb, card=inset, mask=mask, logo=logo)
    else:
        raise LayoutError(f"Unknown layout style '{style}'")

    if mirror:
        g.copy = list(_mirror_box(g.copy, w))
        g.photo = _mirror_box(g.photo, w)
        for name in ("block", "blob", "cutout", "inset"):
            if getattr(g, name):
                setattr(g, name, _mirror_box(getattr(g, name), w))
        if g.shape:
            g.shape = (g.shape[0], _mirror_box(g.shape[1], w))
        if g.halves:
            g.halves = tuple(_mirror_box(b, w) for b in g.halves)
        if g.badge:
            cx, cy, r = g.badge
            g.badge = (w - cx, cy, r)
        g.badge_spots = [(w - cx, cy, r) for cx, cy, r in g.badge_spots]
        if g.detail:
            cx, cy, r = g.detail
            g.detail = (w - cx, cy, r)
        if g.wave and g.wave[0]:
            g.wave = (True, w - g.wave[1], g.wave[2])
    g.logo = logo
    return g


# ---------------------------------------------------------------- the copy stack

@dataclass
class StackOpts:
    cta_in_stack: bool = True
    head_scale: float = 1.0
    caps_headline: bool = False
    price: bool = False
    quote: bool = False
    logo_slot: tuple[int, int] | None = None  # (w, h) of the logo when it sits in the stack
    comfort: float = 0.66  # below this size step optional lines go first (see COMFORT)
    flags: dict = field(default_factory=dict)  # what the stack had to bend (word_floor)


def _stack(d, spec: dict, faces: dict, caps: bool, box_w: float, k: float, hk: float, s: int, script: str,
           lang, opts: StackOpts, hard: bool = False) -> tuple[list[Block], bool]:
    t = spec.get("texts") or {}
    blocks: list[Block] = []
    ok = True
    flags = opts.flags

    def add(role: str, text: str, gap: float, scale: float, pill: bool = False, face_role: str | None = None):
        nonlocal ok
        if not (text or "").strip():
            return
        face = faces[face_role or role]
        low = floor(role, s)
        if role == "headline" and box_w > 0:
            # one long word (a Swedish compound) wider than the column at the floor: the floor gives way, down
            # to 70 %, rather than hyphenating the headline's key word
            f0 = fz.load(str(face.path), low, face.weight)
            longest = max((_width(d, w, f0, lang) for w in text.split()), default=0)
            if longest > box_w:
                low = max(round(low * 0.7), int(low * box_w / longest))
                flags["word_floor"] = True
        size = max(low, round(BASE[role] * s * scale))
        font = fz.load(str(face.path), size, face.weight)
        track = 0.0
        if role == "headline" and script == "latin":
            track = size * TRACK["serif" if _serif(face) else "sans"]
        pad = (round(size * 0.95), round(size * 0.48)) if pill else None
        arrow = _arrow_room(size) if role == "cta" else 0
        inner = box_w - (2 * pad[0] if pad else 0) - arrow
        lines, fitted = wrap(d, text, font, inner, lang, hard=hard, track=track)
        ok = ok and fitted
        adv = _advance(font, size, role, script)
        widest = max((_width(d, ln, font, lang, track) for ln in lines), default=0)
        b = Block(role, lines, font, size, adv, g8(gap * s * k) if blocks else 0, pad,
                  arrow=round(size * 0.85) if arrow else 0, track=track)
        b.width = widest + (2 * pad[0] if pad else 0) + arrow
        b.height = adv * len(lines) + (2 * pad[1] if pad else 0)
        blocks.append(b)
        return b

    kicker = t.get("kicker") or ""
    add("kicker", kicker.upper() if caps else kicker, 0, k)
    quote = (t.get("quote") or "").strip() if opts.quote else ""
    if quote:
        mark = _quote_mark(lang)
        face = faces["headline"]
        size = round(BASE["quote"] * s * k * 2.4)
        f = fz.load(str(face.path), size, face.weight)
        qb = Block("qmark", [mark], f, size, round(size * 0.5), g8(0.02 * s * k) if blocks else 0)
        qb.width, qb.height = _width(d, mark, f, lang), qb.advance
        blocks.append(qb)
        add("quote", quote, 0.004, k, face_role="headline")
        by = (t.get("quote_by") or "").strip()
        if by:
            add("quote_by", f"— {by}" if not _rtl_text(by) else by, 0.02, k, face_role="kicker")
    else:
        head = t.get("headline") or ""
        if opts.caps_headline and script == "latin":
            head = head.upper()
        add("headline", head, 0.022, k * hk * opts.head_scale)
        add("body", t.get("body") or "", 0.026, k)
    offers = [o for o in t.get("offers") or [] if o and o.strip()]
    priced = next((o for o in offers if split_price(o)[1]), None) if opts.price else None
    if priced:
        b = _price_block(d, priced, faces, box_w, k, s, lang, g8(0.032 * s * k) if blocks else 0, hard)
        ok = ok and b.width <= box_w + 0.5
        blocks.append(b)
        for o in [x for x in offers if x != priced][:2]:
            add("plain", o, 0.014, k, face_role="body")
    elif offers:
        add("offer", offers[0], 0.032, k, pill=True)
        if len(offers) > 1:
            add("body", "  ·  ".join(offers[1:3]), 0.02, k, face_role="kicker")
            blocks[-1].role = "offer_line"
    if opts.logo_slot:
        lw, lh = opts.logo_slot
        blocks.append(Block("logo_slot", [], None, 0, 0, g8(0.04 * s * k) if blocks else 0, width=lw, height=lh))
    if opts.cta_in_stack:
        add("cta", t.get("cta") or "", 0.024 if opts.logo_slot else 0.04, k, pill=True)
    return blocks, ok


def _rtl_text(text: str) -> bool:
    return any("֐" <= ch <= "ࣿ" for ch in text)


def _quote_mark(lang) -> str:
    return "”" if (lang or "").split("-")[0] in ("ar", "ur", "fa", "ps", "sd", "ug", "ku", "he") else "“"


_PRICE = re.compile(r"(?:[$€£¥₹]\s?)?\d[\d  .,]*(?:\s?[%٪])?|[۰-۹٠-٩][۰-۹٠-٩٬٫,.]*(?:\s?[%٪])?")


def split_price(offer: str) -> tuple[str, str, str]:
    """("Från", "215", "kr/timme") from "Från 215 kr/timme"; ("", "", offer) when there is no number."""
    m = _PRICE.search(offer or "")
    if not m:
        return "", "", offer or ""
    num = m.group(0).strip().rstrip(".,")
    return offer[:m.start()].strip(), num, offer[m.start() + len(num):].strip()


def _price_block(d, offer: str, faces: dict, box_w: float, k: float, s: int, lang, gap: int, hard: bool) -> Block:
    pre, num, post = split_price(offer)
    small = max(floor("offer", s), round(BASE["offer"] * 1.3 * s * k))
    big = round(small * 3.0)
    fs_face, fb_face = faces["offer"], faces["badge"]
    while True:
        fs = fz.load(str(fs_face.path), small, fs_face.weight)
        fb = fz.load(str(fb_face.path), big, fb_face.weight)
        sp = round(small * 0.35)
        px, py = round(small * 0.9), round(small * 0.55)
        widths = [_width(d, pre, fs, lang) if pre else 0, _width(d, num, fb, lang), _width(d, post, fs, lang) if post else 0]
        total = 2 * px + sum(widths) + sp * (sum(1 for x in widths if x) - 1)
        if total <= box_w or (big <= small * 2.5 and small <= floor("offer", s)):
            break
        if big > small * 2.5:
            big = round(big * 0.92)
        else:
            small, big = max(floor("offer", s), round(small * 0.92)), round(big * 0.92)
    bx = fb.getbbox(num, anchor="ls")
    digit_h = max(1, -bx[1])
    b = Block("price", [offer], fb, big, digit_h + 2 * py, gap)
    b.parts = {"pre": pre, "num": num, "post": post, "fs": fs, "fb": fb, "px": px, "py": py, "sp": sp,
               "digit_h": digit_h, "widths": widths, "small": small}
    b.width, b.height = total, digit_h + 2 * py
    return b


def _total(blocks: list[Block]) -> int:
    return sum(b.gap + b.height for b in blocks)


# below this size step the copy reads as small print; optional lines go first
COMFORT = 0.66
TRIM_ORDER = ("offer_line", "plain", "body", "quote_by", "kicker", "logo_slot", "offer")


def fit(d, spec, faces, caps, box, s, script, lang, opts: StackOpts) -> tuple[list[Block], dict]:
    """The largest size step at which the copy fits its box; long words shrink the headline first."""
    bw, bh = box[2] - box[0], box[3] - box[1]
    hk = 1.0
    hints = len(((spec.get("texts") or {}).get("headline") or "").strip().split("\n"))
    for hk in STEPS:
        blocks, ok = _stack(d, spec, faces, caps, bw, 1.0, hk, s, script, lang, opts)
        head = next((b for b in blocks if b.role == "headline"), None)
        # the writer's line breaks are kept by shrinking a little before any line is wrapped again
        if ok and (head is None or len(head.lines) <= hints or hk < 0.8):
            break
    found = None
    for k in STEPS:
        blocks, ok = _stack(d, spec, faces, caps, bw, k, hk, s, script, lang, opts)
        if _total(blocks) <= bh and all(b.width <= bw + 0.5 for b in blocks):
            found = (blocks, {"scale": k, "headline_scale": hk, "trimmed": []})
            break
    if found and found[1]["scale"] < opts.comfort:
        # a small box with a lot of copy: the second offer line (then the body) goes before the type gets tiny
        trimmed: list[str] = []
        best = None
        t = dict(spec.get("texts") or {})
        for role in ("offer_line", "body"):
            if role == "offer_line" and len(t.get("offers") or []) > 1:
                t["offers"] = t["offers"][:1]
            elif role == "body" and (t.get("body") or "").strip():
                t["body"] = ""
            else:
                continue
            trimmed.append(role)
            for k in STEPS:
                if k <= found[1]["scale"]:
                    break
                blocks, ok = _stack(d, {**spec, "texts": t}, faces, caps, bw, k, hk, s, script, lang, opts)
                if _total(blocks) <= bh and all(b.width <= bw + 0.5 for b in blocks):
                    got = (blocks, {"scale": k, "headline_scale": hk, "trimmed": list(trimmed)})
                    if k >= opts.comfort:
                        return got
                    # not comfortable yet, but clearly bigger type than keeping every line
                    if k >= found[1]["scale"] * 1.15 and (best is None or k > best[1]["scale"]):
                        best = got
                    break
        if best is not None:
            return best
    if found:
        return found
    # still too much copy at the smallest size: break long words, then drop lines from the bottom up
    blocks, _ = _stack(d, spec, faces, caps, bw, STEPS[-1], hk, s, script, lang, opts, hard=True)
    trimmed = []
    order = [r for r in TRIM_ORDER if any(b.role == r for b in blocks)]
    while _total(blocks) > bh and blocks:
        role = next((r for r in order if any(b.role == r for b in blocks)), None)
        victim = next((b for b in reversed(blocks) if b.role == role), None) if role else None
        if victim is None:
            victim = blocks[-1]
        if len(victim.lines) > 1 and victim.role in ("body", "headline", "quote"):
            victim.lines = victim.lines[:-1]
            victim.lines[-1] = victim.lines[-1].rstrip(" .,;:") + "…"
            victim.height = victim.advance * len(victim.lines)
        else:
            blocks.remove(victim)
            if blocks and blocks[0].gap:
                blocks[0].gap = 0
        trimmed.append(victim.role)
    return blocks, {"scale": STEPS[-1], "headline_scale": hk, "trimmed": trimmed}


def _start_x(g: Geo, box, width: float, rtl: bool) -> float:
    x0, _, x1, _ = box
    if g.align == "center":
        return x0 + (x1 - x0 - width) / 2
    return x1 - width if rtl else x0


def _place(g: Geo, blocks: list[Block], box) -> int:
    x0, y0, x1, y1 = box
    total = _total(blocks)
    free = max(0, (y1 - y0) - total)
    return round(y0 + {"top": 0, "upper": free * 0.35, "center": free / 2, "lower": free * 0.72,
                       "bottom": free}[g.valign])


def _boxes(g: Geo, blocks: list[Block], box, y: int, rtl: bool) -> list[tuple[Block, tuple]]:
    out = []
    for b in blocks:
        y += b.gap
        x = _start_x(g, box, b.width, rtl)
        out.append((b, (x, y, x + b.width, y + b.height)))
        y += b.height
    return out


# ---------------------------------------------------------------- pieces

def _pill(d, b: Block, rect, bg: str, fg: str, rtl: bool, lang) -> None:
    x0, y0, x1, y1 = rect
    radius = min((y1 - y0) // 2, round(b.size * 1.1))
    d.rounded_rectangle((x0, y0, x1, y1), radius=radius, fill=rgb(bg))
    px, py = b.pill
    for i, ln in enumerate(b.lines):
        lw = _width(d, ln, b.font, lang)
        x = (x1 - px - lw) if rtl else (x0 + px)
        if len(b.lines) == 1:
            x = x0 + (x1 - x0 - lw) / 2
        _draw(d, (x, y0 + py + i * b.advance + _nudge(b)), ln, b.font, rgb(fg), lang)


def _price(img: Image.Image, b: Block, rect, colours: dict, rtl: bool, lang, report: dict) -> None:
    """The big price band: "Från 215 kr/timme" on the accent, the number about three times the words, all on
    one baseline."""
    p = b.parts
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = rect
    bg, fg = colours["accent"], colours["light"]
    if ratio(lum(colours["text"]), lum(bg)) > ratio(lum(fg), lum(bg)):
        fg = colours["text"]
    if ratio(lum(fg), lum(bg)) < AA_TEXT:
        # the small words are body-sized: the band deepens (or lightens) until they read
        bg = ensure_contrast(bg, lum(fg), AA_TEXT)
    d.rounded_rectangle((x0, y0, x1, y1), radius=round((y1 - y0) * 0.24), fill=rgb(bg))
    base = y0 + p["py"] + p["digit_h"]
    pieces = [(p["pre"], p["fs"], p["widths"][0]), (p["num"], p["fb"], p["widths"][1]),
              (p["post"], p["fs"], p["widths"][2])]
    pieces = [x for x in pieces if x[0]]
    x = x0 + p["px"]
    for text, font, wd in (reversed(pieces) if rtl else pieces):
        s, kw = _shape(text, lang)
        try:
            d.text((x, base), s, font=font, fill=rgb(fg), anchor="ls", **kw)
        except (KeyError, ValueError, OSError):
            d.text((x, base), s, font=font, fill=rgb(fg), anchor="ls")
        x += wd + p["sp"]
    report["contrast"]["price"] = round(ratio(lum(fg), lum(bg)), 2)
    report["price"] = {"pre": p["pre"], "number": p["num"], "post": p["post"], "number_px": b.size,
                       "words_px": p["small"], "bg": bg, "fg": fg}


def _arrow_room(size: int) -> int:
    return round(size * 0.85) + round(size * 0.5)


def _arrow(img: Image.Image, x: float, cy: float, w: int, colour, left: bool) -> None:
    """A clean arrow, drawn 4x and scaled down like the footer icons."""
    ss = 4
    n = w * ss
    m = Image.new("L", (n, n), 0)
    dm = ImageDraw.Draw(m)
    t = max(ss * 2, round(n * 0.13))
    head = n * 0.42
    y = n / 2
    tip, tail = (n * 0.06, n * 0.94) if left else (n * 0.94, n * 0.06)
    back = tip + head if left else tip - head
    dm.line((tail, y, tip, y), fill=255, width=t)
    dm.line((back, y - head, tip, y, back, y + head), fill=255, width=t, joint="curve")
    m = m.resize((w, w), Image.LANCZOS)
    solid = Image.new("RGB", (w, w), tuple(colour))
    img.paste(solid, (round(x), round(cy - w / 2)), m)


def _button(img: Image.Image, b: Block, rect, bg: str, fg: str, rtl: bool, lang) -> None:
    """The CTA: a solid button with a modest radius and an arrow after the label (before it, pointing left,
    in a right-to-left ad). Different in shape and colour from the offer pill on purpose."""
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = rect
    d.rounded_rectangle((x0, y0, x1, y1), radius=max(4, round(b.size * 0.32)), fill=rgb(bg))
    px, py = b.pill
    gap = round(b.size * 0.5)
    widest = max((_width(d, ln, b.font, lang) for ln in b.lines), default=0)
    start = x0 + (x1 - x0 - (widest + gap + b.arrow)) / 2
    text_x = start + (b.arrow + gap if rtl else 0)
    for i, ln in enumerate(b.lines):
        lw = _width(d, ln, b.font, lang)
        x = text_x + (widest - lw if rtl else 0)
        _draw(d, (x, y0 + py + i * b.advance + _nudge(b)), ln, b.font, rgb(fg), lang)
    ax = start if rtl else start + widest + gap
    _arrow(img, ax, (y0 + y1) / 2, b.arrow, rgb(fg), left=rtl)


def _cta_colours(img: Image.Image, rect, colours: dict) -> tuple[str, str, bool]:
    """(background, label, inverted). The primary button, unless it would vanish into what it sits on (a
    bottom bar in the same colour): then it turns white with the primary label."""
    bg, fg = colours["button"], colours["button_text"]
    inverted = False
    if ratio(lum(bg), mean_lum(img, rect)) < 1.6:
        bg, fg, inverted = colours["light"], colours["primary"], True
    if ratio(lum(fg), lum(bg)) < AA_LARGE:
        alt = colours["light"] if lum(fg) < 0.4 else colours["text"]
        fg = alt if ratio(lum(alt), lum(bg)) > ratio(lum(fg), lum(bg)) else fg
        bg = ensure_contrast(bg, lum(fg), AA_LARGE)
    return bg, fg, inverted


def _nudge(b: Block) -> int:
    # Latin capitals sit high in their line box; push them down a touch so the pill looks centred
    if b.font is None:
        return 0
    asc, desc = b.font.getmetrics()
    return max(0, round((b.advance - (asc + desc)) / 2))


def _spans(d, line: str, words: list[str], b: Block, lang, x: float, lw: float, rtl: bool) -> list[tuple]:
    """Where the key word sits in a set line, (x0, x1). Right-to-left lines count from the right edge; Arabic
    letters don't join across a space, so the logical prefix's width is where the word starts."""
    low = line.lower()
    for word in words:
        wl = word.lower()
        out = []
        i = low.find(wl)
        while wl and i >= 0:
            end = i + len(wl)
            whole = (i == 0 or not low[i - 1].isalnum()) and (end >= len(low) or not low[end].isalnum())
            if whole:
                pre = (_width(d, line[:i], b.font, lang, b.track) + b.track) if i else 0
                ww = _width(d, line[i:end], b.font, lang, b.track)
                sx0 = x + lw - pre - ww if rtl else x + pre
                out.append((sx0, sx0 + ww))
            i = low.find(wl, i + 1)
        if out:
            return out
    return []


def _recolour(img: Image.Image, xy, text: str, b: Block, lang, span, colour) -> None:
    """Re-set one line in another colour, but only inside span: the key word keeps the line's exact shaping
    and kerning because it is the same line drawn twice."""
    x, y = xy
    lw = _width(ImageDraw.Draw(img), text, b.font, lang, b.track)
    pad = b.size
    layer = Image.new("RGBA", (int(lw + 2 * pad), int(b.advance + 2 * pad)), (0, 0, 0, 0))
    _draw(ImageDraw.Draw(layer), (pad, pad), text, b.font, (*rgb(colour), 255), lang, b.track)
    sx0, sx1 = span
    c0, c1 = max(0, int(sx0 - x + pad) - 1), min(layer.width, int(sx1 - x + pad) + 2)
    if c1 <= c0:
        return
    piece = layer.crop((c0, 0, c1, layer.height))
    img.paste(piece, (int(x - pad + c0), int(y - pad)), piece)


def _lines(img, d, b: Block, rect, fill: str, g: Geo, rtl: bool, lang, hi: dict | None = None) -> list:
    x0, y0, x1, _ = rect
    hits = []
    for i, ln in enumerate(b.lines):
        lw = _width(d, ln, b.font, lang, b.track)
        if g.align == "center":
            x = x0 + (x1 - x0 - lw) / 2
        else:
            x = x1 - lw if rtl else x0
        y = y0 + i * b.advance + _nudge(b)
        _draw(d, (x, y), ln, b.font, rgb(fill), lang, b.track)
        if hi:
            for span in _spans(d, ln, hi["words"], b, lang, x, lw, rtl):
                _recolour(img, (x, y), ln, b, lang, span, hi["colour"])
                hits.append(ln)
    return hits


def _badge(img, g: Geo, spec, faces, colours, lang, report) -> None:
    t = spec.get("texts") or {}
    big, small = (t.get("badge_big") or "").strip(), (t.get("badge_small") or "").strip()
    if not g.badge or not big:
        return
    cx, cy, r = g.badge
    d = ImageDraw.Draw(img)
    bg = colours["accent"]
    fg = "#FFFFFF" if ratio(lum("#FFFFFF"), lum(bg)) >= ratio(lum(colours["text"]), lum(bg)) else colours["text"]
    if ratio(lum(fg), lum(bg)) < AA_LARGE:
        bg = ensure_contrast(bg, lum(fg), AA_LARGE)
    # drawn 4x and scaled down: the circle's edge stays smooth over a photo
    ss = 4
    disc = Image.new("L", (2 * r * ss, 2 * r * ss), 0)
    ImageDraw.Draw(disc).ellipse((0, 0, 2 * r * ss - 1, 2 * r * ss - 1), fill=255)
    disc = disc.resize((2 * r, 2 * r), Image.LANCZOS)
    img.paste(Image.new("RGB", (2 * r, 2 * r), rgb(bg)), (round(cx - r), round(cy - r)), disc)
    face = faces["badge"]
    size = round(r * 0.62)
    while size > 12:
        f = fz.load(str(face.path), size, face.weight)
        if _width(d, big, f, lang) <= r * 1.55:
            break
        size = round(size * 0.92)
    s, kw = _shape(big, lang)
    d.text((cx, cy - (r * 0.12 if small else 0)), s, font=f, fill=rgb(fg), anchor="mm", **kw)
    if small:
        sf_face = faces["kicker"]
        ss = round(r * 0.22)
        while ss > 10:
            sf = fz.load(str(sf_face.path), ss, sf_face.weight)
            if _width(d, small, sf, lang) <= r * 1.4:
                break
            ss = round(ss * 0.92)
        s2, kw2 = _shape(small, lang)
        d.text((cx, cy + r * 0.40), s2, font=sf, fill=rgb(fg), anchor="mm", **kw2)
    report["contrast"]["badge"] = round(ratio(lum(fg), lum(bg)), 2)
    report["badge"] = [round(cx), round(cy), r]


def _logo_pick(assets: AdAssets, variant: str, under: float) -> tuple[Image.Image | None, str | None]:
    """(logo, which) for the background luminance under it. An asked-for variant wins; on auto the primary
    logo stays unless it can't be read, then the kit's light (or dark) version, and with no light version
    the primary's dark ink recoloured to white."""
    def load(key):
        return prepare_logo(getattr(assets, key))

    if variant in ("light", "dark", "primary"):
        order = {"light": ("logo_light", "logo", "logo_dark"), "dark": ("logo_dark", "logo", "logo_light"),
                 "primary": ("logo", "logo_dark", "logo_light")}[variant]
        for key in order:
            logo = load(key)
            if logo is not None:
                if variant == "light" and key != "logo_light" and _ink_lum(logo) < 0.35:
                    return light_ink(logo), "recoloured"
                return logo, key
        return None, None
    logo, used = None, None
    for key in ("logo", "logo_dark", "logo_light"):
        logo = load(key)
        if logo is not None:
            used = key
            break
    if logo is None:
        return None, None
    ink = _ink_lum(logo)
    if ratio(ink, under) >= AA_LARGE:
        return logo, used
    # which way to go: a mid-tone photo can be lighter than navy ink and still want a white logo
    if ratio(1.0, under) > ratio(0.0, under):
        light = load("logo_light") if used != "logo_light" else None
        if light is not None:
            return light, "logo_light"
        return light_ink(logo), "recoloured"
    dark = load("logo_dark") if used != "logo_dark" else None
    if dark is not None and ratio(_ink_lum(dark), under) > ratio(ink, under):
        return dark, "logo_dark"
    return logo, used


def _logo(img, g: Geo, spec, assets: AdAssets, colours, report, box=None, rtl: bool = False) -> None:
    box = box or g.logo
    if box is None or (spec.get("logo") or {}).get("position") == "none":
        return
    x0, y0, x1, y1 = (round(v) for v in box)
    under = mean_lum(img, (x0, y0, x1, y1))
    logo, used = _logo_pick(assets, (spec.get("logo") or {}).get("variant") or "auto", under)
    if logo is None:
        return
    lw, lh = x1 - x0, y1 - y0
    sc = min(lw / logo.width, lh / logo.height)
    logo = logo.resize((max(1, round(logo.width * sc)), max(1, round(logo.height * sc))), Image.LANCZOS)
    # anchor to the box's own side
    pos = (spec.get("logo") or {}).get("position") or "tl"
    if pos == "stack":
        lx = x1 - logo.width if rtl else x0
        if g.align == "center":
            lx = x0 + (lw - logo.width) // 2
    elif x0 + lw / 2 > g.w * 0.6:
        lx = x1 - logo.width
    elif abs(x0 + lw / 2 - g.w / 2) < 2:
        lx = x0 + (lw - logo.width) // 2
    else:
        lx = x0
    ly = y0 + (lh - logo.height) // 2 if pos[0:1] in ("b", "s") else y0
    # measured where the logo really lands, not over its whole box
    under = mean_lum(img, (lx, ly, lx + logo.width, ly + logo.height))
    ink = _ink_lum(logo)
    plate = None
    got = ratio(ink, under)
    if got < AA_LARGE:
        # still unreadable (a busy mid-tone photo): a soft plate behind the logo, the last resort
        plate = colours["light"] if ink < 0.35 else colours["footer"]
        p = round(g.s * 0.018)
        frosted(img, (lx - p * 2, ly - p, lx + logo.width + p * 2, ly + logo.height + p), radius=p * 2,
                alpha=225, colour=rgb(plate))
        got = ratio(ink, lum(plate))
    img.paste(logo, (lx, ly), logo)
    report["logo"] = {"variant": {"logo": "primary", "logo_light": "light", "logo_dark": "dark",
                                  "recoloured": "recoloured"}[used],
                      "plate": plate is not None, "contrast": round(got, 2),
                      "box": [lx, ly, lx + logo.width, ly + logo.height]}


def _weighted(faces: dict, weight: str | None) -> dict:
    """The headline face at the weight the brand's own ads use (variable fonts only)."""
    want = {"regular": 500, "bold": 760, "black": 900}.get(weight or "")
    f = faces.get("headline")
    if not want or f is None or f.weight is None:
        return faces
    return {**faces, "headline": dc_replace(f, weight=want)}


# ---------------------------------------------------------------- render

# the layouts whose copy sits over the photo: these may move the copy to the subject's other side
AUTO_FLIP = ("frosted", "badge", "side_wash", "big_price")
OVER_PHOTO = ("frosted", "badge", "side_wash", "big_price", "minimal")
# these keep their full copy column and firm up the haze or panel instead of narrowing for the subject
KEEP_WIDTH = ("big_price",)


def _background(g: Geo, style: str, spec, assets: AdAssets, colours: dict, place: dict, faces, lang, rtl,
                report) -> Image.Image:
    from app.ads import designs

    if style in designs.PAINTED:
        return designs.paint(g, style, spec, assets, colours, place, faces, lang, rtl, report)
    fx, fy = place["focus"]
    base = _placeholder(g.w, g.h, colours)
    if assets.photo is not None:
        px0, py0, px1, py1 = g.photo
        base.paste(cover(assets.photo.convert("RGB"), px1 - px0, py1 - py0, fx, fy), (px0, py0))
    else:
        report["treatment"].append("no_photo")
    if g.block:
        block_col = rgb(colours[g.block_role])
        if g.wave:
            designs.wave_block(base, g, block_col)
        else:
            ImageDraw.Draw(base).rectangle(g.block, fill=block_col)
    if g.veil:
        kind, frac, strength = g.veil
        base = veil(base, kind, frac, strength, rtl=g.mirror)
    card = g.footer is not None and g.footer[0] > 0
    if card and g.block is None:
        # a soft shade behind the card; the photo carries on under it to the bottom edge (a heavy fade left
        # the bottom third of the first live stories an empty gradient)
        reach = (g.h - g.footer[1] + round(0.06 * g.h)) / g.h
        base = veil(base, "bottom", reach, 0.5, colour=rgb(colours["footer"]))
        report["treatment"].append("story_fade")
    return base


def _highlight(spec: dict, img, rect, colours: dict) -> dict | None:
    word = " ".join(((spec.get("texts") or {}).get("highlight") or "").split())
    if not word:
        return None
    colour = colours["accent"]
    bgl = worst_lum(img, rect, lum(colour))
    if ratio(lum(colour), bgl) < AA_LARGE:
        colour = ensure_contrast(colour, bgl, AA_LARGE)
    words = [word] + ([w for w in word.split() if len(w) > 1] if " " in word else [])
    return {"word": word, "words": words, "colour": colour, "contrast": round(ratio(lum(colour), bgl), 2)}


def render(spec: dict, assets: AdAssets) -> tuple[Image.Image, dict]:
    from app.ads import designs, placement

    fmt = spec.get("format") or "4:5"
    if fmt not in FORMATS:
        raise LayoutError(f"Unknown format '{fmt}'")
    style = spec.get("style") or "frosted"
    if style not in STYLES:
        raise LayoutError(f"Unknown layout style '{style}'")
    rtl = bool(spec.get("rtl"))
    lang = spec.get("language") or None
    texts = spec.get("texts") or {}
    script = fz.script_of(lang, " ".join([texts.get("headline") or "", texts.get("body") or ""]))
    colours = {**roles(spec.get("palette")), **{k: v for k, v in (spec.get("colours") or {}).items() if v}}
    own = spec.get("colours") or {}
    if own.get("accent"):
        # a new accent carries its tints along unless they were picked too
        colours["pill"] = own.get("pill") or hexs(mix(colours["accent"], WHITE, 0.18))
        colours["block"] = own.get("block") or hexs(mix(colours["accent"], WHITE, 0.84))
    shape = spec.get("shape") or {}
    colours["shape"] = shape.get("colour") or colours["accent"]
    ref = spec.get("style_ref") or {}
    faces, caps = fz.faces(spec.get("font_preset") or fz.DEFAULT_PRESET, script, assets.brand_fonts)
    faces = _weighted(faces, ref.get("headline_weight"))
    used, fallback = designs.honour(style, spec, assets)
    fw, fh = FORMATS[fmt]
    foot = ft.plan(spec, fmt, fw, min(fw, fh), faces)
    # a footer that was asked for but has nothing to show is still a brand-coloured strip
    footer_h = foot.height or (round(0.089 * min(fw, fh)) if spec.get("footer", True) else 0)
    logo_pos = (spec.get("logo") or {}).get("position") or LOGO_DEFAULT.get(used, "tl")
    density = {"airy": 1.18, "dense": 0.86}.get(ref.get("density") or "", 1.0)
    mask_kind = shape.get("mask") or None

    def geo(flip: bool) -> Geo:
        return geometry(used, fmt, footer_h=footer_h, logo_pos=logo_pos, rtl=rtl, flip=flip, density=density,
                        mask=mask_kind)

    pflip = (spec.get("placement") or {}).get("flip")
    subject = placement.subject_of(spec, assets)
    focus = spec.get("focus") or None
    if focus and focus.get("auto"):
        focus = None
    g = geo(bool(pflip))
    place = placement.place(g, assets.photo, subject, focus)
    if pflip is None and subject is not None and used in AUTO_FLIP and assets.photo is not None and focus is None:
        g2 = geo(True)
        p2 = placement.place(g2, assets.photo, subject, None)
        if p2["overlap"] + 0.05 < place["overlap"]:
            g, place = g2, p2
    report: dict = {"format": fmt, "style": style, "size": [g.w, g.h], "contrast": {}, "treatment": [],
                    "script": script, "rtl": rtl, "layout": used, "fallback": fallback,
                    "placement": {"focus": {"x": round(place["focus"][0], 3), "y": round(place["focus"][1], 3)},
                                  "flip": g.flip, "auto": focus is None,
                                  "overlap": round(place["overlap"], 3),
                                  "source": subject.get("source") if subject else None}}

    base = _background(g, used, spec, assets, colours, place, faces, lang, rtl, report)

    d = ImageDraw.Draw(base)
    copy_box = list(g.copy)
    cta_block = None
    opts = StackOpts(cta_in_stack=g.cta == "stack", head_scale=g.head_scale,
                     caps_headline=ref.get("headline_case") == "upper", price=g.price, quote=g.quote,
                     comfort=g.comfort,
                     logo_slot=g.logo_size if g.logo_in_stack and (spec.get("logo") or {}).get("position") != "none"
                     and (assets.logo or assets.logo_light or assets.logo_dark) else None)
    if g.cta in ("anchor", "beside") and (texts.get("cta") or "").strip():
        # the CTA sits on its own near the bottom; the copy fits in what's left above it
        cb, _ = _stack(d, {"texts": {"cta": texts["cta"]}}, faces, caps, g.cta_w or g.w * 0.6, 1.0, 1.0, g.s,
                       script, lang, StackOpts(), hard=True)
        cta_block = cb[0] if cb else None
        if cta_block is not None and g.cta == "anchor":
            copy_box[3] = min(copy_box[3], g.bottom - cta_block.height - round(0.05 * g.s))
    if copy_box[3] - copy_box[1] < g.s * 0.2:
        copy_box[1] = max(g.top, copy_box[3] - round(g.s * 0.2))
    # the copy keeps off the subject: the box gives up the side (or the bottom) the subject is in
    subj = place.get("subject_frame")
    if subj is not None and used in OVER_PHOTO and used not in KEEP_WIDTH:
        copy_box, clipped = placement.clear_of(copy_box, subj, g)
        if clipped:
            report["placement"]["clipped"] = clipped

    inner = list(copy_box)
    if g.panel in ("bar", "fixed"):
        inner = [copy_box[0], copy_box[1] + g.pad, copy_box[2], copy_box[3] - g.pad]
    blocks, fitted = fit(d, spec, faces, caps, inner, g.s, script, lang, opts)
    if opts.flags.get("word_floor"):
        fitted["word_floor"] = True
    report.update(fit=fitted, fonts={b.role: b.size for b in blocks if b.font is not None},
                  lines={b.role: b.lines for b in blocks if b.role in ("headline", "body", "quote")})

    def content_rect(placed):
        xs = [r for _, r in placed]
        return (min(r[0] for r in xs), min(r[1] for r in xs), max(r[2] for r in xs), max(r[3] for r in xs))

    y = _place(g, blocks, inner)
    placed = _boxes(g, blocks, inner, y, rtl)
    card = g.footer is not None and g.footer[0] > 0
    if g.badge_spots and texts.get("badge_big") and placed:
        g.badge = placement.badge_spot(g, place, report, content_rect(placed))

    def panel_rect(level: int):
        if not placed:
            return None
        cx0, cy0, cx1, cy1 = content_rect(placed)
        p = g.pad
        if g.panel == "fixed":
            return (copy_box[0] - p, cy0 - p, copy_box[2] + p, cy1 + p)
        if g.panel == "bar":
            return (0, cy0 - p, g.w, (g.footer[1] if g.footer and not card else g.h))
        return (cx0 - p, cy0 - p, cx1 + p, cy1 + p)

    # what the copy sits on decides the ink, then every element is checked and the panel firmed up
    tone = g.tone
    block_col = colours[g.block_role]
    if g.panel is None and g.block is None and placed:
        tone = "light" if mean_lum(base, content_rect(placed)) > 0.4 else "dark"
    if g.block is not None:
        bl = lum(block_col)
        tone = "light" if ratio(lum(colours["text"]), bl) >= ratio(lum(colours["light"]), bl) else "dark"
    ink = colours["text"] if tone == "light" else colours["light"]
    panel_col = rgb(colours["light"]) if tone == "light" else rgb(colours["footer"])
    levels = ([None] if g.panel is None else []) + [200, 228, 250]
    if subj is not None and used in OVER_PHOTO and placed and g.panel is None and             placement.inter(content_rect(placed), subj) > 0.06 * placement.area(content_rect(placed)):
        # small free area: the copy still crosses the subject, so it gets a panel rather than sitting on it
        levels = [200, 228, 250]
        report["treatment"].append("subject_panel")
    if g.panel == "bar":
        levels = [255]
    elif g.block is not None:
        levels = [None]  # a split block doesn't get a panel on top; it gets deepened below if it must
    img = base
    text_roles = ("offer", "cta", "price", "logo_slot", "qmark")
    for level in levels:
        img = base.copy()
        pr = panel_rect(level) if level is not None else None
        if pr is not None:
            if g.panel == "bar" or level >= 250:
                ImageDraw.Draw(img).rounded_rectangle(pr, radius=0 if g.panel == "bar" else round(g.s * 0.033),
                                                      fill=panel_col)
            else:
                frosted(img, pr, radius=round(g.s * 0.033), alpha=level, colour=panel_col)
        worst = min((ratio(lum(ink), worst_lum(img, r, lum(ink))) / NEED.get(b.role, AA_TEXT)
                     for b, r in placed if b.role not in text_roles), default=9)
        if worst >= 1:
            if level is not None and g.panel is None:
                report["treatment"].append("panel")
            if level is not None and level > 200 and g.panel != "bar":
                report["treatment"].append(f"panel_{level}")
            break
    else:
        if g.block is not None and placed:
            # a mid-tone block colour neither ink reads on: deepen the block itself
            col = ensure_contrast(block_col, lum(ink), AA_TEXT)
            ImageDraw.Draw(img).rectangle(g.block, fill=rgb(col))
            report["treatment"].append("block_deepened")

    # the logo goes on before the copy so its own check sees the final background
    _logo(img, g, spec, assets, colours, report, rtl=rtl)
    d = ImageDraw.Draw(img)
    buttons: dict = {}
    if g.rule and placed:
        first = placed[0][1]
        rw, rh = g8(0.09 * g.s), max(4, round(0.008 * g.s))
        ry = first[1] - g8(0.024 * g.s) - rh
        if ry > g.top - g.m // 2:
            rx = (first[2] - rw) if rtl and g.align != "center" else (first[0] if g.align != "center" else
                                                                      (first[0] + first[2] - rw) / 2)
            rule_col = colours["accent"]
            if ratio(lum(rule_col), mean_lum(img, (rx, ry, rx + rw, ry + rh))) < 1.6:
                rule_col = ink
            d.rectangle((rx, ry, rx + rw, ry + rh), fill=rgb(rule_col))

    def draw_cta(b: Block, rect) -> None:
        bg, fg, inverted = _cta_colours(img, rect, colours)
        _button(img, b, rect, bg, fg, rtl, lang)
        report["contrast"]["cta"] = round(ratio(lum(fg), lum(bg)), 2)
        buttons["cta"] = {"shape": "button", "bg": bg, "fg": fg, "arrow": True, "inverted": inverted}

    for b, r in placed:
        if b.role == "cta":
            draw_cta(b, r)
            continue
        if b.role == "logo_slot":
            _logo(img, g, spec, assets, colours, report, box=r, rtl=rtl)
            continue
        if b.role == "price":
            _price(img, b, r, colours, rtl, lang, report)
            continue
        if b.role == "offer":
            bg, fg = colours["pill"], colours["text"]
            if ratio(lum(fg), lum(bg)) < AA_TEXT:
                alt = colours["light"] if lum(fg) < 0.4 else colours["text"]
                fg = alt if ratio(lum(alt), lum(bg)) > ratio(lum(fg), lum(bg)) else fg
                bg = ensure_contrast(bg, lum(fg), AA_TEXT)
            _pill(d, b, r, bg, fg, rtl, lang)
            report["contrast"]["offer"] = round(ratio(lum(fg), lum(bg)), 2)
            buttons["offer"] = {"shape": "pill", "bg": bg, "fg": fg, "arrow": False}
            continue
        fill = ink
        if b.role in ("kicker", "qmark"):
            fill = colours["accent"]
        elif b.role in ("body", "quote_by") and g.ground and tone == "light":
            # the lighter subline of the reference ads, still at least AA
            fill = colours["muted"]
        bgl = worst_lum(img, r, lum(fill))
        need = NEED.get(b.role, AA_TEXT)
        if ratio(lum(fill), bgl) < need:
            fill = ensure_contrast(fill, bgl, need)
        hi = _highlight(spec, img, r, colours) if b.role == "headline" else None
        hits = _lines(img, d, b, r, fill, g, rtl, lang, hi)
        if hi:
            report["highlight"] = {"word": hi["word"], "colour": hi["colour"], "contrast": hi["contrast"],
                                   "found": bool(hits)}
        prev = report["contrast"].get(b.role)
        got = round(ratio(lum(fill), bgl), 2)
        report["contrast"][b.role] = min(prev, got) if prev else got

    if cta_block is not None:
        cx = g.w - g.m - cta_block.width if g.mirror else g.m
        cy = g.bottom - cta_block.height
        draw_cta(cta_block, (cx, cy, cx + cta_block.width, cy + cta_block.height))
        placed.append((cta_block, (cx, cy, cx + cta_block.width, cy + cta_block.height)))

    _badge(img, g, spec, faces, colours, lang, report)
    if g.footer is not None:
        fcol = colours
        if g.footer_light:
            fcol = {**colours, "footer": hexs(mix(colours["paper"], colours["text"], 0.07)),
                    "footer_text": colours["text"]}
        ft.draw(img, g.footer, foot, faces, fcol, lang, rtl, report)
    report["buttons"] = buttons
    report["boxes"] = {b.role: [round(v) for v in r] for b, r in placed}
    report["copy_box"] = [round(v) for v in inner]
    report["ink"] = ink
    report["placement"]["overlap"] = round(placement.copy_overlap(report, place), 3)
    return img, report
