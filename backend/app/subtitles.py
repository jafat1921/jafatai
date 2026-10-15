"""Burned subtitles (contract v24a). This is the only place they're made: the Audiogram, the Dub export,
Transcribe's "make subtitles" and the AI video podcast all go through `burn`.

Urdu and Arabic need joined letters, right-to-left order, and aerab sitting on the right letter. libass does
all three when ffmpeg's `ass` filter can shape with HarfBuzz. Where it can't, each cue is drawn with Pillow
(raqm, or arabic_reshaper + python-bidi, the same as the brand cards), and the cues go on as one overlay track.
"""
import functools
import logging
import re
import shutil
import subprocess
import tempfile
import unicodedata
from pathlib import Path
from typing import NamedTuple

from PIL import Image, ImageDraw

from app import aerab
from app import brand_render as br
from app.config import get_settings

log = logging.getLogger("mixai.subtitles")

LATIN = "Noto Sans"
NASTALIQ = "Noto Nastaliq Urdu"
NASKH = "Noto Naskh Arabic"
DEVANAGARI = "Noto Sans Devanagari"
DEVANAGARI_LANGS = ("hi", "mr", "ne")
_STYLE_NAMES = {LATIN: "Latin", NASTALIQ: "Nastaliq", NASKH: "Naskh", DEVANAGARI: "Devanagari"}

MAX_CHARS = 42
# Nastaliq slopes down and stacks, so a line of it takes up far more room than its letter count suggests
NASTALIQ_CHARS = 34
MAX_LINES = 2
# line height as a share of the frame height
SIZE = {NASTALIQ: 0.062, NASKH: 0.056}
DEFAULT_SIZE = 0.052
MARGIN_V = 0.06
MARGIN_H = 0.05
BOX_ALPHA = 0x60  # ASS alpha runs 00 (opaque) to FF (clear): a box about 62 % black
BOX_RGBA = (0, 0, 0, 160)
# same as mixdown.VIDEO_REENCODE
VIDEO_REENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]

_DEVANAGARI_RE = re.compile(r"[ऀ-ॿ]")
_HIDDEN = ("Mn", "Me", "Cf")


class Cue(NamedTuple):
    start: float
    end: float
    text: str
    speaker: str | None = None


class BurnError(RuntimeError):
    pass


def _cue(c) -> Cue:
    if isinstance(c, Cue):
        return c
    if isinstance(c, dict):
        return Cue(float(c["start"]), float(c["end"]), str(c.get("text") or ""), c.get("speaker"))
    return Cue(float(c[0]), float(c[1]), str(c[2] or ""), c[3] if len(c) > 3 else None)


def as_cues(items) -> list[Cue]:
    """Cues to draw: anything with no text or no length is left out, and the rest go in time order."""
    out = [_cue(c) for c in items or []]
    return sorted((c for c in out if c.text.strip() and c.end > c.start), key=lambda c: c.start)


# ---------------------------------------------------------------- fonts

def _lang(language: str | None, text: str = "") -> str | None:
    code = (language or "").strip().lower().replace("_", "-")
    base = code.split("-")[0]
    if base in DEVANAGARI_LANGS and "latn" not in code:
        return base
    arabic = aerab.resolve(language, text)
    if arabic:
        return arabic
    # an Urdu name in English subtitles still needs a font that has the letters
    if aerab.has_script(text):
        return aerab.detect_language(text) or "ur"
    if _DEVANAGARI_RE.search(text or ""):
        return "hi"
    return None


def font_for(language: str | None, text: str = "") -> str:
    lang = _lang(language, text)
    if lang == "ur":
        return NASTALIQ
    if lang in aerab.ARABIC_SCRIPT_LANGS:
        return NASKH
    if lang in DEVANAGARI_LANGS:
        return DEVANAGARI
    return LATIN


def _fc_list(family: str) -> str | None:
    fc = shutil.which("fc-list")
    if not fc:
        return None
    for pattern in (f"{family}:style=Regular", family):
        try:
            out = subprocess.run([fc, pattern, "file"], capture_output=True, text=True, timeout=20).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        files = sorted(ln.strip().rstrip(":") for ln in out.splitlines() if ln.strip())
        if files:
            return files[0]
    return None


@functools.lru_cache(maxsize=32)
def _font_file(family: str, fonts_dir: str) -> str | None:
    stem = family.replace(" ", "").lower()
    root = Path(fonts_dir) if fonts_dir else None
    if root is not None and root.is_dir():
        # NotoSans-Regular.ttf or the variable NotoSans[wdth,wght].ttf, never NotoSansArabic-...
        hits = sorted(p for p in root.rglob("*") if p.suffix.lower() in (".ttf", ".otf")
                      and re.match(re.escape(stem) + r"[-\[]", p.name.lower()))
        for p in hits:
            if p.stem.lower() == f"{stem}-regular":
                return str(p)
        if hits:
            return str(hits[0])
    return _fc_list(family)


def font_file(family: str) -> Path | None:
    p = _font_file(family, get_settings().subtitle_fonts_dir or "")
    return Path(p) if p else None


def fonts_dir() -> Path | None:
    d = Path(get_settings().subtitle_fonts_dir or "")
    return d if str(d) not in ("", ".") and d.is_dir() else None


# ---------------------------------------------------------------- wrapping

def visible_len(text: str) -> int:
    """Characters that take up width: aerab, other combining marks and joiners ride on a letter."""
    return sum(1 for ch in text if not aerab.is_mark(ch) and unicodedata.category(ch) not in _HIDDEN)


def width_for(language: str | None, text: str = "", chars: int | None = None) -> int:
    # `chars` narrows the Latin line (a 9:16 frame); Nastaliq keeps its usual ratio to it
    chars = chars or MAX_CHARS
    return NASTALIQ_CHARS * chars // MAX_CHARS if font_for(language, text) == NASTALIQ else chars


def wrap(text: str, width: int | None = None, language: str | None = None) -> list[str] | None:
    """The text on one line, or on two balanced lines, or None when it needs more than two."""
    text = " ".join(text.split())
    width = width or width_for(language, text)
    if visible_len(text) <= width:
        return [text]
    words = text.split(" ")
    best = None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        la, lb = visible_len(a), visible_len(b)
        if la <= width and lb <= width:
            score = abs(la - lb)
            if best is None or score < best[0]:
                best = (score, [a, b])
    return best[1] if best else None


def lines_for(text: str, language: str | None = None, chars: int | None = None) -> list[str]:
    """`wrap`, or a greedy split when the cue is too long for two lines (better three lines than lost words)."""
    width = width_for(language, text, chars)
    got = wrap(text, width, language=language)
    if got:
        return got
    out, cur = [], ""
    for word in text.split():
        cand = f"{cur} {word}".strip()
        if cur and visible_len(cand) > width:
            out.append(cur)
            cur = word
        else:
            cur = cand
    return out + ([cur] if cur else [])


# ---------------------------------------------------------------- soft subtitle files

def _ts(t: float, sep: str) -> str:
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _plain(text: str, language: str | None) -> str:
    return "\n".join(wrap(text, language=language) or [text])


def srt_text(cues, language: str | None = None) -> str:
    rows = [_cue(c) for c in cues]
    return "\n".join(f"{i}\n{_ts(c.start, ',')} --> {_ts(c.end, ',')}\n{_plain(c.text, language)}\n"
                     for i, c in enumerate(rows, 1))


def vtt_text(cues, language: str | None = None) -> str:
    rows = [_cue(c) for c in cues]
    return "WEBVTT\n\n" + "\n".join(f"{_ts(c.start, '.')} --> {_ts(c.end, '.')}\n{_plain(c.text, language)}\n"
                                    for c in rows)


def write_srt(path: Path, cues, language: str | None = None) -> Path:
    Path(path).write_text(srt_text(cues, language), encoding="utf-8")
    return Path(path)


def write_vtt(path: Path, cues, language: str | None = None) -> Path:
    Path(path).write_text(vtt_text(cues, language), encoding="utf-8")
    return Path(path)


def soft_track_args(index: int, language: str, title: str) -> list[str]:
    """Metadata for soft subtitle track `index` (ISO 639-2 `language`); the caller sets `-c:s mov_text`."""
    # MP4 keeps a track's name in its handler box; players show that one, mkv-minded tools read title
    return [f"-metadata:s:s:{index}", f"language={language}", f"-metadata:s:s:{index}", f"title={title}",
            f"-metadata:s:s:{index}", f"handler_name={title}", f"-disposition:s:{index}", "0"]


# ---------------------------------------------------------------- ASS

def line_px(family: str, height: int, scale: float = 1.0) -> int:
    return max(12, round(height * SIZE.get(family, DEFAULT_SIZE) * scale))


def _ass_time(t: float) -> str:
    cs = int(round(max(0.0, t) * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass_escape(text: str) -> str:
    # a word joiner after a backslash keeps "C:\New" from turning into a line break
    return text.replace("\\", "\\\u2060").replace("{", "\\{").replace("}", "\\}")


def _style(family: str, width: int, height: int, scale: float = 1.0) -> str:
    size = line_px(family, height, scale)
    box = f"&H{BOX_ALPHA:02X}000000"
    # Encoding -1 lets libass find each line's base direction, so a full stop lands at the left end of Urdu
    enc = -1 if family in (NASTALIQ, NASKH) else 1
    return (f"Style: {_STYLE_NAMES[family]},{family},{size},&H00FFFFFF,&H00FFFFFF,{box},{box},0,0,0,0,100,100,0,0,"
            f"3,{max(2, round(size * 0.22))},0,2,{round(width * MARGIN_H)},{round(width * MARGIN_H)},"
            f"{round(height * MARGIN_V)},{enc}")


def ass_text(cues, width: int, height: int, language: str | None = None, scale: float = 1.0,
             chars: int | None = None, fade: float = 0.0) -> str:
    items = as_cues(cues)
    families = sorted({font_for(language, c.text) for c in items} or {LATIN})
    out = ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}", "WrapStyle: 2",
           "ScaledBorderAndShadow: yes", "YCbCr Matrix: None", "", "[V4+ Styles]",
           "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
           "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
           "Alignment, MarginL, MarginR, MarginV, Encoding"]
    out += [_style(f, width, height, scale) for f in families]
    out += ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    # a verse fading in (Poetry Shorts); the fade out is kept shorter so lines don't blur into each other
    fad = f"{{\\fad({round(fade * 1000)},{round(fade * 600)})}}" if fade > 0 else ""
    for c in items:
        fam = font_for(language, c.text)
        # logical order: libass runs FriBidi itself, pre-reversed text would come out backwards
        text = "\\N".join(ass_escape(ln) for ln in lines_for(c.text, language, chars))
        name = (c.speaker or "").replace(",", " ")
        out.append(f"Dialogue: 0,{_ass_time(c.start)},{_ass_time(c.end)},{_STYLE_NAMES[fam]},{name},0,0,0,,{fad}{text}")
    return "\n".join(out) + "\n"


@functools.lru_cache(maxsize=4)
def _ass_help(ff: str) -> str:
    try:
        return subprocess.run([ff, "-hide_banner", "-h", "filter=ass"], capture_output=True, text=True,
                              timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def ass_support() -> tuple[bool, bool]:
    """(ffmpeg has the ass filter, it takes shaping=complex)."""
    h = _ass_help(get_settings().ffmpeg_path())
    return "Filter ass" in h, bool(re.search(r"^\s*shaping\b", h, re.M))


def _needs_shaping(items: list[Cue]) -> bool:
    return any(br.is_rtl(c.text) or _DEVANAGARI_RE.search(c.text) for c in items)


def renderer_for(items: list[Cue]) -> str:
    mode = (get_settings().subtitle_renderer or "auto").strip().lower()
    if mode == "pillow":
        return "pillow"
    has_ass, shaping = ass_support()
    if not has_ass:
        return "pillow"
    if mode == "ass" or shaping:
        return "ass"
    # an old libass can't be asked for HarfBuzz; Latin doesn't need it
    return "pillow" if _needs_shaping(items) else "ass"


def _opt(v: str) -> str:
    # escaped twice: once for the filter's option parser, once for the filtergraph around it
    v = re.sub(r"([\\':])", r"\\\1", v)
    return re.sub(r"([\\'\[\],;])", r"\\\1", v)


def _run(args: list[str], cwd: Path, timeout: int) -> None:
    cmd = [get_settings().ffmpeg_path(), "-y", "-loglevel", "error", "-nostdin", *args]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=timeout, cwd=cwd)
    except subprocess.CalledProcessError as e:
        raise BurnError(f"ffmpeg failed: {e.stderr.decode(errors='replace')[-600:]}") from e
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"Burning the subtitles took longer than {timeout} s") from e


def _out_args(dst: Path, encode: list[str] | None) -> list[str]:
    tail = ["-movflags", "+faststart"] if dst.suffix.lower() in (".mp4", ".m4v", ".mov") else []
    return ["-map", "0:a?", *(encode or VIDEO_REENCODE), "-c:a", "copy", *tail, str(dst)]


def _burn_ass(src: Path, dst: Path, items, language, width, height, work: Path, timeout, encode, scale=1.0,
              chars=None, fade=0.0) -> None:
    (work / "subs.ass").write_text(ass_text(items, width, height, language, scale, chars, fade), encoding="utf-8")
    _, shaping = ass_support()
    # a bare file name in the working dir dodges the escaping a Windows path would need
    vf = "ass=filename=subs.ass"
    d = fonts_dir()
    if d is not None:
        vf += f":fontsdir={_opt(d.as_posix())}"
    if shaping:
        vf += ":shaping=complex"
    _run(["-i", str(src), "-vf", vf, "-map", "0:v:0", *_out_args(dst, encode)], work, timeout)


# ---------------------------------------------------------------- Pillow

@functools.lru_cache(maxsize=64)
def _pil_font(path: str | None, px: int):
    # sized like libass: the font's line height (ascent + descent) is the size, not its em
    probe = br.load_font(Path(path) if path else None, 100)
    asc, desc = probe.getmetrics()
    return br.load_font(Path(path) if path else None, max(8, round(100 * px / max(1, asc + desc))))


def _metrics(font) -> tuple[int, int]:
    asc, desc = font.getmetrics()
    lh = asc + desc
    return lh, max(4, round(lh * 0.22))


def _layout(c: Cue, language: str | None, width: int, height: int, probe: ImageDraw.ImageDraw, scale: float = 1.0,
            chars: int | None = None):
    fam = font_for(language, c.text)
    path = font_file(fam)
    px = line_px(fam, height, scale)
    lines = lines_for(c.text, language, chars)
    while True:
        font = _pil_font(str(path) if path else None, px)
        _, pad = _metrics(font)
        widest = max(br.text_width(probe, ln, font) for ln in lines)
        if widest + 2 * pad <= width * (1 - 2 * MARGIN_H) or px <= 14:
            return fam, font, tuple(lines)
        px = int(px * 0.9)


def cue_image(lines: tuple[str, ...] | list[str], font, width: int, strip_h: int, *, rtl: bool,
              lang: str | None = None) -> Image.Image:
    """One cue as a transparent strip: a centred box, RTL lines right-aligned in it, Latin centred."""
    img = Image.new("RGBA", (width, strip_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lh, pad = _metrics(font)
    widths = [br.text_width(d, ln, font) for ln in lines]
    bw, bh = max(widths) + 2 * pad, lh * len(lines) + 2 * pad
    x0, y0 = (width - bw) / 2, max(0, strip_h - bh)
    d.rectangle((x0, y0, x0 + bw, y0 + bh), fill=BOX_RGBA)
    for i, (ln, w) in enumerate(zip(lines, widths)):
        x = x0 + bw - pad - w if rtl else (width - w) / 2
        y = y0 + pad + i * lh
        s, kw = br.shaped(ln)
        if kw.get("language") and lang:
            kw = {**kw, "language": lang}
        try:
            d.text((x, y), s, font=font, fill=(255, 255, 255, 255), **kw)
        except (KeyError, ValueError, OSError):
            d.text((x, y), s, font=font, fill=(255, 255, 255, 255))
    return img


def _burn_pillow(src: Path, dst: Path, items: list[Cue], language, width, height, work: Path, timeout,
                 encode, scale=1.0, chars=None) -> None:
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    laid = [_layout(c, language, width, height, probe, scale, chars) for c in items]
    strip_h = max(_metrics(font)[0] * len(lines) + 2 * _metrics(font)[1] for _, font, lines in laid)
    strip_h += strip_h % 2
    Image.new("RGBA", (width, strip_h), (0, 0, 0, 0)).save(work / "blank.png")
    # an hour of talk repeats itself ("Yes.", "Right."): each distinct cue is drawn once
    cache: dict[tuple, str] = {}
    rows = ["ffconcat version 1.0"]
    # whole milliseconds from the start, so an hour of rounded durations doesn't drift off the speech
    t = 0

    def add(name: str, until: int) -> None:
        nonlocal t
        rows.extend([f"file '{name}'", f"duration {(until - t) / 1000:.3f}"])
        t = until

    for c, (fam, font, lines) in zip(items, laid):
        start, end = max(round(c.start * 1000), t), round(c.end * 1000)
        if end - start < 10:
            continue
        if start > t:
            add("blank.png", start)
        key = (fam, font.size, lines)
        if key not in cache:
            name = f"c{len(cache):05d}.png"
            cue_image(lines, font, width, strip_h, rtl=br.is_rtl(c.text), lang=_lang(language, c.text)) \
                .save(work / name)
            cache[key] = name
        add(cache[key], end)
    add("blank.png", t + 1000)
    # the concat demuxer drops the last entry's duration unless the file is listed once more
    rows.append("file 'blank.png'")
    (work / "cues.txt").write_text("\n".join(rows) + "\n", encoding="utf-8")
    y = max(0, height - round(height * MARGIN_V) - strip_h)
    graph = f"[1:v]format=rgba[s];[0:v][s]overlay=0:{y}:format=auto[v]"
    _run(["-i", str(src), "-f", "concat", "-safe", "0", "-i", "cues.txt", "-filter_complex", graph,
          "-map", "[v]", *_out_args(dst, encode)], work, timeout)


# ---------------------------------------------------------------- the one entry point

def burn(src_video: Path, dst: Path, cues, *, language: str | None = None, width: int | None = None,
         height: int | None = None, timeout: int = 7200, encode: list[str] | None = None, scale: float = 1.0,
         chars: int | None = None, fade: float = 0.0) -> dict:
    """Burn `cues` into `src_video`, writing `dst`; the audio is copied untouched. `scale` sizes the type
    against the usual and `chars` caps a line (story videos: bigger captions, a narrower line on 9:16).
    `fade` fades each cue in over that many seconds; libass only, the Pillow fallback cuts them in.

    Returns {"renderer": "ass" | "pillow" | "none", "fonts_missing": [family, ...]}.
    """
    items = as_cues(cues)
    src, dst = Path(src_video).resolve(), Path(dst).resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not items:
        shutil.copyfile(src, dst)
        return {"renderer": "none", "fonts_missing": []}
    if not width or not height:
        info = br.video_info(src)
        width, height = info.width, info.height
    missing = sorted({f for f in (font_for(language, c.text) for c in items) if font_file(f) is None})
    if missing:
        log.warning("Subtitle fonts not found (%s); falling back to whatever covers the script", ", ".join(missing))
    renderer = renderer_for(items)
    work = Path(tempfile.mkdtemp(prefix=".subs-", dir=dst.parent))
    try:
        if renderer == "ass":
            try:
                _burn_ass(src, dst, items, language, width, height, work, timeout, encode, scale, chars, fade)
            except BurnError as e:
                log.warning("libass couldn't burn the subtitles, drawing them with Pillow: %s", e)
                renderer = "pillow"
        if renderer == "pillow":
            _burn_pillow(src, dst, items, language, width, height, work, timeout, encode, scale, chars)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"renderer": renderer, "fonts_missing": missing}
