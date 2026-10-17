"""Small WebP previews for the library grids.

Tiles used to load the full file: for an item whose current version is a 4K upscale that's a 20-40 MB
PNG per tile, and project renders were drawn as <video> (frame 0 of a fade-in is black). Thumbs sit
next to their file as <stem>.thumb<w>.webp. The worker makes them when a job finishes, uploads make
them on the spot, and GET /api/media/thumb/{id} makes any that are missing, so older libraries fill
themselves in as people browse. Audio gets one waveform PNG instead (<stem>.wave.png), whatever the width.
A 3D model (contract v40) can't be drawn here, so its thumbs are made from the picture it was made from,
until a turntable frame or a viewer snapshot replaces them (set_model_thumb).
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
WAVE_SIZE = "800x160"
WAVE_COLOUR = "0xb8892f"  # the Antique Atelier gold


def wave_file(src: Path) -> Path:
    return src.with_name(f"{src.stem}.wave.png")


def files_for(src: Path) -> list[Path]:
    # plus the sidecars other modules keep beside a file (audio peaks / analysis, mix stems), so they go with it
    extra = [src.with_name(f"{src.stem}.{s}") for s in ("peaks.json", "analysis.json", "stems.zip")]
    return [thumb_file(src, w) for w in SIZES] + [wave_file(src)] + extra


def thumb_file(src: Path, w: int) -> Path:
    return src.with_name(f"{src.stem}.thumb{w}.webp")


def has_preview(media_type: str | None) -> bool:
    mt = media_type or ""
    return mt.startswith(("image/", "video/", "audio/", "model/"))


def url_for(g, w: int = DEFAULT) -> str | None:
    """The tile URL for a finished image/video/audio generation; None while it has nothing to show."""
    from app.services import READY_STATES

    if g is None or g.status not in READY_STATES or not g.file_path or not has_preview(g.media_type):
        return None
    # a model's thumb can be replaced, and the route caches for a week: the version busts that
    v = (g.params or {}).get("thumb_v") if (g.media_type or "").startswith("model/") else None
    return f"/api/media/thumb/{g.id}?w={w}" + (f"&v={v}" if v else "")


def _poster(src: Path, times: tuple[float, ...] = (POSTER_AT, 0.0)) -> Image.Image | None:
    ff = get_settings().ffmpeg_path()
    for at in times:  # clips shorter than a second have no frame at 1 s
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


def waveform(src: Path) -> Path | None:
    dest = wave_file(src)
    if dest.is_file():
        return dest
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex[:8]}.png")
    # showwavespic draws on a transparent background; mono so stereo doesn't split into two thin strips
    cmd = [get_settings().ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(src),
           "-filter_complex", f"aformat=channel_layouts=mono,showwavespic=s={WAVE_SIZE}:colors={WAVE_COLOUR}",
           "-frames:v", "1", str(tmp)]
    try:
        subprocess.run(cmd, capture_output=True, timeout=120, check=True)
        os.replace(tmp, dest)
    except (subprocess.SubprocessError, OSError):
        log.warning("couldn't draw a waveform for %s", src, exc_info=True)
        return None
    finally:
        tmp.unlink(missing_ok=True)
    return dest


def ensure(src: Path, media_type: str | None, w: int = DEFAULT) -> Path | None:
    """The thumb for src at width w, made now if it isn't there. None if the file can't be read."""
    if w not in SIZES or not has_preview(media_type) or not src.is_file():
        return None
    if (media_type or "").startswith("audio/"):
        return waveform(src)
    dest = thumb_file(src, w)
    if dest.is_file():
        return dest
    if (media_type or "").startswith("model/"):
        return None  # only model_thumbs() can make these: it knows the source picture
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
    if (media_type or "").startswith("audio/"):
        return ok
    return ensure(src, media_type, 256) is not None and ok


def remove_for(src: Path) -> None:
    for f in files_for(src):
        f.unlink(missing_ok=True)


def for_generation(g) -> bool:
    from app.services import READY_STATES

    if g is None or g.status not in READY_STATES or not g.file_path or not has_preview(g.media_type):
        return False
    if (g.media_type or "").startswith("model/"):
        return model_thumbs(g)
    return ensure_all(get_settings().data_dir / g.file_path, g.media_type)


def model_thumbs(g) -> bool:
    """Thumbs beside a GLB, cut from its source picture (a turntable frame replaces them later)."""
    from app.db import SessionLocal
    from app.models import Generation

    root = get_settings().data_dir
    model = root / g.file_path
    if all(thumb_file(model, w).is_file() for w in SIZES):
        return True
    source_id = ((g.params or {}).get("model3d") or {}).get("source_id")
    with SessionLocal() as db:
        src = db.get(Generation, source_id) if source_id else None
        rel = src.file_path if src is not None and src.workspace_id == g.workspace_id else None
    pic = root / rel if rel else None
    if pic is None or not pic.is_file():
        return False
    try:
        for w in SIZES:
            with Image.open(pic) as im:
                im.draft("RGB", (w, w))
                _save(_shrink(im, w), thumb_file(model, w))
    except (OSError, ValueError, Image.DecompressionBombError):
        log.warning("couldn't make a thumb for %s from %s", g.id, pic, exc_info=True)
        return False
    return True


def first_frame(src: Path) -> Image.Image | None:
    return _poster(src, (0.0,))


def set_model_thumb(model: Path, im: Image.Image) -> None:
    """Replace a GLB's thumbs with im (a turntable's first frame or a snapshot from the viewer)."""
    for w in SIZES:
        _save(_shrink(im.copy(), w), thumb_file(model, w))


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
        if (g.media_type or "").startswith("model/"):
            if all(thumb_file(src, w).is_file() for w in SIZES):
                continue
            made, failed = (made + 1, failed) if model_thumbs(g) else (made, failed + 1)
            continue
        if (g.media_type or "").startswith("audio/"):
            if wave_file(src).is_file():
                continue
        elif all(thumb_file(src, w).is_file() for w in SIZES):
            continue
        if ensure_all(src, g.media_type):
            made += 1
        else:
            failed += 1
            log_to(f"  no thumb for {g.id} ({g.file_path})")
    return made, failed
