from fastapi import APIRouter, Depends, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Character, Generation, Project
from app.schemas import CharacterCreate, CharacterOut, CharacterPatch
from app.security import CurrentUser, get_current_user, require_editor
from app.services import character_out, get_owned

router = APIRouter(tags=["characters"])


@router.get("/projects/{project_id}/characters", response_model=list[CharacterOut])
def list_characters(project_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    get_owned(db, Project, project_id, cur.workspace_id, "Project")
    rows = db.scalars(select(Character).where(Character.project_id == project_id).order_by(Character.created_at)).all()
    return [character_out(db, c) for c in rows]


@router.post("/projects/{project_id}/characters", response_model=CharacterOut, status_code=201)
def create_character(
    project_id: str, body: CharacterCreate, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)
):
    get_owned(db, Project, project_id, cur.workspace_id, "Project")
    c = Character(
        workspace_id=cur.workspace_id,
        project_id=project_id,
        name=body.name,
        description=body.description,
        source="user",
        locked=bool(body.description),
    )
    db.add(c)
    db.commit()
    return character_out(db, c)


@router.patch("/characters/{character_id}", response_model=CharacterOut)
def patch_character(
    character_id: str, body: CharacterPatch, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)
):
    c = get_owned(db, Character, character_id, cur.workspace_id, "Character")
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    text_changed = any(changes.get(f, getattr(c, f)) != getattr(c, f) for f in ("name", "description"))
    for k, v in changes.items():
        setattr(c, k, v)
    if text_changed:
        # same provenance rule as scenes
        c.source = "ai_edited" if c.source in ("ai", "ai_edited") else "user"
        c.locked = True
    db.commit()
    return character_out(db, c)


@router.delete("/characters/{character_id}", status_code=204)
def delete_character(character_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    c = get_owned(db, Character, character_id, cur.workspace_id, "Character")
    db.execute(delete(Generation).where(Generation.target_type == "character", Generation.target_id == c.id))
    db.delete(c)
    db.commit()
    return Response(status_code=204)
