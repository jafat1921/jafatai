"""Any-size print layout (contract v41).

Ad Studio's engine works in pixels on seven fixed formats. Print needs any shape from a 10 cm sticker to a
106 x 160 cm board, at a working size for the editor and at print size for the files, so this one lays out a
scene in millimetres and leaves pixels to app/print_studio/raster.py and the SVG writer. The same scene gives
the preview, the PDF, the PNG and the editable SVG, so they always agree, and text is set afresh at every size.

Geometry follows the real aspect ratio: a fascia sign (wide) puts the name across with an emblem at the start
and the hours on a band; a board or blade sign (tall) stacks name, picture, lines and a contact band; square-ish
shapes centre; flyers and menus (sheet) get a header, a price list and a footer. Every text row is fitted to
its column; nothing goes under the smallest letters the viewing distance allows, so optional lines (website,
address, offers) give way first and the report says what went.

Text only ever sits on solid colour (ground, band or panel), never straight on a photo, so each contrast is
exact and nudged to WCAG AA. Ad Studio's text measuring, wrapping, shaping and contrast maths are reused.
"""
from dataclasses import dataclass, field, replace

from PIL import Image, ImageDraw

from app.ads import layout as lay
from app.ads.fonts import Face, script_of
from app.print_studio import fonts as pf
from app.print_studio import gamut
from app.print_studio import sizes as sz

LAYOUTS = {
    "wide": ("band", "awning", "photo_side"),
    "tall": ("stack", "hero_top", "photo_middle"),
    "square": ("centre", "photo_circle"),
    "sheet": ("menu", "menu_photo"),
}
PHOTO_LAYOUTS = ("photo_side", "hero_top", "photo_middle", "photo_circle", "menu_photo")
LAYOUT_LABELS = {"band": "Name with emblem and a contact band", "awning": "Awning stripes over the name",
                 "photo_side": "Photo at the side", "stack": "Stacked lines", "hero_top": "Photo on top",
                 "photo_middle": "Name, photo, details", "centre": "Centred", "photo_circle": "Photo in a circle",
                 "menu": "Menu / price list", "menu_photo": "Menu with a photo"}
DESIGN_FAMILIES = ("typographic", "photo", "illustration")
DECOR = ("none", "awning", "frame")
TEXT_KEYS = ("name", "tagline", "headline", "offers", "hours", "phone", "address", "website", "cta")
INFO_KEYS = (("hours", "hours"), ("phone", "phone"), ("address", "location"), ("website", "website"))
# what goes first when space runs out: lower keeps less
KEEP = {"name": 9, "tagline": 7, "headline": 6, "hours": 5, "phone": 4, "offers": 3, "cta": 2, "address": 2,
        "website": 1, "art": 6, "logo": 5}
NEED = lay.AA_TEXT  # print copy is read from afar and at a glance: AA for every line, the big ones too
DEFAULT = {"ground": "#FFFFFF", "ink": "#1B1B1B", "accent": "#2E7D32"}


class PrintLayoutError(ValueError):
    pass


@dataclass
class Assets:
    photo: Image.Image | None = None
    art: Image.Image | None = None  # an illustration, white keyed out (RGBA)
    logo: Image.Image | None = None  # the kit logo, prepared (RGBA)


@dataclass
class El:
    kind: str  # rect | circle | frame | image | text | icon
    layer: str  # background | photo | logo | text
    box: tuple  # mm, trim coordinates: (0, 0) is the trim's top left, the bleed lies outside 0..W, 0..H
    fill: str | None = None
    radius: float = 0.0
    stroke: float = 0.0
    src: str | None = None  # image: photo | art | logo
    shape: str = "rect"  # image mask: rect | rounded | circle | arch
    fit: str = "cover"
    focus: tuple = (0.5, 0.5)
    role: str = ""
    lines: list = field(default_factory=list)
    face: Face | None = None
    em: float = 0.0  # type size in mm
    cap: float = 0.0  # its capital height in mm
    advance: float = 0.0
    baseline: float = 0.0  # the first line's baseline, mm
    align: str = "left"  # left | center | right, of each line inside box
    rtl: bool = False
    icon: str = ""
    on: str = ""  # the colour under a text element, for its contrast


@dataclass
class Scene:
    canvas: sz.Canvas
    els: list
    report: dict
    rtl: bool = False
    lang: str | None = None


# ---------------------------------------------------------------- measuring

class Type:
    """Text measured in em units at one reference size: every width scales linearly from it."""

    def __init__(self, faces: dict, script: str, lang: str | None):
        self.faces, self.script, self.lang = faces, script, lang
        self.d = ImageDraw.Draw(Image.new("L", (4, 4)))
        self._fits: dict = {}

    def m(self, role: str) -> dict:
        f = self.faces[role]
        return pf.metrics(str(f.path), f.weight, self.script)

    def ref(self, role: str):
        return pf.font(self.faces[role], pf.REF)

    def width(self, text: str, role: str) -> float:
        """Width in em (at size 1)."""
        return lay._width(self.d, text, self.ref(role), self.lang) / pf.REF * 1.02

    def advance(self, role: str, em: float) -> float:
        if self.script != "latin":
            mm = self.m(role)
            return em * (mm["asc"] + mm["desc"]) * 0.9
        return em * (1.02 if role == "display" else 1.24)

    def em_of(self, role: str, cap: float) -> float:
        return cap / self.m(role)["cap"]

    def fit(self, text: str, role: str, box_w: float, cap: float, max_lines: int) -> tuple[float, list[str]]:
        """(cap height mm, lines): the largest size up to `cap` at which the text fits the width in at most
        max_lines lines. A word too wide at any sensible size is hyphenated as a last resort."""
        text = (text or "").strip()
        if not text:
            return 0.0, []
        key = (text, role, round(box_w, 2), round(cap, 3), max_lines)
        if key not in self._fits:
            self._fits[key] = self._fit(text, role, box_w, cap, max_lines)
        c, lines = self._fits[key]
        return c, list(lines)

    def _fit(self, text: str, role: str, box_w: float, cap: float, max_lines: int) -> tuple[float, list[str]]:
        c = cap
        one = self.width(text.replace("\n", " "), role)
        if max_lines == 1 or " " not in text.strip():
            c = min(cap, box_w / max(one, 1e-6) * self.m(role)["cap"])
            return c, [" ".join(text.split())]
        while c > 0.3:
            em = self.em_of(role, c)
            lines, ok = lay.wrap(self.d, text, self.ref(role), box_w / em * pf.REF / 1.02, self.lang)
            if ok and len(lines) <= max_lines:
                return c, lines
            c *= 0.95
        em = self.em_of(role, c)
        lines, _ = lay.wrap(self.d, text, self.ref(role), box_w / em * pf.REF / 1.02, self.lang, hard=True)
        return c, lines

    def block(self, role: str, cap: float, n: int) -> float:
        """Height of n lines from the first cap top to the last baseline (plus a descender share off Latin)."""
        em = self.em_of(role, cap)
        h = cap + (n - 1) * self.advance(role, em)
        return h + (em * self.m(role)["desc"] * 0.55 if self.script != "latin" else 0)


# ---------------------------------------------------------------- the copy stack

@dataclass
class Row:
    role: str
    kind: str = "text"  # text | art | info | offers | menu | pill
    text: str = ""
    items: list = field(default_factory=list)
    face: str = "bold"
    cap: float = 0.0
    min_cap: float = 0.0
    lines: int = 2
    keep: int = 5
    gap: float = 0.0  # in units of the row's own cap height
    colour: str = ""
    on: str = ""
    height: float = 0.0  # art
    aspect: float = 1.0
    src: str = ""
    pill: str = ""  # pill fill
    # filled while sizing
    got: float = 0.0
    out_lines: list = field(default_factory=list)
    h: float = 0.0
    parts: list = field(default_factory=list)
    multi: bool = False


class Stack:
    def __init__(self, t: Type, box, align: str = "center", valign: str = "center", report: dict | None = None):
        self.t, self.box, self.align, self.valign = t, box, align, valign
        self.report = report if report is not None else {}

    @property
    def w(self) -> float:
        return self.box[2] - self.box[0]

    def _size(self, r: Row, scale: float) -> bool:
        """Size one row at the scale; False when it can't stay above its minimum."""
        t, w = self.t, self.w
        if r.kind == "art":
            r.h = min(r.height * scale, w / max(r.aspect, 1e-6))
            return r.h >= r.min_cap
        if r.kind == "text":
            r.got, r.out_lines = t.fit(r.text, r.face, w, r.cap * scale, r.lines)
            r.h = t.block(r.face, r.got, len(r.out_lines))
            return r.got >= r.min_cap - 1e-6
        if r.kind == "pill":
            r.got, r.out_lines = t.fit(r.text, r.face, w * 0.8, r.cap * scale, 1)
            r.h = r.got * 2.6
            return r.got >= r.min_cap - 1e-6
        if r.kind == "info":
            return self._size_info(r, scale)
        if r.kind in ("offers", "menu"):
            def label(o: str) -> str:
                return o if r.kind == "offers" else _menu_label(o)

            def room(o: str) -> float:
                # an offer leaves room for its bullet; a menu line for its price on the right
                if r.kind == "offers":
                    return w - r.cap * scale * 1.6
                return w * (0.62 if lay.split_price(o)[1] else 1.0)

            caps = [t.fit(label(o), r.face, room(o), r.cap * scale, 2)[0] for o in r.items]
            r.got = min(caps) if caps else 0.0
            r.parts = [t.fit(label(o), r.face, room(o), r.got, 2)[1] for o in r.items]
            if not r.got:
                r.h = 0
                return True
            adv = t.advance(r.face, t.em_of(r.face, r.got))
            r.h = sum(r.got + (len(ls) - 1) * adv for ls in r.parts) + (len(r.parts) - 1) * r.got * 0.9
            return r.got >= r.min_cap - 1e-6
        return True

    def _size_info(self, r: Row, scale: float) -> bool:
        t, w = self.t, self.w
        items = [it for it in r.items if it[1]]
        if not items:
            r.h = 0
            return True

        def line_w(group) -> float:
            # icon, a small gap, the text; groups on one line are spaced by 1.6 caps
            return sum(1.35 + 0.45 + t.width(x, r.face) / t.m(r.face)["cap"] for _, x, _r in group) + 1.6 * (len(group) - 1)

        one = min(r.cap * scale, w / line_w(items))
        if one >= r.min_cap - 1e-6 or r.lines == 1:
            r.got, r.multi, r.parts = one, False, [[(*it, [it[1]]) for it in items]]
            r.h = one * 1.35
            return one >= r.min_cap - 1e-6
        if len(items) > r.lines:
            return False
        # one item a line, and a long one (the opening hours on a narrow sign) may wrap to a second
        caps = []
        for _, x, _r in items:
            c = r.cap * scale
            for _ in range(40):
                got, _lines = t.fit(x, r.face, w - 1.8 * c, c, 2)
                if got >= c * 0.999:
                    break
                c = got
            caps.append(c)
        c = min(caps)
        r.got, r.multi = c, True
        r.parts = [[(*it, t.fit(it[1], r.face, w - 1.8 * c, c, 2)[1])] for it in items]
        adv = t.advance(r.face, t.em_of(r.face, c))
        r.h = sum(c * 1.35 + (len(g[0][3]) - 1) * adv for g in r.parts) + (len(r.parts) - 1) * c * 0.75
        return c >= r.min_cap - 1e-6

    def run(self, rows: list[Row]) -> tuple[list[El], list[Row]]:
        rows = [r for r in rows if _has(r)]
        h = self.box[3] - self.box[1]
        scale, dropped = 1.0, []
        for _ in range(400):
            fails = [r for r in rows if not self._size(r, scale)]
            gaps = sum(r.gap * max(r.got, r.h * 0.25 if r.kind == "art" else 0) for r in rows[1:])
            total = sum(r.h for r in rows) + gaps
            if not fails and total <= h + 1e-6:
                break
            if fails:
                victim = min(fails, key=lambda r: r.keep)
                if victim.kind == "info" and len([i for i in victim.items if i[1]]) > 1:
                    # one contact item goes before the whole band does
                    worst = min((i for i in victim.items if i[1]), key=lambda i: KEEP.get(i[2], 1))
                    victim.items = [i for i in victim.items if i is not worst]
                    dropped.append(worst[2])
                    continue
                if victim.keep >= 9:
                    # the name never goes; it may sit a little under the distance rule, and the report says so
                    victim.min_cap *= 0.85
                    self.report.setdefault("below_min", []).append(victim.role)
                    continue
                rows.remove(victim)
                dropped.append(victim.role)
                continue
            if scale > 0.3:
                scale *= 0.95
                continue
            victim = min(rows, key=lambda r: r.keep)
            if victim.keep >= 9:
                break
            rows.remove(victim)
            dropped.append(victim.role)
        self.report.setdefault("dropped", []).extend(x for x in dropped if x not in self.report.get("dropped", []))
        return self._place(rows), rows

    def _place(self, rows: list[Row]) -> list[El]:
        x0, y0, x1, y1 = self.box
        gaps = [r.gap * max(r.got, r.h * 0.25 if r.kind == "art" else 0) for r in rows]
        gaps[0:1] = [0.0] * min(1, len(gaps))
        total = sum(r.h for r in rows) + sum(gaps)
        free = max(0.0, (y1 - y0) - total)
        extra = 0.0
        if self.valign == "spread" and len(rows) > 1:
            extra = free / (len(rows) + 1)
            y = y0 + extra
        else:
            y = y0 + {"top": 0, "center": free / 2, "bottom": free}.get(self.valign, free / 2)
        els: list[El] = []
        for r, g in zip(rows, gaps):
            y += g + (extra if r is not rows[0] else 0)
            els += self._row_els(r, y)
            y += r.h
        return els

    def _x(self, width: float) -> tuple[float, float]:
        x0, _, x1, _ = self.box
        if self.align == "left":
            return x0, x0 + width
        if self.align == "right":
            return x1 - width, x1
        return x0 + (x1 - x0 - width) / 2, x0 + (x1 - x0 + width) / 2

    def _row_els(self, r: Row, y: float) -> list[El]:
        t = self.t
        x0, _, x1, _ = self.box
        if r.kind == "art":
            w = r.h * r.aspect
            ax0, ax1 = self._x(w)
            return [El("image", "logo" if r.src == "logo" else "photo", (ax0, y, ax1, y + r.h), src=r.src,
                       fit="contain", role=r.role)]
        if r.kind == "text":
            return [text_el(t, r.role, r.face, r.out_lines, r.got, (x0, y, x1, y + r.h), r.colour, self.align, r.on)]
        if r.kind == "pill":
            em = t.em_of(r.face, r.got)
            tw = t.width(r.out_lines[0], r.face) * em
            pw = tw + r.got * 3.2
            px0, px1 = self._x(pw)
            ink = lay.ensure_contrast(r.colour, lay.lum(r.pill), NEED)
            return [El("rect", "background", (px0, y, px1, y + r.h), fill=r.pill, radius=r.h / 2, role="pill"),
                    text_el(t, r.role, r.face, r.out_lines, r.got, (px0, y + (r.h - r.got) / 2, px1, y + r.h), ink,
                            "center", r.pill)]
        if r.kind == "info":
            return self._info_els(r, y)
        if r.kind in ("offers", "menu"):
            return self._list_els(r, y)
        return []

    def _info_els(self, r: Row, y: float) -> list[El]:
        t = self.t
        c = r.got
        em = t.em_of(r.face, c)
        adv = t.advance(r.face, em)
        isz = c * 1.35
        ink = lay.ensure_contrast(r.colour, lay.lum(r.on), NEED)
        out = []
        ly = y
        for group in r.parts:
            widths = [(1.35 + 0.45) * c + max(t.width(ln, r.face) for ln in lines) * em for *_, lines in group]
            total = sum(widths) + 1.6 * c * (len(group) - 1)
            gx, _ = self._x(total)
            tall = max(len(lines) for *_, lines in group)
            for (icon, _text, role, lines), wd in zip(group, widths):
                out.append(El("icon", "text", (gx, ly, gx + isz, ly + isz), fill=ink, icon=icon, role=role))
                tx = gx + isz + 0.45 * c
                top = ly + (isz - c) / 2
                out.append(text_el(t, role, r.face, lines, c, (tx, top, tx + wd - isz - 0.45 * c,
                                                               top + c + (len(lines) - 1) * adv), ink, "left", r.on))
                gx += wd + 1.6 * c
            ly += isz + (tall - 1) * adv + c * 0.75
        return out

    def _list_els(self, r: Row, y: float) -> list[El]:
        t = self.t
        c = r.got
        em = t.em_of(r.face, c)
        adv = t.advance(r.face, em)
        x0, _, x1, _ = self.box
        out = []
        ink = lay.ensure_contrast(r.colour, lay.lum(r.on), NEED)
        for item, lines in zip(r.items, r.parts):
            h = c + (len(lines) - 1) * adv
            if r.kind == "offers":
                d = c * 0.55
                widest = max(t.width(ln, r.face) * em for ln in lines) + c * 1.6
                lx0, _ = self._x(widest)
                accent = r.pill or ink
                out.append(El("circle", "background", (lx0, y + c / 2 - d / 2, lx0 + d, y + c / 2 + d / 2),
                              fill=accent, role="bullet"))
                out.append(text_el(t, "offers", r.face, lines, c, (lx0 + c * 1.6, y, x1, y + h), ink, "left", r.on))
            else:
                pre, num, post = lay.split_price(item)
                out.append(text_el(t, "offers", r.face, lines, c, (x0, y, x1, y + h), ink, "left", r.on))
                if num:
                    price = " ".join(x for x in (num, post) if x)
                    out.append(text_el(t, "price", r.face, [price], c, (x0, y, x1, y + c), ink, "right", r.on))
                out.append(El("rect", "background", (x0, y + h + c * 0.42, x1, y + h + c * 0.42 + max(0.2, c * 0.04)),
                              fill=lay.hexs(lay.mix(ink, r.on or "#FFFFFF", 0.75)), role="rule"))
            y += h + c * 0.9
        return out


def _menu_label(o: str) -> str:
    pre, num, post = lay.split_price(o)
    return pre if num and pre else o


def _has(r: Row) -> bool:
    if r.kind in ("text", "pill"):
        return bool((r.text or "").strip())
    if r.kind in ("info", "offers", "menu"):
        return any((it[1] if r.kind == "info" else it) for it in r.items)
    return r.kind == "art" and r.height > 0


def text_el(t: Type, role: str, face: str, lines: list[str], cap: float, box, colour: str, align: str,
            on: str) -> El:
    em = t.em_of(face, cap)
    return El("text", "text", tuple(box), fill=colour, role=role, lines=list(lines), face=t.faces[face], em=em,
              cap=cap, advance=t.advance(face, em), baseline=box[1] + cap, align=align, on=on)


# ---------------------------------------------------------------- colour

def valid_hex(v) -> str | None:
    v = (v or "").strip()
    if len(v) == 7 and v.startswith("#"):
        try:
            int(v[1:], 16)
            return v.upper()
        except ValueError:
            return None
    return None


def colours_of(spec: dict) -> dict:
    """ground, ink, accent and the band's ink: the concept's pair (else the kit's roles), print-safe when
    asked, and the ink nudged until it reads on the ground."""
    own = spec.get("colours") or {}
    kit = lay.roles(spec.get("palette")) if spec.get("palette") else {}
    pick = {k: valid_hex(own.get(k)) or ({"ground": kit.get("paper"), "ink": kit.get("text"),
                                          "accent": kit.get("accent")}.get(k) if kit else None) or DEFAULT[k]
            for k in ("ground", "ink", "accent")}
    if spec.get("print_safe"):
        pick = {k: gamut.safe(v) for k, v in pick.items()}
    pick["ink"] = lay.ensure_contrast(pick["ink"], lay.lum(pick["ground"]), NEED)
    band_ink = "#FFFFFF" if lay.ratio(1.0, lay.lum(pick["accent"])) >= lay.ratio(lay.lum(pick["ink"]),
                                                                                    lay.lum(pick["accent"])) \
        else pick["ink"]
    pick["band_ink"] = lay.ensure_contrast(band_ink, lay.lum(pick["accent"]), NEED)
    # the accent as type on the ground (a headline in the brand colour) only when it reads there
    pick["accent_ink"] = pick["accent"] if lay.ratio(lay.lum(pick["accent"]), lay.lum(pick["ground"])) >= NEED \
        else pick["ink"]
    return pick


# ---------------------------------------------------------------- the scene

class Builder:
    def __init__(self, spec: dict, assets: Assets):
        size = spec.get("size") or {}
        self.c = sz.Canvas(float(size.get("width_mm") or 250), float(size.get("height_mm") or 700),
                           float(size.get("bleed_mm") if size.get("bleed_mm") is not None else sz.DEFAULT_BLEED_MM),
                           int(size.get("dpi") or 150))
        self.spec, self.assets = spec, assets
        self.W, self.H, self.B = self.c.width_mm, self.c.height_mm, self.c.bleed_mm
        self.s = min(self.W, self.H)
        self.round = size.get("shape") == "round"
        # the safe area: 5 % of the short side, at least 5 mm in from the trim
        self.m = max(5.0, 0.06 * self.s)
        self.rtl = bool(spec.get("rtl"))
        self.lang = spec.get("language") or None
        t = spec.get("texts") or {}
        self.texts = {k: (t.get(k) or ([] if k == "offers" else "")) for k in TEXT_KEYS}
        self.script = script_of(self.lang, " ".join([self.texts["name"], self.texts["headline"],
                                                     self.texts["tagline"]]))
        faces, caps = pf.faces(spec.get("font_preset") or pf.DEFAULT, self.script, spec.get("brand_fonts") or [])
        self.caps = caps if spec.get("caps") is None else bool(spec.get("caps")) and self.script == "latin"
        self.t = Type(faces, self.script, self.lang)
        self.col = colours_of(spec)
        self.distance = spec.get("distance") or "street"
        self.min_cap = sz.min_cap_mm(self.distance)
        self.hero_cap = sz.hero_cap_mm(self.distance)
        self.report: dict = {"dropped": [], "contrast": {}, "below_min": []}
        self.els: list[El] = []

    # -- pieces
    def full(self, y0: float, y1: float, fill: str, role: str = "ground") -> El:
        B = self.B
        return El("rect", "background", (-B, y0 if y0 > 0 else -B, self.W + B, y1 if y1 < self.H else self.H + B),
                  fill=fill, role=role)

    def caps_of(self, text: str) -> str:
        return text.upper() if self.caps and self.script == "latin" else text

    def emblem(self) -> tuple[str, float] | None:
        """(asset key, width / height) of what goes at the start of the name: the illustration on an
        illustration design, else the kit logo."""
        fam = self.spec.get("design") or "typographic"
        logo_on = (self.spec.get("logo") or {}).get("position") != "none"
        if fam == "illustration" and self.assets.art is not None:
            a = self.assets.art
            return "art", a.width / a.height
        if logo_on and self.assets.logo is not None:
            a = self.assets.logo
            return "logo", a.width / a.height
        return None

    def info_items(self) -> list[tuple]:
        return [(icon, (self.texts[k] or "").strip(), k) for k, icon in INFO_KEYS if (self.texts[k] or "").strip()]

    def name_row(self, cap: float, lines: int, colour: str, on: str) -> Row:
        return Row("name", text=self.caps_of(self.texts["name"]), face="display", cap=cap, min_cap=self.min_cap * 1.6,
                   lines=lines, keep=9, colour=colour, on=on)

    def hero_rows(self, big: float, on: str, lines: int = 3, tag: float = 0.0) -> list[Row]:
        """Name, the owner's tagline under it, then the hero line; or the hero line first when the concept leads
        with it."""
        c = self.col
        headline = self.texts["headline"]
        tag = tag or big * 0.36
        if (self.spec.get("hero") == "headline") and headline:
            return [Row("headline", text=self.caps_of(headline), face="display", cap=big, min_cap=self.min_cap * 1.4,
                        lines=lines, keep=8, colour=c["accent_ink"], on=on),
                    self.name_row(big * 0.5, 2, c["ink"], on), self.tagline_row(tag * 0.8, on)]
        rows = [self.name_row(big, lines, c["ink"], on), self.tagline_row(tag, on)]
        if headline:
            rows.append(Row("headline", text=headline, face="bold", cap=tag * 0.85, min_cap=self.min_cap, lines=2,
                            keep=6, colour=c["accent_ink"], on=on, gap=1.0))
        return rows

    def tagline_row(self, cap: float, on: str, colour: str | None = None) -> Row:
        return Row("tagline", text=self.texts["tagline"], face="bold", cap=cap, min_cap=self.min_cap, lines=2, keep=7,
                   colour=colour or self.col["ink"], on=on, gap=0.7)

    def info_row(self, cap: float, on: str, colour: str, lines: int = 1, gap: float = 0.0) -> Row:
        return Row("info", kind="info", items=self.info_items(), face="text", cap=cap, min_cap=self.min_cap,
                   lines=lines, keep=5, colour=colour, on=on, gap=gap)

    def offers_row(self, cap: float, on: str, kind: str = "offers") -> Row:
        offers = [o for o in self.texts["offers"] or [] if (o or "").strip()][:8]
        return Row("offers", kind=kind, items=offers, face="bold", cap=cap, min_cap=self.min_cap, keep=3,
                   colour=self.col["ink"], on=on, pill=self.col["accent"], gap=1.2)

    def cta_row(self, cap: float) -> Row:
        return Row("cta", kind="pill", text=self.texts["cta"], face="bold", cap=cap, min_cap=self.min_cap, keep=2,
                   colour=self.col["band_ink"], pill=self.col["accent"], gap=1.0)

    def art_row(self, height: float, min_h: float) -> Row | None:
        e = self.emblem()
        if e is None:
            return None
        return Row(e[0], kind="art", src=e[0], height=height, min_cap=min_h, aspect=e[1], keep=KEEP[e[0]], gap=0.12)

    def stack(self, box, rows, align="center", valign="center") -> list[El]:
        # built left to right and mirrored at the end for RTL, so "left" here is the start side
        els, _ = Stack(self.t, box, align, valign, self.report).run([r for r in rows if r is not None])
        return els

    def band(self, cap: float, lines: int) -> tuple[float, Row | None]:
        """The contact band along the bottom: (its height, the info row) or (0, None) when there's nothing."""
        items = self.info_items()
        if not items:
            return 0.0, None
        row = self.info_row(cap, self.col["accent"], self.col["band_ink"], lines)
        st = Stack(self.t, (self.m, 0, self.W - self.m, self.H), report=self.report)
        _, kept = st.run([row])
        if not kept:
            return 0.0, None
        return row.h + 2 * max(row.got * 1.1, self.m * 0.6), row

    def put_band(self, h: float, row: Row) -> float:
        y0 = self.H - h
        self.els.append(self.full(y0, self.H, self.col["accent"], "band"))
        pad = (h - row.h) / 2
        self.els += Stack(self.t, (self.m, y0 + pad, self.W - self.m, self.H - pad), "center", "center",
                          self.report)._place([row])
        return y0

    def decor(self, kind: str, top: float = 0.0) -> float:
        """Draw the decoration; returns how much of the top it took."""
        c = self.col
        if kind == "awning":
            h = max(self.s * 0.13, 12.0) if self.W >= self.H else max(self.W * 0.16, 12.0)
            n = max(4, round(self.W / (h * 0.9)))
            sw = (self.W + 2 * self.B) / n
            light = lay.hexs(lay.mix(c["ground"], "#FFFFFF", 0.6)) if lay.lum(c["ground"]) < 0.8 else "#FFFFFF"
            if lay.ratio(lay.lum(light), lay.lum(c["accent"])) < 1.6:
                light = c["ground"]
            body = h * 0.72
            for i in range(n):
                x = -self.B + i * sw
                fill = c["accent"] if i % 2 == 0 else light
                self.els.append(El("rect", "background", (x, -self.B, x + sw + 0.01, body), fill=fill, role="awning"))
                # the scalloped hem
                r = sw / 2
                self.els.append(El("circle", "background", (x, body - r, x + sw, body + r), fill=fill, role="awning"))
            return body + sw / 2
        if kind == "frame":
            inset = self.m * 0.45
            self.els.append(El("frame", "background", (inset, inset, self.W - inset, self.H - inset),
                               fill=c["accent"], stroke=max(0.6, self.s * 0.012), role="frame",
                               radius=self.s * 0.02))
            return 0.0
        return 0.0

    def photo(self, box, shape: str = "rect", radius: float = 0.0) -> None:
        f = self.spec.get("focus") or {}
        self.els.append(El("image", "photo", tuple(box), src="photo", shape=shape, radius=radius,
                           focus=(float(f.get("x", 0.5)), float(f.get("y", 0.5))), role="photo"))

    # -- layouts
    def wide_band(self, awning: bool = False) -> None:
        W, H, m, c = self.W, self.H, self.m, self.col
        self.els.append(self.full(0, H, c["ground"]))
        top = self.decor("awning") if awning else self.decor(self.spec.get("decor") or "none")
        band_h, row = (0.0, None) if awning else self.band(max(self.min_cap, H * 0.075), 1)
        if row is not None:
            self.put_band(band_h, row)
        y0, y1 = max(m, top + m * 0.5), H - band_h - m * (0.7 if band_h else 1)
        em = self.emblem() if not awning else None
        x0 = m
        if em is not None:
            eh = (y1 - y0)
            ew = min(eh * em[1], W * 0.3)
            eh = ew / em[1]
            ey = y0 + (y1 - y0 - eh) / 2
            self.els.append(El("image", "logo" if em[0] == "logo" else "photo", (m, ey, m + ew, ey + eh), src=em[0],
                               fit="contain", role=em[0]))
            x0 = m + ew + m
        col_h = y1 - y0
        rows = self.hero_rows(col_h * 0.42, c["ground"], lines=2 if em is None else 1, tag=col_h * 0.15)
        if awning:
            rows.append(self.info_row(max(self.min_cap, col_h * 0.09), c["ground"], c["ink"], 1, gap=1.4))
        self.els += self.stack((x0, y0, W - m, y1), rows, "left" if em is not None else "center")

    def wide_photo_side(self) -> None:
        W, H, m, c = self.W, self.H, self.m, self.col
        split = W * 0.6
        self.els.append(self.full(0, H, c["ground"]))
        self.photo((split, -self.B, W + self.B, H + self.B))
        self.els.append(El("rect", "background", (split - self.s * 0.04, -self.B, split, H + self.B),
                           fill=c["accent"], role="rule"))
        col_h = H - 2 * m
        rows = [self.art_row(col_h * 0.16, col_h * 0.07)]
        rows += self.hero_rows(col_h * 0.36, c["ground"], lines=2, tag=col_h * 0.13)
        rows.append(self.info_row(max(self.min_cap, col_h * 0.08), c["ground"], c["ink"], 2, gap=1.4))
        self.els += self.stack((m, m, split - self.s * 0.04 - m, H - m), rows, "left")

    def tall_stack(self) -> None:
        W, H, m, c = self.W, self.H, self.m, self.col
        self.els.append(self.full(0, H, c["ground"]))
        top = self.decor(self.spec.get("decor") or "none")
        band_h, row = self.band(max(self.min_cap, W * 0.05), 4)
        if row is not None:
            self.put_band(band_h, row)
        y0, y1 = max(m, top + m * 0.6), H - band_h - m * 0.8
        col_h = y1 - y0
        rows = self.hero_rows(min(W * 0.2, col_h * 0.2), c["ground"], lines=3, tag=W * 0.075)
        rows.insert(2, self.art_row(col_h * 0.3, col_h * 0.1))
        rows.append(self.offers_row(W * 0.045, c["ground"]))
        rows.append(self.cta_row(W * 0.045))
        self.els += self.stack((m, y0, W - m, y1), rows, "center", "spread")

    def tall_hero_top(self) -> None:
        W, H, m, c = self.W, self.H, self.m, self.col
        ph = H * (0.44 if W / H > 0.5 else 0.36)
        self.els.append(self.full(0, H, c["ground"]))
        self.photo((-self.B, -self.B, W + self.B, ph))
        self.els.append(El("rect", "background", (-self.B, ph, W + self.B, ph + max(1.0, self.s * 0.015)),
                           fill=c["accent"], role="rule"))
        band_h, row = self.band(max(self.min_cap, W * 0.035), 3)
        if row is not None:
            self.put_band(band_h, row)
        y0, y1 = ph + m * 0.9, H - band_h - m * 0.7
        col_h = y1 - y0
        rows = [self.art_row(col_h * 0.12, col_h * 0.05)]
        rows += self.hero_rows(min(W * 0.15, col_h * 0.22), c["ground"], lines=2, tag=W * 0.06)
        rows.append(self.offers_row(W * 0.04, c["ground"]))
        rows.append(self.cta_row(W * 0.04))
        self.els += self.stack((m, y0, W - m, y1), rows, "center", "spread")

    def tall_photo_middle(self) -> None:
        W, H, m, c = self.W, self.H, self.m, self.col
        self.els.append(self.full(0, H, c["ground"]))
        band_h, row = self.band(max(self.min_cap, W * 0.035), 3)
        if row is not None:
            self.put_band(band_h, row)
        top_h = H * 0.24
        p0, p1 = top_h, H * 0.62
        rows = [self.name_row(min(W * 0.17, top_h * 0.5), 2, c["ink"], c["ground"]),
                self.tagline_row(W * 0.055, c["ground"])]
        self.els += self.stack((m, m, W - m, top_h - m * 0.5), rows, "center", "center")
        self.photo((m * 0.6, p0, W - m * 0.6, p1), shape="rounded", radius=self.s * 0.03)
        low = [Row("headline", text=self.texts["headline"], face="bold", cap=W * 0.06, min_cap=self.min_cap, lines=2,
                   keep=6, colour=c["accent_ink"], on=c["ground"]),
               self.offers_row(W * 0.04, c["ground"]), self.cta_row(W * 0.04)]
        low_h = H - band_h - m * 0.7 - (p1 + m * 0.8)
        low.append(self.art_row(low_h * 0.2, low_h * 0.08))
        self.els += self.stack((m, p1 + m * 0.8, W - m, H - band_h - m * 0.7), low, "center", "spread")

    def square_centre(self, with_photo: bool = False) -> None:
        W, H, m, c = self.W, self.H, self.m, self.col
        if self.round:
            self.els.append(self.full(0, H, c["ground"]))
            ring = max(0.6, self.s * 0.012)
            self.els.append(El("frame", "background", (m * 0.5, m * 0.5, W - m * 0.5, H - m * 0.5), fill=c["accent"],
                               stroke=ring, radius=(W - m) / 2, role="ring"))
            # the copy keeps inside the square inscribed in the circle
            inset = W * (1 - 0.7071) / 2 + m * 0.4
            box = (inset, inset, W - inset, H - inset)
        else:
            self.els.append(self.full(0, H, c["ground"]))
            self.decor(self.spec.get("decor") or "frame")
            box = (m * 1.2, m * 1.2, W - m * 1.2, H - m * 1.2)
        bh = box[3] - box[1]
        rows: list = []
        if with_photo:
            d = min(box[2] - box[0], bh) * 0.46
            cx = (box[0] + box[2]) / 2
            self.photo((cx - d / 2, box[1], cx + d / 2, box[1] + d), shape="circle")
            box = (box[0], box[1] + d + m * 0.5, box[2], box[3])
            bh = box[3] - box[1]
        else:
            rows.append(self.art_row(bh * 0.3, bh * 0.1))
        rows += self.hero_rows(bh * 0.2, c["ground"], lines=2, tag=bh * 0.08)
        if with_photo:
            rows.append(self.art_row(bh * 0.12, bh * 0.05))
        rows.append(self.info_row(max(self.min_cap, bh * 0.045), c["ground"], c["ink"], 3, gap=1.3))
        self.els += self.stack(box, rows, "center", "center")

    def sheet_menu(self, with_photo: bool = False) -> None:
        W, H, m, c = self.W, self.H, self.m, self.col
        self.els.append(self.full(0, H, c["ground"]))
        head_h = H * 0.17
        self.els.append(self.full(0, head_h, c["accent"], "header"))
        em = self.emblem()
        hx0 = m
        if em is not None:
            eh = head_h - 1.6 * m
            ew = min(eh * em[1], W * 0.25)
            eh = ew / em[1]
            self.els.append(El("image", "logo" if em[0] == "logo" else "photo",
                               (m, (head_h - eh) / 2, m + ew, (head_h + eh) / 2), src=em[0], fit="contain",
                               role=em[0]))
            hx0 = m + ew + m * 0.6
        name = Row("name", text=self.caps_of(self.texts["name"]), face="display", cap=head_h * 0.36,
                   min_cap=self.min_cap * 1.6, lines=1, keep=9, colour=c["band_ink"], on=c["accent"])
        tag = Row("tagline", text=self.texts["tagline"], face="bold", cap=head_h * 0.13, min_cap=self.min_cap,
                  lines=1, keep=7, colour=c["band_ink"], on=c["accent"], gap=0.7)
        self.els += self.stack((hx0, m * 0.7, W - m, head_h - m * 0.7), [name, tag],
                               "left" if hx0 > m else "center")
        y = head_h
        if with_photo:
            ph = H * 0.26
            self.photo((-self.B, head_h, W + self.B, head_h + ph))
            y = head_h + ph
        band_h, row = self.band(max(self.min_cap, W * 0.025), 2)
        if row is not None:
            self.put_band(band_h, row)
        rows = [Row("headline", text=self.texts["headline"], face="display" if not self.caps else "bold",
                    cap=W * 0.05, min_cap=self.min_cap * 1.2, lines=2, keep=6, colour=c["accent_ink"],
                    on=c["ground"]),
                self.offers_row(W * 0.045, c["ground"], kind="menu"),
                self.cta_row(W * 0.035)]
        self.els += self.stack((m, y + m * 0.8, W - m, H - band_h - m * 0.7), rows, "center", "center")

    def build(self) -> Scene:
        fam = sz.family(self.spec.get("job") or "sign", self.W, self.H)
        if self.round:
            fam = "square"
        layout = self.spec.get("layout")
        if layout not in LAYOUTS[fam]:
            layout = LAYOUTS[fam][0]
        if layout in PHOTO_LAYOUTS and self.assets.photo is None:
            # no picture yet (or a typographic concept moved to another shape): the plain layout of the family
            self.report["fallback"] = {"asked": layout, "used": LAYOUTS[fam][0]}
            layout = LAYOUTS[fam][0]
        {"band": self.wide_band, "awning": lambda: self.wide_band(awning=True), "photo_side": self.wide_photo_side,
         "stack": self.tall_stack, "hero_top": self.tall_hero_top, "photo_middle": self.tall_photo_middle,
         "centre": self.square_centre, "photo_circle": lambda: self.square_centre(with_photo=True),
         "menu": self.sheet_menu, "menu_photo": lambda: self.sheet_menu(with_photo=True)}[layout]()
        if self.rtl:
            self.els = [mirror(e, self.W) for e in self.els]
        for e in self.els:
            if e.kind == "text":
                e.rtl = self.rtl
        self.finish(fam, layout)
        return Scene(self.c, self.els, self.report, self.rtl, self.lang)

    def finish(self, fam: str, layout: str) -> None:
        texts = [e for e in self.els if e.kind == "text"]
        contrast: dict[str, float] = {}
        for e in texts:
            r = round(lay.ratio(lay.lum(e.fill), lay.lum(e.on or self.col["ground"])), 2)
            contrast[e.role] = min(contrast.get(e.role, r), r)
        smallest = min(texts, key=lambda e: e.cap, default=None)
        W, H, B = self.W, self.H, self.B
        fw, fh = W + 2 * B, H + 2 * B
        self.report.update(
            family=fam, layout=layout, contrast=contrast,
            all_pass=all(v >= NEED - 0.005 for v in contrast.values()),
            min_text={"cap_mm": round(smallest.cap, 1) if smallest else None,
                      "cap_cm": round(smallest.cap / 10, 2) if smallest else None,
                      "role": smallest.role if smallest else None, "need_mm": self.min_cap,
                      "distance": self.distance,
                      "pass": bool(smallest is None or smallest.cap >= self.min_cap - 0.05)},
            colours={k: self.col[k] for k in ("ground", "ink", "accent", "band_ink")},
            gamut=gamut.report({k: self.col[k] for k in ("ground", "ink", "accent")}),
            fonts={e.role: round(e.cap, 1) for e in texts},
            boxes={"trim": [B / fw, B / fh, (B + W) / fw, (B + H) / fh],
                   "safe": [(B + self.m) / fw, (B + self.m) / fh, (B + W - self.m) / fw, (B + H - self.m) / fh]},
            canvas={"width_mm": W, "height_mm": H, "bleed_mm": B, "dpi": self.c.dpi,
                    "px": list(self.c.size_px), "mp": round(self.c.megapixels, 1), "label": self.c.label()},
            shape="round" if self.round else "rect",
            used={"photo": any(e.src == "photo" for e in self.els), "art": any(e.src == "art" for e in self.els),
                  "logo": any(e.src == "logo" for e in self.els)})
        self.report["below_min"] = sorted(set(self.report.get("below_min") or []))
        self.report["dropped"] = list(dict.fromkeys(self.report.get("dropped") or []))


def mirror(e: El, W: float) -> El:
    x0, y0, x1, y1 = e.box
    align = {"left": "right", "right": "left"}.get(e.align, e.align)
    return replace(e, box=(W - x1, y0, W - x0, y1), align=align)


def build(spec: dict, assets: Assets | None = None) -> Scene:
    return Builder(spec, assets or Assets()).build()
