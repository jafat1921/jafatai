"""The bundled ad fonts (all SIL OFL, licence files next to them) and the pairings the editor offers.

Montserrat, Inter, Playfair Display and the two Noto Arabic-script faces are variable fonts: one file, the
weight set per use. A kit's own uploaded fonts win over the preset (headline from the first, body from the
second when there are two), except for scripts they have no letters for.
"""
import functools
import logging
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app import aerab
from app import brand_render as br

log = logging.getLogger("mixai.ads")

ROOT = Path(__file__).resolve().parent.parent / "assets" / "fonts"


@dataclass(frozen=True)
class Face:
    path: Path
    # the wght axis value for variable files; None for a static file
    weight: int | None = None


def _var(folder: str, name: str, weight: int) -> Face:
    return Face(ROOT / folder / name, weight)


def _poppins(weight: str) -> Face:
    return Face(ROOT / "poppins" / f"Poppins-{weight}.ttf")


MONTSERRAT = "Montserrat[wght].ttf"
INTER = "Inter[opsz,wght].ttf"
PLAYFAIR = "PlayfairDisplay[wght].ttf"
NASKH = "NotoNaskhArabic[wght].ttf"
NASTALIQ = "NotoNastaliqUrdu[wght].ttf"

ROLES = ("headline", "kicker", "body", "offer", "cta", "badge", "footer")

# role -> face. Kickers are set in capitals for the Latin presets
PRESETS: dict[str, dict] = {
    "modern": {"label": "Modern", "caps_kicker": True, "faces": {
        "headline": _var("montserrat", MONTSERRAT, 800), "kicker": _var("montserrat", MONTSERRAT, 700),
        "body": _var("montserrat", MONTSERRAT, 500), "offer": _var("montserrat", MONTSERRAT, 700),
        "cta": _var("montserrat", MONTSERRAT, 700), "badge": _var("montserrat", MONTSERRAT, 800),
        "footer": _var("montserrat", MONTSERRAT, 500)}},
    "clean": {"label": "Clean", "caps_kicker": True, "faces": {
        "headline": _var("inter", INTER, 800), "kicker": _var("inter", INTER, 600),
        "body": _var("inter", INTER, 400), "offer": _var("inter", INTER, 700), "cta": _var("inter", INTER, 700),
        "badge": _var("inter", INTER, 800), "footer": _var("inter", INTER, 500)}},
    "friendly": {"label": "Friendly", "caps_kicker": False, "faces": {
        "headline": _poppins("Bold"), "kicker": _poppins("SemiBold"), "body": _poppins("Regular"),
        "offer": _poppins("SemiBold"), "cta": _poppins("SemiBold"), "badge": _poppins("ExtraBold"),
        "footer": _poppins("Medium")}},
    "elegant": {"label": "Elegant", "caps_kicker": True, "faces": {
        "headline": _var("playfair-display", PLAYFAIR, 700), "kicker": _var("inter", INTER, 600),
        "body": _var("inter", INTER, 400), "offer": _var("inter", INTER, 600), "cta": _var("inter", INTER, 600),
        "badge": _var("playfair-display", PLAYFAIR, 800), "footer": _var("inter", INTER, 500)}},
    "editorial": {"label": "Editorial", "caps_kicker": True, "faces": {
        "headline": Face(ROOT / "dm-serif-display" / "DMSerifDisplay-Regular.ttf"),
        "kicker": _var("inter", INTER, 600), "body": _var("inter", INTER, 400), "offer": _var("inter", INTER, 600),
        "cta": _var("inter", INTER, 600), "badge": Face(ROOT / "dm-serif-display" / "DMSerifDisplay-Regular.ttf"),
        "footer": _var("inter", INTER, 500)}},
}
DEFAULT_PRESET = "modern"
BRAND = "brand"  # the kit's uploaded fonts; only offered when the kit has some


def _script_faces(folder: str, name: str, heavy: int, light: int) -> dict[str, Face]:
    return {r: _var(folder, name, heavy if r in ("headline", "badge", "cta", "offer", "kicker") else light)
            for r in ROLES}


# Urdu reads in Nastaliq; the other Arabic-script languages in Naskh. Weights stop at 700 in both
URDU = _script_faces("noto-nastaliq-urdu", NASTALIQ, 700, 400)
NASKH_FACES = _script_faces("noto-naskh-arabic", NASKH, 700, 500)


def presets_out(has_brand: bool) -> list[dict]:
    out = [{"id": BRAND, "label": "Brand fonts"}] if has_brand else []
    return out + [{"id": k, "label": v["label"]} for k, v in PRESETS.items()]


def script_of(language: str | None, text: str = "") -> str:
    """latin, urdu or arabic: which family of faces the copy needs."""
    lang = aerab.resolve(language, text)
    if lang == "ur":
        return "urdu"
    if lang in aerab.ARABIC_SCRIPT_LANGS:
        return "arabic"
    return "latin"


@functools.lru_cache(maxsize=256)
def load(path: str, size: int, weight: int | None) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(path, max(6, int(size)))
    if weight is not None:
        try:
            axes = f.get_variation_axes()
            vals = []
            for ax in axes:
                name = ax.get("name") or b""
                name = (name.decode("latin-1") if isinstance(name, bytes) else str(name)).lower()
                if "weight" in name:
                    vals.append(max(ax["minimum"], min(ax["maximum"], weight)))
                elif "optical" in name:
                    # Inter's optical size: the display cut for headlines, the text cut below ~20 px
                    vals.append(max(ax["minimum"], min(ax["maximum"], size)))
                else:
                    vals.append(ax["default"])
            f.set_variation_by_axes(vals)
        except (OSError, KeyError, AttributeError):
            pass  # a static file, or FreeType built without variations: the default instance
    return f


@functools.lru_cache(maxsize=32)
def has_letters(path: str, sample: str) -> bool:
    """Whether the font draws `sample` with its own glyphs rather than the missing-glyph box."""
    try:
        f = ImageFont.truetype(path, 48)
    except OSError:
        return False

    def ink(s: str) -> bytes:
        im = Image.new("L", (160, 80), 0)
        ImageDraw.Draw(im).text((8, 8), s, font=f, fill=255)
        return im.tobytes()

    missing = ink("\U0010fffd")
    return all(ink(ch) != missing for ch in sample if not ch.isspace())


SAMPLES = {"latin": "Aaé", "urdu": "بےک", "arabic": "بةك"}


def faces(preset: str, script: str, brand_fonts: list[Path] | None = None) -> tuple[dict[str, Face], bool]:
    """(role -> face, set the kicker in capitals) for a preset in a script."""
    brand_fonts = [p for p in brand_fonts or [] if p and Path(p).is_file()]
    if preset == BRAND and brand_fonts:
        usable = [p for p in brand_fonts if has_letters(str(p), SAMPLES[script])]
        if usable:
            head, body = usable[0], usable[1] if len(usable) > 1 else usable[0]
            loud = ("headline", "kicker", "badge", "cta", "offer")
            return {r: Face(head if r in loud else body) for r in ROLES}, False
    if script == "urdu":
        # Nastaliq is all contextual shaping and has no presentation forms: without raqm it draws boxes
        return dict(URDU if br.HAS_RAQM else NASKH_FACES), False
    if script == "arabic":
        return dict(NASKH_FACES), False
    p = PRESETS.get(preset) or PRESETS[DEFAULT_PRESET]
    return dict(p["faces"]), bool(p["caps_kicker"])


def bundled() -> list[Path]:
    return sorted(ROOT.rglob("*.ttf"))
