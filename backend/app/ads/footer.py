"""The advert footer (contract v36 addendum): contact details and social handles that always fit their format.

Digital first: the website or booking link and the handles lead, phone and WhatsApp share one "Ring/WhatsApp"
line, the address only shows when it was picked. Each format gets its own shape: a story puts a "Follow us"
line and the handle row on top in a bigger size, 4:5 and 2:3 may wrap to two rows, square stays compact and
the wide formats keep one bar.

Fitting never overflows. In turn it shrinks the type to the floor, wraps to more rows where the format
allows, folds differing handles into one icon row with the first handle, then drops the least important item,
and as a last resort cuts the one label left with an ellipsis. plan() only measures, so the layout can size
the copy box around the footer before anything is drawn.
"""
from dataclasses import dataclass, field

from PIL import Image, ImageDraw

from app import brand_render as br
from app.ads import fonts as fz
from app.ads import icons

# what a phone line starts with, per ad language; languages without one get the icons only
CALL = {"en": "Call", "sv": "Ring", "nb": "Ring", "no": "Ring", "da": "Ring", "de": "Anrufen", "fi": "Soita",
        "nl": "Bel", "fr": "Appelez", "es": "Llama", "it": "Chiama", "pt": "Ligue", "pl": "Zadzwoń",
        "tr": "Ara"}
FOLLOW = {"en": "Follow us", "sv": "Följ oss", "nb": "Følg oss", "no": "Følg oss", "da": "Følg os",
          "de": "Folge uns", "fi": "Seuraa meitä", "nl": "Volg ons", "fr": "Suivez-nous", "es": "Síguenos",
          "it": "Seguici", "pt": "Siga-nos", "pl": "Obserwuj nas", "tr": "Bizi takip edin",
          # Arabic-script lines carry their full marks (aerab), like every other line the app writes
          "ur": "ہَمیں فالو کَریں", "ar": "تابِعونا", "fa": "ما را دُنبال کُنید"}

CONTACT_KEYS = ("website", "booking_url", "phone", "whatsapp", "email", "opening_hours", "location")
DEFAULT_CONTACT = ("website", "booking_url", "phone", "whatsapp")
ICON = {"website": "website", "booking_url": "booking", "email": "email", "opening_hours": "hours",
        "location": "location"}
# lower ranks are kept longest
RANK = {"website": 0, "booking_url": 1, "social": 2, "follow": 3, "phone": 4, "whatsapp": 5, "email": 6,
        "opening_hours": 7, "location": 8}
MAX_ROWS = {"9:16": 3, "4:5": 2, "2:3": 2, "1:1": 1, "16:9": 1, "1.91:1": 1, "yt": 1}
SIZE = {"1:1": 0.95, "9:16": 1.0}
# formats whose footer is a rounded floating card rather than an edge-to-edge bar
CARD = ("9:16",)


def card_inset(fmt: str, s: int) -> int:
    return round(0.045 * s) if fmt in CARD else 0


@dataclass
class Item:
    key: str
    icons: list[str]
    label: str
    rank: float
    row: str = "contact"  # contact | social | follow


@dataclass
class Plan:
    rows: list[list[Item]] = field(default_factory=list)
    size: int = 0
    scale: dict = field(default_factory=dict)  # row kind -> size multiplier
    height: int = 0
    dropped: list[str] = field(default_factory=list)
    folded: bool = False


def call_word(lang: str | None) -> str:
    return CALL.get((lang or "").lower().split("-")[0], "")


def follow_text(lang: str | None) -> str:
    return FOLLOW.get((lang or "").lower().split("-")[0], FOLLOW["en"])


def short_url(v: str) -> str:
    v = " ".join((v or "").split())
    for pre in ("https://", "http://"):
        if v.lower().startswith(pre):
            v = v[len(pre):]
    return v.rstrip("/")


def _digits(v: str) -> str:
    d = "".join(ch for ch in v or "" if ch.isdigit())
    return d[2:] if d.startswith("00") else d


def same_number(a: str, b: str) -> bool:
    da, db = _digits(a), _digits(b)
    if not da or not db:
        return False
    # +46 72 846 73 94 and 072-846 73 94 are one number
    return da == db or da[-9:] == db[-9:]


def _bare(handle: str) -> str:
    return (handle or "").lstrip("@+").lower()


def items(spec: dict) -> list[Item]:
    """Every footer item the spec asks for, in reading order."""
    contact = {k: " ".join(str(v).split()) for k, v in (spec.get("contact") or {}).items() if v and str(v).strip()}
    socials = [s for s in spec.get("socials") or [] if (s.get("handle") or "").strip()]
    follow = spec.get("follow") or {}
    lang = spec.get("language")
    rtl = bool(spec.get("rtl"))
    out: list[Item] = []
    for k in ("website", "booking_url"):
        if contact.get(k):
            out.append(Item(k, [ICON[k]], short_url(contact[k]), RANK[k]))
    if socials:
        if follow.get("show"):
            out.append(Item("follow", [], (follow.get("text") or "").strip() or follow_text(lang), RANK["follow"],
                            "follow"))
        handles = {_bare(s["handle"]) for s in socials}
        if len(handles) == 1:
            out.append(Item("social", [s["platform"] for s in socials], socials[0]["handle"], RANK["social"], "social"))
        else:
            for i, s in enumerate(socials):
                out.append(Item(f"social:{i}", [s["platform"]], s["handle"], RANK["social"] + i * 0.01, "social"))
    phone, wa = contact.get("phone", ""), contact.get("whatsapp", "")
    word = "" if rtl else call_word(lang)
    if phone and wa and same_number(phone, wa):
        out.append(Item("phone", ["phone", "whatsapp"], f"{word}/WhatsApp {phone}" if word else phone, RANK["phone"]))
    else:
        if phone:
            out.append(Item("phone", ["phone"], f"{word} {phone}" if word else phone, RANK["phone"]))
        if wa:
            out.append(Item("whatsapp", ["whatsapp"], wa if rtl else f"WhatsApp {wa}", RANK["whatsapp"]))
    for k in ("email", "opening_hours", "location"):
        if contact.get(k):
            out.append(Item(k, [ICON[k]], contact[k], RANK[k]))
    return out


# ---------------------------------------------------------------- measuring

_MEASURE = ImageDraw.Draw(Image.new("L", (1, 1)))


def font_for(label: str, px: int, faces: dict, bold: bool = False):
    # a phone number or web address in an Urdu ad still wants a Latin face
    if br.is_rtl(label):
        face = faces["footer"]
    else:
        face = fz.PRESETS[fz.DEFAULT_PRESET]["faces"]["kicker" if bold else "footer"]
    return fz.load(str(face.path), px, face.weight)


def _parts(size: int) -> tuple[int, int, int, int]:
    """(icon px, gap between icons, gap before the label, space between items)"""
    return round(size * 1.15), round(size * 0.35), round(size * 0.55), round(size * 1.6)


def item_width(it: Item, size: int, faces: dict, lang) -> float:
    from app.ads import layout as lay

    icon_px, igap, lgap, _ = _parts(size)
    w = len(it.icons) * icon_px + max(0, len(it.icons) - 1) * igap
    if it.label:
        w += (lgap if it.icons else 0) + lay._width(_MEASURE, it.label, font_for(it.label, size, faces,
                                                                                    it.row == "follow"), lang)
    return w


def row_width(row: list[Item], size: int, faces: dict, lang) -> float:
    return sum(item_width(it, size, faces, lang) for it in row) + _parts(size)[3] * max(0, len(row) - 1)


def _arrangements(its: list[Item], max_rows: int, story: bool) -> list[list[list[Item]]]:
    """The row layouts to try, best first."""
    contact = [i for i in its if i.row == "contact"]
    social = [i for i in its if i.row == "social"]
    follow = [i for i in its if i.row == "follow"]
    handles = follow + social
    half = (len(contact) + 1) // 2
    out: list[list[list[Item]]] = []
    if story:
        # the handles lead on a story, with the "Follow us" line on its own above them when there's room
        if follow and max_rows >= 3:
            out.append([follow, social, contact])
        out.append([handles, contact])
        if len(contact) > 1 and max_rows >= 3:
            out.append([handles, contact[:half], contact[half:]])
    else:
        out.append([its])
        if max_rows >= 2 and contact and handles:
            out.append([contact, handles])
        if max_rows >= 2 and len(contact) > 1:
            out.append([contact[:half], contact[half:] + handles])
    rows = [[r for r in a if r] for a in out]
    return [a for a in rows if a] or [[its]]


def _fold(its: list[Item]) -> list[Item] | None:
    socials = [i for i in its if i.key.startswith("social:")]
    if len(socials) < 2:
        return None
    merged = Item("social", [p for s in socials for p in s.icons], socials[0].label, RANK["social"], "social")
    first = its.index(socials[0])
    rest = [i for i in its if not i.key.startswith("social:")]
    rest.insert(min(first, len(rest)), merged)
    return rest


def plan(spec: dict, fmt: str, w: int, s: int, faces: dict) -> Plan:
    """How the footer will look in this format, or an empty Plan when it shows nothing."""
    if not spec.get("footer", True):
        return Plan()
    its = items(spec)
    if not its:
        return Plan()
    lang = spec.get("language") or None
    story = fmt == "9:16"
    max_rows = MAX_ROWS.get(fmt, 1)
    floor = max(16, round(0.0204 * s))
    top = max(floor, round(0.025 * s * 1.08 * SIZE.get(fmt, 1.0)))
    avail = w - 2 * (round(0.065 * s * 0.7) + card_inset(fmt, s))
    p = Plan()
    scale = {"social": 1.25, "follow": 1.1} if story else {}

    def fits(rows, size):
        return all(row_width(r, round(size * scale.get(r[0].row, 1.0)), faces, lang) <= avail for r in rows)

    while its:
        for rows in _arrangements(its, max_rows, story):
            for size in range(top, floor - 1, -1):
                if fits(rows, size):
                    return _done(p, rows, size, scale, s)
        folded = _fold(its)
        if folded is not None:
            its, p.folded = folded, True
            continue
        if len(its) == 1:
            break
        victim = max(its, key=lambda i: i.rank)
        its = [i for i in its if i is not victim]
        p.dropped.append(victim.key)
    # one item left that is wider than the frame at the smallest size: cut its label to fit
    it = its[0]
    while it.label and item_width(it, floor, faces, lang) > avail:
        it.label = it.label[:-2].rstrip(" .,/") + "…" if len(it.label) > 2 else ""
    return _done(p, [[it]], floor, scale, s)


def _done(p: Plan, rows: list[list[Item]], size: int, scale: dict, s: int) -> Plan:
    p.rows, p.size, p.scale = rows, size, scale
    hs = [round(size * scale.get(r[0].row, 1.0) * (1.9 if r[0].row == "follow" else 2.25)) for r in rows]
    p.height = max(round(0.089 * s), sum(hs) + round(size * 0.9))
    return p


# ---------------------------------------------------------------- drawing

def draw(img: Image.Image, box: tuple[int, int, int, int], p: Plan, faces: dict, colours: dict, lang, rtl: bool,
         report: dict) -> None:
    from app.ads import layout as lay

    d = ImageDraw.Draw(img)
    bg = colours["footer"]
    card = box[0] > 0
    if card:
        # lifted a shade off the footer colour the photo fades into, so the card reads as its own object
        lifted = lay.hexs(lay.mix(bg, (255, 255, 255), 0.09 if lay.lum(bg) < 0.2 else 0.0))
        if lay.ratio(lay.lum(colours["footer_text"]), lay.lum(lifted)) >= lay.AA_TEXT:
            bg = lifted
        d.rounded_rectangle(box, radius=round((box[3] - box[1]) * 0.18), fill=lay.rgb(bg))
    else:
        d.rectangle(box, fill=lay.rgb(bg))
    if not p.rows:
        return
    fg = lay.ensure_contrast(colours["footer_text"], lay.lum(bg), lay.AA_TEXT)
    ic = colours["accent"] if lay.ratio(lay.lum(colours["accent"]), lay.lum(bg)) >= lay.AA_LARGE else fg
    x0, y0, x1, y1 = box
    hs = [round(p.size * p.scale.get(r[0].row, 1.0) * (1.9 if r[0].row == "follow" else 2.25)) for r in p.rows]
    y = y0 + (y1 - y0 - sum(hs)) / 2
    for row, rh in zip(p.rows, hs):
        size = round(p.size * p.scale.get(row[0].row, 1.0))
        icon_px, igap, lgap, spacing = _parts(size)
        total = row_width(row, size, faces, lang)
        x = x0 + (x1 - x0 - total) / 2
        cy = y + rh / 2
        for it in (reversed(row) if rtl else row):
            f = font_for(it.label, size, faces, it.row == "follow") if it.label else None
            # the follow line takes the accent when it reads well enough, like the icons do
            ink = ic if it.row == "follow" and ic != fg and lay.ratio(lay.lum(ic), lay.lum(bg)) >= lay.AA_TEXT else fg
            for kind in it.icons:
                im = icons.icon(kind, icon_px, lay.rgb(ic))
                img.paste(im, (round(x), round(cy - icon_px / 2)), im)
                x += icon_px + igap
            if it.icons:
                x += (lgap if it.label else 0) - igap
            if it.label:
                asc, desc = f.getmetrics()
                lay._draw(d, (x, cy - (asc + desc) / 2), it.label, f, lay.rgb(ink), lang)
                x += lay._width(d, it.label, f, lang)
            x += spacing
        y += rh
    report["contrast"]["footer"] = round(lay.ratio(lay.lum(fg), lay.lum(bg)), 2)
    report["footer"] = {"rows": len(p.rows), "items": [i.key for r in p.rows for i in r], "dropped": p.dropped,
                        "folded": p.folded, "size": p.size, "box": [round(v) for v in box], "card": card}
    if p.dropped:
        report["footer_dropped"] = len(p.dropped)
