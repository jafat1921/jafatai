"""EXIF out of any photo we accept (JPEG, PNG, WebP, TIFF, HEIC, camera RAW) via exifread.

Pillow only knows JPEG/TIFF EXIF well and nothing about NEF or CR3, so one pure-Python reader covers
every format and the catalogue columns stay consistent whatever came in.
"""
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from fractions import Fraction
from pathlib import Path

log = logging.getLogger("mixai.catalogue")
# "PNG file does not have exif data" for every screenshot is noise in the server log
logging.getLogger("exifread").setLevel(logging.ERROR)

SKIP = ("JPEGThumbnail", "TIFFThumbnail", "Filename", "EXIF MakerNote", "Thumbnail ")
MAX_KEYS = 160


@dataclass
class Exif:
    captured_at: datetime | None = None  # naive UTC, like every other DateTime column
    camera: str | None = None
    lens: str | None = None
    focal_mm: float | None = None
    aperture: float | None = None
    shutter_s: float | None = None
    iso: int | None = None
    gps_lat: float | None = None
    gps_lng: float | None = None
    orientation: int | None = None
    raw: dict = field(default_factory=dict)  # every readable tag as text, for the Metadata panel


def _num(v) -> float | None:
    try:
        x = v.values if hasattr(v, "values") else v
        # rationals from cameras, doubles from some editors (exifread wraps those in a 1-tuple)
        while isinstance(x, (list, tuple)):
            x = x[0]
        return float(Fraction(x.num, x.den)) if hasattr(x, "num") else float(x)
    except (TypeError, ValueError, ZeroDivisionError, IndexError, AttributeError):
        return None


def _text(v) -> str | None:
    s = str(v).strip().strip("\x00").strip() if v is not None else ""
    return s or None


def _when(tags: dict) -> datetime | None:
    raw = _text(tags.get("EXIF DateTimeOriginal") or tags.get("Image DateTime"))
    if not raw:
        return None
    try:
        at = datetime.strptime(raw[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None
    off = _text(tags.get("EXIF OffsetTimeOriginal") or tags.get("EXIF OffsetTime"))
    if off and len(off) >= 6 and off[0] in "+-":
        try:
            sign = 1 if off[0] == "+" else -1
            delta = timedelta(hours=int(off[1:3]), minutes=int(off[4:6]))
            return (at - sign * delta).replace(tzinfo=None)
        except ValueError:
            pass
    # no offset written: camera clock time, kept as is (most cameras don't record a zone)
    return at


def _gps(tags: dict, key: str, ref_key: str) -> float | None:
    v = tags.get(key)
    if v is None or not getattr(v, "values", None) or len(v.values) < 3:
        return None
    try:
        d, m, s = (float(Fraction(x.num, x.den)) if x.den else 0.0 for x in v.values[:3])
    except (AttributeError, ZeroDivisionError):
        return None
    val = d + m / 60 + s / 3600
    ref = _text(tags.get(ref_key)) or ""
    return round(-val if ref.upper() in ("S", "W") else val, 6)


def camera_name(make: str | None, model: str | None) -> str | None:
    # "NIKON CORPORATION" + "NIKON Z 8" reads better as "NIKON Z 8"
    if not model:
        return make
    if not make:
        return model
    first = make.split()[0]
    return model if model.lower().startswith(first.lower()) else f"{first} {model}"


def read(path: Path) -> Exif:
    import exifread

    try:
        with open(path, "rb") as f:
            tags = exifread.process_file(f, details=False)
    except Exception:  # exifread raises plain Exceptions on odd files; EXIF is a nice-to-have
        log.info("no EXIF in %s", path.name, exc_info=True)
        return Exif()
    if not tags:
        return Exif()
    e = Exif()
    e.captured_at = _when(tags)
    e.camera = camera_name(_text(tags.get("Image Make")), _text(tags.get("Image Model")))
    e.lens = _text(tags.get("EXIF LensModel") or tags.get("MakerNote LensModel"))
    e.focal_mm = _num(tags.get("EXIF FocalLength"))
    e.aperture = _num(tags.get("EXIF FNumber"))
    e.shutter_s = _num(tags.get("EXIF ExposureTime"))
    iso = _num(tags.get("EXIF ISOSpeedRatings") or tags.get("EXIF PhotographicSensitivity"))
    e.iso = int(iso) if iso else None
    e.gps_lat = _gps(tags, "GPS GPSLatitude", "GPS GPSLatitudeRef")
    e.gps_lng = _gps(tags, "GPS GPSLongitude", "GPS GPSLongitudeRef")
    o = _num(tags.get("Image Orientation"))
    e.orientation = int(o) if o else None
    for k, v in tags.items():
        if len(e.raw) >= MAX_KEYS or any(k.startswith(p) for p in SKIP):
            continue
        s = _text(v)
        if s and len(s) <= 200:
            e.raw[k] = s
    return e


def shutter_text(s: float | None) -> str | None:
    if not s:
        return None
    if s >= 1:
        return f"{s:g}s"
    return f"1/{round(1 / s)}"
