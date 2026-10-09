"""Cut-out compositing: subject masks from BiRefNet / SAM 3 meet the full-size image here, on the CPU.

ComfyUI only ever returns a greyscale mask. Keeping the mask beside the version means a new background,
a softer edge or an added/removed region is a cheap CPU job instead of another GPU pass.
"""
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

OPS = ("replace", "add", "subtract")
HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")


def load_mask(path: Path, size: tuple[int, int]) -> Image.Image:
    """Any mask image -> mode L at `size`. ComfyUI's MaskToImage gives RGB with equal channels."""
    with Image.open(path) as im:
        m = im.convert("L")
        if m.size != size:
            m = m.resize(size, Image.BILINEAR)
        return m.copy()


def combine(current: Image.Image | None, new: Image.Image, op: str) -> Image.Image:
    if op not in OPS:
        raise ValueError(f"Unknown mask operation '{op}'")
    if current is None or op == "replace":
        return new
    a = np.asarray(current, dtype=np.int16)
    b = np.asarray(new, dtype=np.int16)
    out = np.maximum(a, b) if op == "add" else np.clip(a - b, 0, 255)
    return Image.fromarray(out.astype(np.uint8), "L")


def refine_edge(mask: Image.Image, feather: float = 0.0, shift: int = 0) -> Image.Image:
    """shift > 0 grows the subject by that many pixels, < 0 shrinks it; feather softens the edge."""
    m = mask
    if shift:
        n = min(abs(int(shift)), 10) * 2 + 1
        m = m.filter(ImageFilter.MaxFilter(n) if shift > 0 else ImageFilter.MinFilter(n))
    if feather > 0:
        m = m.filter(ImageFilter.GaussianBlur(float(feather)))
    return m


def coverage(mask: Image.Image) -> float:
    small = mask.copy()
    small.thumbnail((256, 256))
    return float(np.asarray(small, dtype=np.float32).mean() / 255)


def parse_colour(value: str) -> tuple[int, int, int]:
    m = HEX.match((value or "").strip())
    if not m:
        raise ValueError(f"'{value}' isn't a colour like #1a2b3c")
    h = m.group(1)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _cover(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    # fill the frame like CSS object-fit: cover, cropping the overflow evenly
    w, h = size
    s = max(w / im.width, h / im.height)
    big = im.resize((max(w, round(im.width * s)), max(h, round(im.height * s))), Image.LANCZOS)
    x, y = (big.width - w) // 2, (big.height - h) // 2
    return big.crop((x, y, x + w, y + h))


def background_for(base: Image.Image, spec: dict, image_path: Path | None = None) -> Image.Image | None:
    """None means transparent."""
    kind = (spec or {}).get("type") or "transparent"
    if kind == "transparent":
        return None
    if kind == "colour":
        return Image.new("RGB", base.size, parse_colour(spec.get("colour", "")))
    if kind == "blur":
        radius = max(2.0, min(60.0, float(spec.get("radius") or 18)))
        # radius is for a ~2000 px image; keep the look the same on bigger and smaller ones
        return base.filter(ImageFilter.GaussianBlur(radius * max(base.size) / 2000))
    if kind in ("image", "generated"):
        if image_path is None or not image_path.is_file():
            raise ValueError("The background picture is missing")
        with Image.open(image_path) as bg:
            return _cover(bg.convert("RGB"), base.size)
    raise ValueError(f"Unknown background '{kind}'")


def compose(base: Image.Image, mask: Image.Image, background: Image.Image | None) -> Image.Image:
    """RGBA when the background is transparent, RGB otherwise."""
    rgb = base.convert("RGB")
    if background is None:
        out = rgb.copy()
        out.putalpha(mask)
        return out
    return Image.composite(rgb, background.convert("RGB"), mask)
