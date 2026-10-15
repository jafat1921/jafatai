"""Dialogue & narration (contract v17): scripts, paste & split, import from a film project, line renders,
the mix and the stems."""
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import visibility as vis
from app import cast as film_cast
from app import dialogue as dl
from app import voices as vc
from app.db import get_db
from app.dialogue_schemas import (ImportIn, RenderIn, RenderOut, ScriptIn, ScriptOut, ScriptPatch, ScriptSummary,
                                  SplitIn)
from app.models import Project, Scene, VoiceScript
from app.schemas import JobOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import get_owned, job_out

router = APIRouter(prefix="/scripts", tags=["dialogue"])


def _engine(engine: str | None) -> str:
    e = (engine or "auto").strip().lower()
    if e != "auto" and e not in vc.ENGINES:
        raise HTTPException(422, f"Unknown speech engine '{e}' (expected {', '.join(vc.ENGINES)} or auto)")
    return e


def _project(db: Session, cur: CurrentUser, project_id: str | None) -> str | None:
    if not project_id:
        return None
    return get_owned(db, Project, project_id, cur.workspace_id, "Project").id


def _owned(db: Session, cur: CurrentUser, script_id: str) -> VoiceScript:
    return get_owned(db, VoiceScript, script_id, cur.workspace_id, "Script")


def _out(db: Session, s: VoiceScript) -> ScriptOut:
    return ScriptOut(**dl.script_out(db, s))


@router.get("", response_model=list[ScriptSummary])
def list_scripts(db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    rows = db.scalars(select(VoiceScript).where(VoiceScript.workspace_id == cur.workspace_id,
                                                *vis.where(VoiceScript, vis.wanted(cur)))
                      .order_by(VoiceScript.updated_at.desc(), VoiceScript.id)).all()
    return [ScriptSummary(**dl.summary_out(db, s)) for s in rows]


@router.post("", response_model=ScriptOut, status_code=201)
def create_script(body: ScriptIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    s = VoiceScript(workspace_id=cur.workspace_id, title=body.title.strip(), language=body.language.lower(),
                    engine=_engine(body.engine), project_id=_project(db, cur, body.project_id),
                    cast=dl.clean_cast([]), lines=[], settings=dict(dl.DEFAULT_SETTINGS))
    db.add(s)
    db.commit()
    return _out(db, s)


@router.get("/{script_id}", response_model=ScriptOut)
def get_script(script_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return _out(db, _owned(db, cur, script_id))


@router.patch("/{script_id}", response_model=ScriptOut)
def patch_script(script_id: str, body: ScriptPatch, db: Session = Depends(get_db),
                 cur: CurrentUser = Depends(require_editor)):
    s = _owned(db, cur, script_id)
    data = body.model_dump(exclude_unset=True)
    if data.get("title"):
        s.title = data["title"].strip()
    if data.get("language"):
        s.language = data["language"].lower()
    if "engine" in data:
        s.engine = _engine(data["engine"])
    if data.get("settings") is not None:
        s.settings = {**dl.settings_of(s), **data["settings"]}
    if data.get("cast") is not None:
        s.cast = dl.clean_cast(data["cast"])
        dl.reassign_removed(s)
    if data.get("lines") is not None:
        s.lines = dl.merge_lines(s, data["lines"])
    # every change can move a fingerprint (a voice swap on the cast restales all of that speaker's lines)
    dl.refresh(db, s)
    db.commit()
    return _out(db, s)


@router.delete("/{script_id}", status_code=204)
def delete_script(script_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    # takes and mixes are Library items and stay there
    db.delete(_owned(db, cur, script_id))
    db.commit()
    return Response(status_code=204)


@router.post("/{script_id}/split", response_model=ScriptOut)
def split_into(script_id: str, body: SplitIn, db: Session = Depends(get_db),
               cur: CurrentUser = Depends(require_editor)):
    s = _owned(db, cur, script_id)
    cast = dl.clean_cast(s.cast)
    new = dl.split(body.text, body.mode, cast, body.speaker_id)
    if not new:
        raise HTTPException(422, "There's nothing to split in that text")
    s.cast = cast
    s.lines = [*(s.lines or []), *new]
    dl.refresh(db, s)
    db.commit()
    return _out(db, s)


@router.post("/{script_id}/import-project", response_model=ScriptOut)
def import_project(script_id: str, body: ImportIn, db: Session = Depends(get_db),
                   cur: CurrentUser = Depends(require_editor)):
    s = _owned(db, cur, script_id)
    project = get_owned(db, Project, body.project_id, cur.workspace_id, "Project")
    stmt = select(Scene).where(Scene.project_id == project.id)
    if body.scene_ids:
        stmt = stmt.where(Scene.id.in_(body.scene_ids))
    scenes = db.scalars(stmt.order_by(Scene.order, Scene.created_at)).all()
    if not scenes:
        raise HTTPException(422, "That project has no scenes to import")
    cast = dl.clean_cast(s.cast)
    new = dl.import_scenes(scenes, cast, body.include_action, film_cast.project_cast(db, project.id))
    if not new:
        raise HTTPException(422, "Those scenes have no dialogue yet" if not body.include_action
                                 else "Those scenes have no script text yet")
    s.cast = cast
    s.lines = [*(s.lines or []), *new]
    s.project_id = s.project_id or project.id
    dl.refresh(db, s)
    db.commit()
    return _out(db, s)


@router.post("/{script_id}/render", response_model=RenderOut, status_code=202)
def render_lines(script_id: str, body: RenderIn | None = None, db: Session = Depends(get_db),
                 cur: CurrentUser = Depends(require_editor)):
    s = _owned(db, cur, script_id)
    jobs, failed = dl.queue_render(db, cur, s, body.line_ids if body else None)
    db.commit()
    return RenderOut(jobs=jobs, queued=len(jobs), failed=failed)


@router.post("/{script_id}/mix", response_model=JobOut, status_code=202)
def mix(script_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    s = _owned(db, cur, script_id)
    job = dl.queue_mix(db, cur, s)
    db.commit()
    return job_out(job)


@router.post("/{script_id}/stems", response_model=JobOut, status_code=202)
def stems(script_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    s = _owned(db, cur, script_id)
    job = dl.queue_stems(db, s)
    db.commit()
    return job_out(job)
