"""The M16b layouts, modelled on the owner's own Canva adverts.

cutout_blob   the subject cut out, standing on an organic accent blob with confetti dots, on a light ground
arch_mask     the photo in an arch (or circle / teardrop / blob) with a small detail circle, headline on top
circle_mask   the same in a circle
big_price     full-bleed photo, white haze, huge headline and an accent band with the number at about 3x
editorial     oversized type on a calm ground and a small rounded photo
before_after  two halves labelled in the ad's language; the before picture is an edit of the photo
quote         a testimonial the user wrote, in large type on a deep block, the photo above

geometry() fills in the Geo for each; paint() draws the grounds, masks, blobs and halves. The copy, the logo,
the badge and the footer are the shared engine in layout.py.
"""
from PIL import Image, ImageDraw, ImageOps

from app.ads import layout as lay
from app.ads import shapes

STYLES = ("cutout_blob", "arch_mask", "circle_mask", "big_price", "editorial", "before_after", "quote")
# the ones painted here rather than by the shared full-bleed photo path
PAINTED = ("cutout_blob", "arch_mask", "circle_mask", "editorial", "before_after")

BEFORE_AFTER = {"en": ("Before", "After"), "sv": ("Före", "Efter"), "nb": ("Før", "Etter"), "no": ("Før", "Etter"),
                "da": ("Før", "Efter"), "de": ("Vorher", "Nachher"), "fi": ("Ennen", "Jälkeen"),
                "nl": ("Voor", "Na"), "fr": ("Avant", "Après"), "es": ("Antes", "Después"), "it": ("Prima", "Dopo"),
                "pt": ("Antes", "Depois"), "pl": ("Przed", "Po"), "tr": ("Önce", "Sonra"), "hi": ("पहले", "बाद में"),
                # Arabic-script labels carry their full marks, like every line the app writes
                "ur": ("پَہلے", "بَعد"), "ar": ("قَبْل", "بَعْد"), "fa": ("قَبل", "بَعد")}


def labels(lang: str | None) -> tuple[str, str]:
    return BEFORE_AFTER.get((lang or "").lower().split("-")[0], BEFORE_AFTER["en"])


def _instead(style: str, why: str, used: str) -> tuple[str, str]:
    return used, f"{lay.STYLE_LABELS[style]} needs {why}; {lay.STYLE_LABELS[used]} is used instead."


def honour(style: str, spec: dict, assets) -> tuple[str, str | None]:
    """(the layout that can really be drawn, a sentence on why another one was used)."""
    t = spec.get("texts") or {}
    if style == "badge" and not (t.get("badge_big") or "").strip():
        return _instead(style, "a number for the badge", "frosted")
    if style == "big_price" and not any(lay.split_price(o)[1] for o in t.get("offers") or [] if o):
        return _instead(style, "an offer with a number", "side_wash")
    if style == "quote" and not (t.get("quote") or "").strip():
        return _instead(style, "a quote of yours", "editorial")
    if style == "before_after" and assets.before is None:
        return _instead(style, "a before picture", "split")
    return style, None


# ---------------------------------------------------------------- geometry

def _square_in(box, kind: str):
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    if kind in ("circle", "blob"):
        d = min(bw, bh)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        return (cx - d / 2, cy - d / 2, cx + d / 2, cy + d / 2)
    # an arch or teardrop reads as one when it is taller than wide
    nw = min(bw, bh * 0.86)
    cx = (x0 + x1) / 2
    return (cx - nw / 2, y0, cx + nw / 2, y1)


def geometry(g, style: str, fam: str, *, cy0: int, cy1: int, gap: int, sb: int, card: int, mask: str | None,
             logo=None):
    w, h, s, m = g.w, g.h, g.s, g.m
    wide, tall = fam == "16:9", fam == "9:16"
    ftop = g.footer[1] if g.footer and not card else h - sb
    if style == "cutout_blob":
        g.ground, g.tone, g.head_scale = "light", "light", 1.08
        if wide:
            g.copy = [m, cy0, round(w * 0.47), cy1]
            g.valign = "center"
            cx, cy, rx, ry = 0.74 * w, g.top + 0.56 * (g.bottom - g.top), 0.19 * w, 0.37 * h
            g.cutout = (round(0.5 * w), g.top, round(0.98 * w), g.bottom)
        elif tall:
            # a story: the subject fills the lower frame and carries on behind the footer card to the edge
            g.copy = [m, cy0, round(0.56 * w), cy0 + round((cy1 - cy0) * 0.5)]
            cx, cy, rx = 0.66 * w, cy0 + 0.6 * (cy1 - cy0), 0.36 * w
            ry = rx * 1.1
            g.cutout = (round(0.34 * w), cy0 + round((cy1 - cy0) * 0.12), w, h)
        else:
            g.copy = [m, cy0, round(w * 0.56), cy1]
            g.valign = "center"
            rx = (0.25 if fam == "1:1" else 0.27) * w
            cx, cy, ry = 0.73 * w, g.top + 0.6 * (g.bottom - g.top), rx * 1.04
            g.cutout = (round(0.47 * w), cy0, round(0.995 * w), g.bottom)
        g.blob = (round(cx - rx), round(cy - ry), round(cx + rx), round(cy + ry))
        r = round(0.085 * s)
        lim = w - r - round(m * 0.4)
        g.badge_spots = [(round(min(lim, x)), round(y), r) for x, y in (
            (cx - rx * 0.78, cy - ry * 0.72), (cx + rx * 0.8, cy - ry * 0.8), (cx - rx * 0.92, cy + ry * 0.45),
            (cx + rx * 0.85, cy + ry * 0.35), (cx, cy - ry * 0.95))]
        g.badge = g.badge_spots[0]
    elif style in ("arch_mask", "circle_mask"):
        kind = mask or ("circle" if style == "circle_mask" else "arch")
        g.ground, g.tone, g.footer_light = "paper", "light", True
        g.head_scale, g.comfort = 1.25, 0.9
        if wide:
            g.copy = [m, cy0, round(w * 0.48), cy1]
            g.valign = "center"
            box = (round(0.54 * w), g.top, w - m, g.bottom)
        else:
            side = lay.g8(m * 1.2)
            # the copy gets a good third of the frame and is set big (the owner's sample); the photo shape takes
            # the lower end side, down to the footer, and gives way to the logo on the plain ground beside it
            g.copy = [side, cy0, w - side, cy0 + round(h * (0.31 if tall else 0.5 if fam == "1:1" else 0.4))]
            g.align = "center"
            x0 = (0.36 if tall else 0.47) * w
            if logo is not None and logo[1] > h / 2 and logo[0] < w / 2:
                x0 = max(x0, logo[2] + gap)
            # a story's shape stops above the card, so the card never sits on the subject
            low = g.bottom + (m // 2 if tall else m)
            box = (round(x0), g.copy[3] + gap // 2, round(w - m * 0.6), low)
        box = _square_in(box, kind)
        g.shape = (kind, tuple(round(v) for v in box))
        bx0, by0, bx1, by1 = g.shape[1]
        r = round(0.115 * s)
        if not wide and r * 2 < (by1 - by0) * 0.6:
            cx, cy = round(bx0 + 0.02 * w), round(by0 + 0.62 * (by1 - by0))
            if logo is not None and cy + r + gap // 2 > logo[1] and cx - r < logo[2]:
                cy = logo[1] - gap // 2 - r  # the logo has that corner; the circle moves up out of its way
            if cy - r >= by0:
                g.detail = (cx, cy, r)
        br = round(0.098 * s)
        g.badge_spots = [(round(min(w - br - m * 0.4, bx1 - br * 0.25)), round(by0 + 0.2 * (by1 - by0)), br),
                         (round(bx0 + br * 0.3), round(by0 + br * 0.55), br)]
        g.badge = g.badge_spots[0]
    elif style == "big_price":
        g.head_scale, g.price, g.tone, g.footer_light = 1.32, True, "light", True
        if tall:
            g.veil = ("top", 0.72, 0.95)
            g.copy = [m, cy0, w - m, cy0 + round((cy1 - cy0) * 0.66)]
        elif wide:
            g.veil = ("side", 0.62, 0.92)
            g.copy = [m, cy0, round(w * 0.5), cy1]
            g.valign = "center"
        else:
            g.veil = ("side", 0.84 if fam == "1:1" else 0.82, 0.95)
            g.copy = [m, cy0, round(w * (0.68 if fam == "1:1" else 0.66)), cy1]
            g.valign = "upper"
    elif style == "editorial":
        g.ground, g.tone, g.head_scale, g.rule = "paper", "light", 1.7, True
        if wide:
            g.copy = [m, cy0, round(w * 0.56), cy1]
            g.valign = "center"
            g.inset = (round(w * 0.61), g.top, w - m, g.bottom)
        else:
            pw, ph = {"9:16": (0.5, 0.27), "1:1": (0.44, 0.36)}.get(fam, (0.46, 0.3))
            pw, ph = round(pw * w), round(ph * h)
            # in a story the photo carries on behind the footer card
            g.inset = (w - m - pw, g.bottom - ph, w - m, h if tall else g.bottom)
            g.copy = [m, cy0, w - m, g.bottom - ph - gap]
            g.cta, g.cta_w = "beside", w - 2 * m - pw - gap
    elif style == "before_after":
        g.tone = "dark"
        if wide:
            area = (round(w * 0.4), 0, w, ftop)
            g.block = (0, 0, area[0], ftop)
            g.copy = [m, cy0, area[0] - m, cy1]
            g.valign = "center"
        else:
            ph = round(h * {"9:16": 0.56, "1:1": 0.5}.get(fam, 0.54))
            area = (0, 0, w, ph)
            g.block = (0, ph, w, g.footer[1] if g.footer and not card else h)
            g.copy = [m, ph + m, w - m, (g.footer[1] if g.footer else h - sb) - m]
        mid = (area[0] + area[2]) // 2
        g.halves = ((area[0], area[1], mid, area[3]), (mid, area[1], area[2], area[3]))
        g.photo = area
    elif style == "quote":
        g.quote, g.block_role, g.tone = True, "primary", "dark"
        if wide:
            g.photo = (round(w * 0.5), 0, w, ftop)
            g.block = (0, 0, round(w * 0.5), ftop)
            g.copy = [m, cy0, round(w * 0.5) - m, cy1]
            g.valign = "center"
        else:
            ph = round(h * {"9:16": 0.4, "1:1": 0.4}.get(fam, 0.42))
            g.photo = (0, 0, w, ph)
            g.block = (0, ph, w, g.footer[1] if g.footer and not card else h)
            g.copy = [lay.g8(m * 1.2), ph + lay.g8(m * 1.2), w - lay.g8(m * 1.2), (g.footer[1] if g.footer else h - sb) - m]
            g.align, g.valign = "center", "center"


# ---------------------------------------------------------------- painting

def _photo_or_placeholder(assets, size, focus, colours) -> Image.Image:
    w, h = size
    if assets.photo is None:
        return lay._placeholder(w, h, colours)
    return lay.cover(assets.photo.convert("RGB"), w, h, focus[0], focus[1])


def _rounded(size, radius: int) -> Image.Image:
    w, h = size
    big = Image.new("L", (w * shapes.SS, h * shapes.SS), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, w * shapes.SS - 1, h * shapes.SS - 1), radius=radius * shapes.SS,
                                          fill=255)
    return big.resize(size, Image.LANCZOS)


def _cutout(base: Image.Image, g, assets, report) -> tuple | None:
    """The subject from the mask, standing in g.cutout: feet on the blob, or on the footer when the photo cut
    them off. Returns the box it landed in."""
    photo, mask = assets.photo.convert("RGB"), assets.mask.convert("L")
    if mask.size != photo.size:
        mask = mask.resize(photo.size, Image.BILINEAR)
    bbox = mask.point(lambda v: 255 if v > 40 else 0).getbbox()
    if not bbox:
        return None
    pad = round(max(photo.size) * 0.01)
    bbox = (max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(photo.width, bbox[2] + pad), min(photo.height, bbox[3] + pad))
    sub = photo.crop(bbox)
    sub.putalpha(mask.crop(bbox))
    x0, y0, x1, y1 = g.cutout
    sc = min((x1 - x0) / sub.width, (y1 - y0) / sub.height)
    sub = sub.resize((max(1, round(sub.width * sc)), max(1, round(sub.height * sc))), Image.LANCZOS)
    bx0, by0, bx1, by1 = g.blob
    cx = (bx0 + bx1) / 2
    left = round(min(max(x0, cx - sub.width / 2), x1 - sub.width))
    cut_off = bbox[3] >= photo.height * 0.97
    # a figure cut off by the photo's edge stands on the bottom; a whole one stands on the blob
    feet = y1 if cut_off else min(y1, round(by0 + (by1 - by0) * 0.9))
    top = max(y0, feet - sub.height)
    base.paste(sub, (left, top), sub)
    report["treatment"].append("cutout")
    return (left, top, left + sub.width, top + sub.height)


def paint(g, style: str, spec: dict, assets, colours: dict, place: dict, faces, lang, rtl, report) -> Image.Image:
    w, h = g.w, g.h
    focus = place["focus"]
    shape = spec.get("shape") or {}
    seed = int(shape.get("seed") or 0)
    base = Image.new("RGB", (w, h), lay.rgb(colours[g.ground or "paper"]))
    if assets.photo is None:
        report["treatment"].append("no_photo")

    if style == "cutout_blob":
        col = lay.rgb(colours["shape"])
        layer = shapes.blob_layer((w, h), g.blob, col, seed)
        base.paste(Image.new("RGB", (w, h), col), (0, 0), layer.getchannel("A"))
        report["shape"] = {"kind": "blob", "seed": seed, "colour": colours["shape"], "box": list(g.blob)}
        landed = None
        if assets.photo is not None and assets.mask is not None:
            landed = _cutout(base, g, assets, report)
        if landed is None and assets.photo is not None:
            # no cut-out yet: the photo fills a slightly smaller blob, a rim of the colour round it
            bx0, by0, bx1, by1 = g.blob
            k = 0.05
            inner = (round(bx0 + (bx1 - bx0) * k), round(by0 + (by1 - by0) * k), round(bx1 - (bx1 - bx0) * k),
                     round(by1 - (by1 - by0) * k))
            crop = lay.cover(assets.photo.convert("RGB"), inner[2] - inner[0], inner[3] - inner[1], *focus)
            shapes.paste_masked(base, crop, inner, "blob", seed)
            report["fallback"] = report.get("fallback") or "The cut-out isn't ready yet, so the photo fills the shape."
            landed = inner
        if landed:
            report["cutout_box"] = [round(v) for v in landed]
        avoid = [g.copy] + ([g.logo] if g.logo else []) + ([g.footer] if g.footer else []) + \
            ([report["cutout_box"]] if landed and assets.mask is not None else [])
        spots = shapes.dots(seed, g.blob, 7, 0.007 * g.s, 0.017 * g.s, avoid)
        shapes.draw_dots(base, spots, col)
    elif style in ("arch_mask", "circle_mask"):
        kind, box = g.shape
        x0, y0, x1, y1 = box
        crop = _photo_or_placeholder(assets, (x1 - x0, y1 - y0), focus, colours)
        shapes.paste_masked(base, crop, box, kind, seed)
        report["shape"] = {"kind": kind, "seed": seed, "box": list(box)}
        if g.detail and assets.photo is not None:
            _detail(base, g, assets, place, colours)
    elif style == "editorial":
        x0, y0, x1, y1 = g.inset
        crop = _photo_or_placeholder(assets, (x1 - x0, y1 - y0), focus, colours)
        base.paste(crop, (x0, y0), _rounded(crop.size, round(0.035 * g.s)))
    elif style == "before_after":
        ImageDraw.Draw(base).rectangle(g.block, fill=lay.rgb(colours["block"]))
        (a, b) = g.halves
        # the before picture goes first in reading order
        first, second = (b, a) if rtl else (a, b)
        for pic, box in ((assets.before, first), (assets.photo, second)):
            if pic is None:
                continue
            base.paste(lay.cover(pic.convert("RGB"), box[2] - box[0], box[3] - box[1], *focus), box[:2])
        _divider(base, g, colours)
        _labels(base, g, faces, colours, lang, rtl, report, first, second)
    return base


# TODO: the detail circle could show a second candidate photo instead of a closer crop of the same one
def _detail(base, g, assets, place, colours) -> None:
    """The small circle: a closer crop around the face (or the subject), ringed in white."""
    cx, cy, r = g.detail
    photo = assets.photo.convert("RGB")
    pw, ph = photo.size
    from app.ads import placement

    subj = placement.subject_of({"subject": {}}, assets) if assets.mask is not None else None
    face = (subj or {}).get("face") or (subj or {}).get("box")
    u, v = ((face[0] + face[2]) / 2, (face[1] + face[3]) / 2) if face else (0.5, 0.42)
    side = round(min(pw, ph) * 0.36)
    left = int(min(max(0, u * pw - side / 2), pw - side))
    top = int(min(max(0, v * ph - side / 2), ph - side))
    crop = photo.crop((left, top, left + side, top + side)).resize((2 * r, 2 * r), Image.LANCZOS)
    shapes.paste_masked(base, crop, (cx - r, cy - r, cx + r, cy + r), "circle")
    shapes.circle_ring(base, cx, cy, r, max(3, round(0.009 * g.s)), lay.rgb(colours["light"]))


def _divider(base, g, colours) -> None:
    a, b = g.halves
    x = a[2] if a[2] == b[0] else b[2]
    d = ImageDraw.Draw(base)
    lw = max(4, round(0.006 * g.s))
    d.rectangle((x - lw // 2, a[1], x + lw // 2, a[3]), fill=lay.WHITE)
    r = round(0.034 * g.s)
    cy = (a[1] + a[3]) // 2
    disc = shapes.mask("circle", (2 * r, 2 * r))
    base.paste(Image.new("RGB", (2 * r, 2 * r), lay.WHITE), (x - r, cy - r), disc)
    ink = lay.rgb(colours["text"])
    t = r * 0.42
    d.polygon([(x - r * 0.18, cy - t), (x - r * 0.18 - t, cy), (x - r * 0.18, cy + t)], fill=ink)
    d.polygon([(x + r * 0.18, cy - t), (x + r * 0.18 + t, cy), (x + r * 0.18, cy + t)], fill=ink)


def _labels(base, g, faces, colours, lang, rtl, report, before_box, after_box) -> None:
    from app.ads import fonts as fz

    d = ImageDraw.Draw(base)
    face = faces["kicker"]
    size = max(18, round(0.03 * g.s))
    f = fz.load(str(face.path), size, face.weight)
    fg = colours["text"]
    for text, box in zip(labels(lang), (before_box, after_box)):
        tw = lay._width(d, text, f, lang)
        px, py = round(size * 0.8), round(size * 0.42)
        asc, desc = f.getmetrics()
        bw, bh = tw + 2 * px, asc + desc + 2 * py
        x = box[2] - g.m * 0.5 - bw if rtl else box[0] + g.m * 0.5
        y = box[3] - g.m * 0.5 - bh
        d.rounded_rectangle((x, y, x + bw, y + bh), radius=bh // 2, fill=lay.WHITE)
        lay._draw(d, (x + px, y + py), text, f, lay.rgb(fg), lang)
    report["contrast"]["label"] = round(lay.ratio(lay.lum(fg), 1.0), 2)
    report["labels"] = list(labels(lang))


def wave_block(base: Image.Image, g, colour) -> None:
    """The refined split's colour block with a soft curved edge where it meets the photo."""
    from PIL import ImageChops

    vertical, at, depth = g.wave
    if vertical:
        m = shapes.wave_edge((g.w, g.h), True, g.w - at if g.mirror else at, depth, seed=3)
        m = ImageOps.mirror(m) if g.mirror else m
    else:
        m = ImageOps.invert(shapes.wave_edge((g.w, g.h), False, at, depth, seed=3))
    # only within the block's own span (a story's block stops at the card), plus the curve's reach
    x0, y0, x1, y1 = g.block
    e = depth + 2
    if vertical:
        x0, x1 = (x0 - e, x1) if g.mirror else (x0, x1 + e)
    else:
        y0 -= e
    clip = Image.new("L", (g.w, g.h), 0)
    ImageDraw.Draw(clip).rectangle((x0, y0, x1, y1), fill=255)
    base.paste(Image.new("RGB", (g.w, g.h), colour), (0, 0), ImageChops.multiply(m, clip))
