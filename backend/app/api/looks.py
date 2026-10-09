"""Looks: built-in and saved looks, Lightroom/.cube import, .cube export, apply to video (contract v9)."""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from app.api.photo import _file_name
from app.db import get_db
from app.models import utcnow
from app.photo import develop as dv
from app.photo import looks as lk
from app.photo.schemas import ApplyVideoIn, ImportOut, LookIn, LookOut, LookPatch
from app.schemas import JobOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import job_out, owned_source

router = APIRouter(prefix="/looks", tags=["looks"])


@router.get("", response_model=list[LookOut])
def list_looks(db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return [lk.look_out(x) for x in lk.list_looks(db, cur.workspace_id)]


@router.post("", response_model=LookOut, status_code=201)
def create_look(body: LookIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    params = body.params.plain()
    if params.get("lut"):
        lk.get_visible(db, cur.workspace_id, params["lut"]["look_id"])
    look = lk.create(db, cur.workspace_id, name=body.name, params=params, description=body.description,
                     category=body.category)
    if body.generation_id:
        lk.save_thumb(db, look, owned_source(db, cur.workspace_id, body.generation_id))
    db.commit()
    return lk.look_out(look)


@router.post("/import", response_model=ImportOut, status_code=201)
async def import_looks(request: Request, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    form = await request.form(max_files=lk.MAX_IMPORT_FILES + 5)
    files = []
    for _, v in form.multi_items():
        if isinstance(v, UploadFile):
            data = await v.read(lk.MAX_IMPORT_BYTES + 1)
            if len(data) > lk.MAX_IMPORT_BYTES:
                raise HTTPException(413, f"{v.filename} is over {lk.MAX_IMPORT_BYTES // (1024 * 1024)} MB")
            files.append((v.filename or "file", data))
    if not files:
        raise HTTPException(422, "Attach one or more .xmp, .lrtemplate or .cube files")
    looks, reports = await run_in_threadpool(lk.import_files, db, cur.workspace_id, files)
    if not looks:
        db.rollback()
        raise HTTPException(422, {"message": "Nothing could be imported", "reports": reports})
    db.commit()
    return {"looks": [lk.look_out(x) for x in looks], "reports": reports}


@router.get("/{look_id}", response_model=LookOut)
def get_look(look_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return lk.look_out(lk.get_visible(db, cur.workspace_id, look_id))


@router.patch("/{look_id}", response_model=LookOut)
def patch_look(look_id: str, body: LookPatch, db: Session = Depends(get_db),
               cur: CurrentUser = Depends(require_editor)):
    look = lk.get_editable(db, cur.workspace_id, look_id)
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(422, "The name can't be blank")
        look.name = body.name.strip()
    if body.description is not None:
        look.description = body.description
    if body.category is not None:
        look.category = body.category
    if body.params is not None:
        look.params = dv.sparse(body.params.plain())
    look.updated_at = utcnow()
    db.commit()
    return lk.look_out(look)


@router.delete("/{look_id}", status_code=204)
def delete_look(look_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    lk.delete(db, lk.get_editable(db, cur.workspace_id, look_id))
    db.commit()
    return Response(status_code=204)


@router.get("/{look_id}/thumb", responses={200: {"content": {"image/jpeg": {}}}})
async def look_thumb(look_id: str, generation_id: str | None = None, db: Session = Depends(get_db),
                     cur: CurrentUser = Depends(get_current_user)):
    look = lk.get_visible(db, cur.workspace_id, look_id)
    data = await run_in_threadpool(lk.thumb, db, look, cur.workspace_id, generation_id)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


@router.get("/{look_id}/cube")
def look_cube(look_id: str, size: int = Query(33, ge=2, le=65), db: Session = Depends(get_db),
              cur: CurrentUser = Depends(get_current_user)):
    look = lk.get_visible(db, cur.workspace_id, look_id)
    text = lk.cube_text(lk.bake(look, size), look.name, look.params or {})
    return Response(text, media_type="text/plain; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="{_file_name(look.name)}.cube"', "Cache-Control": "no-store"})


@router.post("/{look_id}/apply-video", response_model=JobOut, status_code=202)
def apply_video(look_id: str, body: ApplyVideoIn, db: Session = Depends(get_db),
                cur: CurrentUser = Depends(require_editor)):
    look = lk.get_visible(db, cur.workspace_id, look_id)
    g = owned_source(db, cur.workspace_id, body.generation_id)
    job = lk.queue_apply_video(db, look, g, body.intensity, cur.user.id)
    db.commit()
    return job_out(job)
