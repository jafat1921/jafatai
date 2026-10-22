"""Exact English lettering on an Ideogram 4 picture.

The open weights draw one big headline well and garble small lines (the five-line birth announcement on
22 Oct came back with "Sadat", dropped names and made-up Arabic). For those pieces Ideogram draws the art with
blank banners and plaques (app.ideogram_caption.blank_out), and the words are set here in a real font.
Latin script only for now; Urdu and Arabic still go through the model.
"""
import logging
import re
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

from app.ads import fonts as fz
from app.ads.layout import ensure_contrast, lum, mean_lum, veil, worst_lum
from app.brand_render import text_width

log = logging.getLogger("mixai.ideogram")

INK, IVORY, GOLD = "#2B2118", "#FBF3E4", "#D4AF37"
# (pattern on the line's look words, font file, wght or None)
FACES = (
    (r"calligraph|elegant script|formal script|copperplate|wedding", fz.ROOT / "great-vibes" / "GreatVibes-Regular.ttf",
     None),
    (r"script|hand[- ]?(drawn|written|lettered)|brush|playful|cursive",
     fz.ROOT / "dancing-script" / "DancingScript[wght].ttf", 600),
    (r"serif|elegant|classic|engraved|neoclassical|luxur", fz.ROOT / "playfair-display" / "PlayfairDisplay[wght].ttf",
     700),
    (r"condensed|poster|impact|bold sans|stencil|sport", fz.ROOT / "oswald" / "Oswald[wght].ttf", 600),
)
DEFAULT_FACE = (fz.ROOT / "montserrat" / fz.MONTSERRAT, 700)
SERIF = (fz.ROOT / "playfair-display" / "PlayfairDisplay[wght].ttf", 600)
LINE_GAP = 1.18
SCRIPTS = ("great-vibes", "dancing-script")


def face_for(hint: str) -> tuple[Path, int | None]:
    for pattern, path, weight in FACES:
        if re.search(pattern, hint or "", re.I):
            return path, weight
    return DEFAULT_FACE


def ink_for(img: Image.Image, box, hint: str) -> str:
    bg = mean_lum(img, box)
    if re.search(r"\bgold", hint or "", re.I) and bg < 0.3:
        want = GOLD
    else:
        want = INK if bg > 0.3 else IVORY
    return ensure_contrast(want, worst_lum(img, box, lum(want)), 4.5)


def _wrap(d, text: str, font, max_w: float, sep: str = " ") -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        words, cur, out = para.split(), "", []
        for word in words:
            cand = f"{cur}{sep}{word}" if cur else word
            if cur and text_width(d, cand, font) > max_w:
                out.append(cur)
                cur = word
            else:
                cur = cand
        out.append(cur)
        if len(out) == 2:
            # balance the two lines: "Alhamdulillah A Grandson Is / Born" left one word hanging
            out = min(([sep.join(words[:i]), sep.join(words[i:])] for i in range(1, len(words))),
                      key=lambda pair: max(text_width(d, x, font) for x in pair))
        lines.extend(out)
    return [ln for ln in lines if ln]


def fit(d, text: str, path: Path, weight: int | None, w: float, h: float, cap: int | None = None):
    """The biggest size (up to `cap`) where every line fits the box's width and the stack its height."""
    size = int(h / max(1, text.count("\n") + 1) / LINE_GAP)
    if cap:
        size = min(size, cap)
    while True:
        font = fz.load(str(path), size, weight)
        # script faces set their words almost touching
        lines = _wrap(d, text, font, w, "  " if path.parent.name in SCRIPTS else " ")
        tall = len(lines) * size * LINE_GAP
        if (tall <= h and all(text_width(d, ln, font) <= w for ln in lines) and len(lines) <= 3) or size <= 10:
            return font, lines, size
        size = max(10, int(size * 0.92))


def set_text(path: Path, layout: list[dict]) -> dict:
    """Draw each {text, bbox [y1, x1, y2, x2] on 0-1000, hint} into the picture at `path`, in place. The
    picture without the words is kept beside it (<stem>_art.png) for a later re-edit."""
    path = Path(path)
    art = path.with_name(f"{path.stem}_art{path.suffix}")
    shutil.copyfile(path, art)
    with Image.open(path) as im:
        img = im.convert("RGB")
    W, H = img.size
    band = next((ln["band"] for ln in layout if ln.get("band") is not None), None)
    if band is not None:
        # the quiet band under the art, deepened (or lifted) so the block of lines reads on it
        dark = mean_lum(img, (0, band * H / 1000, W, H)) < 0.45
        img = veil(img, "bottom", min(1.0, (1000 - band) / 1000 * 1.5), 0.72,
                   (0, 0, 0) if dark else (255, 255, 255))
    words = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(words)
    placed, lead = [], None
    for i, line in enumerate(layout):
        y1, x1, y2, x2 = line["bbox"]
        box = (x1 * W / 1000, y1 * H / 1000, x2 * W / 1000, y2 * H / 1000)
        # stay inside the blank surface the model drew around this spot
        pad_x, pad_y = (box[2] - box[0]) * 0.08, (box[3] - box[1]) * 0.14
        inner = (box[0] + pad_x, box[1] + pad_y, box[2] - pad_x, box[3] - pad_y)
        fpath, weight = face_for(line.get("hint", ""))
        cap = None
        if band is not None and i:
            # a block under the art: the opening line leads, the rest support it in a serif ("Proud
            # Grandparents" came out as big as the headline, in plain sans after a script)
            cap = int(lead * 0.6)
            if fpath == DEFAULT_FACE[0] or fpath.parent.name in SCRIPTS:
                fpath, weight = SERIF
        font, lines, size = fit(d, line["text"], fpath, weight, inner[2] - inner[0], inner[3] - inner[1], cap)
        lead = lead or size
        colour = ink_for(img, inner, line.get("hint", ""))
        lh = size * LINE_GAP
        y = (inner[1] + inner[3]) / 2 - len(lines) * lh / 2
        for ln in lines:
            x = (inner[0] + inner[2]) / 2 - text_width(d, ln, font) / 2
            d.text((x, y), ln, font=font, fill=colour)
            y += lh
        placed.append({"text": line["text"], "font": fpath.stem, "size": size, "colour": colour})
    # a soft shadow on the side away from the ink, so light words read on busy art
    alpha = words.split()[3]
    shade = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dark = sum(lum(p["colour"]) for p in placed) / max(1, len(placed)) > 0.35
    shade.paste((0, 0, 0, 120) if dark else (255, 255, 255, 90), mask=alpha.filter(ImageFilter.GaussianBlur(3)))
    out = Image.alpha_composite(Image.alpha_composite(img.convert("RGBA"), shade), words).convert("RGB")
    out.save(path)
    log.info("exact text set: %s", [p["text"] for p in placed])
    return {"lines": placed, "art": art.name}

