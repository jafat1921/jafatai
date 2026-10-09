"""Photo Studio: develop schema, live preview, histogram, analysis, Auto, render/effect jobs, history (contract v9)."""
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.db import get_db
from app.models import Generation
from app.photo import develop as dv
from app.photo import effects as fx
from app.photo import looks as lk
from app.photo import lut as lt
from app.photo import service as svc
from app.photo import restore as rs
from app.photo.schemas import (BackgroundIn, CubeIn, DevelopParams, EffectIn, ParamsIn, PreviewIn, RenderIn,
                                RestoreIn, SmartRestoreIn)
from app.schemas import JobOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import job_out, owned_source

router = APIRouter(prefix="/photo", tags=["photo"])


def _source(db: Session, cur: CurrentUser, any_id: str) -> Generation:
    return owned_source(db, cur.workspace_id, any_id)


@router.get("/schema")
def schema(cur: CurrentUser = Depends(get_current_user)):
    return {
        "version": dv.PARAMS_VERSION,
        "defaults": dv.defaults(),
        "ranges": dv.ranges(),
        "groups": dv.GROUPS,
        "hsl_bands": [{"id": k, "label": label, "hue": hue} for k, label, hue in dv.HSL_BANDS],
        "curve_points": [{"id": k, "label": label, "at": at} for k, label, at in dv.CURVE_POINTS],
        "spatial_keys": list(dv.SPATIAL_KEYS),
        "formats": [{"id": k, "label": v["label"], "media_type": v["media_type"]} for k, v in dv.FORMATS.items()],
        "effects": fx.EFFECTS,
    }


@router.post("/{gen_id}/preview", responses={200: {"content": {"image/jpeg": {}}}})
async def preview(gen_id: str, body: PreviewIn, db: Session = Depends(get_db),
                  cur: CurrentUser = Depends(get_current_user)):
    g = _source(db, cur, gen_id)
    data, info = await run_in_threadpool(svc.preview, db, g, body.params.plain(), body.max_side)
    return Response(data, media_type="image/jpeg", headers={
        "Cache-Control": "no-store", "X-Develop-Ms": str(info["ms"]),
        "X-Source-Size": "{}x{}".format(*info["source"]), "X-Output-Size": "{}x{}".format(*info["output"]),
    })


def _params_from_query(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        return DevelopParams.model_validate(json.loads(raw)).plain()
    except (ValueError, ValidationError) as e:
        raise HTTPException(422, f"params isn't valid develop params JSON: {str(e)[:200]}") from None


@router.get("/{gen_id}/histogram")
async def histogram_get(gen_id: str, params: str | None = Query(None, max_length=20000), db: Session = Depends(get_db),
                        cur: CurrentUser = Depends(get_current_user)):
    g = _source(db, cur, gen_id)
    return await run_in_threadpool(svc.histogram, db, g, _params_from_query(params))


@router.post("/{gen_id}/histogram")
async def histogram_post(gen_id: str, body: ParamsIn, db: Session = Depends(get_db),
                         cur: CurrentUser = Depends(get_current_user)):
    g = _source(db, cur, gen_id)
    return await run_in_threadpool(svc.histogram, db, g, body.params.plain())


@router.get("/{gen_id}/analysis")
async def analysis(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    g = _source(db, cur, gen_id)
    return await run_in_threadpool(svc.analyse, g)


@router.get("/{gen_id}/palette")
async def palette(gen_id: str, k: int = Query(8, ge=2, le=16), db: Session = Depends(get_db),
                  cur: CurrentUser = Depends(get_current_user)):
    g = _source(db, cur, gen_id)
    return {"clusters": await run_in_threadpool(svc.palette, g, k)}


@router.post("/{gen_id}/auto")
async def auto(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    g = _source(db, cur, gen_id)
    return await run_in_threadpool(svc.auto, g)


@router.post("/{gen_id}/render", response_model=JobOut, status_code=202)
def render(gen_id: str, body: RenderIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    g = _source(db, cur, gen_id)
    job = svc.queue_render(db, g, body.params.plain(), body.format, body.quality, body.note, cur.user.id)
    db.commit()
    return job_out(job)


@router.post("/{gen_id}/effect", response_model=JobOut, status_code=202)
def effect(gen_id: str, body: EffectIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    g = _source(db, cur, gen_id)
    job = svc.queue_effect(db, g, body.name, body.strength, body.format, body.quality, body.note, cur.user.id)
    db.commit()
    return job_out(job)


@router.get("/{gen_id}/history")
def history(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return svc.history(db, _source(db, cur, gen_id))


@router.post("/{gen_id}/revert")
def revert(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    # a Library item id would mean "its current version", which is already current: only generation ids here
    from app.services import get_owned

    g = get_owned(db, Generation, gen_id, cur.workspace_id, "Generation")
    out = svc.revert(db, g)
    db.commit()
    return out


@router.post("/cube")
def cube(body: CubeIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    p = dv.normalise(body.params.plain())
    lut = svc.resolve_lut(db, cur.workspace_id, p)
    p["lut"] = None
    table = lt.bake(p, body.size, lut=lut)
    title = body.title.strip() or "Mix AI look"
    return Response(lk.cube_text(table, title, p), media_type="text/plain; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="{_file_name(title)}.cube"', "Cache-Control": "no-store"})


def _file_name(title: str) -> str:
    safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in title).strip()
    return safe[:80] or "look"


# ---------------------------------------------------------------- restore / cut-out (contract v10)

async def _info() -> tuple[dict | None, str | None, str]:
    from app.config import get_settings
    from app.upscale import fetch_object_info

    driver = get_settings().gen_driver
    info, error = (None, None) if driver == "mock" else await fetch_object_info()
    return info, error, driver


@router.get("/tools")
async def tools(cur: CurrentUser = Depends(get_current_user)):
    info, error, driver = await _info()
    return {"tools": rs.tool_options(info, driver=driver, error=error), "effects": fx.EFFECTS}


@router.get("/{gen_id}/smart-plan")
async def smart_plan(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    g = _source(db, cur, gen_id)
    info, _, driver = await _info()
    return await run_in_threadpool(rs.smart_plan, db, g, info, driver)


@router.post("/{gen_id}/smart-restore", status_code=202)
def smart_restore(gen_id: str, body: SmartRestoreIn, db: Session = Depends(get_db),
                  cur: CurrentUser = Depends(require_editor)):
    g = _source(db, cur, gen_id)
    try:
        out = rs.queue_smart(db, g, [s.model_dump() for s in body.steps], cur.user.id)
    except rs.RestoreError as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return out


@router.post("/{gen_id}/restore", response_model=JobOut, status_code=202)
def restore(gen_id: str, body: RestoreIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    g = _source(db, cur, gen_id)
    opts = body.model_dump(exclude={"tool", "note"})
    try:
        job = rs.queue_tool(db, g, body.tool, opts, cur.user.id, note=body.note)
    except rs.RestoreError as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return job_out(job)


@router.post("/{gen_id}/background", response_model=JobOut, status_code=202)
def background(gen_id: str, body: BackgroundIn, db: Session = Depends(get_db),
               cur: CurrentUser = Depends(require_editor)):
    g = _source(db, cur, gen_id)
    try:
        job = rs.queue_background(db, g, body.background.model_dump(),
                                  body.edge.model_dump() if body.edge else None, cur.user.id)
    except (rs.RestoreError, ValueError) as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return job_out(job)


@router.get("/{gen_id}/mask", responses={200: {"content": {"image/png": {}}}})
def mask(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    from app.config import get_settings

    g = _source(db, cur, gen_id)
    _, rel = rs.cutout_base(db, g)
    path = get_settings().data_dir / rel if rel else None
    if not path or not path.is_file():
        raise HTTPException(404, "This picture has no cut-out mask")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/{gen_id}/describe")
async def describe(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    g = _source(db, cur, gen_id)
    return await run_in_threadpool(rs.describe, g)
