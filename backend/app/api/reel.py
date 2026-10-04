from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import reel as rl
from app.db import get_db
from app.models import Generation, Job, Project, Reel, ReelClip, Scene, utcnow
from app.schemas import (
    AssembleIn, GenerationOut, JobOut, ReelClipOut, ReelClipPatch, ReelEstimateOut, ReelOut, ReelReorderIn,
)
from app.security import CurrentUser, get_current_user, require_editor
from app.services import gen_out, get_owned, job_out, new_seed, next_version

router = APIRouter(tags=["reel"])


def _synced(db: Session, project: Project) -> Reel:
    reel = rl.get_reel(db, project)
    rl.sync(db, reel)
    db.commit()
    return reel


@router.get("/projects/{project_id}/reel", response_model=ReelOut)
def get_reel(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return rl.reel_out(db, _synced(db, get_owned(db, Project, project_id, cur.workspace_id, "Project")))


@router.post("/projects/{project_id}/reel/sync", response_model=ReelOut)
def sync_reel(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    reel = _synced(db, get_owned(db, Project, project_id, cur.workspace_id, "Project"))
    reel.updated_at = utcnow()  # an explicit sync always announces itself over SSE
    db.commit()
    return rl.reel_out(db, reel)


@router.patch("/reel-clips/{clip_id}", response_model=ReelClipOut)
def patch_clip(clip_id: str, body: ReelClipPatch, db: Session = Depends(get_db),
               cur: CurrentUser = Depends(require_editor)):
    clip = get_owned(db, ReelClip, clip_id, cur.workspace_id, "Clip")
    data = body.model_dump(exclude_unset=True)
    trim_in = data.get("trim_in_s", clip.trim_in_s)
    trim_out = data.get("trim_out_s", clip.trim_out_s)
    if clip.source_duration_s and trim_in + trim_out > clip.source_duration_s - rl.MIN_CLIP:
        raise HTTPException(422, f"Trims leave less than {rl.MIN_CLIP}s of a {clip.source_duration_s:.2f}s take")
    for k, v in data.items():
        setattr(clip, k, v)
    reel = db.get(Reel, clip.reel_id)
    reel.updated_at = utcnow()
    db.commit()
    out = rl.reel_out(db, reel)
    found = next((c for s in out.scenes for c in s.clips if c.id == clip.id), None)
    if found is None:
        raise HTTPException(409, "This clip's shot no longer has an approved take")
    return found


@router.post("/projects/{project_id}/reel/reorder", response_model=ReelOut)
def reorder(project_id: str, body: ReelReorderIn, db: Session = Depends(get_db),
            cur: CurrentUser = Depends(require_editor)):
    project = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    reel = rl.get_reel(db, project)
    clips = {c.id: c for c in db.scalars(select(ReelClip).where(ReelClip.reel_id == reel.id)).all()}
    unknown = [i for i in body.clip_ids if i not in clips]
    if unknown or len(set(body.clip_ids)) != len(body.clip_ids):
        raise HTTPException(422, "clip_ids must be distinct clips of this reel")
    per_scene: dict[str, list[ReelClip]] = {}
    for cid in body.clip_ids:
        per_scene.setdefault(clips[cid].scene_id, []).append(clips[cid])
    for scene_id, listed in per_scene.items():
        # clips only move within their scene for now, so each scene must be listed whole
        if len(listed) != sum(1 for c in clips.values() if c.scene_id == scene_id):
            raise HTTPException(422, "List every clip of a scene when reordering it")
        for i, c in enumerate(listed, start=1):
            c.order = i
    reel.updated_at = utcnow()
    db.commit()
    return rl.reel_out(db, reel)


@router.post("/projects/{project_id}/reel/assemble", response_model=JobOut, status_code=202)
def assemble(project_id: str, body: AssembleIn, db: Session = Depends(get_db),
             cur: CurrentUser = Depends(require_editor)):
    project = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    if body.scene_ids:
        ok = set(db.scalars(select(Scene.id).where(Scene.project_id == project.id, Scene.id.in_(body.scene_ids))).all())
        if ok != set(body.scene_ids):
            raise HTTPException(422, "scene_ids must be scenes of this project")
    running = rl.active_job(db, project.id)
    if running is not None:
        return job_out(running)  # one assembly per project at a time; hand back the one in flight
    reel = _synced(db, project)
    if not rl.estimate(db, reel)["clips"]:
        raise HTTPException(409, "Nothing to assemble yet: approve at least one take")

    render = Generation(
        workspace_id=project.workspace_id, project_id=project.id, target_type="project", target_id=project.id,
        kind="render", version=next_version(db, "project", project.id, "render"), status="queued",
        prompt=f"{project.title} · draft cut", params={"quality": body.quality}, seed=new_seed(),
    )
    db.add(render)
    db.flush()
    job = Job(workspace_id=project.workspace_id, type=rl.ASSEMBLE_JOB, project_id=project.id,
              generation_id=render.id, message="Waiting for a worker",
              payload={"project_id": project.id, "quality": body.quality, "scene_ids": body.scene_ids or []})
    db.add(job)
    db.flush()
    render.job_id = job.id
    reel.updated_at = utcnow()
    db.commit()
    return job_out(job)


@router.get("/projects/{project_id}/renders", response_model=list[GenerationOut])
def list_renders(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    get_owned(db, Project, project_id, cur.workspace_id, "Project")
    return [gen_out(g) for g in rl.renders(db, project_id)]


@router.get("/projects/{project_id}/reel/estimate", response_model=ReelEstimateOut)
def estimate(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    project = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    return rl.estimate(db, _synced(db, project))
