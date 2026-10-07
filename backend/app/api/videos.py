"""Create Video (contract v6): one prompt (plus an optional start image) to one clip in the Library."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import brand
from app import library as lib
from app import longtake
from app import models_catalog as mc
from app.config import get_settings
from app.db import get_db
from app.drivers.comfy import HQ_SIZES, VIDEO_SIZES, WAN_SIZES
from app.models import Generation, Job, MediaItem, new_id
from app.schemas import VideoGenerateIn, VideoGenerateOut
from app.security import CurrentUser, require_editor
from app.services import enqueue_generation, job_out

router = APIRouter(prefix="/videos", tags=["videos"])


def _start_image(db: Session, workspace_id: str, image_id: str) -> Generation:
    """A Library image (MediaItem id) or any finished image generation id."""
    item = db.get(MediaItem, image_id)
    if item is not None and item.workspace_id == workspace_id:
        g = db.get(Generation, item.generation_id) if item.generation_id else None
    else:
        g = db.get(Generation, image_id)
        if g is not None and g.workspace_id != workspace_id:
            g = None
    if g is None:
        raise HTTPException(404, "Start image not found")
    if not (g.media_type or "").startswith("image/") or g.status not in lib.FINISHED or not g.file_path:
        raise HTTPException(422, "The start image isn't a finished image")
    return g


def _size(m: mc.Model, aspect: str) -> tuple[int, int]:
    table = {"wan22_t2v": WAN_SIZES, "ltx23_hq": HQ_SIZES}.get(m.id, VIDEO_SIZES)
    return table.get(aspect, table["16:9"])


@router.post("/generate", response_model=VideoGenerateOut, status_code=202)
def generate_video(body: VideoGenerateIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(422, "A prompt is required")
    m = mc.get(body.model, "video")
    mc.check_video(m, has_image=bool(body.image_id), duration_s=body.duration_s, smooth_motion=body.smooth_motion)
    top = get_settings().longtake_max_s
    if body.duration_s > top:
        raise HTTPException(422, f"duration_s must be at most {top:g} seconds")
    long_take = m.id == "ltx23_distilled" and longtake.is_long(body.duration_s)
    if long_take and body.smooth_motion:
        raise HTTPException(422, f"Smooth motion works on clips up to {mc.SINGLE_PASS_S:.1f} s; "
                                 "turn it off or make the clip shorter")
    start = _start_image(db, cur.workspace_id, body.image_id) if body.image_id else None

    w, h = _size(m, body.aspect)
    fps = mc.WAN_FPS if m.id == "wan22_t2v" else longtake.FPS
    frames = mc.video_frames(m, body.duration_s, fps)
    # Wan is capped at its trained 81 frames, so report what it will really make
    duration = round((frames - 1) / fps, 3) if m.id == "wan22_t2v" else body.duration_s
    params = {"model": m.id, "aspect_ratio": body.aspect, "duration_s": duration, "fps": fps,
              "num_frames": frames, "width": w, "height": h,
              "smooth_motion": body.smooth_motion, "user_prompt": prompt,
              "created_by": {"user_id": cur.id, "flow": "video_generate"}}
    if m.id == "ltx23_hq":
        params["quality"] = "hq"
    if start is not None:
        params["first_frame_id"] = start.id
    if body.negative:
        params["negative"] = body.negative.strip()
    if long_take:
        longtake.init_params(params)

    prompt, params = brand.apply_to_request(db, cur.workspace_id, body.brand_kit_id, prompt, params)
    title = (body.title or "").strip() or lib.short_title(body.prompt)
    item = MediaItem(id=new_id(), workspace_id=cur.workspace_id, kind="video", origin="generated", title=title,
                     tags=[], width=w, height=h, duration_s=params["duration_s"])
    db.add(item)
    db.flush()
    g = enqueue_generation(db, workspace_id=cur.workspace_id, project_id=None, target_type="media",
                           target_id=item.id, kind="video", prompt=prompt, params=params, seed=body.seed)
    item.generation_id = g.id
    job = db.get(Job, g.job_id)
    db.commit()
    return VideoGenerateOut(**lib.item_out(db, item).model_dump(), job=job_out(job))
