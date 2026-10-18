"""Colours that print dull. We don't convert to CMYK (the print shop's RIP does that with its own profile), but a
very saturated screen green or blue lands well outside what offset or a wide-format printer can lay down, and
the owner should know before the board comes back flat.

The check works in CIELAB: each hue has a rough chroma ceiling for coated CMYK (FOGRA39-ish, from the shape of
that gamut, not a measured profile), and a colour above it is flagged. "Print-safe" pulls the chroma down to
the ceiling, keeping lightness and hue.
"""
import math

# (hue in degrees, chroma ceiling) round the wheel; yellow is generous, cyan and blue are tight
_CEILING = ((0, 74), (30, 82), (60, 80), (90, 94), (105, 92), (135, 78), (165, 66), (200, 52), (230, 50),
            (260, 56), (290, 62), (320, 72), (350, 76), (360, 74))
_WHITE = (95.047, 100.0, 108.883)


def _lin(v: float) -> float:
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def _gam(v: float) -> float:
    v = max(0.0, min(1.0, v))
    return 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


def _f(t: float) -> float:
    return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116


def _finv(t: float) -> float:
    return t ** 3 if t ** 3 > 0.008856 else (t - 16 / 116) / 7.787


def to_lab(hex_value: str) -> tuple[float, float, float]:
    h = hex_value.lstrip("#")
    r, g, b = (_lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4))
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) * 100
    y = (0.2126 * r + 0.7152 * g + 0.0722 * b) * 100
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) * 100
    fx, fy, fz = (_f(v / w) for v, w in zip((x, y, z), _WHITE))
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def from_lab(L: float, a: float, b: float) -> str:
    fy = (L + 16) / 116
    x, y, z = (_finv(v) * w for v, w in zip((fy + a / 500, fy, fy - b / 200), _WHITE))
    x, y, z = x / 100, y / 100, z / 100
    r = 3.2406 * x - 1.5372 * y - 0.4986 * z
    g = -0.9689 * x + 1.8758 * y + 0.0415 * z
    bl = 0.0557 * x - 0.2040 * y + 1.0570 * z
    return "#%02X%02X%02X" % tuple(round(_gam(v) * 255) for v in (r, g, bl))


def ceiling(hue: float) -> float:
    hue %= 360
    for (h0, c0), (h1, c1) in zip(_CEILING, _CEILING[1:]):
        if h0 <= hue <= h1:
            return c0 + (c1 - c0) * (hue - h0) / (h1 - h0)
    return 70.0


def check(hex_value: str) -> dict:
    """{chroma, ceiling, out}: whether this colour sits outside what CMYK prints."""
    L, a, b = to_lab(hex_value)
    c = math.hypot(a, b)
    hue = math.degrees(math.atan2(b, a)) % 360
    top = ceiling(hue)
    # very dark colours have little room for chroma; so do very light ones, except yellow, which peaks up there
    if L < 40:
        top *= 0.45 + L / 72
    elif L > 85 and not 70 <= hue <= 115:
        top *= max(0.4, 0.4 + (100 - L) / 25)
    return {"chroma": round(c, 1), "ceiling": round(top, 1), "out": c > top + 4}


def safe(hex_value: str) -> str:
    """The colour pulled inside the ceiling (same lightness and hue); unchanged when it already prints."""
    rep = check(hex_value)
    if not rep["out"]:
        return hex_value.upper()
    L, a, b = to_lab(hex_value)
    s = rep["ceiling"] / max(rep["chroma"], 1e-6)
    return from_lab(L, a * s, b * s)


def report(colours: dict[str, str]) -> list[dict]:
    out = []
    for role, hx in colours.items():
        if not hx:
            continue
        rep = check(hx)
        if rep["out"]:
            out.append({"role": role, "hex": hx.upper(), "safe": safe(hx), "chroma": rep["chroma"],
                        "ceiling": rep["ceiling"]})
    return out
