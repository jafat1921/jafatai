from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import longtake
from app import storyboard as sb
from app.ai_jobs import active_job, enqueue_ai
from app.config import get_settings
from app.db import get_db
from app.models import Character, Generation, Job, Location, Project, Scene, Shot
from app.schemas import (ChunkRegenerateIn, JobOut, ShotCreate, ShotOut, ShotPatch, ShotReorderIn, TakeEstimate,
                         TakesIn)
from app.security import CurrentUser, get_current_user, require_editor
from app.services import enqueue_generation, get_owned, job_out, new_seed

router = APIRouter(tags=["shots"])

LOCK_FIELDS = ("description", "prompt", "camera")
PROMPT_FIELDS = ("start_prompt", "end_prompt", "motion_prompt")


def _check_refs(db: Session, project_id: str, character_ids: list[str] | None, location_id: str | None) -> None:
    if character_ids:
        found = set(db.scalars(
            select(Character.id).where(Character.project_id == project_id, Character.id.in_(character_ids))
        ).all())
        if found != set(character_ids):
            raise HTTPException(422, "character_ids must be characters of this project")
    if location_id:
        loc = db.get(Location, location_id)
        if loc is None or loc.project_id != project_id:
            raise HTTPException(422, "location_id is not a location of this project")


@router.get("/scenes/{scene_id}/shots", response_model=list[ShotOut])
def list_scene_shots(scene_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    get_owned(db, Scene, scene_id, cur.workspace_id, "Scene")
    return sb.shots_out(db, sb.scene_shots(db, scene_id))


@router.get("/projects/{project_id}/shots", response_model=list[ShotOut])
def list_project_shots(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    get_owned(db, Project, project_id, cur.workspace_id, "Project")
    return sb.shots_out(db, sb.project_shots(db, project_id))


@router.get("/shots/{shot_id}", response_model=ShotOut)
def get_shot(shot_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return sb.shot_out(db, get_owned(db, Shot, shot_id, cur.workspace_id, "Shot"))


@router.post("/scenes/{scene_id}/shots", response_model=ShotOut, status_code=201)
def create_shot(scene_id: str, body: ShotCreate, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    scene = get_owned(db, Scene, scene_id, cur.workspace_id, "Scene")
    _check_refs(db, scene.project_id, body.character_ids, body.location_id)
    shots = sb.scene_shots(db, scene.id)
    insert_at = len(shots)
    if body.after_shot_id:
        idx = next((i for i, s in enumerate(shots) if s.id == body.after_shot_id), None)
        if idx is None:
            raise HTTPException(422, "after_shot_id is not a shot of this scene")
        insert_at = idx + 1
    shot = Shot(
        workspace_id=cur.workspace_id,
        project_id=scene.project_id,
        scene_id=scene.id,
        shot_type=body.shot_type or ("long_take" if longtake.is_long(body.duration_s) else "medium"),
        duration_s=body.duration_s,
        description=body.description,
        camera=body.camera,
        character_ids=body.character_ids or [],
        location_id=body.location_id or scene.location_id,
        seam_in=body.seam_in,
        source="user",
        locked=bool(body.description.strip()),
    )
    shots.insert(insert_at, shot)
    sb.renumber(shots)
    db.add(shot)
    db.commit()
    return sb.shot_out(db, shot)


@router.patch("/shots/{shot_id}", response_model=ShotOut)
def patch_shot(shot_id: str, body: ShotPatch, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    shot = get_owned(db, Shot, shot_id, cur.workspace_id, "Shot")
    changes = body.model_dump(exclude_unset=True)
    _check_refs(db, shot.project_id, changes.get("character_ids"), changes.get("location_id"))

    for flag in ("locked", "stale"):
        if changes.get(flag) is not None:
            setattr(shot, flag, changes.pop(flag))
        changes.pop(flag, None)

    if "beats" in changes:
        beats = changes.pop("beats")
        if beats is not None:
            shot.beats = _merge_beats(shot.beats or [], beats)
    if changes.get("duration_s") is not None and changes["duration_s"] != shot.duration_s:
        # beats are timed to the old chunk plan; unlocked ones get rewritten on the next render
        longtake.mark_beats_stale(shot)
        if "shot_type" not in changes and longtake.is_long(changes["duration_s"]):
            changes["shot_type"] = "long_take"

    edited: set[str] = set()
    for field, value in changes.items():
        if value is None and field != "location_id":
            continue
        if value != getattr(shot, field):
            edited.add(field)
        setattr(shot, field, value)

    # same lock rule as scenes: the user's words are never silently replaced by AI
    if edited & set(LOCK_FIELDS):
        shot.source = "ai_edited" if shot.source in ("ai", "ai_edited") else "user"
        shot.locked = True
    if edited & set(PROMPT_FIELDS) and "prompt_mode" not in changes:
        shot.prompt_mode = "manual"
    if "seam_in" in edited and sb.has_gens(db, shot.id, sb.SHOT_KINDS):
        shot.stale = True
    db.commit()
    return sb.shot_out(db, shot)


@router.post("/scenes/{scene_id}/shots/reorder", response_model=list[ShotOut])
def reorder_shots(scene_id: str, body: ShotReorderIn, db: Session = Depends(get_db),
                  cur: CurrentUser = Depends(require_editor)):
    get_owned(db, Scene, scene_id, cur.workspace_id, "Scene")
    shots = {s.id: s for s in sb.scene_shots(db, scene_id)}
    if len(body.shot_ids) != len(set(body.shot_ids)) or set(body.shot_ids) != set(shots):
        raise HTTPException(422, "shot_ids must list every shot of the scene exactly once")
    ordered = [shots[i] for i in body.shot_ids]
    sb.renumber(ordered)
    # TODO: a reorder changes which END frame a Continue seam links to; flag those shots stale too
    db.commit()
    return sb.shots_out(db, ordered)


@router.delete("/shots/{shot_id}", status_code=204)
def delete_shot(shot_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    shot = get_owned(db, Shot, shot_id, cur.workspace_id, "Shot")
    scene_id = shot.scene_id
    _, nxt = sb.neighbours(db, shot)
    if nxt is not None and nxt.seam_in == "continue" and sb.has_gens(db, nxt.id, sb.SHOT_KINDS):
        nxt.stale = True
    sb.delete_shots(db, [shot])
    db.flush()
    sb.renumber(sb.scene_shots(db, scene_id))
    db.commit()
    return Response(status_code=204)


@router.post("/shots/{shot_id}/clear-stale", response_model=ShotOut)
def clear_stale(shot_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    shot = get_owned(db, Shot, shot_id, cur.workspace_id, "Shot")
    shot.stale = False
    db.commit()
    return sb.shot_out(db, shot)


def _merge_beats(old: list[dict], new: list[dict]) -> list[dict]:
    """Every beat the user changed gets locked (source user/ai_edited); untouched ones keep their state."""
    out = []
    for i, b in enumerate(new):
        prev = old[i] if i < len(old) else None
        b = dict(b)
        if b["t_end"] < b["t_start"]:
            raise HTTPException(422, f"beat {i + 1}: t_end is before t_start")
        if prev is None or (prev.get("prompt") or "").strip() != b["prompt"].strip():
            b["source"] = "ai_edited" if prev is not None and prev.get("source") in ("ai", "ai_edited") else "user"
            b["locked"] = True
        elif prev.get("stale") and (prev.get("t_start"), prev.get("t_end")) == (b["t_start"], b["t_end"]):
            b["stale"] = True
        out.append(b)
    return out


def _take_count(body: TakesIn | None, project: Project, long: bool) -> int:
    if body and body.count:
        return body.count
    # long takes are expensive: one unless asked
    return 1 if long else project.takes_per_shot


def _queue_takes(db: Session, shot: Shot, count: int, duration_s: float | None = None,
                 render: dict | None = None) -> list[Job]:
    params = {"duration_s": duration_s} if duration_s else {}
    params.update({k: v for k, v in (render or {}).items() if v is not None})
    prompt, params = sb.prepare_shot_generation(db, shot, "take", "", params)
    jobs = []
    for _ in range(count):
        # one seed each, queued back to back so LTX stays loaded between them
        g = enqueue_generation(db, workspace_id=shot.workspace_id, project_id=shot.project_id, target_type="shot",
                               target_id=shot.id, kind="take", prompt=prompt, params=dict(params))
        jobs.append(db.get(Job, g.job_id))
    return jobs


@router.post("/shots/{shot_id}/takes", response_model=list[JobOut], status_code=202)
def queue_takes(shot_id: str, body: TakesIn | None = None, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    shot = get_owned(db, Shot, shot_id, cur.workspace_id, "Shot")
    duration = (body.duration_s if body else None) or shot.duration_s
    count = _take_count(body, db.get(Project, shot.project_id), longtake.is_long(duration))
    jobs = _queue_takes(db, shot, count, duration, _render_choice(body))
    db.commit()
    return [job_out(j) for j in jobs]


def _render_choice(body: TakesIn | None) -> dict:
    return {"quality": body.quality, "smooth_motion": body.smooth_motion} if body else {}


@router.post("/scenes/{scene_id}/render", response_model=list[JobOut], status_code=202)
def render_scene(scene_id: str, body: TakesIn | None = None, db: Session = Depends(get_db),
                 cur: CurrentUser = Depends(require_editor)):
    scene = get_owned(db, Scene, scene_id, cur.workspace_id, "Scene")
    project = db.get(Project, scene.project_id)
    jobs = []
    for shot in sb.scene_shots(db, scene.id):
        start, _ = sb.take_frames(db, shot)
        if start is not None:
            long = longtake.is_long(shot.duration_s)
            # the scene-wide count is meant for normal shots; a long take stays at one
            # (re-roll it from the shot if needed) so one click can't queue hours of GPU
            count = 1 if long else _take_count(body, project, long)
            render = _render_choice(body)
            if long:
                # a scene-wide HQ request shouldn't 422 because one shot is a long take
                render = {}
            jobs += _queue_takes(db, shot, count, render=render)
    if not jobs:
        raise HTTPException(409, "No shot in this scene has an approved START frame yet")
    db.commit()
    return [job_out(j) for j in jobs]


# ---------------------------------------------------------------- long takes (contract v2)

@router.get("/shots/{shot_id}/estimate", response_model=TakeEstimate)
def estimate_take(shot_id: str, duration_s: float | None = Query(None), db: Session = Depends(get_db),
                  cur: CurrentUser = Depends(get_current_user)):
    shot = get_owned(db, Shot, shot_id, cur.workspace_id, "Shot")
    duration = duration_s if duration_s is not None else shot.duration_s
    if not 1 <= duration <= get_settings().longtake_max_s:
        raise HTTPException(422, f"duration_s must be between 1 and {get_settings().longtake_max_s:g} seconds")
    return longtake.estimate(duration, longtake.measured_rate(db, cur.workspace_id))


@router.post("/shots/{shot_id}/ai/beats", response_model=JobOut, status_code=202)
def write_beats(shot_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    shot = get_owned(db, Shot, shot_id, cur.workspace_id, "Shot")
    running = active_job(db, "ai_beats", shot.project_id, shot_id=shot.id)
    if running:
        return job_out(running)
    job = enqueue_ai(db, workspace_id=cur.workspace_id, type="ai_beats", project_id=shot.project_id,
                     payload={"shot_id": shot.id, "duration_s": shot.duration_s,
                              "old_duration_s": longtake.beats_span(shot.beats)})
    job.priority = 5
    db.commit()
    return job_out(job)


@router.post("/generations/{gen_id}/chunks/{idx}/regenerate", response_model=JobOut, status_code=202)
def regenerate_chunk(gen_id: str, idx: int, body: ChunkRegenerateIn | None = None, db: Session = Depends(get_db),
                     cur: CurrentUser = Depends(require_editor)):
    """New take version: chunks before idx are reused, idx..end are rendered again, then rejoined."""
    parent = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    if parent.kind != "take" or not (parent.params or {}).get("longtake"):
        raise HTTPException(409, "Only long takes are made of chunks")
    if parent.status in ("queued", "generating"):
        raise HTTPException(409, "This take is still rendering")
    body = body or ChunkRegenerateIn()
    try:
        params = longtake.reroll_params(parent, idx, body.prompt, body.seed)
    except longtake.LongTakeError as e:
        raise HTTPException(422, str(e)) from None
    g = enqueue_generation(db, workspace_id=parent.workspace_id, project_id=parent.project_id,
                           target_type=parent.target_type, target_id=parent.target_id, kind="take",
                           prompt=parent.prompt, params=params, seed=new_seed(), parent_id=parent.id)
    longtake.copy_kept_chunks(parent, g)
    job = db.get(Job, g.job_id)
    redo = len(params["chunks"]) - idx
    job.message = f"Waiting for a worker · redoing {redo} of {len(params['chunks'])} chunks"
    db.commit()
    return job_out(job)
