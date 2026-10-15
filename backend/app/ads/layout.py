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
"""
import logging
from dataclasses import dataclass, field
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
STYLES = ("frosted", "side_wash", "bottom_bar", "split", "badge", "minimal")
STYLE_LABELS = {"frosted": "Frosted panel", "side_wash": "Side wash", "bottom_bar": "Bottom bar",
                "split": "Split colour block", "badge": "Price badge", "minimal": "Minimal centred"}
LOGO_POSITIONS = ("tl", "tr", "tc", "bl", "br", "none")
# the top and bottom of a story are under the app's own header and reply bar
SAFE = {"9:16": (0.13, 0.18)}
AA_TEXT, AA_LARGE = 4.5, 3.0
NEED = {"headline": AA_LARGE, "cta": AA_LARGE, "badge": AA_LARGE}  # everything else needs AA_TEXT

DEFAULT_TEXT, DEFAULT_ACCENT = "#22223B", "#E2685C"
WHITE = (255, 255, 255)
CONTACT_ORDER = ft.CONTACT_KEYS

# sizes as a share of the frame's short side, before fitting
BASE = {"headline": 0.080, "kicker": 0.027, "body": 0.031, "offer": 0.032, "cta": 0.035, "footer": 0.025}
FLOOR = {"headline": 28, "kicker": 16, "body": 17, "offer": 18, "cta": 22, "footer": 22}
LEADING = {"headline": 1.06, "kicker": 1.2, "body": 1.3, "offer": 1.2, "cta": 1.1}
STEPS = [round(1.0 * 0.93 ** i, 4) for i in range(16)]


class LayoutError(ValueError):
    pass


@dataclass
class AdAssets:
    photo: Image.Image | None = None
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
    """Colour roles from a kit palette: the darkest colour is the ink and the footer, the liveliest one the
    accent (kicker, CTA, badge). Falls back to the prototype's navy and coral."""
    cols = [p["hex"] for p in palette or [] if p.get("hex")]
    dark = min(cols, key=lum) if cols and lum(min(cols, key=lum)) < 0.2 else DEFAULT_TEXT
    rest = [c for c in cols if c != dark and 0.03 < lum(c) < 0.8]
    accent = max(rest, key=_sat) if rest and _sat(max(rest, key=_sat)) > 0.15 else DEFAULT_ACCENT
    return {"text": dark, "accent": accent, "button": accent, "button_text": "#FFFFFF", "footer": dark,
            "footer_text": "#FFFFFF", "pill": hexs(mix(accent, WHITE, 0.18)), "light": "#FFFFFF",
            # the split layout's block: a pale wash of the accent, so the logo's own accent never vanishes on it
            "block": hexs(mix(accent, WHITE, 0.84))}


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


# ---------------------------------------------------------------- text

def _shape(text: str, lang: str | None) -> tuple[str, dict]:
    s, kw = br.shaped(text)
    if kw.get("language") and lang:
        kw = {**kw, "language": lang}
    return s, kw


def _width(d: ImageDraw.ImageDraw, text: str, font, lang: str | None) -> float:
    s, kw = _shape(text, lang)
    try:
        return d.textlength(s, font=font, **kw)
    except (KeyError, ValueError, OSError):
        return d.textlength(s, font=font)


def _draw(d: ImageDraw.ImageDraw, xy, text: str, font, fill, lang: str | None) -> None:
    s, kw = _shape(text, lang)
    try:
        d.text(xy, s, font=font, fill=fill, anchor="la", **kw)
    except (KeyError, ValueError, OSError):
        d.text(xy, s, font=font, fill=fill, anchor="la")


def _break_word(d, word: str, font, maxw: float, lang) -> list[str]:
    # last resort for a word wider than the box at the smallest size: hyphenate wherever it has to
    parts, cur = [], ""
    for ch in word:
        if cur and _width(d, cur + ch + "-", font, lang) > maxw:
            parts.append(cur + "-")
            cur = ch
        else:
            cur += ch
    return parts + [cur] if cur else parts


def wrap(d, text: str, font, maxw: float, lang: str | None, hard: bool = False) -> tuple[list[str], bool]:
    """Greedy word wrap; a "\\n" in the text is a wanted line break. (lines, every word fitted)."""
    lines, ok = [], True
    for para in (text or "").split("\n"):
        words = para.split()
        cur = ""
        for w in words:
            if _width(d, w, font, lang) > maxw:
                ok = False
                if hard:
                    if cur:
                        lines.append(cur)
                    *head, cur = _break_word(d, w, font, maxw, lang)
                    lines.extend(head)
                    continue
            trial = f"{cur} {w}" if cur else w
            if cur and _width(d, trial, font, lang) > maxw:
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
    pill: tuple[int, int] | None = None  # (pad_x, pad_y) for the offer and CTA pills
    width: float = 0
    height: int = 0


def _advance(font, size: int, role: str, script: str) -> int:
    if script != "latin":
        asc, desc = font.getmetrics()
        return round((asc + desc) * (0.92 if role == "headline" else 1.0))
    return round(size * LEADING.get(role, 1.2))


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
    tone: str = "light"  # what the copy sits on: light (dark ink) or dark (light ink)
    veil: tuple | None = None  # (kind, frac, strength)
    cta: str = "stack"  # stack | anchor
    badge: tuple[int, int, int] | None = None
    logo: tuple[int, int, int, int] | None = None
    pad: int = 0


def _mirror_box(box, w):
    x0, y0, x1, y1 = box
    return (w - x1, y0, w - x0, y1)


def geometry(style: str, fmt: str, *, footer_h: int, logo_pos: str, rtl: bool) -> Geo:
    """Where everything goes. footer_h is the planned footer's height, 0 for none."""
    w, h = FORMATS[fmt]
    s = min(w, h)
    m = round(0.065 * s)
    st, sb = (round(h * f) for f in SAFE.get(fmt, (0, 0)))
    fh = footer_h
    footer = fh > 0
    top, bottom = st + m, h - sb - fh - m
    foot = (0, h - sb - fh, w, h - sb) if footer else None
    band = (h - sb - fh, h - sb) if footer else None
    fmt = LAYOUT_OF.get(fmt, fmt)
    wide, tall = fmt == "16:9", fmt == "9:16"
    logo_h, logo_w = round(0.085 * s), round(0.25 * s)
    pos = logo_pos if logo_pos in LOGO_POSITIONS else "tl"
    # logo positions are written for left-to-right; mirrored below for RTL
    lp = {"tl": "tl", "tr": "tr", "bl": "bl", "br": "br"}.get(pos, pos)
    if rtl and lp in ("tl", "tr", "bl", "br"):
        lp = {"tl": "tr", "tr": "tl", "bl": "br", "br": "bl"}[lp]
    logo = None
    if lp != "none":
        x0 = {"l": m, "r": w - m - logo_w, "c": (w - logo_w) // 2}[lp[1]]
        y0 = top if lp[0] == "t" else bottom - logo_h
        logo = (x0, y0, x0 + logo_w, y0 + logo_h)
    gap = round(0.045 * s)
    cy0 = top + (logo_h + gap if lp[0] == "t" else 0)
    cy1 = bottom - (logo_h + gap if lp[0] == "b" else 0)
    g = Geo(w, h, s, m, top, bottom, foot, band, (0, 0, w, h), [m, cy0, w - m, cy1], pad=round(0.037 * s))

    if style in ("frosted", "badge"):
        x0 = round(m * 0.63)
        x1 = {"4:5": 0.74, "1:1": 0.66, "9:16": 1.0, "16:9": 0.5}[fmt] * w
        x1 = w - x0 if tall else round(x1)
        g.veil = ("top", min(0.5, (cy0 + 0.04 * h) / h), 0.75)
        g.copy = [x0 + g.pad, cy0, x1 - g.pad, cy1]
        g.panel, g.cta = "fixed", "anchor"
        g.valign = "center" if wide else ("upper" if tall else "top")
        if style == "badge":
            r = round(0.104 * s)
            cx, cy = w - m - r, top + r
            if logo is not None and logo[2] > w - m - 2 * r and logo[1] < cy + r:
                cy = logo[3] + gap + r  # the logo has the corner; the badge goes under it
            g.badge = (cx, cy, r)
            if tall:
                # a story is narrow: the copy starts below the badge instead of beside it
                g.copy[1] = max(g.copy[1], cy + r + gap)
    elif style == "side_wash":
        frac = {"4:5": 0.62, "1:1": 0.66, "9:16": 0.85, "16:9": 0.55}[fmt]
        g.veil = ("side", frac, 0.9)
        x1 = {"4:5": 0.58, "1:1": 0.6, "9:16": 0.8, "16:9": 0.45}[fmt] * w
        g.copy = [m, cy0, round(x1), cy1]
        g.valign = "upper"
    elif style == "bottom_bar":
        g.panel, g.tone, g.valign = "bar", "dark", "bottom"
        g.copy = [m, max(cy0, round(h * (0.42 if tall else 0.4))), w - m, bottom]
        if wide:
            # a full-width bar on a banner would set the copy tiny; it takes the start side instead
            g.copy = [m, max(cy0, round(h * 0.3)), round(w * 0.62), bottom]
    elif style == "split":
        g.tone = "dark"
        if fmt in ("4:5", "9:16"):
            bt = round(h * (0.5 if fmt == "4:5" else 0.45))
            g.block = (0, bt, w, foot[1] if foot else h)
            g.photo = (0, 0, w, bt)
            g.copy = [m, bt + m, w - m, (foot[1] if foot else h - sb) - m]
        else:
            bw = round(w * (0.5 if fmt == "1:1" else 0.42))
            g.block = (0, 0, bw, foot[1] if foot else h)
            g.photo = (bw, 0, w, foot[1] if foot else h)
            g.copy = [m, cy0, bw - m, cy1]
            g.valign = "center"
    elif style == "minimal":
        side = round(m * 1.4)
        g.copy = [side, cy0, w - side, cy0 + round((cy1 - cy0) * (0.62 if tall else 0.58))]
        g.align, g.panel = "center", None
    else:
        raise LayoutError(f"Unknown layout style '{style}'")

    if rtl:
        g.copy = list(_mirror_box(g.copy, w))
        g.photo = _mirror_box(g.photo, w)
        if g.block:
            g.block = _mirror_box(g.block, w)
        if g.badge:
            cx, cy, r = g.badge
            g.badge = (w - cx, cy, r)
    g.logo = logo
    return g


# ---------------------------------------------------------------- the copy stack

def _stack(d, spec: dict, faces: dict, caps: bool, box_w: float, k: float, hk: float, s: int, script: str,
           lang, cta_in_stack: bool, hard: bool = False) -> tuple[list[Block], bool]:
    t = spec.get("texts") or {}
    blocks: list[Block] = []
    ok = True

    def add(role: str, text: str, gap: float, scale: float, pill: bool = False, face_role: str | None = None):
        nonlocal ok
        if not (text or "").strip():
            return
        size = max(FLOOR[role], round(BASE[role] * s * scale))
        face = faces[face_role or role]
        font = fz.load(str(face.path), size, face.weight)
        pad = (round(size * 0.95), round(size * 0.48)) if pill else None
        inner = box_w - (2 * pad[0] if pad else 0)
        lines, fitted = wrap(d, text, font, inner, lang, hard=hard)
        ok = ok and fitted
        adv = _advance(font, size, role, script)
        widest = max((_width(d, ln, font, lang) for ln in lines), default=0)
        b = Block(role, lines, font, size, adv, round(gap * s * k) if blocks else 0, pad)
        b.width = widest + (2 * pad[0] if pad else 0)
        b.height = adv * len(lines) + (2 * pad[1] if pad else 0)
        blocks.append(b)

    kicker = t.get("kicker") or ""
    add("kicker", kicker.upper() if caps else kicker, 0, k)
    add("headline", t.get("headline") or "", 0.022, k * hk)
    add("body", t.get("body") or "", 0.026, k)
    offers = [o for o in t.get("offers") or [] if o and o.strip()]
    if offers:
        add("offer", offers[0], 0.032, k, pill=True)
        if len(offers) > 1:
            add("body", "  ·  ".join(offers[1:3]), 0.02, k, face_role="kicker")
            blocks[-1].role = "offer_line"
    if cta_in_stack:
        add("cta", t.get("cta") or "", 0.04, k, pill=True)
    return blocks, ok


def _total(blocks: list[Block]) -> int:
    return sum(b.gap + b.height for b in blocks)


def fit(d, spec, faces, caps, box, s, script, lang, cta_in_stack) -> tuple[list[Block], dict]:
    """The largest size step at which the copy fits its box; long words shrink the headline first."""
    bw, bh = box[2] - box[0], box[3] - box[1]
    hk = 1.0
    hints = len(((spec.get("texts") or {}).get("headline") or "").strip().split("\n"))
    for hk in STEPS:
        blocks, ok = _stack(d, spec, faces, caps, bw, 1.0, hk, s, script, lang, cta_in_stack)
        head = next((b for b in blocks if b.role == "headline"), None)
        # the writer's line breaks are kept by shrinking a little before any line is wrapped again
        if ok and (head is None or len(head.lines) <= hints or hk < 0.8):
            break
    for k in STEPS:
        blocks, ok = _stack(d, spec, faces, caps, bw, k, hk, s, script, lang, cta_in_stack)
        if _total(blocks) <= bh and all(b.width <= bw + 0.5 for b in blocks):
            return blocks, {"scale": k, "headline_scale": hk, "trimmed": []}
    # still too much copy at the smallest size: break long words, then drop lines from the bottom up
    blocks, _ = _stack(d, spec, faces, caps, bw, STEPS[-1], hk, s, script, lang, cta_in_stack, hard=True)
    trimmed = []
    order = [r for r in ("offer_line", "body", "kicker", "offer") if any(b.role == r for b in blocks)]
    while _total(blocks) > bh and blocks:
        role = next((r for r in order if any(b.role == r for b in blocks)), None)
        victim = next((b for b in reversed(blocks) if b.role == role), None) if role else None
        if victim is None:
            victim = blocks[-1]
        if len(victim.lines) > 1 and victim.role in ("body", "headline"):
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
    return round(y0 + {"top": 0, "upper": free * 0.35, "center": free / 2, "bottom": free}[g.valign])


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


def _nudge(b: Block) -> int:
    # Latin capitals sit high in their line box; push them down a touch so the pill looks centred
    asc, desc = b.font.getmetrics()
    return max(0, round((b.advance - (asc + desc)) / 2))


def _lines(d, b: Block, rect, fill: str, g: Geo, rtl: bool, lang) -> None:
    x0, y0, x1, _ = rect
    for i, ln in enumerate(b.lines):
        lw = _width(d, ln, b.font, lang)
        if g.align == "center":
            x = x0 + (x1 - x0 - lw) / 2
        else:
            x = x1 - lw if rtl else x0
        _draw(d, (x, y0 + i * b.advance + _nudge(b)), ln, b.font, rgb(fill), lang)


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
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=rgb(bg))
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


def _logo(img, g: Geo, spec, assets: AdAssets, colours, report) -> None:
    if g.logo is None or (spec.get("logo") or {}).get("position") == "none":
        return
    x0, y0, x1, y1 = g.logo
    under = mean_lum(img, g.logo)
    dark_bg = under < 0.3
    variant = (spec.get("logo") or {}).get("variant") or "auto"
    order = {"light": ("logo_light", "logo", "logo_dark"), "dark": ("logo_dark", "logo", "logo_light"),
             "primary": ("logo", "logo_dark", "logo_light")}.get(variant) or \
        (("logo_light", "logo", "logo_dark") if dark_bg else ("logo", "logo_dark", "logo_light"))
    logo, used = None, None
    for key in order:
        logo = prepare_logo(getattr(assets, key))
        if logo is not None:
            used = key
            break
    if logo is None:
        return
    lw, lh = x1 - x0, y1 - y0
    sc = min(lw / logo.width, lh / logo.height)
    logo = logo.resize((max(1, round(logo.width * sc)), max(1, round(logo.height * sc))), Image.LANCZOS)
    # anchor to the box's own side
    pos = (spec.get("logo") or {}).get("position") or "tl"
    if x0 + lw / 2 > g.w * 0.6:
        lx = x1 - logo.width
    elif abs(x0 + lw / 2 - g.w / 2) < 2:
        lx = x0 + (lw - logo.width) // 2
    else:
        lx = x0
    ly = y0 + (lh - logo.height) // 2 if pos[0:1] == "b" else y0
    ink = _ink_lum(logo)
    plate = None
    if ratio(ink, under) < AA_LARGE:
        # no variant for this background: a soft plate behind the logo instead
        plate = colours["light"] if ink < 0.35 else colours["footer"]
        p = round(g.s * 0.018)
        frosted(img, (lx - p * 2, ly - p, lx + logo.width + p * 2, ly + logo.height + p), radius=p * 2,
                alpha=225, colour=rgb(plate))
    img.paste(logo, (lx, ly), logo)
    report["logo"] = {"variant": {"logo": "primary", "logo_light": "light", "logo_dark": "dark"}[used],
                      "plate": plate is not None, "box": [lx, ly, lx + logo.width, ly + logo.height]}


# ---------------------------------------------------------------- render

def render(spec: dict, assets: AdAssets) -> tuple[Image.Image, dict]:
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
    faces, caps = fz.faces(spec.get("font_preset") or fz.DEFAULT_PRESET, script, assets.brand_fonts)
    has_badge = style == "badge" and bool((texts.get("badge_big") or "").strip())
    fw, fh = FORMATS[fmt]
    foot = ft.plan(spec, fmt, fw, min(fw, fh), faces)
    # a footer that was asked for but has nothing to show is still a brand-coloured strip
    footer_h = foot.height or (round(0.089 * min(fw, fh)) if spec.get("footer", True) else 0)
    g = geometry(style if style != "badge" or has_badge else "frosted", fmt, footer_h=footer_h,
                 logo_pos=(spec.get("logo") or {}).get("position") or "tl", rtl=rtl)
    report: dict = {"format": fmt, "style": style, "size": [g.w, g.h], "contrast": {}, "treatment": [],
                    "script": script, "rtl": rtl}
    focus = spec.get("focus") or {}

    # the background: the photo in its rect, the split block, the wash
    base = _placeholder(g.w, g.h, colours)
    if assets.photo is not None:
        px0, py0, px1, py1 = g.photo
        base.paste(cover(assets.photo.convert("RGB"), px1 - px0, py1 - py0, focus.get("x", 0.5),
                         focus.get("y", 0.5)), (px0, py0))
    else:
        report["treatment"].append("no_photo")
    if g.block:
        block_col = colours["block"]
        ImageDraw.Draw(base).rectangle(g.block, fill=rgb(block_col))
    if g.veil:
        kind, frac, strength = g.veil
        base = veil(base, kind, frac, strength, rtl=rtl)

    d = ImageDraw.Draw(base)
    copy_box = list(g.copy)
    cta_block = None
    if g.cta == "anchor" and (texts.get("cta") or "").strip():
        # the CTA sits on its own near the bottom; the copy fits in what's left above it
        cb, _ = _stack(d, {"texts": {"cta": texts["cta"]}}, faces, caps, g.w * 0.6, 1.0, 1.0, g.s, script, lang,
                       True, hard=True)
        cta_block = cb[0] if cb else None
        if cta_block is not None:
            copy_box[3] = min(copy_box[3], g.bottom - cta_block.height - round(0.05 * g.s))
    if copy_box[3] - copy_box[1] < g.s * 0.2:
        copy_box[1] = max(g.top, copy_box[3] - round(g.s * 0.2))

    inner = list(copy_box)
    if g.panel == "bar":
        inner = [copy_box[0], copy_box[1] + g.pad, copy_box[2], copy_box[3] - g.pad]
    elif g.panel == "fixed":
        inner = [copy_box[0], copy_box[1] + g.pad, copy_box[2], copy_box[3] - g.pad]
    blocks, fitted = fit(d, spec, faces, caps, inner, g.s, script, lang, g.cta == "stack")
    report.update(fit=fitted, fonts={b.role: b.size for b in blocks},
                  lines={b.role: b.lines for b in blocks if b.role in ("headline", "body")})

    def content_rect(placed):
        xs = [r for _, r in placed]
        return (min(r[0] for r in xs), min(r[1] for r in xs), max(r[2] for r in xs), max(r[3] for r in xs))

    y = _place(g, blocks, inner)
    placed = _boxes(g, blocks, inner, y, rtl)

    def panel_rect(level: int):
        if not placed:
            return None
        cx0, cy0, cx1, cy1 = content_rect(placed)
        p = g.pad
        if g.panel == "fixed":
            return (copy_box[0] - p, cy0 - p, copy_box[2] + p, cy1 + p)
        if g.panel == "bar":
            return (0, cy0 - p, g.w, (g.footer[1] if g.footer else g.h))
        return (cx0 - p, cy0 - p, cx1 + p, cy1 + p)

    # what the copy sits on decides the ink, then every element is checked and the panel firmed up
    tone = g.tone
    if g.panel is None and g.block is None and placed:
        tone = "light" if mean_lum(base, content_rect(placed)) > 0.4 else "dark"
    if g.block is not None:
        bl = lum(colours["block"])
        tone = "light" if ratio(lum(colours["text"]), bl) >= ratio(lum(colours["light"]), bl) else "dark"
    ink = colours["text"] if tone == "light" else colours["light"]
    panel_col = rgb(colours["light"]) if tone == "light" else rgb(colours["footer"])
    levels = ([None] if g.panel is None else []) + [200, 228, 250]
    if g.panel == "bar":
        levels = [255]
    elif g.block is not None:
        levels = [None]  # a split block doesn't get a panel on top; it gets deepened below if it must
    img = base
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
                     for b, r in placed if b.role not in ("offer", "cta")), default=9)
        if worst >= 1:
            if level is not None and g.panel is None:
                report["treatment"].append("panel")
            if level is not None and level > 200 and g.panel != "bar":
                report["treatment"].append(f"panel_{level}")
            break
    else:
        if g.block is not None and placed:
            # a mid-tone block colour neither ink reads on: deepen the block itself
            col = ensure_contrast(colours["block"], lum(ink), AA_TEXT)
            ImageDraw.Draw(img).rectangle(g.block, fill=rgb(col))
            report["treatment"].append("block_deepened")

    # the logo goes on before the copy so its own check sees the final background
    _logo(img, g, spec, assets, colours, report)
    d = ImageDraw.Draw(img)
    for b, r in placed:
        if b.role in ("offer", "cta"):
            bg = colours["pill"] if b.role == "offer" else colours["button"]
            fg = colours["text"] if b.role == "offer" else colours["button_text"]
            if ratio(lum(fg), lum(bg)) < NEED.get(b.role, AA_TEXT):
                alt = colours["light"] if lum(fg) < 0.4 else colours["text"]
                fg = alt if ratio(lum(alt), lum(bg)) > ratio(lum(fg), lum(bg)) else fg
                bg = ensure_contrast(bg, lum(fg), NEED.get(b.role, AA_TEXT))
            _pill(d, b, r, bg, fg, rtl, lang)
            report["contrast"][b.role] = round(ratio(lum(fg), lum(bg)), 2)
            continue
        fill = ink
        if b.role == "kicker":
            fill = colours["accent"]
        bgl = worst_lum(img, r, lum(fill))
        need = NEED.get(b.role, AA_TEXT)
        if ratio(lum(fill), bgl) < need:
            fill = ensure_contrast(fill, bgl, need)
        _lines(d, b, r, fill, g, rtl, lang)
        prev = report["contrast"].get(b.role)
        got = round(ratio(lum(fill), bgl), 2)
        report["contrast"][b.role] = min(prev, got) if prev else got

    if cta_block is not None:
        cx = g.m if not rtl else g.w - g.m - cta_block.width
        cy = g.bottom - cta_block.height
        bg, fg = colours["button"], colours["button_text"]
        if ratio(lum(fg), lum(bg)) < AA_LARGE:
            alt = colours["light"] if lum(fg) < 0.4 else colours["text"]
            fg = alt if ratio(lum(alt), lum(bg)) > ratio(lum(fg), lum(bg)) else fg
            bg = ensure_contrast(bg, lum(fg), AA_LARGE)
        _pill(d, cta_block, (cx, cy, cx + cta_block.width, cy + cta_block.height), bg, fg, rtl, lang)
        report["contrast"]["cta"] = round(ratio(lum(fg), lum(bg)), 2)
        placed.append((cta_block, (cx, cy, cx + cta_block.width, cy + cta_block.height)))

    _badge(img, g, spec, faces, colours, lang, report)
    if g.footer is not None:
        ft.draw(img, g.footer, foot, faces, colours, lang, rtl, report)
    report["boxes"] = {b.role: [round(v) for v in r] for b, r in placed}
    report["copy_box"] = [round(v) for v in inner]
    report["ink"] = ink
    return img, report
