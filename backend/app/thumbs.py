"""Small WebP previews for the library grids.

Tiles used to load the full file: for an item whose current version is a 4K upscale that's a 20-40 MB
PNG per tile, and project renders were drawn as <video> (frame 0 of a fade-in is black). Thumbs sit
next to their file as <stem>.thumb<w>.webp. The worker makes them when a job finishes, uploads make
them on the spot, and GET /api/media/thumb/{id} makes any that are missing, so older libraries fill
themselves in as people browse.
"""
import io
import logging
import os
import subprocess
import uuid
from pathlib import Path

from PIL import Image, ImageOps

from app.config import get_settings

log = logging.getLogger("mixai.thumbs")

# TODO: a --force on "manage thumbs" for when SIZES or QUALITY change; today old thumbs are kept as-is
SIZES = (256, 512)
DEFAULT = 512
QUALITY = 80
POSTER_AT = 1.0  # seconds in: past a fade from black, still the opening shot


def thumb_file(src: Path, w: int) -> Path:
    return src.with_name(f"{src.stem}.thumb{w}.webp")


def has_preview(media_type: str | None) -> bool:
    mt = media_type or ""
    return mt.startswith("image/") or mt.startswith("video/")


def url_for(g, w: int = DEFAULT) -> str | None:
    """The tile URL for a finished image/video generation; None while it has nothing to show."""
    from app.services import READY_STATES

    if g is None or g.status not in READY_STATES or not g.file_path or not has_preview(g.media_type):
        return None
    return f"/api/media/thumb/{g.id}?w={w}"


def _poster(src: Path) -> Image.Image | None:
    ff = get_settings().ffmpeg_path()
    for at in (POSTER_AT, 0.0):  # clips shorter than a second have no frame at 1 s
        cmd = [ff, "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{at:.2f}", "-i", str(src),
               "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=60, check=True).stdout
        except (subprocess.SubprocessError, OSError):
            continue
        if out:
            im = Image.open(io.BytesIO(out))
            im.load()
            return im
    return None


def _shrink(im: Image.Image, w: int) -> Image.Image:
    im = ImageOps.exif_transpose(im)
    im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
    im.thumbnail((w, w), Image.LANCZOS)
    return im


def _save(im: Image.Image, dest: Path) -> None:
    # write-then-rename so two tiles asking at once never see half a file
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        im.save(tmp, "WEBP", quality=QUALITY, method=4)
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


def _open(src: Path, media_type: str | None, w: int) -> Image.Image | None:
    if (media_type or "").startswith("video/"):
        return _poster(src)
    im = Image.open(src)
    im.draft("RGB", (w, w))  # JPEGs decode at a fraction of the size; a no-op for PNG
    return im


def ensure(src: Path, media_type: str | None, w: int = DEFAULT) -> Path | None:
    """The thumb for src at width w, made now if it isn't there. None if the file can't be read."""
    if w not in SIZES or not has_preview(media_type) or not src.is_file():
        return None
    dest = thumb_file(src, w)
    if dest.is_file():
        return dest
    try:
        # the small one comes from the big one when that already exists: far cheaper than a 4K decode
        base = thumb_file(src, DEFAULT)
        im = Image.open(base) if w < DEFAULT and base.is_file() else _open(src, media_type, w)
        if im is None:
            return None
        with im:
            _save(_shrink(im, w), dest)
    except (OSError, ValueError, Image.DecompressionBombError):
        log.warning("couldn't make a thumb for %s", src, exc_info=True)
        return None
    return dest


def ensure_all(src: Path, media_type: str | None) -> bool:
    ok = ensure(src, media_type, DEFAULT) is not None
    return ensure(src, media_type, 256) is not None and ok


def remove_for(src: Path) -> None:
    for w in SIZES:
        thumb_file(src, w).unlink(missing_ok=True)


def for_generation(g) -> bool:
    from app.services import READY_STATES

    if g is None or g.status not in READY_STATES or not g.file_path or not has_preview(g.media_type):
        return False
    return ensure_all(get_settings().data_dir / g.file_path, g.media_type)


def on_job_finished(db, job) -> None:
    """Worker hook: thumbs for whatever the job just made, so the grid never has to wait for one."""
    from app.models import Generation

    if job.status != "done" or not job.generation_id:
        return
    for_generation(db.get(Generation, job.generation_id))


def backfill(db, workspace_id: str | None = None, log_to=print) -> tuple[int, int]:
    """manage thumbs: every finished image/video without both thumbs. Returns (made, failed)."""
    from sqlalchemy import select

    from app.models import Generation
    from app.services import READY_STATES

    q = select(Generation).where(Generation.status.in_(READY_STATES), Generation.file_path.is_not(None))
    if workspace_id:
        q = q.where(Generation.workspace_id == workspace_id)
    made = failed = 0
    root = get_settings().data_dir
    for g in db.scalars(q.execution_options(yield_per=200)):
        if not has_preview(g.media_type):
            continue
        src = root / g.file_path
        if all(thumb_file(src, w).is_file() for w in SIZES):
            continue
        if ensure_all(src, g.media_type):
            made += 1
        else:
            failed += 1
            log_to(f"  no thumb for {g.id} ({g.file_path})")
    return made, failed
