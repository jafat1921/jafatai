"""RAW / HEIC / TIFF imports: keep the original, make an sRGB working copy browsers and Photo Studio can use.

Browsers can't show HEIC, TIFF or camera RAW, so these get a full-resolution JPEG (q97, 4:4:4) beside the
untouched original. RAW also keeps a 16-bit linear master (name.master.tif) that Develop prefers. EXIF that
matters is written back into the working copy so exports from Photo Studio still say which camera took it.
"""
import io
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
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


def decode_raw_linear(src: Path) -> np.ndarray:
    """16-bit linear sRGB-primaries RGB, highlights reconstructed rather than clipped, no auto brightening
    (the gain is ours, see auto_gain). LibRaw already applies the orientation."""
    import rawpy

    try:
        with rawpy.imread(str(src)) as raw:
            rgb = raw.postprocess(use_camera_wb=True, output_color=rawpy.ColorSpace.sRGB, output_bps=16,
                                  gamma=(1, 1), no_auto_bright=True,
                                  highlight_mode=rawpy.HighlightMode.ReconstructDefault)
    except (rawpy.LibRawError, OSError) as e:
        raise ConvertError(f"This RAW file couldn't be decoded ({type(e).__name__})") from None
    if rgb.dtype != np.uint16:
        rgb = rgb.astype(np.uint16) * 257
    return rgb


def auto_gain(lin16: np.ndarray) -> float:
    """LibRaw's auto-bright, done here so the JPEG and the master agree: the brightest 1 % goes to white."""
    probe = lin16[::4, ::4].max(axis=-1)
    white = float(np.percentile(probe, 99)) / 65535 if probe.size else 1.0
    return float(min(8.0, max(1.0, 1.0 / white))) if white > 1e-4 else 1.0


def _decode(src: Path, media_type: str) -> Image.Image:
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
    if media_type == "image/x-raw":
        return _raw_copy(src, dest, exif)
    im = _decode(src, media_type)
    w, h = im.size
    if w * h > MAX_PIXELS:
        raise ConvertError(f"That image is {w}×{h}; the limit is {MAX_PIXELS // 1_000_000} megapixels")
    tmp = dest.with_name(dest.name + ".tmp")
    im.save(tmp, "JPEG", quality=JPEG_Q, subsampling=0, optimize=False, exif=_exif_bytes(exif))
    tmp.replace(dest)
    return Working(dest, w, h)


def _raw_copy(src: Path, dest: Path, exif: Exif) -> Working:
    """RAW: a 16-bit linear master for Develop (exposure and highlights can reach what the JPEG clipped)
    and the JPEG working copy made from the very same pixels, so the two match on screen."""
    from app.photo import develop as dv

    lin = decode_raw_linear(src)
    h, w = lin.shape[:2]
    if w * h > MAX_PIXELS:
        raise ConvertError(f"That image is {w}×{h}; the limit is {MAX_PIXELS // 1_000_000} megapixels")
    gain = auto_gain(lin)
    dv.write_master(dv.master_path(dest), lin, gain)
    shown = dv.quantise(dv.enc(np.minimum(lin.astype(np.float32) * np.float32(gain / 65535), 1.0)))
    del lin
    tmp = dest.with_name(dest.name + ".tmp")
    Image.fromarray(shown).save(tmp, "JPEG", quality=JPEG_Q, subsampling=0, optimize=False, exif=_exif_bytes(exif))
    tmp.replace(dest)
    return Working(dest, w, h)
