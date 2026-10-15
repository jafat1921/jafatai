"""Admin-only housekeeping (contract v34). Signed-in studio session only; hidden from the API docs."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import visibility as vis
from app.db import get_db
from app.security import CurrentUser, get_current_user, is_admin, session_only

router = APIRouter(prefix="/admin", tags=["admin"])


class MarkApiIn(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=2000)
    since: datetime | None = None
    until: datetime | None = None
    kinds: list[str] | None = None
    apply: bool = False


def _naive_utc(at: datetime | None) -> datetime | None:
    if at is None or at.tzinfo is None:
        return at
    return at.astimezone(timezone.utc).replace(tzinfo=None)


@router.post("/mark-api")
@session_only
def mark_api(body: MarkApiIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    """Mark rows made through the API before via_api existed. A dry run unless apply is true."""
    if not is_admin(cur):
        raise HTTPException(404, "Not Found")
    try:
        return vis.mark(db, workspace_id=cur.workspace_id, ids=[i.strip() for i in body.ids if i.strip()],
                        since=_naive_utc(body.since), until=_naive_utc(body.until), kinds=body.kinds,
                        apply=body.apply)
    except vis.MarkError as e:
        raise HTTPException(422, str(e)) from None
