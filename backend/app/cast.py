"""Who is in a film: its own characters plus the Character Studio ones linked in (project_cast, M12a).

A studio character has project_id NULL. Linking never copies it, so an edit in the studio shows in every
film that uses it.
"""
from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import Character, Project, ProjectCast


def linked_ids(db: Session, project_id: str) -> list[str]:
    return list(db.scalars(select(ProjectCast.character_id).where(ProjectCast.project_id == project_id)))


def in_project(project_id: str):
    """A where-clause for "cast of this film" on Character."""
    linked = select(ProjectCast.character_id).where(ProjectCast.project_id == project_id)
    return or_(Character.project_id == project_id, Character.id.in_(linked))


def project_cast(db: Session, project_id: str) -> list[Character]:
    return list(db.scalars(select(Character).where(in_project(project_id)).order_by(Character.created_at)))


def is_cast(db: Session, project_id: str, character: Character) -> bool:
    if character.project_id == project_id:
        return True
    return db.get(ProjectCast, (project_id, character.id)) is not None


def link(db: Session, project: Project, character: Character) -> None:
    if character.workspace_id != project.workspace_id:
        raise HTTPException(404, "Character not found")
    if character.project_id is not None and character.project_id != project.id:
        raise HTTPException(409, "That character belongs to another film. Save it to Character Studio first.")
    if character.project_id is None and db.get(ProjectCast, (project.id, character.id)) is None:
        db.add(ProjectCast(project_id=project.id, character_id=character.id))
        db.flush()


def unlink(db: Session, project_id: str, character: Character) -> bool:
    row = db.get(ProjectCast, (project_id, character.id))
    if row is None:
        return False
    db.delete(row)
    _clear_from_shots(db, project_id, character.id)
    return True


def _clear_from_shots(db: Session, project_id: str, character_id: str) -> None:
    from app.models import Shot

    for s in db.scalars(select(Shot).where(Shot.project_id == project_id)):
        if character_id in (s.character_ids or []):
            s.character_ids = [c for c in s.character_ids if c != character_id]
        if character_id in (s.ref_panels or {}):
            s.ref_panels = {k: v for k, v in s.ref_panels.items() if k != character_id}


def save_to_studio(db: Session, character: Character) -> None:
    """A film's own character becomes a studio one, still cast in that film."""
    pid = character.project_id
    if pid is None:
        return
    character.project_id = None
    db.flush()
    if db.get(ProjectCast, (pid, character.id)) is None:
        db.add(ProjectCast(project_id=pid, character_id=character.id))
    db.flush()


def films(db: Session, character: Character) -> list[Project]:
    """Every film this character appears in (its own film, or the ones it's linked into)."""
    ids = set(db.scalars(select(ProjectCast.project_id).where(ProjectCast.character_id == character.id)))
    if character.project_id:
        ids.add(character.project_id)
    if not ids:
        return []
    return list(db.scalars(select(Project).where(Project.id.in_(ids)).order_by(Project.title)))


def remove_everywhere(db: Session, character: Character) -> None:
    for p in films(db, character):
        _clear_from_shots(db, p.id, character.id)
