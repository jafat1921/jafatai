"""@-mention suggestions and the camera rack vocabulary (polish P2)."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import camera
from app import mentions as mn
from app.db import get_db
from app.security import CurrentUser, get_current_user

router = APIRouter(tags=["mentions"])


@router.get("/mentions")
def list_mentions(q: str = "", project_id: str | None = None, types: str | None = None, kit_id: str | None = None,
                  db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    wanted = tuple(t.strip() for t in (types or "").split(",") if t.strip()) or mn.TYPES
    bad = [t for t in wanted if t not in mn.TYPES]
    if bad:
        raise HTTPException(422, f"Unknown mention type '{bad[0]}' (expected {', '.join(mn.TYPES)})")
    return mn.search(db, cur.workspace_id, q[:80], project_id=project_id or None, types=wanted, kit_id=kit_id or None)


@router.get("/camera/presets")
def camera_presets(cur: CurrentUser = Depends(get_current_user)):
    return camera.presets()
