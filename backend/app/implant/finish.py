"""After the edit: only the chest is taken from the result. The rest of the picture is the patient's own photo,
pixel for pixel, so the face, arms, waist and background can't drift; then the vision model checks the
clothing wasn't touched."""
import logging
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from pydantic import BaseModel, Field

from app.config import get_settings
from app.llm import LLMError, chat_sync
from app.vision import image_b64

log = logging.getLogger("mixai.implant")

# [y1, x1, y2, x2] on 0-1000, when the vision model can't say: neck-to-hip clinical framing
DEFAULT_BOX = {"front": [0, 100, 620, 900], "left_oblique": [0, 80, 620, 920], "right_oblique": [0, 80, 620, 920],
               "left_lateral": [0, 150, 620, 950], "right_lateral": [0, 50, 620, 850],
               # her own photo may be anything from a bust shot to full length
               "own": [80, 100, 650, 900]}


class Box(BaseModel):
    box: list[int] = Field(min_length=4, max_length=4)


class Garment(BaseModel):
    uncovered: bool
    why: str = ""


def clean_box(b) -> list[int] | None:
    try:
        y1, x1, y2, x2 = (max(0, min(1000, int(v))) for v in b)
    except (TypeError, ValueError):
        return None
    # too thin to be a chest, or upside down
    if y2 - y1 < 120 or x2 - x1 < 200:
        return None
    return [y1, x1, y2, x2]


def find_chest(photo: Path, view: str, tick=None) -> tuple[list[int], str]:
    """(box, source): the vision model's box around both breasts and whatever covers them, else the default."""
    msgs = [{"role": "system", "content": "You locate regions in clinical photographs. Answer only with JSON."},
            {"role": "user", "images": [image_b64(photo)],
             "content": "Give the bounding box that contains both breasts, the clothing over them (bra, top, kameez, "
                        "dress, dupatta), and a "
                        "little margin, as [y1, x1, y2, x2] on a 0-1000 scale (y down). Reply as JSON "
                        '{"box": [y1, x1, y2, x2]}.'}]
    try:
        res = chat_sync("vision", msgs, schema=Box, temperature=0.0, max_tokens=80,
                        timeout=get_settings().vision_timeout_s, tick=tick)
        box = clean_box(res.data.box)
        if box:
            return box, "vision"
    except LLMError as e:
        log.info("chest box from the vision model failed, using the default: %s", e)
    return list(DEFAULT_BOX.get(view, DEFAULT_BOX["front"])), "default"


def _grey(im: Image.Image, size: tuple[int, int]) -> np.ndarray:
    return np.asarray(im.convert("L").resize(size), dtype=np.float32)


def align(before: Image.Image, after: Image.Image, box: list[int]) -> Image.Image:
    """The edit model re-frames slightly (about 1% on the first live sample). Find the scale and shift that best
    match the two pictures outside the chest box and put the result on the photo's own grid."""
    w, h = 240, max(1, round(240 * before.height / before.width))
    a = _grey(before, (w, h))
    keep = np.ones((h, w), bool)
    y1, x1, y2, x2 = box
    keep[int(y1 * h / 1000):int(y2 * h / 1000), int(x1 * w / 1000):int(x2 * w / 1000)] = False
    src = after.resize(before.size)
    best = (np.inf, 1.0, 0, 0)
    for s in np.arange(0.97, 1.0301, 0.005):
        g = _grey(_placed(src, before.size, s, 0, 0), (w, h))
        for dx in range(-3, 4):
            for dy in range(-3, 4):
                d = np.abs(a - np.roll(g, (dy, dx), axis=(0, 1)))[keep].mean()
                if d < best[0]:
                    best = (d, s, dx, dy)
    _, s, dx, dy = best
    return _placed(src, before.size, s, dx * before.width / w, dy * before.height / h)


def _placed(img: Image.Image, size: tuple[int, int], scale: float, dx: float, dy: float) -> Image.Image:
    if abs(scale - 1) < 1e-6 and not dx and not dy:
        return img
    sw, sh = round(size[0] * scale), round(size[1] * scale)
    canvas = Image.new("RGB", size)
    canvas.paste(img.resize((sw, sh)), (round((size[0] - sw) / 2 + dx), round((size[1] - sh) / 2 + dy)))
    return canvas


def mask_for(before: Image.Image, after: Image.Image, box: list[int]) -> Image.Image:
    """The box with soft edges, kept to where the result really differs (dilated), so untouched skin and
    fabric inside the box stay the photo's."""
    w, h = before.size
    y1, x1, y2, x2 = (round(v * d / 1000) for v, d in zip(box, (h, w, h, w)))
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle((x1, y1, x2, y2), radius=max(8, (x2 - x1) // 8), fill=255)
    feather = max(4, round(0.04 * min(w, h)))
    m = m.filter(ImageFilter.GaussianBlur(feather))
    diff = ImageChops.difference(before.convert("L"), after.convert("L")).point(lambda v: 255 if v > 18 else 0)
    changed = diff.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(feather))
    return ImageChops.multiply(m, changed.point(lambda v: min(255, v * 3)))


def match_colour(before: Image.Image, after: Image.Image, mask: Image.Image) -> Image.Image:
    """Nudge the result's overall tone to the photo's, so the seam doesn't show. Measured only where the two
    should agree (the soft edge, minus whatever the edit really changed) and capped, so a real change of shape or
    shading inside the chest is never undone."""
    b, a = np.asarray(before, np.float32), np.asarray(after, np.float32)
    mk = np.asarray(mask, np.float32) / 255
    same = np.abs(b - a).mean(axis=2) < 25
    ring = (mk > 0.02) & (mk < 0.5) & same
    if ring.sum() < 200:
        return after
    shift = np.clip(b[ring].mean(axis=0) - a[ring].mean(axis=0), -12, 12)
    return Image.fromarray(np.clip(a + shift, 0, 255).astype(np.uint8))


def composite(photo: Path, result: Path, box: list[int]) -> None:
    """Writes the finished picture over `result`."""
    with Image.open(photo) as p, Image.open(result) as r:
        before, after = p.convert("RGB"), r.convert("RGB")
    grow = before.width / after.width
    after = align(before, after, box)
    if grow > 1.15:
        after = after.filter(ImageFilter.UnsharpMask(radius=1.2 * grow, percent=round(40 + 20 * min(grow, 3)),
                                                     threshold=2))
    mask = mask_for(before, after, box)
    after = match_colour(before, after, mask)
    Image.composite(after, before, mask).save(result)


def garment_check(photo: Path, result: Path, tick=None) -> bool | None:
    """False when the result shows skin the photo's clothing covered; None when the check couldn't run."""
    msgs = [{"role": "system", "content": "You check medical simulation images. Answer only with JSON."},
            {"role": "user", "images": [image_b64(photo), image_b64(result)],
             "content": "The FIRST picture is the original, the SECOND is an edited simulation of the same person. "
                        "Is any skin or body part uncovered in the SECOND picture that clothing (bra, top, kameez, dress, dupatta, scarf) covers in "
                        "the FIRST? Ignore a change of shape or size under the same clothing. Reply as JSON "
                        '{"uncovered": true|false, "why": "short reason"}.'}]
    try:
        res = chat_sync("vision", msgs, schema=Garment, temperature=0.0, max_tokens=120,
                        timeout=get_settings().vision_timeout_s, tick=tick)
    except LLMError as e:
        log.info("garment check couldn't run: %s", e)
        return None
    return not res.data.uncovered
