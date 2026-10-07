"""Deterministic brand compositing: pixels and ffmpeg only, no AI (contract v7).

Everything here takes a KitAssets (files already resolved on disk), so it runs the same in the API
(previews), the worker (brand_apply / brand_reveal jobs) and the tests. The real logo file is never
sent through a model: watermark, cards, lower third and the logo reveal are exact.
"""
import logging
import math
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, features

from app.brand_schemas import BrandSettings, CardSettings, LowerThirdSettings, WatermarkSettings, norm_hex
from app.config import get_settings

log = logging.getLogger("mixai.brand")

AFMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
VENC = ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high"]
AENC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
CARD_FADE_S = 0.35
LT_FADE_S = 0.4
NTSC = {23.98: "24000/1001", 23.976: "24000/1001", 29.97: "30000/1001", 59.94: "60000/1001"}
HAS_RAQM = features.check("raqm")

# fallbacks when a kit has no font file; the first two cover Urdu on the Linux box if fonts-noto is installed
SYSTEM_FONTS = (
    "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
)


class BrandRenderError(RuntimeError):
    pass


@dataclass
class KitAssets:
    name: str = ""
    tagline: str = ""
    palette: list[dict] = field(default_factory=list)
    logo: Path | None = None
    logo_light: Path | None = None  # for dark backgrounds
    logo_dark: Path | None = None  # for light backgrounds
    font: Path | None = None
    settings: BrandSettings = field(default_factory=BrandSettings)


# ---------------------------------------------------------------- colour

def hex_rgb(h: str) -> tuple[int, int, int]:
    h = norm_hex(h)
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def luminance(rgb) -> float:
    r, g, b = (c / 255 for c in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def bg_colour(assets: KitAssets, bg: int | str | None) -> tuple[int, int, int]:
    pal = [p["hex"] for p in assets.palette if p.get("hex")]
    if isinstance(bg, int) or (isinstance(bg, str) and bg.isdigit()):
        i = int(bg)
        if 0 <= i < len(pal):
            return hex_rgb(pal[i])
    elif isinstance(bg, str) and bg.strip():
        try:
            return hex_rgb(bg)
        except ValueError:
            pass
    return hex_rgb(pal[0]) if pal else (16, 16, 18)


def ink_for(rgb) -> tuple[int, int, int]:
    return (20, 20, 22) if luminance(rgb) > 0.55 else (250, 250, 250)


def grade_shifts(palette: list[dict], strength: float) -> tuple[float, float, float]:
    """Per-channel midtone push towards the palette's mean colour, brightness-neutral."""
    cols = [hex_rgb(p["hex"]) for p in palette if p.get("hex")]
    if not cols or strength <= 0:
        return 0.0, 0.0, 0.0
    mean = [sum(c[i] for c in cols) / len(cols) / 255 for i in range(3)]
    raw = [strength * (m - 0.5) * 0.5 for m in mean]
    avg = sum(raw) / 3
    return tuple(round(r - avg, 4) for r in raw)


def _curve(s: float):
    # x + s*4x(1-x): moves midtones, leaves black and white where they are. Same maths as grade_filter.
    return [max(0, min(255, round(v + s * 4 * v * (255 - v) / 255))) for v in range(256)]


def grade_image(img: Image.Image, palette: list[dict], strength: float) -> Image.Image:
    sr, sg, sb = grade_shifts(palette, strength)
    if not any((sr, sg, sb)):
        return img
    alpha = img.getchannel("A") if img.mode == "RGBA" else None
    r, g, b = img.convert("RGB").split()
    out = Image.merge("RGB", (r.point(_curve(sr)), g.point(_curve(sg)), b.point(_curve(sb))))
    if alpha is not None:
        out.putalpha(alpha)
    return out


def grade_filter(palette: list[dict], strength: float) -> str | None:
    sr, sg, sb = grade_shifts(palette, strength)
    if not any((sr, sg, sb)):
        return None
    ex = lambda s: f"clip(val+{s}*4*val*(255-val)/255\\,0\\,255)"  # noqa: E731
    return f"format=rgb24,lutrgb=r='{ex(sr)}':g='{ex(sg)}':b='{ex(sb)}'"


# ---------------------------------------------------------------- text

_RTL = re.compile(r"[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]")


def is_rtl(text: str) -> bool:
    return bool(_RTL.search(text or ""))


def load_font(path: Path | None, size: int) -> ImageFont.ImageFont:
    # TODO: fall back per script when the brand font has no Urdu glyphs (needs a cmap read, e.g. fontTools)
    size = max(8, int(size))
    for cand in ([path] if path else []) + [Path(p) for p in SYSTEM_FONTS]:
        try:
            if cand and Path(cand).is_file():
                return ImageFont.truetype(str(cand), size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def shaped(text: str) -> tuple[str, dict]:
    """Text ready for draw.text. With libraqm Pillow shapes and reorders itself; without it, Arabic-script
    text (Urdu) is joined with arabic_reshaper and put in visual order with python-bidi."""
    if not is_rtl(text):
        return text, {}
    if HAS_RAQM:
        return text, {"direction": "rtl", "language": "ur"}
    try:
        import arabic_reshaper
        from bidi import get_display
    except ImportError:  # still renders, just unjoined and left-to-right
        return text, {}
    return get_display(arabic_reshaper.reshape(text)), {}


def text_width(draw: ImageDraw.ImageDraw, text: str, font) -> float:
    s, kw = shaped(text)
    try:
        return draw.textlength(s, font=font, **kw)
    except (KeyError, ValueError, OSError):
        return draw.textlength(s, font=font)


def wrap(draw, text: str, font, max_w: float) -> list[str]:
    """Greedy word wrap in logical order; each line is shaped on its own when drawn."""
    lines: list[str] = []
    for para in (text or "").splitlines() or [""]:
        cur = ""
        for word in para.split():
            cand = f"{cur} {word}".strip()
            if cur and text_width(draw, cand, font) > max_w:
                lines.append(cur)
                cur = word
            else:
                cur = cand
        if cur:
            lines.append(cur)
    return lines


def fit_text(draw, text: str, font_path: Path | None, size: int, max_w: float, max_lines: int = 3):
    while True:
        font = load_font(font_path, size)
        lines = wrap(draw, text, font, max_w)
        too_wide = any(text_width(draw, ln, font) > max_w for ln in lines)
        if (len(lines) <= max_lines and not too_wide) or size <= 12:
            return font, lines
        size = int(size * 0.88)


def draw_lines(draw, lines: list[str], font, centre_x: float, top: float, fill, line_gap: float = 1.25) -> float:
    asc, desc = font.getmetrics() if hasattr(font, "getmetrics") else (font.size, 0)
    lh = (asc + desc) * line_gap
    y = top
    for ln in lines:
        s, kw = shaped(ln)
        w = text_width(draw, ln, font)
        try:
            draw.text((centre_x - w / 2, y), s, font=font, fill=fill, **kw)
        except (KeyError, ValueError, OSError):
            draw.text((centre_x - w / 2, y), s, font=font, fill=fill)
        y += lh
    return y - top


def text_block_height(font, n: int, line_gap: float = 1.25) -> float:
    asc, desc = font.getmetrics() if hasattr(font, "getmetrics") else (font.size, 0)
    return (asc + desc) * line_gap * n


# ---------------------------------------------------------------- logo + watermark

def open_logo(path: Path) -> Image.Image:
    with Image.open(path) as im:
        return im.convert("RGBA")


def fit_box(w: int, h: int, max_w: float, max_h: float) -> tuple[int, int]:
    s = min(max_w / w, max_h / h)
    return max(1, round(w * s)), max(1, round(h * s))


def watermark_box(frame_w: int, frame_h: int, logo_w: int, logo_h: int, wm: WatermarkSettings) -> tuple[int, int, int, int]:
    """(x, y, w, h) of the logo: its longer side is size_pct of the frame's short side."""
    short = min(frame_w, frame_h)
    long_side = wm.size_pct / 100 * short
    s = long_side / max(logo_w, logo_h)
    w, h = max(1, round(logo_w * s)), max(1, round(logo_h * s))
    m = round(wm.margin_pct / 100 * short)
    x = m if wm.position in ("tl", "bl") else frame_w - m - w
    y = m if wm.position in ("tl", "tr") else frame_h - m - h
    return x, y, w, h


def pick_logo(assets: KitAssets, variant: str, bg_lum: float | None) -> Path | None:
    if variant == "light" and assets.logo_light:
        return assets.logo_light
    if variant == "dark" and assets.logo_dark:
        return assets.logo_dark
    if variant == "auto" and bg_lum is not None:
        if bg_lum < 0.4 and assets.logo_light:
            return assets.logo_light
        if bg_lum > 0.6 and assets.logo_dark:
            return assets.logo_dark
    return assets.logo or assets.logo_light or assets.logo_dark


def prepared_logo(path: Path, w: int, h: int, opacity: float) -> Image.Image:
    logo = open_logo(path).resize((w, h), Image.LANCZOS)
    if opacity < 1:
        a = logo.getchannel("A").point(lambda v: round(v * opacity))
        logo.putalpha(a)
    return logo


def region_luminance(img: Image.Image, box: tuple[int, int, int, int]) -> float:
    x, y, w, h = box
    crop = img.convert("RGB").crop((x, y, x + w, y + h)).resize((1, 1), Image.BOX)
    return luminance(crop.getpixel((0, 0)))


def watermark_image(img: Image.Image, assets: KitAssets, wm: WatermarkSettings) -> Image.Image:
    base = assets.logo or assets.logo_light or assets.logo_dark
    if base is None:
        raise BrandRenderError("This kit has no logo to place")
    with Image.open(base) as lg:
        lw, lh = lg.size
    box = watermark_box(img.width, img.height, lw, lh, wm)
    path = pick_logo(assets, wm.variant, region_luminance(img, box))
    with Image.open(path) as lg:
        if lg.size != (lw, lh):
            box = watermark_box(img.width, img.height, *lg.size, wm)
    x, y, w, h = box
    logo = prepared_logo(path, w, h, wm.opacity)
    out = img.convert("RGBA")
    out.alpha_composite(logo, (x, y))
    return out


def apply_to_image(src: Path, dest: Path, assets: KitAssets, st: BrandSettings) -> list[str]:
    applied = []
    with Image.open(src) as im:
        had_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
        img = im.convert("RGBA")
    if st.grade.enabled:
        img = grade_image(img, assets.palette, st.grade.strength)
        applied.append("grade")
    if st.watermark.enabled:
        img = watermark_image(img, assets, st.watermark)
        applied.append("watermark")
    if not applied:
        raise BrandRenderError("Nothing to apply to an image: turn on the watermark or the colour grade")
    dest.parent.mkdir(parents=True, exist_ok=True)
    (img if had_alpha else img.convert("RGB")).save(dest, "PNG")
    return applied


def sample_frame(assets: KitAssets, size=(1280, 720)) -> Image.Image:
    """Stand-in frame for previews: a soft diagonal blend of the first two palette colours."""
    w, h = size
    a = bg_colour(assets, 0)
    b = bg_colour(assets, 1) if len(assets.palette) > 1 else tuple(min(255, c + 60) for c in a)
    grad = Image.linear_gradient("L").rotate(45, expand=True).resize((w, h))
    return Image.composite(Image.new("RGB", size, b), Image.new("RGB", size, a), grad)


# ---------------------------------------------------------------- cards

def render_card(size: tuple[int, int], assets: KitAssets, card: CardSettings, kind: str = "end_card") -> Image.Image:
    w, h = size
    bg = bg_colour(assets, card.bg)
    img = Image.new("RGB", size, bg)
    draw = ImageDraw.Draw(img)
    short = min(w, h)
    texts = []
    if card.show_name and assets.name:
        texts.append(("name", assets.name, 0.07))
    if card.show_tagline and assets.tagline:
        texts.append(("tagline", assets.tagline, 0.05))
    blocks = []
    for _key, text, rel in texts:
        font, lines = fit_text(draw, text, assets.font, round(short * rel), w * 0.8)
        blocks.append((font, lines))
    text_h = sum(text_block_height(f, len(ls)) for f, ls in blocks) + (short * 0.02 * max(0, len(blocks) - 1))

    logo_path = pick_logo(assets, "auto", luminance(bg))
    logo = None
    if logo_path:
        logo = open_logo(logo_path)
        lw, lh = fit_box(*logo.size, w * 0.5, h * (0.32 if blocks else 0.42))
        logo = logo.resize((lw, lh), Image.LANCZOS)
    gap = short * 0.05 if logo and blocks else 0
    total = (logo.height if logo else 0) + gap + text_h
    y = (h - total) / 2
    if logo:
        img.paste(logo, (round((w - logo.width) / 2), round(y)), logo)
        y += logo.height + gap
    ink = ink_for(bg)
    for font, lines in blocks:
        y += draw_lines(draw, lines, font, w / 2, y, ink) + short * 0.02
    return img


def render_lower_third(size: tuple[int, int], assets: KitAssets, lt: LowerThirdSettings) -> Image.Image:
    w, h = size
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    short = min(w, h)
    title = lt.text if lt.text is not None else assets.name
    sub = lt.subtext if lt.subtext is not None else assets.tagline
    f1, l1 = fit_text(draw, title or "", assets.font, round(short * 0.05), w * 0.6, 1)
    f2, l2 = fit_text(draw, sub or "", assets.font, round(short * 0.033), w * 0.6, 2)
    pad = short * 0.025
    inner = text_block_height(f1, len(l1)) + (text_block_height(f2, len(l2)) if l2 else 0)
    widths = [text_width(draw, ln, f1) for ln in l1] + [text_width(draw, ln, f2) for ln in l2]
    bw = (max(widths) if widths else 0) + pad * 2 + short * 0.012
    bh = inner + pad * 2
    x0 = short * 0.05
    y0 = h - short * 0.08 - bh
    band = bg_colour(assets, 0)
    accent = bg_colour(assets, 1) if len(assets.palette) > 1 else ink_for(band)
    draw.rectangle((x0, y0, x0 + bw, y0 + bh), fill=(*band, 225))
    draw.rectangle((x0, y0, x0 + short * 0.012, y0 + bh), fill=(*accent, 255))
    ink = ink_for(band)
    cx = x0 + short * 0.012 + pad + (bw - short * 0.012 - pad * 2) / 2
    y = y0 + pad
    y += draw_lines(draw, l1, f1, cx, y, (*ink, 255))
    if l2:
        draw_lines(draw, l2, f2, cx, y, (*ink, 215))
    return img


# ---------------------------------------------------------------- video

_FPS = re.compile(r"Video: .*?, (\d+(?:\.\d+)?) (?:fps|tbr)")


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    fps_str: str
    duration: float
    has_audio: bool
    chapters: int


def ffmpeg() -> str:
    return get_settings().ffmpeg_path()


def run_ff(args: list[str], timeout: float = 1800) -> subprocess.CompletedProcess:
    from app.reel import run_ff as _run

    return _run(args, timeout=timeout)


def video_info(path: Path) -> VideoInfo:
    from app import reel as rl

    p = rl.probe(path)
    if not p.has_video or not p.width:
        raise BrandRenderError(f"{path.name} has no readable video stream")
    err = subprocess.run([ffmpeg(), "-hide_banner", "-nostdin", "-i", str(path)], capture_output=True, text=True,
                         encoding="utf-8", errors="replace", timeout=60).stderr
    m = _FPS.search(err)
    fps = float(m[1]) if m else 24.0
    fps_str = NTSC.get(round(fps, 3)) or NTSC.get(round(fps, 2)) or f"{fps:g}"
    return VideoInfo(p.width, p.height, fps, fps_str, p.duration, p.has_audio, len(p.chapters))


def grab_frame(src: Path, at: float, dest: Path) -> Image.Image | None:
    try:
        run_ff(["-ss", f"{at:.3f}", "-i", str(src), "-frames:v", "1", str(dest)], timeout=120)
        with Image.open(dest) as im:
            return im.convert("RGB")
    except Exception:
        return None


def shifted_chapters(src: Path, workdir: Path, offset_s: float) -> Path | None:
    meta = workdir / "chapters_src.txt"
    try:
        run_ff(["-i", str(src), "-f", "ffmetadata", str(meta)], timeout=60)
    except Exception:
        return None
    lines = meta.read_text(encoding="utf-8", errors="replace").splitlines()
    if "[CHAPTER]" not in lines:
        return None
    out, tb = [], (1, 1000)
    for ln in lines:
        if ln.startswith("TIMEBASE="):
            a, b = ln.split("=", 1)[1].split("/")
            tb = (int(a), int(b))
        elif ln.startswith(("START=", "END=")) and offset_s:
            k, v = ln.split("=", 1)
            ln = f"{k}={int(v) + round(offset_s * tb[1] / tb[0])}"
        out.append(ln)
    dest = workdir / "chapters.txt"
    dest.write_text("\n".join(out) + "\n", encoding="utf-8")
    return dest


def _frames(d: float, fps: float) -> int:
    return max(1, round(d * fps))


def video_plan(info: VideoInfo, st: BrandSettings) -> dict:
    intro = _frames(st.intro_card.duration_s, info.fps) / info.fps if st.intro_card.enabled else 0.0
    end = _frames(st.end_card.duration_s, info.fps) / info.fps if st.end_card.enabled else 0.0
    return {"intro_s": round(intro, 4), "end_s": round(end, 4), "main_s": round(info.duration, 4),
            "total_s": round(intro + info.duration + end, 4)}


def apply_to_video(src: Path, dest: Path, assets: KitAssets, st: BrandSettings, workdir: Path) -> dict:
    """One ffmpeg pass: optional grade, watermark and lower third over the source, then intro/end cards
    joined with the concat filter. Same size and frame rate; the original audio is kept and the cards
    carry silence, so the output always has one continuous stereo track."""
    applied = st.enabled()
    if not applied:
        raise BrandRenderError("Nothing to apply: turn on the watermark, a card, the lower third or the grade")
    if "watermark" in applied and not (assets.logo or assets.logo_light or assets.logo_dark):
        raise BrandRenderError("This kit has no logo to place")
    workdir.mkdir(parents=True, exist_ok=True)
    info = video_info(src)
    W, H, F, dur = info.width, info.height, info.fps_str, info.duration
    if dur <= 0:
        raise BrandRenderError("Couldn't read this video's length")
    plan = video_plan(info, st)

    inputs: list[str] = ["-i", str(src)]
    n = 1
    graph: list[str] = []
    chain = f"[0:v]setpts=PTS-STARTPTS,fps={F},scale={W}:{H},setsar=1"
    if st.grade.enabled:
        gf = grade_filter(assets.palette, st.grade.strength)
        if gf:
            chain += "," + gf
    graph.append(chain + "[m0]")
    cur = "m0"

    if st.watermark.enabled:
        frame = grab_frame(src, min(1.0, dur / 2), workdir / "probe.png")
        base = assets.logo or assets.logo_light or assets.logo_dark
        with Image.open(base) as lg:
            box = watermark_box(W, H, *lg.size, st.watermark)
        path = pick_logo(assets, st.watermark.variant, region_luminance(frame, box) if frame else None)
        with Image.open(path) as lg:
            x, y, w, h = watermark_box(W, H, *lg.size, st.watermark)
        prepared_logo(path, w, h, st.watermark.opacity).save(workdir / "wm.png")
        inputs += ["-i", str(workdir / "wm.png")]
        graph.append(f"[{cur}][{n}:v]overlay={x}:{y}:format=auto[m1]")
        cur, n = "m1", n + 1

    if st.lower_third.enabled:
        lt = st.lower_third
        a = min(lt.at_s, max(0.0, dur - 1.0))
        b = min(dur, a + lt.duration_s)
        render_lower_third((W, H), assets, lt).save(workdir / "lt.png")
        inputs += ["-loop", "1", "-framerate", F, "-t", f"{dur:.4f}", "-i", str(workdir / "lt.png")]
        fade = min(LT_FADE_S, (b - a) / 3)
        graph.append(f"[{n}:v]format=rgba,fade=t=in:st={a:.3f}:d={fade:.3f}:alpha=1,"
                     f"fade=t=out:st={b - fade:.3f}:d={fade:.3f}:alpha=1[lt]")
        graph.append(f"[{cur}][lt]overlay=0:0:format=auto:enable='between(t,{a:.3f},{b:.3f})'[m2]")
        cur, n = "m2", n + 1
    graph.append(f"[{cur}]format=yuv420p[mv]")

    if info.has_audio:
        graph.append(f"[0:a]asetpts=PTS-STARTPTS,aresample=48000,{AFMT},apad,atrim=0:{dur:.4f}[ma]")
    else:
        inputs += ["-f", "lavfi", "-t", f"{dur:.4f}", "-i", "anullsrc=r=48000:cl=stereo"]
        graph.append(f"[{n}:a]{AFMT}[ma]")
        n += 1

    def card(kind: str, cs: CardSettings, secs: float, fade: str) -> tuple[str, str]:
        nonlocal n
        png = workdir / f"{kind}.png"
        render_card((W, H), assets, cs, kind).save(png)
        inputs.extend(["-loop", "1", "-framerate", F, "-t", f"{secs:.4f}", "-i", str(png),
                       "-f", "lavfi", "-t", f"{secs:.4f}", "-i", "anullsrc=r=48000:cl=stereo"])
        v, a = f"{kind}v", f"{kind}a"
        graph.append(f"[{n}:v]fps={F},scale={W}:{H},setsar=1,format=yuv420p,{fade}[{v}]")
        graph.append(f"[{n + 1}:a]{AFMT}[{a}]")
        n += 2
        return v, a

    segs = []
    if st.intro_card.enabled:
        s = plan["intro_s"]
        segs.append(card("intro", st.intro_card, s, f"fade=t=out:st={max(0, s - CARD_FADE_S):.3f}:d={CARD_FADE_S}"))
    segs.append(("mv", "ma"))
    if st.end_card.enabled:
        segs.append(card("end", st.end_card, plan["end_s"], f"fade=t=in:st=0:d={CARD_FADE_S}"))
    if len(segs) > 1:
        graph.append("".join(f"[{v}][{a}]" for v, a in segs) + f"concat=n={len(segs)}:v=1:a=1[vout][aout]")
    else:
        graph.append("[mv]null[vout];[ma]anull[aout]")

    maps = ["-map", "[vout]", "-map", "[aout]"]
    if info.chapters:
        meta = shifted_chapters(src, workdir, plan["intro_s"])
        if meta is not None:
            inputs += ["-f", "ffmetadata", "-i", str(meta)]
            maps += ["-map_chapters", str(n)]
            n += 1
    tmp = dest.with_name(dest.stem + ".tmp.mp4")
    dest.parent.mkdir(parents=True, exist_ok=True)
    run_ff([*inputs, "-filter_complex", ";".join(graph), *maps, *VENC, "-r", F, *AENC,
            "-movflags", "+faststart", str(tmp)])
    tmp.replace(dest)
    return {"applied": applied, "size": [W, H], "fps": round(info.fps, 3), **plan}


# ---------------------------------------------------------------- logo reveal

def _smooth(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def _cover(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    w, h = size
    s = max(w / img.width, h / img.height)
    im = img.resize((math.ceil(img.width * s), math.ceil(img.height * s)), Image.LANCZOS)
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def reveal_background(size, assets: KitAssets, colour=None, image: Path | None = None) -> Image.Image:
    w, h = size
    if image is not None:
        with Image.open(image) as im:
            bg = _cover(im.convert("RGB"), size)
        # darken so the logo stays the brightest thing on screen
        return Image.blend(Image.new("RGB", size, (0, 0, 0)), bg, 0.55)
    base = colour or bg_colour(assets, 0)
    # a gentle vignette keeps a flat colour from looking like a placeholder
    mask = Image.radial_gradient("L").resize((w, h))
    edge = tuple(round(c * 0.72) for c in base)
    return Image.composite(Image.new("RGB", size, edge), Image.new("RGB", size, base), mask)


def _sweep_strip(w: int, h: int) -> Image.Image:
    """A soft diagonal light band, three logo-widths wide, cropped per frame to move it across."""
    strip = Image.new("L", (w * 3, h), 0)
    band = Image.linear_gradient("L").rotate(90).resize((max(2, w // 3), h))
    peak = ImageChops.multiply(band, band.transpose(Image.FLIP_LEFT_RIGHT))
    peak = peak.point(lambda v: min(255, v * 4))
    strip.paste(peak, (w + w // 3, 0))
    return strip.transform(strip.size, Image.AFFINE, (1, -0.35, h * 0.175, 0, 1, 0), Image.BICUBIC)


def reveal_frames(size, assets: KitAssets, duration_s: float, fps: int, bg: Image.Image, show_tagline: bool):
    """Yields RGB frames: logo fades in while easing from 94% to 100%, a light sweep crosses it,
    then the tagline fades in. Deterministic, no randomness anywhere."""
    w, h = size
    short = min(w, h)
    path = pick_logo(assets, "auto", luminance(bg.resize((1, 1), Image.BOX).getpixel((0, 0))))
    if path is None:
        raise BrandRenderError("This kit has no logo for a logo reveal")
    tag_img = None
    if show_tagline and assets.tagline:
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        font, lines = fit_text(d, assets.tagline, assets.font, round(short * 0.05), w * 0.8)
        th = text_block_height(font, len(lines))
        tag_img = (layer, font, lines, th)
    logo = open_logo(path)
    lw, lh = fit_box(*logo.size, w * 0.5, h * (0.34 if tag_img else 0.42))
    logo = logo.resize((lw, lh), Image.LANCZOS)
    gap = short * 0.05 if tag_img else 0
    total = lh + gap + (tag_img[3] if tag_img else 0)
    logo_cy = (h - total) / 2 + lh / 2
    if tag_img:
        layer, font, lines, _ = tag_img
        draw_lines(ImageDraw.Draw(layer), lines, font, w / 2, logo_cy + lh / 2 + gap,
                   (*ink_for(bg.getpixel((w // 2, min(h - 1, int(logo_cy + lh / 2 + gap))))), 255))
        tag_alpha = layer.getchannel("A")
        tag_rgb = layer.convert("RGB")
    strip = _sweep_strip(lw, lh)
    n = max(1, round(duration_s * fps))
    sweep_a, sweep_b = 0.55, max(0.9, min(duration_s - 0.5, 1.9))
    for i in range(n):
        t = i / fps
        frame = bg.copy()
        a = _smooth(t / 0.7)
        s = 0.94 + 0.06 * _smooth(t / max(0.5, duration_s * 0.8))
        cw, ch = max(1, round(lw * s)), max(1, round(lh * s))
        lg = logo.resize((cw, ch), Image.BICUBIC) if (cw, ch) != (lw, lh) else logo.copy()
        la = lg.getchannel("A")
        if sweep_a <= t <= sweep_b:
            u = (t - sweep_a) / (sweep_b - sweep_a)
            off = round(u * 2 * lw)
            band = strip.crop((off, 0, off + lw, lh)).resize((cw, ch))
            shine = ImageChops.multiply(band, la).point(lambda v: round(v * 0.6))
            white = Image.new("RGBA", (cw, ch), (255, 255, 255, 0))
            white.putalpha(shine)
            lg.alpha_composite(white)
            lg.putalpha(la)
        if a < 1:
            lg.putalpha(la.point(lambda v, a=a: round(v * a)))
        frame.paste(lg, (round(w / 2 - cw / 2), round(logo_cy - ch / 2)), lg)
        if tag_img:
            ta = _smooth((t - 0.9) / 0.6)
            if ta > 0:
                mask = tag_alpha if ta >= 1 else tag_alpha.point(lambda v, ta=ta: round(v * ta))
                frame.paste(tag_rgb, (0, 0), mask)
        yield frame


def logo_reveal_clip(assets: KitAssets, dest: Path, *, duration_s: float = 3.0, size=(1920, 1080), fps: int = 24,
                     colour=None, bg_image: Path | None = None, show_tagline: bool = True, tick=None) -> dict:
    w, h = size
    bg = reveal_background(size, assets, colour, bg_image)
    n = max(1, round(duration_s * fps))
    secs = n / fps
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.stem + ".tmp.mp4")
    cmd = [ffmpeg(), "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-framerate", str(fps), "-i", "-",
           "-f", "lavfi", "-t", f"{secs:.4f}", "-i", "anullsrc=r=48000:cl=stereo",
           "-map", "0:v", "-map", "1:a", *VENC, "-r", str(fps), *AENC, "-shortest", "-movflags", "+faststart", str(tmp)]
    with tempfile.TemporaryFile() as errf:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errf)
        try:
            for i, frame in enumerate(reveal_frames(size, assets, duration_s, fps, bg, show_tagline)):
                proc.stdin.write(frame.tobytes())
                if tick and i % fps == 0:
                    tick(i / n)
            proc.stdin.close()
            rc = proc.wait(timeout=600)
        except BaseException:
            proc.kill()
            proc.wait()
            tmp.unlink(missing_ok=True)
            raise
        if rc != 0:
            errf.seek(0)
            tmp.unlink(missing_ok=True)
            raise BrandRenderError("ffmpeg failed: " + errf.read().decode("utf-8", "replace")[-600:])
    tmp.replace(dest)
    return {"size": [w, h], "fps": fps, "duration_s": round(secs, 3), "frames": n}
