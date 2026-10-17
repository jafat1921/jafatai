"""3D Studio (contract v40): a picture, a prompt, a character or up to four views to a textured GLB.

A result is a MediaItem of kind "model" whose generations are kind "model3d" (target_type "media"), so
versions, deletes, favourites and downloads work like any other Library item. One picture runs through
app/workflows/trellis2_image_to_3d (Pixal3D or TRELLIS.2); several views of one object run through
pixal3d_multiview_to_3d. The engine and quality only change the graph's inputs.

params["model3d"] holds source_id (the picture, or the front view), views {front, left, back, right} for the
multi-view graph, and for a text start picture {generation_id, media_id, status}: the image the job waits
for (run_in_job) before it can run. "Better back" (addendum A) makes a side and a back view of one picture
first, with Character Studio's turnaround edit, and then runs the views graph: better_back {status, views
{left, back: {generation_id, media_id}}}. A logo (addendum B) never reaches the GPU; app.model3d_logo.

A turntable (part 3) is recorded in the browser and uploaded as an ordinary video item whose generation
carries params.model3d_of; the model's own generation then holds turntable_id, thumb_from and thumb_v.
"""
import hashlib
import logging
import subprocess
import uuid
from pathlib import Path

from PIL import Image

GEN_KIND = "model3d"
MEDIA_KIND = "model"
MEDIA_TYPE = "model/gltf-binary"
TEMPLATE = "trellis2_image_to_3d"
MULTIVIEW_TEMPLATE = "pixal3d_multiview_to_3d"
ENGINES = ("pixal3d", "trellis2")
DEFAULT_ENGINE = "pixal3d"
VIEWS = ("front", "left", "back", "right")
# working pictures made for a model (a text start) live with it, out of the Library grid (contract v37)
PART_HOME = "3d"
# better back: Pixal3D's views, and the turnaround panel each is drawn like (app.character_panels.VIEW_PROMPTS)
BACK_VIEWS = (("left", "side"), ("back", "back"))
BACK_EDIT_MODEL = "qwen_image_edit_2511"  # the multiple-angles LoRA is Qwen-only
BACK_FAILED = "The side and back views couldn't be made, so this model was made from the one picture."

log = logging.getLogger("mixai.model3d")

# Final is the official workflow's own settings; Draft trades detail for roughly half the time and VRAM
QUALITY = {
    "draft": {"upsample_resolution": 1024, "texture_size": 2048, "face_count": 200_000,
              "ao_resolution": 1024, "normal_resolution": 1024},
    "final": {"upsample_resolution": 1536, "texture_size": 4096, "face_count": 700_000,
              "ao_resolution": 1024, "normal_resolution": 2048},
}
QUALITY_LABELS = {"draft": "Draft", "final": "Final"}
# share of a Final run's time, for the estimate until the server has timings of its own
QUALITY_FACTOR = {"draft": 0.45, "final": 1.0}
# Pixal3D wants the subject padded a little (pad_factor 1.1), TRELLIS.2 cropped tight (1.0): the nodes' own advice
PAD = {"pixal3d": 1.1, "trellis2": 1.0}

# short on purpose: the image models follow a plain product-shot brief better than a long one
OBJECT_BRIEF = ("Single object, centred, whole object in frame, plain light background, soft studio lighting, "
                "product photo")
OBJECT_NEGATIVE = "text, letters, watermark, logo, several objects, cropped, cut off, busy background, shadows"


def object_head(prompt: str) -> str:
    return " ".join(prompt.split()).rstrip(" ,.")


def object_prompt(prompt: str) -> str:
    # a sentence of its own, so a magic prompt can swap the user's words and keep the brief (prompt_enhance.splice)
    return f"{object_head(prompt)}. {OBJECT_BRIEF}"


def has_transparency(path: Path) -> bool:
    try:
        with Image.open(path) as im:
            if "A" not in im.getbands() and "transparency" not in im.info:
                return False
            alpha = im.convert("RGBA").getchannel("A")
            return alpha.getextrema()[0] < 250
    except (OSError, ValueError):
        return False


def inputs_for(rec: dict, seed: int) -> dict:
    """Template inputs for a params["model3d"] record (the comfy driver's half of the job)."""
    quality = rec.get("quality") if rec.get("quality") in QUALITY else "final"
    base = {**QUALITY[quality], "remove_background": bool(rec.get("remove_background", True)), "seed": seed}
    if rec.get("views"):
        # photos need their field of view measured; turnaround panels are framed like the 20-degree rig
        return {**base, "pad_factor": PAD["pixal3d"], "measure_fov": bool(rec.get("measure_fov"))}
    engine = rec.get("engine") if rec.get("engine") in ENGINES else DEFAULT_ENGINE
    return {**base, "trellis2": engine == "trellis2", "pad_factor": PAD[engine]}


def template_of(rec: dict) -> str:
    return MULTIVIEW_TEMPLATE if rec.get("views") else TEMPLATE


# ---------------------------------------------------------------- characters

def character_views(db, character_id: str):
    """(views, picture) for a character: the turnaround panels as views when the sheet has a front and at
    least one more real angle, else the full-body hero or the portrait as one picture. A side panel is
    used as the left view only; it isn't mirrored into a right one."""
    from app import character_sheet as cs

    gens = cs.panel_gens(db, character_id)
    turn = {v: cs.current(gens.get(f"turn_{p}", [])) for v, p in (("front", "front"), ("left", "side"),
                                                                     ("back", "back"))}
    views = {v: g for v, g in turn.items() if g is not None}
    if "front" in views and len(views) >= 2:
        return views, None
    return None, cs.hero(db, character_id) or cs.portrait(db, character_id)


# ---------------------------------------------------------------- inside the job

LIVE = ("queued", "generating")
READY = ("ready", "approved")


class PictureFailed(RuntimeError):
    pass


def wait_on(ctx, gens, message: str) -> None:
    """Back to the queue (JobDeferred) while any of these generations is still being made."""
    from app import autopilot as ap
    from app import worker
    from app.models import Job

    live = [g for g in gens if g is not None and g.status in LIVE]
    if not live:
        return
    db, job = ctx.db, ctx.job
    ids = []
    for g in live:
        child = db.get(Job, g.job_id) if g.job_id else None
        if child is not None:
            # worker.wake_parent puts this job back at normal priority once they are all done
            child.payload = {**(child.payload or {}), "parent_job_id": job.id}
            ids.append(child.id)
    if ids:
        job.result = {"waiting_on": ids}
    ctx.progress(0.0, message)
    db.commit()
    raise worker.JobDeferred(message, priority=ap.WAIT_PRIORITY)


def run_in_job(ctx, gen) -> None:
    """The pre-steps (worker.handle_generate): a text start waits for its picture, which then becomes the
    source; better back waits for its side and back views. Raises JobDeferred while they're on their way."""
    rec = dict((gen.params or {}).get("model3d") or {})
    if (rec.get("picture") or {}).get("status") == "pending":
        _picture_step(ctx, gen, rec)
    if (rec.get("better_back") or {}).get("status") == "pending":
        _back_step(ctx, gen, rec)


def _picture_step(ctx, gen, rec: dict) -> None:
    from app.models import Generation, Job

    pic = dict(rec["picture"])
    db, job = ctx.db, ctx.job
    src = db.get(Generation, pic.get("generation_id") or "")
    wait_on(ctx, [src], "Making the picture first")
    if src is None or src.status not in READY or not src.file_path:
        child = db.get(Job, src.job_id) if src is not None and src.job_id else None
        why = f" ({child.error})" if child is not None and child.error else ""
        gen.params = {**gen.params, "model3d": {**rec, "picture": {**pic, "status": "failed"}}}
        db.commit()
        raise PictureFailed(f"The picture for this model couldn't be made{why}. Try another prompt.")
    rec.update(source_id=src.id, picture={**pic, "status": "done"})
    gen.params = {**gen.params, "model3d": rec}
    job.result = None
    db.commit()


def _back_step(ctx, gen, rec: dict) -> None:
    """The views graph with the made views beside the original, or the one picture if none came out."""
    from app.models import Generation

    db, job = ctx.db, ctx.job
    bb = dict(rec["better_back"])
    parts = bb.get("views") or {}
    gens = {v: db.get(Generation, p.get("generation_id") or "") for v, p in parts.items()}
    wait_on(ctx, list(gens.values()), "Making the side and back views first")
    ok = {v: g for v, g in gens.items() if g is not None and g.status in READY and g.file_path}
    if ok:
        views = {"front": rec["source_id"], **{v: ok[v].id for v, _ in BACK_VIEWS if v in ok}}
        media = {"front": rec.get("source_media_id"), **{v: parts[v].get("media_id") for v in ok}}
        rec.update(views=views, view_media={v: m for v, m in media.items() if m})
        missing = [v for v, _ in BACK_VIEWS if v not in ok]
        if missing:
            name = "side" if missing[0] == "left" else "back"
            rec["better_back_note"] = f"The {name} view couldn't be made, so the model used the others."
        bb["status"] = "done"
    else:
        rec["better_back_note"] = BACK_FAILED
        bb["status"] = "failed"
    rec["better_back"] = bb
    gen.params = {**gen.params, "model3d": rec}
    job.result = None
    db.commit()


def back_view_size(src) -> tuple[int, int]:
    # a person or figure is tall; anything squarer gets a square canvas to turn round in
    w, h = (src.params or {}).get("width"), (src.params or {}).get("height")
    if not (w and h):
        try:
            from app.config import get_settings

            with Image.open(get_settings().data_dir / src.file_path) as im:
                w, h = im.size
        except (OSError, TypeError):
            w = h = 1
    return (768, 1152) if h >= w * 1.2 else (1024, 1024)



# ---------------------------------------------------------------- turntables

# browsers record WebM; H.264 in MP4 is what phones, socials and Safari play
TURNTABLE_ENC = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                 "-r", "30", "-movflags", "+faststart"]


def webm_to_mp4(got) -> bool:
    """Swap a received WebM for an MP4 in place (path, type, name, size, hash). Keeps the WebM when ffmpeg
    can't: a turntable that only plays in some browsers beats no turntable."""
    from app import reel as rl

    dst = got.path.with_name(f".turntable-{uuid.uuid4().hex}.mp4")
    try:
        rl.run_ff(["-i", str(got.path), *TURNTABLE_ENC, str(dst)], timeout=300)
    except (rl.FFmpegError, OSError, subprocess.SubprocessError) as e:
        dst.unlink(missing_ok=True)
        log.warning("turntable stays WebM: %s", e)
        return False
    got.path.unlink(missing_ok=True)
    got.path, got.media_type = dst, "video/mp4"
    got.filename = f"{Path(got.filename or 'turntable').stem}.mp4"
    data = dst.read_bytes()
    got.size, got.sha256 = len(data), hashlib.sha256(data).hexdigest()
    return True
