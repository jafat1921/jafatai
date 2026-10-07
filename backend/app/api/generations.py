from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.ai_jobs import rewrite_prompt_from_note
from app import models_catalog, reel, storyboard, upscale, upscale_image
from app.api.media import resolve_media_path
from app.config import get_settings
from app.models import Generation, Job, Location, Project, Shot, utcnow
from app.schemas import (
    GenerationCreate, GenerationOut, GenerationPatch, JobOut, RegenerateIn, RejectIn, RenderOut, UpscaleIn,
)
from app.security import CurrentUser, get_current_user, require_editor
from app.services import (
    READY_STATES, approve, enqueue_generation, gen_out, get_owned, job_out, new_seed, resolve_target_project,
)

router = APIRouter(prefix="/generations", tags=["generations"])


@router.get("", response_model=list[GenerationOut])
def list_generations(
    target_type: str | None = None,
    target_id: str | None = None,
    kind: str | None = None,
    project_id: str | None = None,
    include_rejected: bool = False,
    db: Session = Depends(get_db),
    cur: CurrentUser = Depends(get_current_user),
):
    q = select(Generation).where(Generation.workspace_id == cur.workspace_id)
    if target_type:
        q = q.where(Generation.target_type == target_type)
    if target_id:
        q = q.where(Generation.target_id == target_id)
    if kind:
        q = q.where(Generation.kind == kind)
    if project_id:
        q = q.where(Generation.project_id == project_id)
    if not include_rejected:
        q = q.where(Generation.status != "rejected")
    q = q.order_by(Generation.version.desc(), Generation.created_at.desc()).limit(500)
    return [gen_out(g) for g in db.scalars(q).all()]


@router.get("/{gen_id}", response_model=GenerationOut)
def get_generation(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    # Quick Create resolves its preview_ids one by one
    return gen_out(get_owned(db, Generation, gen_id, cur.workspace_id, "Generation"))


@router.post("", response_model=GenerationOut, status_code=201)
def create_generation(body: GenerationCreate, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    project_id = resolve_target_project(db, cur.workspace_id, body.target_type, body.target_id)
    params = dict(body.params)
    seed = params.pop("seed", None)
    prompt = body.prompt
    if body.target_type == "shot":
        prompt, params = storyboard.prepare_shot_generation(db, db.get(Shot, body.target_id), body.kind, prompt, params)
    elif body.target_type == "location":
        prompt, params = storyboard.prepare_location_generation(
            db, db.get(Location, body.target_id), body.kind, prompt, params)
    elif not prompt.strip():
        raise HTTPException(422, "A prompt is required")
    if body.target_type == "character" and body.kind == "portrait":
        project = db.get(Project, project_id) if project_id else None
        models_catalog.apply_image_choice(params, project.settings if project else None)
    g = enqueue_generation(
        db,
        workspace_id=cur.workspace_id,
        project_id=project_id,
        target_type=body.target_type,
        target_id=body.target_id,
        kind=body.kind,
        prompt=prompt,
        params=params,
        seed=int(seed) if seed is not None else None,
    )
    db.commit()
    return gen_out(g)


@router.post("/{gen_id}/regenerate", response_model=GenerationOut, status_code=201)
def regenerate(gen_id: str, body: RegenerateIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    parent = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    prompt, params, seed, note = parent.prompt, dict(parent.params or {}), new_seed(), None
    # regenerating an upscaled image makes a fresh picture, not another upscale of its source
    if parent.kind in upscale_image.IMAGE_KINDS and params.pop("upscale", None) is not None:
        params.pop("size", None)
    rewrite_failed = None

    if body.mode == "note":
        if not (body.note and body.note.strip()):
            raise HTTPException(422, "A note is required for mode=note")
        note = body.note.strip()
        # creative LLM folds the note into the prompt; if it can't, the note is appended and flagged
        prompt, rewrite_failed = rewrite_prompt_from_note(parent.prompt, note)
    elif body.mode == "edit":
        if body.prompt is not None:
            if not body.prompt.strip():
                raise HTTPException(422, "Prompt can't be empty")
            prompt = body.prompt
        if body.params:
            params.update(body.params)
        if "seed" in params:
            seed = int(params.pop("seed"))

    if parent.target_type == "shot":
        shot = db.get(Shot, parent.target_id)
        if shot is None:
            raise HTTPException(404, "Shot not found")
        if parent.kind == "take":
            # frames may have been re-approved since; a take always renders from the current pair
            for k in ("first_frame_id", "last_frame_id", "num_frames"):
                params.pop(k, None)
        elif parent.kind == "keyframe_start":
            prev, _ = storyboard.neighbours(db, shot)
            if storyboard.is_linked(shot, prev):
                raise HTTPException(409, storyboard.LINKED_DETAIL)
        if parent.kind == "take" or not prompt.strip():
            prompt, params = storyboard.prepare_shot_generation(db, shot, parent.kind, prompt, params)

    g = enqueue_generation(
        db,
        workspace_id=cur.workspace_id,
        project_id=parent.project_id,
        target_type=parent.target_type,
        target_id=parent.target_id,
        kind=parent.kind,
        prompt=prompt,
        params=params,
        seed=seed,
        parent_id=parent.id,
        note=note,
    )
    if rewrite_failed:
        job = db.get(Job, g.job_id)
        job.message = f"Waiting for a worker · note appended, AI rewrite unavailable ({rewrite_failed})"[:500]
    db.commit()
    return gen_out(g)


@router.post("/{gen_id}/approve", response_model=GenerationOut)
def approve_generation(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    g = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    approve(db, g)
    db.commit()
    return gen_out(g)


@router.post("/{gen_id}/unapprove", response_model=GenerationOut)
def unapprove_generation(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    g = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    if g.status != "approved":
        raise HTTPException(409, "This generation isn't approved")
    g.status = "ready"
    g.approved_at = None
    db.commit()
    return gen_out(g)


@router.post("/{gen_id}/reject", response_model=GenerationOut)
def reject_generation(
    gen_id: str, body: RejectIn | None = None, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)
):
    g = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    if g.status not in ("ready", "approved", "failed", "rejected"):
        raise HTTPException(409, f"Can't reject a generation that is {g.status}")
    g.status = "rejected"
    g.approved_at = None
    if body and body.reason:
        g.reject_reason = body.reason
    db.commit()
    return gen_out(g)


@router.patch("/{gen_id}", response_model=RenderOut)
def rename_generation(gen_id: str, body: GenerationPatch, db: Session = Depends(get_db),
                      cur: CurrentUser = Depends(require_editor)):
    g = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    if g.kind != "render":
        raise HTTPException(422, "Only stitched videos can be renamed")
    title = body.title.strip()
    if not title:
        raise HTTPException(422, "The name can't be blank")
    # a new dict, so the JSON column registers the change
    g.params = {**(g.params or {}), "title": title, "title_auto": False}
    g.updated_at = utcnow()
    db.commit()
    return reel.render_out(g)


@router.get("/{gen_id}/download")
def download_generation(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    g = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    path = resolve_media_path(g.file_path or "", cur.workspace_id, get_settings().data_dir)
    if path is None or g.status not in READY_STATES:
        raise HTTPException(404, "This file isn't available")
    name = reel.download_name(db.get(Project, g.project_id) if g.project_id else None, g)
    return FileResponse(path, media_type=g.media_type or None, filename=name,
                        headers={"Cache-Control": "private, no-store"})


@router.post("/{gen_id}/restore", response_model=GenerationOut)
def restore_generation(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    g = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    if g.status != "rejected":
        raise HTTPException(409, "Only rejected generations can be restored")
    # a rejected failure has no media, so it goes back to failed rather than ready
    g.status = "ready" if g.file_path else "failed"
    g.reject_reason = None
    g.updated_at = utcnow()
    db.commit()
    return gen_out(g)


@router.post("/{gen_id}/upscale", response_model=JobOut, status_code=202)
def upscale_generation(gen_id: str, body: UpscaleIn, db: Session = Depends(get_db),
                       cur: CurrentUser = Depends(require_editor)):
    g = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    try:
        if upscale_image.is_image(g):
            job = upscale_image.queue_image_upscale(db, g, body.engine, body.target, body.variant, body.denoise,
                                                    body.prompt, user_id=cur.id)
        else:
            if body.engine in ("redraw", "faithful", "zimage") or body.target in ("2x", "4x", "2k"):
                raise upscale.UpscaleError(f"'{body.engine or body.target}' is for images; videos take "
                                           "best/fast/quick and 1080p/1440p/4k")
            job = upscale.queue_upscale(db, g, body.engine, body.target or "1080p", body.variant, user_id=cur.id)
    except upscale.UpscaleError as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return job_out(job)
