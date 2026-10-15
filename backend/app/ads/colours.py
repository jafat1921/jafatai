"""Brand colours as words, and image prompts kept free of anything an image model would print.

Diffusion models read "#26243F #FF8484" as text to paint, and the first real campaign did exactly that. So
the photo prompts never carry a hex value, a handle, a web address or the brand's name: the palette goes in
as plain colour names ("deep navy", "soft coral") and scrub() cleans whatever the LLM wrote on top.
"""
import colorsys
import re

# hue bands in degrees: (upper bound, plain name, dark name, light name)
_HUES = [
    (12, "red", "burgundy", "coral"),
    (36, "orange", "rust brown", "peach"),
    (55, "amber", "ochre", "sand"),
    (70, "yellow", "olive", "butter yellow"),
    (95, "lime green", "olive green", "pale lime"),
    (160, "green", "forest green", "sage green"),
    (190, "teal", "dark teal", "mint"),
    (205, "sky blue", "petrol blue", "powder blue"),
    (250, "blue", "navy", "light blue"),
    (265, "violet", "indigo", "lavender"),
    (320, "purple", "plum", "lilac"),
    (345, "pink", "berry", "blush pink"),
    (361, "red", "burgundy", "coral"),
]

HEX = re.compile(r"#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|(?<![\w#])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6}\b", re.I)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL = re.compile(r"(?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|se|net|org|io|co|uk|de|no|dk|fi|"
                  r"nl|fr|es|it|pk|in|ae|sa|app|shop|store|online|eu|nu|me)\b(?:/\S*)?", re.I)
_HANDLE = re.compile(r"(?<!\w)@[\w.]*\w")
_PHONE = re.compile(r"\+?\d[\d \-()]{6,}\d")


def _rgb(h: str) -> tuple[int, int, int] | None:
    h = (h or "").strip().lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", h):
        return None
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def colour_name(hex_value: str) -> str:
    """A plain name a photographer would use: "#26243F" -> "deep navy", "#FF8484" -> "soft coral"."""
    c = _rgb(hex_value)
    if c is None:
        return ""
    r, g, b = (v / 255 for v in c)
    hue, light, sat = colorsys.rgb_to_hls(r, g, b)
    chroma = max(r, g, b) - min(r, g, b)
    if chroma < 0.08 or sat < 0.1:
        warm = r - b > 0.03
        if light < 0.12:
            return "black"
        if light < 0.3:
            return "charcoal"
        if light < 0.6:
            return "warm grey" if warm else "grey"
        if light < 0.88:
            return "warm stone" if warm else "light grey"
        return "cream white" if warm else "white"
    deg = hue * 360
    if sat < 0.35 and 12 <= deg < 55:
        # low-saturation oranges are the browns and taupes of wood, leather and linen
        return "dark brown" if light < 0.3 else ("brown" if light < 0.42 else "warm taupe")
    plain, dark, pale = next((p, d, li) for top, p, d, li in _HUES if deg < top)
    if light < 0.3:
        return f"deep {dark.removeprefix('dark ')}"
    if light < 0.42:
        name = dark
    elif light > 0.68:
        return f"soft {pale}"
    elif light > 0.58:
        name = pale
    else:
        name = plain
    return f"muted {name}" if sat < 0.35 else name


def palette_words(palette: list[dict] | None) -> list[str]:
    """One plain name per palette colour, duplicates folded."""
    out = []
    for p in palette or []:
        name = colour_name(p.get("hex") or "")
        if name and name not in out:
            out.append(name)
    return out


def palette_phrase(palette: list[dict] | None) -> str:
    """The palette for the copywriter: the kit's own colour names where it has them, plain names always."""
    out = []
    for p in palette or []:
        plain = colour_name(p.get("hex") or "")
        own = (p.get("name") or "").strip()
        if own and plain and own.lower() != plain:
            out.append(f"{own} ({plain})")
        elif own or plain:
            out.append(own or plain)
    return ", ".join(out)


def _named(m: re.Match) -> str:
    return colour_name(m.group(0)) or ""


def scrub(text: str, tokens: list[str] | None = None) -> str:
    """The prompt without hex values (named instead), emails, links, handles, phone numbers or any of the
    brand's own words in `tokens` (its name, handles, site)."""
    out = HEX.sub(_named, text or "")
    out = _EMAIL.sub(" ", out)
    out = _HANDLE.sub(" ", out)
    out = _URL.sub(" ", out)
    out = _PHONE.sub(" ", out)
    for t in sorted({t.strip() for t in tokens or [] if t and len(t.strip()) > 1}, key=len, reverse=True):
        # "iXperts' van" and "the iXperts logo" both lose the name, not the noun after it. Case matters, so a
        # brand called "Clean" doesn't take the word out of "a clean floor"
        out = re.sub(rf"(?<!\w){re.escape(t)}(?:'s|’s|')?(?!\w)", " ", out)
    out = re.sub(r"\(\s*[,;]?\s*\)", " ", out)
    out = re.sub(r"\s+([,.;:])", r"\1", re.sub(r"[ \t]{2,}", " ", out))
    out = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", out)
    return " ".join(out.split()).strip(" ,;")


def leaks(text: str, tokens: list[str] | None = None) -> list[str]:
    """What scrub() would take out; the guard tests use it, the photo stage logs it."""
    found = [m.group(0) for p in (HEX, _EMAIL, _URL, _HANDLE, _PHONE) for m in p.finditer(text or "")]
    for t in tokens or []:
        if t and len(t.strip()) > 1 and re.search(rf"(?<!\w){re.escape(t.strip())}(?!\w)", text or ""):
            found.append(t.strip())
    return found
