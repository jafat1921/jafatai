"""RAW / HEIC / TIFF imports: keep the original, make an sRGB working copy browsers and Photo Studio can use.

Browsers can't show HEIC, TIFF or camera RAW, and develop.py works on 8-bit sRGB, so these get a
full-resolution JPEG (q97, 4:4:4) beside the untouched original. EXIF that matters is written back into
the working copy so exports from Photo Studio still say which camera took the picture.
"""
import io
import logging
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageCms, ImageOps

from app.catalogue.exif import Exif

log = logging.getLogger("mixai.catalogue")

RAW_EXT = {".nef", ".nrw", ".cr2", ".cr3", ".arw", ".srf", ".sr2", ".raf", ".orf", ".rw2", ".dng", ".pef",
           ".srw", ".3fr", ".iiq", ".erf", ".x3f", ".kdc", ".mrw", ".rwl"}
HEIC_EXT = {".heic", ".heif", ".hif"}
TIFF_EXT = {".tif", ".tiff"}
HEIF_BRANDS = (b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1")
MAX_PIXELS = 120_000_000  # 102 MP medium format still fits
JPEG_Q = 97


class ConvertError(ValueError):
    pass


def sniff(head: bytes, filename: str) -> str | None:
    """The extra still types the catalogue takes. TIFF-based RAWs only differ from TIFF by name."""
    ext = Path(filename).suffix.lower()
    tiffish = head[:4] in (b"II*\x00", b"MM\x00*")
    if ext in RAW_EXT and (tiffish or head[:4] in (b"IIRO", b"IIRS", b"IIU\x00") or head.startswith(b"FUJIFILMCCD-RAW")
                           or (head[4:8] == b"ftyp" and head[8:12] == b"crx ")):
        return "image/x-raw"
    if head[4:8] == b"ftyp" and head[8:12] in HEIF_BRANDS:
        return "image/heic"
    if tiffish:
        return "image/tiff"
    return None


@dataclass
class Working:
    path: Path
    width: int
    height: int


def _srgb(im: Image.Image) -> Image.Image:
    # iPhone HEICs are Display P3; showing them as sRGB without converting looks washed out
    icc = im.info.get("icc_profile")
    if not icc:
        return im.convert("RGB")
    try:
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        return ImageCms.profileToProfile(im.convert("RGB"), src, ImageCms.createProfile("sRGB"),
                                         renderingIntent=ImageCms.Intent.PERCEPTUAL, outputMode="RGB")
    except (ImageCms.PyCMSError, OSError):
        return im.convert("RGB")


def _decode(src: Path, media_type: str) -> Image.Image:
    if media_type == "image/x-raw":
        import rawpy

        try:
            with rawpy.imread(str(src)) as raw:
                rgb = raw.postprocess(use_camera_wb=True, output_color=rawpy.ColorSpace.sRGB, output_bps=8,
                                      no_auto_bright=False)
        except (rawpy.LibRawError, OSError) as e:
            raise ConvertError(f"This RAW file couldn't be decoded ({type(e).__name__})") from None
        return Image.fromarray(rgb)  # LibRaw already applied the orientation
    if media_type == "image/heic":
        import pillow_heif

        pillow_heif.register_heif_opener()
    try:
        im = Image.open(src)
        im.load()
    except (OSError, ValueError, Image.DecompressionBombError) as e:
        raise ConvertError(f"This {media_type.split('/')[1].upper()} couldn't be read ({type(e).__name__})") from None
    im = ImageOps.exif_transpose(im)
    if im.mode in ("I;16", "I;16B", "I"):
        # 16-bit greyscale scans: scale down to 8 bits by range, not by clipping
        im = im.point(lambda v: v / 256).convert("L")
    return _srgb(im)


def _exif_bytes(e: Exif) -> bytes:
    ex = Image.Exif()
    if e.camera:
        ex[0x0110] = e.camera  # Model
    sub = ex.get_ifd(0x8769)
    if e.captured_at:
        sub[0x9003] = e.captured_at.strftime("%Y:%m:%d %H:%M:%S")
    if e.shutter_s:
        sub[0x829A] = e.shutter_s
    if e.aperture:
        sub[0x829D] = e.aperture
    if e.iso:
        sub[0x8827] = e.iso
    if e.focal_mm:
        sub[0x920A] = e.focal_mm
    if e.lens:
        sub[0xA434] = e.lens
    return ex.tobytes()


def working_copy(src: Path, media_type: str, dest: Path, exif: Exif) -> Working:
    im = _decode(src, media_type)
    w, h = im.size
    if w * h > MAX_PIXELS:
        raise ConvertError(f"That image is {w}×{h}; the limit is {MAX_PIXELS // 1_000_000} megapixels")
    tmp = dest.with_name(dest.name + ".tmp")
    im.save(tmp, "JPEG", quality=JPEG_Q, subsampling=0, optimize=False, exif=_exif_bytes(exif))
    tmp.replace(dest)
    return Working(dest, w, h)
