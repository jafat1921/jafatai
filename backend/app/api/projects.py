import shutil

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models_catalog
from app.config import get_settings
from app.db import get_db
from app.models import Project
from app.schemas import ProjectCreate, ProjectOut, ProjectPatch
from app.security import CurrentUser, get_current_user, require_editor
from app.services import get_owned, project_out

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    rows = db.scalars(
        select(Project).where(Project.workspace_id == cur.workspace_id).order_by(Project.updated_at.desc())
    ).all()
    return [project_out(db, p) for p in rows]


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectCreate, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    data = body.model_dump()
    data["brief"] = data["brief"] or ""
    data["settings"] = models_catalog.clean_project_settings({}, data.get("settings") or {})
    p = Project(workspace_id=cur.workspace_id, **data)
    db.add(p)
    db.commit()
    return project_out(db, p)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return project_out(db, get_owned(db, Project, project_id, cur.workspace_id, "Project"))


@router.patch("/{project_id}", response_model=ProjectOut)
def patch_project(
    project_id: str, body: ProjectPatch, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)
):
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    for k, v in body.model_dump(exclude_unset=True).items():
        if k == "settings":
            if v is not None:
                # a fresh dict so the JSON column registers the change
                p.settings = models_catalog.clean_project_settings(dict(p.settings or {}), v)
            continue
        if v is None and k != "brief":
            continue
        setattr(p, k, v if v is not None else "")
    db.commit()
    return project_out(db, p)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    p = get_owned(db, Project, project_id, cur.workspace_id, "Project")
    db.delete(p)
    db.commit()
    folder = get_settings().data_dir / "workspaces" / cur.workspace_id / "projects" / project_id
    shutil.rmtree(folder, ignore_errors=True)
    return Response(status_code=204)
