"""Streaming multipart uploads into the media folder (contract v5).

Starlette's own form parser spools the whole part to a temp file before the handler runs, so a 3 GB
upload would land on disk before we could say no. This parses the request stream ourselves: the file
part goes straight into a .part file next to its final home, the type is sniffed from the first bytes
and the size limit is enforced as the bytes arrive.
"""
import hashlib
import re
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from fastapi import HTTPException, Request
from PIL import Image
from python_multipart.multipart import MultipartParser, parse_options_header

from app.config import get_settings

MB = 1024 * 1024
IMAGE_MAX = 40 * MB
PHOTO_MAX = 250 * MB  # camera RAW, HEIC and TIFF (M10): a 100 MP RAW or a layered TIFF is big
VIDEO_MAX = 2048 * MB
MAX_PIXELS = 100_000_000  # a 40 MB JPEG can still decode to something silly
SNIFF_BYTES = 64
FIELDS = ("title", "album_id", "on_duplicate")

EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
       "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
       "font/ttf": ".ttf", "font/otf": ".otf", "image/svg+xml": ".svg"}
# what a file name may say for each sniffed type; mp4 and mov are the same container family
NAME_OK = {"image/png": {".png"}, "image/jpeg": {".jpg", ".jpeg", ".jfif"}, "image/webp": {".webp"},
           "video/mp4": {".mp4", ".m4v", ".mov"}, "video/quicktime": {".mov", ".mp4", ".m4v"},
           "video/webm": {".webm"}, "font/ttf": {".ttf"}, "font/otf": {".otf"}, "image/svg+xml": {".svg"}}
# ISO-BMFF brands that are stills or audio, not video
NOT_VIDEO_BRANDS = (b"avif", b"avis", b"heic", b"heix", b"heim", b"heis", b"mif1", b"msf1", b"M4A ", b"M4B ", b"M4P ")
ALLOWED = ("PNG, JPEG or WebP images up to 40 MB, camera RAW, HEIC or TIFF photos up to 250 MB, "
           "or MP4, MOV or WebM videos up to 2 GB")
# kept as uploaded and given a JPEG working copy (app.catalogue.convert)
CONVERTED = ("image/x-raw", "image/heic", "image/tiff")


def sniff(head: bytes, filename: str = "") -> str | None:
    from app.catalogue import convert

    extra = convert.sniff(head, filename)
    if extra:
        return extra
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in NOT_VIDEO_BRANDS:
            return None
        return "video/quicktime" if brand == b"qt  " else "video/mp4"
    if head[:4] == b"\x1a\x45\xdf\xa3" and b"webm" in head[:SNIFF_BYTES]:
        return "video/webm"
    return None


def limit_for(media_type: str) -> int:
    if media_type in CONVERTED:
        return PHOTO_MAX
    return IMAGE_MAX if media_type.startswith("image/") else VIDEO_MAX


def _too_big(media_type: str | None) -> HTTPException:
    if media_type in CONVERTED:
        return HTTPException(413, "RAW, HEIC and TIFF photos can be at most 250 MB")
    if media_type and media_type.startswith("image/"):
        return HTTPException(413, "Images can be at most 40 MB")
    return HTTPException(413, "Videos can be at most 2 GB")


@dataclass(frozen=True)
class Profile:
    """What one upload endpoint accepts: sniffer, per-type size limit, and the words for errors."""
    sniff: Callable[[bytes], str | None]
    limit: Callable[[str], int]
    too_big: Callable[[str | None], HTTPException]
    allowed: str
    max_bytes: int


MEDIA = Profile(sniff, limit_for, _too_big, ALLOWED, VIDEO_MAX)


@dataclass
class Received:
    path: Path
    media_type: str
    size: int
    filename: str
    title: str | None = None
    sha256: str | None = None
    fields: dict[str, str] = field(default_factory=dict)


@dataclass
class _Part:
    headers: dict[str, bytes] = field(default_factory=dict)
    name: str = ""
    filename: str | None = None


class _Sink:
    """Callbacks for python-multipart. Raises HTTPException from inside parser.write()."""

    def __init__(self, folder: Path, profile: Profile = MEDIA):
        self.folder = folder
        self.profile = profile
        self.part = _Part()
        self._hname = b""
        self._hvalue = b""
        self.file = None
        self.tmp: Path | None = None
        self.size = 0
        self.head = b""
        self.media_type: str | None = None
        self.filename = ""
        self.done = False  # a file part has been fully received
        self.fields: dict[str, bytes] = {}
        self._field = None
        self.hash = hashlib.sha256()

    def callbacks(self) -> dict:
        return {"on_part_begin": self.part_begin, "on_part_data": self.part_data, "on_part_end": self.part_end,
                "on_header_field": self.header_field, "on_header_value": self.header_value,
                "on_header_end": self.header_end, "on_headers_finished": self.headers_finished}

    def part_begin(self):
        self.part = _Part()

    def header_field(self, data, start, end):
        self._hname += data[start:end]

    def header_value(self, data, start, end):
        self._hvalue += data[start:end]

    def header_end(self):
        self.part.headers[self._hname.decode("latin-1").lower()] = self._hvalue
        self._hname = self._hvalue = b""

    def headers_finished(self):
        _, opts = parse_options_header(self.part.headers.get("content-disposition", b""))
        self.part.name = opts.get(b"name", b"").decode("utf-8", "replace")
        fn = opts.get(b"filename")
        self.part.filename = fn.decode("utf-8", "replace") if fn is not None else None
        if self.part.name == "file" and self.part.filename is not None and self.file is None and not self.done:
            self.folder.mkdir(parents=True, exist_ok=True)
            self.tmp = self.folder / f".upload-{uuid.uuid4().hex}.part"
            self.file = open(self.tmp, "wb")
            self.filename = self.part.filename
            self._field = None
        elif self.part.filename is None and self.part.name in FIELDS:
            self._field = self.part.name
            self.fields[self._field] = b""
        else:
            self._field = None

    def part_data(self, data, start, end):
        if self.file is not None and not self.done:
            chunk = data[start:end]
            self.size += len(chunk)
            if len(self.head) < SNIFF_BYTES:
                self.head += chunk[:SNIFF_BYTES - len(self.head)]
                if len(self.head) >= SNIFF_BYTES:
                    self._sniff()
            pr = self.profile
            if self.size > (pr.limit(self.media_type) if self.media_type else pr.max_bytes):
                raise pr.too_big(self.media_type)
            self.file.write(chunk)
            self.hash.update(chunk)
        elif self._field:
            buf = self.fields[self._field]
            if len(buf) < 2000:
                self.fields[self._field] = buf + data[start:end][:2000 - len(buf)]

    def part_end(self):
        if self.file is not None and not self.done:
            if self.media_type is None:
                self._sniff()
            self.file.close()
            self.done = True
        self._field = None

    def _sniff(self):
        pr = self.profile
        self.media_type = pr.sniff(self.head, self.filename) if pr.sniff is sniff else pr.sniff(self.head)
        if self.media_type is None:
            raise HTTPException(415, f"Unsupported file type. Upload {pr.allowed}.")
        ext = Path(self.filename).suffix.lower()
        if self.media_type in CONVERTED:
            pass  # sniff() already matched the name against the RAW / HEIC / TIFF extensions
        elif ext and ext not in NAME_OK[self.media_type]:
            kind = EXT[self.media_type].lstrip(".").upper()
            raise HTTPException(415, f"This file is a {kind} but its name ends in {ext}. Upload {pr.allowed}.")
        if self.size > pr.limit(self.media_type):
            raise pr.too_big(self.media_type)

    def close(self):
        if self.file is not None and not self.file.closed:
            self.file.close()

    def discard(self):
        self.close()
        if self.tmp is not None:
            self.tmp.unlink(missing_ok=True)


async def receive(request: Request, folder: Path, profile: Profile = MEDIA) -> Received:
    ctype, opts = parse_options_header(request.headers.get("content-type", ""))
    if ctype != b"multipart/form-data" or not opts.get(b"boundary"):
        raise HTTPException(415, "Send the file as multipart/form-data in a field named 'file'")
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > profile.max_bytes + MB:
        raise profile.too_big(None)
    sink = _Sink(folder, profile)
    parser = MultipartParser(opts[b"boundary"], callbacks=sink.callbacks())
    try:
        async for chunk in request.stream():
            parser.write(chunk)
        parser.finalize()
        if not sink.done:
            raise HTTPException(422, "No file in the upload (expected a field named 'file')")
        if sink.size == 0:
            raise HTTPException(422, "The file is empty")
    except BaseException:
        sink.discard()
        raise
    sink.close()
    fields = {k: v.decode("utf-8", "replace").strip() for k, v in sink.fields.items()}
    return Received(sink.tmp, sink.media_type, sink.size, sink.filename, fields.pop("title", "") or None,
                    sink.hash.hexdigest(), fields)


# ---------------------------------------------------------------- probing

@dataclass
class MediaInfo:
    width: int
    height: int
    duration_s: float | None = None
    fps: float | None = None
    has_audio: bool = False


_FPS = re.compile(r"Video: .*?, (\d+(?:\.\d+)?) (?:fps|tbr)")


def probe_image(path: Path, media_type: str) -> MediaInfo:
    fmt = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}[media_type]
    try:
        with Image.open(path) as im:
            if im.format != fmt:
                raise HTTPException(415, "The image header doesn't match its contents")
            w, h = im.size
            if w * h > MAX_PIXELS:
                raise HTTPException(413, f"That image is {w}×{h}; the limit is 100 megapixels")
            im.verify()
    except HTTPException:
        raise
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise HTTPException(415, "This image is damaged or not really an image") from None
    return MediaInfo(w, h)


def probe_video(path: Path) -> MediaInfo:
    from app import reel as rl

    p = rl.probe(path)
    if not p.has_video or not p.width:
        raise HTTPException(415, "This file has no readable video stream")
    err = subprocess.run([rl.ffmpeg(), "-hide_banner", "-nostdin", "-i", str(path)], capture_output=True, text=True,
                         encoding="utf-8", errors="replace", timeout=60).stderr
    m = _FPS.search(err)
    return MediaInfo(p.width, p.height, round(p.duration, 3) or None, float(m[1]) if m else None, p.has_audio)


def video_thumb(src: Path, dest: Path, duration_s: float | None) -> bool:
    at = min(1.0, (duration_s or 0) / 2)
    cmd = [get_settings().ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{at:.2f}",
           "-i", str(src), "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4", str(dest)]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    except (subprocess.SubprocessError, OSError):
        return False
    return dest.is_file()
