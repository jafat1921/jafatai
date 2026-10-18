"""Print type: signage display faces (Bebas Neue, Anton, Oswald, Archivo Black; SIL OFL) next to Ad Studio's
presets. Three roles only: the display face for the name and hero line, a bold for straplines, offers and
buttons, and a text face for the small print."""
import functools
from pathlib import Path

from PIL import ImageFont

from app.ads import fonts as fz
from app.ads.fonts import Face

ROOT = fz.ROOT
OSWALD = "Oswald[wght].ttf"
ROLES = ("display", "bold", "text")


def _v(folder: str, name: str, weight: int | None = None) -> Face:
    return Face(ROOT / folder / name, weight)


MONT = ("montserrat", fz.MONTSERRAT)
INTER = ("inter", fz.INTER)
PRESETS: dict[str, dict] = {
    "bold": {"label": "Bold sans (Archivo Black)", "caps": True, "faces": {
        "display": _v("archivo-black", "ArchivoBlack-Regular.ttf"), "bold": _v(*MONT, 700), "text": _v(*MONT, 500)}},
    "condensed": {"label": "Condensed caps (Bebas Neue)", "caps": True, "faces": {
        "display": _v("bebas-neue", "BebasNeue-Regular.ttf"), "bold": _v("oswald", OSWALD, 600),
        "text": _v("oswald", OSWALD, 400)}},
    "impact": {"label": "Heavy condensed (Anton)", "caps": True, "faces": {
        "display": _v("anton", "Anton-Regular.ttf"), "bold": _v("oswald", OSWALD, 600), "text": _v(*INTER, 500)}},
    "modern": {"label": "Modern (Montserrat)", "caps": False, "faces": {
        "display": _v(*MONT, 800), "bold": _v(*MONT, 700), "text": _v(*MONT, 500)}},
    "friendly": {"label": "Friendly (Poppins)", "caps": False, "faces": {
        "display": Face(ROOT / "poppins" / "Poppins-ExtraBold.ttf"), "bold": Face(ROOT / "poppins" / "Poppins-SemiBold.ttf"),
        "text": Face(ROOT / "poppins" / "Poppins-Medium.ttf")}},
    "elegant": {"label": "Elegant (Playfair + Inter)", "caps": False, "faces": {
        "display": _v("playfair-display", fz.PLAYFAIR, 800), "bold": _v(*INTER, 700), "text": _v(*INTER, 500)}},
}
DEFAULT = "bold"
# heavy enough to carry a board's name from across the street
HEAVY = ("bold", "condensed", "impact", "friendly")
# the name's face on its own, chosen apart from the preset (Latin only)
DISPLAY: dict[str, tuple[str, Face]] = {
    "archivo": ("Archivo Black", _v("archivo-black", "ArchivoBlack-Regular.ttf")),
    "anton": ("Anton", _v("anton", "Anton-Regular.ttf")),
    "bebas": ("Bebas Neue", _v("bebas-neue", "BebasNeue-Regular.ttf")),
    "poppins": ("Poppins ExtraBold", Face(ROOT / "poppins" / "Poppins-ExtraBold.ttf")),
    "montserrat": ("Montserrat ExtraBold", _v(*MONT, 800)),
    "oswald": ("Oswald Bold", _v("oswald", OSWALD, 700)),
    "playfair": ("Playfair Display Black", _v("playfair-display", fz.PLAYFAIR, 900)),
}


def board_preset(preset: str, round_logo: bool, logo_led: bool) -> str:
    """The preset a sign or board gets when nobody picked one by hand: a light face goes up to a heavy display
    one, and a rounded badge logo pulls towards the rounded geometric Poppins ExtraBold that sits with it."""
    if preset == fz.BRAND:
        return preset
    if round_logo and (logo_led or preset not in HEAVY):
        return "friendly"
    return preset if preset in HEAVY else DEFAULT


def display_out() -> list[dict]:
    return [{"id": k, "label": v[0]} for k, v in DISPLAY.items()]


def faces(preset: str, script: str, brand_fonts: list[Path] | None = None) -> tuple[dict[str, Face], bool]:
    """(role -> face, whether the display line is set in capitals) in the copy's script. Arabic-script copy
    takes Ad Studio's Naskh/Nastaliq faces whatever the preset says; a kit's own fonts win when asked for."""
    if script != "latin" or (preset == fz.BRAND and brand_fonts):
        got, _ = fz.faces(preset, script, brand_fonts)
        return {"display": got["headline"], "bold": got["offer"], "text": got["footer"]}, False
    p = PRESETS.get(preset) or PRESETS[DEFAULT]
    return dict(p["faces"]), bool(p["caps"])


def presets_out(has_brand: bool) -> list[dict]:
    out = [{"id": fz.BRAND, "label": "Brand fonts"}] if has_brand else []
    return out + [{"id": k, "label": v["label"]} for k, v in PRESETS.items()]


REF = 200  # the size every measurement is taken at; widths scale linearly from it


def font(face: Face, px: float) -> ImageFont.FreeTypeFont:
    return fz.load(str(face.path), max(6, round(px)), face.weight)


@functools.lru_cache(maxsize=128)
def metrics(path: str, weight: int | None, script: str) -> dict:
    """Shares of the em: cap height (the alef's height for Arabic script), ascent, descent."""
    f = fz.load(path, REF, weight)
    asc, desc = f.getmetrics()
    sample = "H" if script == "latin" else "ا"
    box = f.getbbox(sample, anchor="ls")
    cap = max(1, -box[1]) / REF
    return {"cap": cap, "asc": asc / REF, "desc": desc / REF}


@functools.lru_cache(maxsize=64)
def family_name(path: str) -> tuple[str, str]:
    """(family, style) as the font file names itself, for the SVG's font-family."""
    try:
        return ImageFont.truetype(path, 20).getname()
    except OSError:
        return Path(path).stem, "Regular"
