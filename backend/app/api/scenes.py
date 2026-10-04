from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.ai_jobs import queue_summary
from app.db import get_db
from app import storyboard as sb
from app.models import Generation, Location, Project, Scene, SceneVersion
from app.schemas import ReorderIn, SceneCreate, SceneOut, ScenePatch
from app.security import CurrentUser, get_current_user, require_editor
from app.services import get_owned

router = APIRouter(tags=["scenes"])

SCRIPT_FIELDS = ("heading", "logline", "script_text")


def _ordered(db: Session, project_id: str) -> list[Scene]:
    return list(
        db.scalars(select(Scene).where(Scene.project_id == project_id).order_by(Scene.order, Scene.created_at)).all()
    )


def _renumber(scenes: list[Scene]) -> None:
    for i, s in enumerate(scenes, start=1):
        s.order = i


def _snapshot(scene: Scene, user_id: str) -> SceneVersion:
    return SceneVersion(
        workspace_id=scene.workspace_id,
        scene_id=scene.id,
        version=scene.version,
        heading=scene.heading,
        logline=scene.logline,
        script_text=scene.script_text,
        source=scene.source,
        created_by=user_id,
    )


@router.get("/projects/{project_id}/scenes", response_model=list[SceneOut])
def list_scenes(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    get_owned(db, Project, project_id, cur.workspace_id, "Project")
    return _ordered(db, project_id)


@router.post("/projects/{project_id}/scenes", response_model=SceneOut, status_code=201)
def create_scene(
    project_id: str, body: SceneCreate, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)
):
    project = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    scenes = _ordered(db, project.id)

    insert_at = len(scenes)
    if body.after_scene_id:
        idx = next((i for i, s in enumerate(scenes) if s.id == body.after_scene_id), None)
        if idx is None:
            raise HTTPException(422, "after_scene_id is not a scene of this project")
        insert_at = idx + 1

    scene = Scene(
        workspace_id=cur.workspace_id,
        project_id=project.id,
        heading=body.heading,
        logline=body.logline,
        script_text=body.script_text,
        source="user",
        locked=bool(body.heading or body.logline or body.script_text),
        version=1,
    )
    scenes.insert(insert_at, scene)
    _renumber(scenes)
    db.add(scene)
    db.flush()
    db.add(_snapshot(scene, cur.id))
    project.updated_at = scene.created_at
    db.commit()
    return scene


@router.patch("/scenes/{scene_id}", response_model=SceneOut)
def patch_scene(scene_id: str, body: ScenePatch, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    scene = get_owned(db, Scene, scene_id, cur.workspace_id, "Scene")
    changes = body.model_dump(exclude_unset=True)

    if "locked" in changes and changes["locked"] is not None:
        scene.locked = changes.pop("locked")
    if "location_id" in changes:
        loc_id = changes.pop("location_id")
        if loc_id:
            loc = db.get(Location, loc_id)
            if loc is None or loc.project_id != scene.project_id:
                raise HTTPException(422, "location_id is not a location of this project")
        scene.location_id = loc_id

    script_changed = False
    for field, value in changes.items():
        if value is None and field != "time_of_day":
            continue
        if field in SCRIPT_FIELDS and value != getattr(scene, field):
            script_changed = True
        setattr(scene, field, value)

    # Lock rule (PLAN 2b): user-typed script text is never overwritten by AI later
    if script_changed:
        scene.source = "ai_edited" if scene.source in ("ai", "ai_edited") else "user"
        scene.locked = True
        scene.version += 1
        db.add(_snapshot(scene, cur.id))
        if "script_text" in changes:
            # keeps scene.summary fresh as context for later AI writing
            queue_summary(db, scene)
            sb.mark_scene_shots_stale(db, scene.id)

    db.commit()
    return scene


@router.post("/projects/{project_id}/scenes/reorder", response_model=list[SceneOut])
def reorder_scenes(
    project_id: str, body: ReorderIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)
):
    get_owned(db, Project, project_id, cur.workspace_id, "Project")
    scenes = {s.id: s for s in _ordered(db, project_id)}
    if len(body.scene_ids) != len(set(body.scene_ids)) or set(body.scene_ids) != set(scenes):
        raise HTTPException(422, "scene_ids must list every scene of the project exactly once")
    ordered = [scenes[i] for i in body.scene_ids]
    _renumber(ordered)
    db.commit()
    return ordered


@router.delete("/scenes/{scene_id}", status_code=204)
def delete_scene(scene_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    scene = get_owned(db, Scene, scene_id, cur.workspace_id, "Scene")
    project_id = scene.project_id
    db.execute(delete(Generation).where(Generation.target_type == "scene", Generation.target_id == scene.id))
    sb.delete_shots(db, sb.scene_shots(db, scene.id))
    db.delete(scene)
    db.flush()
    _renumber(_ordered(db, project_id))
    db.commit()
    return Response(status_code=204)
