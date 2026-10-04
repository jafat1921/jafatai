from fastapi import APIRouter, Depends, Response
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Generation, Location, Project, Scene, Shot
from app.schemas import LocationCreate, LocationOut, LocationPatch
from app.security import CurrentUser, get_current_user, require_editor
from app.services import get_owned
from app.storyboard import location_out

router = APIRouter(tags=["locations"])


@router.get("/projects/{project_id}/locations", response_model=list[LocationOut])
def list_locations(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    get_owned(db, Project, project_id, cur.workspace_id, "Project")
    rows = db.scalars(select(Location).where(Location.project_id == project_id).order_by(Location.created_at)).all()
    return [location_out(db, loc) for loc in rows]


@router.post("/projects/{project_id}/locations", response_model=LocationOut, status_code=201)
def create_location(
    project_id: str, body: LocationCreate, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)
):
    get_owned(db, Project, project_id, cur.workspace_id, "Project")
    loc = Location(
        workspace_id=cur.workspace_id,
        project_id=project_id,
        name=body.name.strip(),
        description=body.description,
        time_of_day_variants=body.time_of_day_variants,
        source="user",
        locked=bool(body.description),
    )
    db.add(loc)
    db.commit()
    return location_out(db, loc)


@router.get("/locations/{location_id}", response_model=LocationOut)
def get_location(location_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return location_out(db, get_owned(db, Location, location_id, cur.workspace_id, "Location"))


@router.patch("/locations/{location_id}", response_model=LocationOut)
def patch_location(
    location_id: str, body: LocationPatch, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)
):
    loc = get_owned(db, Location, location_id, cur.workspace_id, "Location")
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    text_changed = any(changes.get(f, getattr(loc, f)) != getattr(loc, f) for f in ("name", "description"))
    for k, v in changes.items():
        setattr(loc, k, v)
    if text_changed:
        loc.source = "ai_edited" if loc.source in ("ai", "ai_edited") else "user"
        loc.locked = True
    db.commit()
    return location_out(db, loc)


@router.delete("/locations/{location_id}", status_code=204)
def delete_location(location_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    loc = get_owned(db, Location, location_id, cur.workspace_id, "Location")
    # scene/shot location_id carry no FK (see models.Scene), so unlink by hand
    db.execute(update(Scene).where(Scene.location_id == loc.id).values(location_id=None))
    db.execute(update(Shot).where(Shot.location_id == loc.id).values(location_id=None))
    db.execute(delete(Generation).where(Generation.target_type == "location", Generation.target_id == loc.id))
    db.delete(loc)
    db.commit()
    return Response(status_code=204)
