"""GET /models (contract v6): what the pickers offer, with live availability."""
from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models_catalog as mc
from app import upscale
from app.config import get_settings
from app.db import get_db
from app.models import Generation
from app.security import CurrentUser, get_current_user

router = APIRouter(tags=["models"])


def measured(db: Session, workspace_id: str) -> dict[str, float]:
    rows = db.scalars(select(Generation.params).where(
        Generation.workspace_id == workspace_id, Generation.status.in_(("ready", "approved")),
        Generation.kind.in_(("portrait", "establishing", "keyframe_start", "keyframe_end", "image", "take", "video")),
    ).order_by(Generation.created_at.desc()).limit(300)).all()
    return mc.measured_seconds(list(rows))


@router.get("/models")
async def list_models(type: Literal["image", "edit", "video", "upscale"] | None = None,
                      db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    s = get_settings()
    info, error = (None, None) if s.gen_driver == "mock" else await upscale.fetch_object_info()
    return mc.catalog(type, info, driver=s.gen_driver, error=error, measured=measured(db, cur.workspace_id))
