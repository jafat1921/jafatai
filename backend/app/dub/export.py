"""MP4 assembly for a dubbed video (and the Transcribe page's "make subtitles"): the picture copied, one AAC
track per language with its language tag and title, soft mov_text subtitles or subtitles burned in."""
import zipfile
from dataclasses import dataclass
from pathlib import Path

from app import mixdown as md
from app.dub.engines import _ffmpeg
from app.voices import lang_name

# MP4 language boxes want ISO 639-2; the bibliographic codes are what players show most reliably
ISO639_2 = {
    "en": "eng", "ur": "urd", "hi": "hin", "pa": "pan", "sd": "snd", "ps": "pus", "bn": "ben", "ar": "ara",
    "fa": "per", "es": "spa", "fr": "fre", "de": "ger", "zh": "chi", "yue": "yue", "ja": "jpn", "ko": "kor",
    "tr": "tur", "ru": "rus", "pt": "por", "it": "ita", "id": "ind", "ms": "may", "sw": "swa", "ta": "tam",
    "te": "tel", "mr": "mar", "gu": "guj", "kn": "kan", "ml": "mal", "or": "ori", "as": "asm", "ne": "nep",
    "si": "sin", "ks": "kas", "bal": "bal", "my": "bur", "th": "tha", "vi": "vie", "km": "khm", "lo": "lao",
    "tl": "tgl", "uk": "ukr", "pl": "pol", "nl": "dut", "sv": "swe", "da": "dan", "no": "nor", "fi": "fin",
    "el": "gre", "he": "heb", "cs": "cze", "ro": "rum", "hu": "hun", "bg": "bul", "sr": "srp", "hr": "hrv",
    "sk": "slo", "az": "aze", "kk": "kaz", "uz": "uzb", "tg": "tgk", "ku": "kur", "am": "amh", "ha": "hau",
    "yo": "yor", "ig": "ibo", "zu": "zul", "so": "som",
}
AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]


def iso3(code: str | None) -> str:
    code = (code or "").lower().split("-")[0]
    return ISO639_2.get(code) or (code if len(code) == 3 else "und")


@dataclass
class Stream:
    path: Path | None  # None: the source video's own audio
    lang: str | None
    title: str
    default: bool = False


def build_mp4(video: Path, dst: Path, audio: list[Stream], subs: list[Stream], *, burn: Path | None = None,
              work: Path, timeout: int = 3600) -> None:
    args = ["-i", str(video)]
    inputs = 1
    amaps, smaps = [], []
    for a in audio:
        if a.path is None:
            amaps.append("0:a:0")
        else:
            args += ["-i", str(a.path)]
            amaps.append(f"{inputs}:a:0")
            inputs += 1
    for s in subs:
        args += ["-i", str(s.path)]
        smaps.append(f"{inputs}:s:0")
        inputs += 1
    args += ["-map", "0:v:0"]
    for m in amaps:
        args += ["-map", m]
    for m in smaps:
        args += ["-map", m]
    if burn is not None:
        # libass parses the filter argument itself; a bare file name in the working dir dodges all the
        # escaping a Windows path (drive colon, backslashes) would need
        args += ["-vf", f"subtitles={burn.name}", *md.VIDEO_REENCODE]
    else:
        args += ["-c:v", "copy"]
    if audio:
        args += AUDIO_ARGS
    # MP4 keeps a track's name in its handler box; players show that one, mkv-minded tools read title
    for k, a in enumerate(audio):
        args += [f"-metadata:s:a:{k}", f"language={iso3(a.lang)}", f"-metadata:s:a:{k}", f"title={a.title}",
                 f"-metadata:s:a:{k}", f"handler_name={a.title}", f"-disposition:a:{k}",
                 "default" if a.default else "0"]
    if subs:
        args += ["-c:s", "mov_text"]
    for k, s in enumerate(subs):
        args += [f"-metadata:s:s:{k}", f"language={iso3(s.lang)}", f"-metadata:s:s:{k}", f"title={s.title}",
                 f"-metadata:s:s:{k}", f"handler_name={s.title}", f"-disposition:s:{k}", "0"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    _ffmpeg([*args, "-movflags", "+faststart", "-f", "mp4", str(dst)], timeout=timeout, cwd=work)


def dub_title(lang: str) -> str:
    return f"{lang_name(lang)} dub"


def stems_zip(dst: Path, files: dict[str, Path]) -> None:
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for name, path in files.items():
            if path.is_file():
                z.write(path, name)
