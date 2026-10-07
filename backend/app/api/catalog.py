"""GET /models (contract v6): what the pickers offer, with live availability."""
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import estimate as est
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


@router.get("/estimate")
def estimate(kind: Literal["image", "video", "take", "upscale"] = "image", model: str | None = Query(None, max_length=60),
             speed: str | None = Query(None, max_length=30), count: int = Query(1, ge=1, le=16),
             duration_s: float | None = Query(None, gt=0, le=1200), width: int | None = Query(None, ge=64, le=8192),
             height: int | None = Query(None, ge=64, le=8192),
             db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return est.estimate(db, cur.workspace_id, kind=kind, model=model, speed=speed, count=count,
                        duration_s=duration_s, width=width, height=height)
