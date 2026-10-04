"""Shared domain helpers used by several routers and the worker."""
import random
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Character, Generation, Job, Location, Project, Scene, Shot, utcnow
from app.schemas import CharacterOut, Counts, GenerationOut, JobOut, ProjectOut

READY_STATES = ("ready", "approved", "rejected")


def media_url(rel_path: str | None) -> str | None:
    if not rel_path:
        return None
    return "/api/media/" + Path(rel_path).as_posix()


def gen_out(g: Generation) -> GenerationOut:
    out = GenerationOut.model_validate(g)
    if g.status in READY_STATES:
        out.media_url = media_url(g.file_path)
    return out


def job_out(j: Job) -> JobOut:
    return JobOut.model_validate(j)


def get_owned(db: Session, model, obj_id: str, workspace_id: str, label: str):
    obj = db.get(model, obj_id)
    # same 404 for "missing" and "someone else's" so ids can't be probed
    if obj is None or obj.workspace_id != workspace_id:
        raise HTTPException(404, f"{label} not found")
    return obj


def project_out(db: Session, p: Project) -> ProjectOut:
    out = ProjectOut.model_validate(p)
    out.counts = Counts(
        scenes=db.scalar(select(func.count()).select_from(Scene).where(Scene.project_id == p.id)) or 0,
        characters=db.scalar(select(func.count()).select_from(Character).where(Character.project_id == p.id)) or 0,
        shots=db.scalar(select(func.count()).select_from(Shot).where(Shot.project_id == p.id)) or 0,
    )
    thumb = db.scalars(
        select(Generation.file_path)
        .where(
            Generation.project_id == p.id,
            Generation.status.in_(("approved", "ready")),
            Generation.media_type == "image/png",
        )
        .order_by((Generation.status == "approved").desc(), Generation.created_at.desc())
        .limit(1)
    ).first()
    out.thumbnail_url = media_url(thumb)
    return out


def character_out(db: Session, c: Character) -> CharacterOut:
    out = CharacterOut.model_validate(c)
    g = db.scalars(
        select(Generation).where(
            Generation.target_type == "character",
            Generation.target_id == c.id,
            Generation.kind == "portrait",
            Generation.status == "approved",
        )
    ).first()
    out.approved_portrait = gen_out(g) if g else None
    return out


def resolve_target_project(db: Session, workspace_id: str, target_type: str, target_id: str) -> str:
    if target_type == "project":
        return get_owned(db, Project, target_id, workspace_id, "Project").id
    if target_type == "character":
        return get_owned(db, Character, target_id, workspace_id, "Character").project_id
    if target_type == "scene":
        return get_owned(db, Scene, target_id, workspace_id, "Scene").project_id
    if target_type == "shot":
        return get_owned(db, Shot, target_id, workspace_id, "Shot").project_id
    if target_type == "location":
        return get_owned(db, Location, target_id, workspace_id, "Location").project_id
    raise HTTPException(422, f"target_type '{target_type}' is not available yet")


def new_seed() -> int:
    return random.randint(0, 2**31 - 1)


def next_version(db: Session, target_type: str, target_id: str, kind: str) -> int:
    cur = db.scalar(
        select(func.max(Generation.version)).where(
            Generation.target_type == target_type,
            Generation.target_id == target_id,
            Generation.kind == kind,
        )
    )
    return (cur or 0) + 1


def enqueue_generation(
    db: Session,
    *,
    workspace_id: str,
    project_id: str | None,
    target_type: str,
    target_id: str,
    kind: str,
    prompt: str,
    params: dict,
    seed: int | None = None,
    parent_id: str | None = None,
    note: str | None = None,
) -> Generation:
    g = Generation(
        workspace_id=workspace_id,
        project_id=project_id,
        target_type=target_type,
        target_id=target_id,
        kind=kind,
        version=next_version(db, target_type, target_id, kind),
        status="queued",
        prompt=prompt,
        params=params or {},
        seed=seed if seed is not None else new_seed(),
        parent_id=parent_id,
        note=note,
    )
    db.add(g)
    db.flush()
    job = Job(
        workspace_id=workspace_id,
        type="generate",
        payload={"generation_id": g.id},
        project_id=project_id,
        generation_id=g.id,
        message="Waiting for a worker",
    )
    db.add(job)
    db.flush()
    g.job_id = job.id
    return g


def approve(db: Session, g: Generation) -> Generation:
    if g.status == "approved":
        return g
    if g.status != "ready":
        raise HTTPException(409, f"Only a ready generation can be approved (this one is {g.status})")
    now = utcnow()
    # demote first: the partial unique index would reject two approved rows
    db.execute(
        update(Generation)
        .where(
            Generation.target_type == g.target_type,
            Generation.target_id == g.target_id,
            Generation.kind == g.kind,
            Generation.status == "approved",
            Generation.id != g.id,
        )
        .values(status="ready", approved_at=None, updated_at=now)
    )
    g.status = "approved"
    g.approved_at = now
    db.flush()
    from app.storyboard import after_approve  # storyboard imports this module

    after_approve(db, g)
    return g


def generation_file(g: Generation) -> Path | None:
    if not g.file_path:
        return None
    return get_settings().data_dir / g.file_path
