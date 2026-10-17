"""3D Studio (contract v40): POST /3d/make turns a finished picture into a textured GLB in the Library."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import library as lib
from app import model3d as m3
from app import models_catalog as mc
from app.api.library import _edit_source, generate_into
from app.config import get_settings
from app.db import get_db
from app.models import Job, MediaItem, new_id
from app.schemas import Model3DIn, Model3DOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import enqueue_generation, job_out

router = APIRouter(tags=["3d"])

NO_ALPHA = "The picture has no transparent background, so the background was removed anyway."


@router.get("/3d/options")
def options(cur: CurrentUser = Depends(get_current_user)):
    return {
        "engines": [{"id": m.id, "label": m.label, "description": m.description, "default": m.default,
                     "best_for": list(m.best_for)} for m in mc.MODELS.values() if m.type == "model3d"],
        "qualities": [{"id": q, "label": m3.QUALITY_LABELS[q]} for q in m3.QUALITY],
        "default_quality": "final",
    }


@router.post("/3d/make", response_model=Model3DOut, status_code=202,
             summary="Make a 3D model from a picture",
             description="Queues one job on the image GPU. The result is a Library item of kind `model` whose "
                         "file is a binary glTF (`model/gltf-binary`); list them with `GET /api/media?kind=model`.")
def make_3d(body: Model3DIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    engine, chosen = mc.choose(body.engine, "model3d")
    into = generate_into(db, cur.workspace_id, body.folder_id, m3.MEDIA_KIND)
    media_id, src = _edit_source(db, cur.workspace_id, body.source_id)
    note = None
    remove_bg = body.remove_background
    if not remove_bg and not m3.has_transparency(get_settings().data_dir / src.file_path):
        # without an alpha channel the template's "keep" branch crops to an empty mask
        remove_bg, note = True, NO_ALPHA
    source_item = db.get(MediaItem, media_id) if media_id else None
    title = (body.title or "").strip() or (f"{source_item.title} · 3D" if source_item and source_item.title else "3D model")
    rec = {"engine": engine.id, "quality": body.quality, "remove_background": remove_bg, "source_id": src.id,
           "source_media_id": media_id}
    params = {"model3d": rec, "model": engine.id, **chosen,
              "created_by": {"user_id": cur.id, "flow": "make_3d"}}
    item = MediaItem(id=new_id(), workspace_id=cur.workspace_id, kind=m3.MEDIA_KIND, origin="generated",
                     title=title[:300], tags=[], folder_id=into, home=lib.home_of(body.part_of))
    db.add(item)
    db.flush()
    g = enqueue_generation(db, workspace_id=cur.workspace_id, project_id=None, target_type="media",
                           target_id=item.id, kind=m3.GEN_KIND, prompt=(src.prompt or "")[:4000], params=params,
                           seed=body.seed, parent_id=None)
    item.generation_id = g.id
    job = db.get(Job, g.job_id)
    db.commit()
    return Model3DOut(item=lib.item_out(db, item), job=job_out(job), model_resolved=engine.id, background_note=note)
