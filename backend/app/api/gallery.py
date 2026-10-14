"""Voice Gallery (contract v19): browse the catalogue, hear a sample, add a voice to the library.

Registered before app.api.voices so /voices/gallery isn't taken for a voice id.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import voice_gallery as vg
from app import voices as vc
from app.db import get_db, release
from app.schemas import VoiceOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import job_out

router = APIRouter(prefix="/voices/gallery", tags=["voices"])


class GalleryAddIn(BaseModel):
    starred: bool | None = None


def _entry(gallery_id: str) -> dict:
    v = vg.get(gallery_id)
    if v is None:
        raise HTTPException(404, "That gallery voice doesn't exist")
    return v


@router.get("")
def gallery(q: str | None = Query(None, max_length=120), language: str | None = Query(None, max_length=12),
            gender: str | None = Query(None, max_length=10), age: str | None = Query(None, max_length=10),
            style: str | None = Query(None, max_length=20), engine: str | None = Query(None, max_length=20),
            db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    res = vg.search((q or "").strip() or None, language=language, gender=gender, age=age, style=style, engine=engine)
    added = vg.added_voices(db, cur.workspace_id)
    return {**res, "items": [vg.item_out(v, added) for v in res["items"]]}


@router.get("/{gallery_id}/sample")
def sample(gallery_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    _entry(gallery_id)
    path = vg.sample_path(gallery_id)
    if path.is_file():
        release(db)
        return FileResponse(path, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=86400"})
    # rendered once for everyone; a viewer may trigger it too, it's the studio's own catalogue
    job = vg.queue_sample(db, cur.workspace_id, gallery_id)
    db.commit()
    return JSONResponse({"job": job_out(job).model_dump(mode="json"), "status": "preparing"}, status_code=202)


@router.post("/{gallery_id}/add", response_model=VoiceOut)
def add(gallery_id: str, body: GalleryAddIn | None = Body(None), db: Session = Depends(get_db),
        cur: CurrentUser = Depends(require_editor)):
    v, created = vg.add(db, cur.workspace_id, _entry(gallery_id), (body.starred if body else None))
    db.commit()
    return JSONResponse(VoiceOut(**vc.voice_out(db, v)).model_dump(mode="json"), status_code=201 if created else 200)
