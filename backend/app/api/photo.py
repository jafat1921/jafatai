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
from app.photo import workflow as wf
from app.photo.schemas import (BackgroundIn, CubeIn, DevelopParams, EffectIn, ParamsIn, PreviewIn, RenderIn,
                                RestoreIn, SmartRestoreIn, SnapshotIn, SnapshotPatch, SyncIn)
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
        "switchable": list(dv.SWITCHABLE),
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


# ---------------------------------------------------------------- develop workflow (M10 / D1)

@router.post("/sync", status_code=202)
def sync(body: SyncIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    out = wf.queue_sync(db, cur.workspace_id, body.ids, body.params.plain(), body.groups, body.format, body.quality,
                        cur.user.id)
    db.commit()
    return {"results": out, "queued": sum(1 for r in out if r["job_id"])}


@router.get("/{gen_id}/snapshots")
def list_snapshots(gen_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return wf.snapshots(db, _source(db, cur, gen_id))


@router.post("/{gen_id}/snapshots", status_code=201)
def create_snapshot(gen_id: str, body: SnapshotIn, db: Session = Depends(get_db),
                    cur: CurrentUser = Depends(require_editor)):
    from app.models import PhotoSnapshot

    g = _source(db, cur, gen_id)
    base = _source(db, cur, body.base_id) if body.base_id else g
    if (base.target_type, base.target_id) != (g.target_type, g.target_id):
        raise HTTPException(422, "base_id must be a version of the same picture")
    s = PhotoSnapshot(workspace_id=cur.workspace_id, target_type=g.target_type, target_id=g.target_id,
                      base_id=base.id, name=body.name.strip(), params=dv.normalise(body.params.plain()))
    db.add(s)
    db.commit()
    return wf.snapshot_out(s)


@router.patch("/snapshots/{sid}")
def patch_snapshot(sid: str, body: SnapshotPatch, db: Session = Depends(get_db),
                   cur: CurrentUser = Depends(require_editor)):
    s = wf.owned_snapshot(db, cur.workspace_id, sid)
    if body.name is not None:
        s.name = body.name.strip()
    if body.params is not None:
        s.params = dv.normalise(body.params.plain())
    db.commit()
    return wf.snapshot_out(s)


@router.delete("/snapshots/{sid}", status_code=204)
def delete_snapshot(sid: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    db.delete(wf.owned_snapshot(db, cur.workspace_id, sid))
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------- profiles and LUT tables (M10 / D2)

@router.get("/profiles")
def list_profiles(cur: CurrentUser = Depends(get_current_user)):
    from app.photo import profiles

    return profiles.listing()


def _table_json(table) -> dict:
    import base64

    import numpy as np

    n = int(table.shape[0])
    data = np.clip(np.rint(table.reshape(-1, 3) * 255), 0, 255).astype(np.uint8).tobytes()
    # red runs fastest, then green, then blue: a WebGL TEXTURE_3D (width = red) takes it as it is
    return {"size": n, "data": base64.b64encode(data).decode("ascii")}


@router.get("/luts/profile/{profile_id}")
def profile_lut(profile_id: str, response: Response, cur: CurrentUser = Depends(get_current_user)):
    from app.photo import profiles

    if profile_id not in profiles.PROFILES:
        raise HTTPException(404, "No such profile")
    table = profiles.table(profile_id)
    if table is None:
        table = lt.identity(profiles.SIZE)
    response.headers["Cache-Control"] = "private, max-age=86400"
    return _table_json(table)


@router.get("/luts/look/{look_id}")
def look_lut(look_id: str, response: Response, db: Session = Depends(get_db),
             cur: CurrentUser = Depends(get_current_user)):
    look = svc.visible_look(db, cur.workspace_id, look_id)
    if look is None:
        raise HTTPException(404, "Look not found")
    try:
        table = svc.look_table(look)
    except (svc.PhotoError, lt.CubeError) as e:
        raise HTTPException(422, str(e)) from None
    if table is None:
        raise HTTPException(404, "This look has no .cube")
    response.headers["Cache-Control"] = "private, max-age=3600"
    return _table_json(table)
