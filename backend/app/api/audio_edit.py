"""Audio editor, analysis and Score a Clip (contract v15).

The /audio/mix routes are declared first: /audio/mix/preview would otherwise match /audio/{item_id}/preview.
"""
import shutil
import tempfile
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from app import audio_analysis as aa
from app import audio_edit as ae
from app import audio_jobs as aj
from app import library as lib
from app import mixdown as md
from app.db import get_db
from app.reel import safe_name
from app.schemas import AudioPreviewIn, AudioRenderIn, LoudnessTarget, MixIn, MixRenderIn
from app.security import CurrentUser, get_current_user, require_editor
from app.services import generation_file, job_out

router = APIRouter(prefix="/audio", tags=["audio"])

ExportFormat = Literal["wav16", "wav24", "wav32f", "flac", "mp3_128", "mp3_192", "mp3_320", "opus"]
TOO_LONG = "This is over 20 minutes, too long to preview; use Save"


def _fail(e: Exception):
    if isinstance(e, ae.TooLong):
        return HTTPException(413, TOO_LONG)
    if isinstance(e, (ae.EditError, ae.FFmpegFailed, aa.AnalysisError)):
        return HTTPException(422, str(e))
    return e


def _num(v) -> str | None:
    return None if v is None else f"{v:.1f}"


def _mp3(headers: dict, data: bytes) -> Response:
    return Response(data, media_type="audio/mpeg",
                    headers={"Cache-Control": "no-store", **{k: v for k, v in headers.items() if v is not None}})


# ---------------------------------------------------------------- Score a Clip

def _mix_preview(mix: dict, video, tracks) -> tuple[bytes, dict]:
    tmp = Path(tempfile.mkdtemp(prefix="mixai-mix-"))
    try:
        if aa.stream_info(video).duration > ae.PREVIEW_MAX_S:
            raise ae.TooLong(TOO_LONG)
        dst = tmp / "mix.mp3"
        t0 = time.monotonic()
        info = md.preview(mix, video, tracks, dst)
        info["ms"] = round((time.monotonic() - t0) * 1000)
        return dst.read_bytes(), info
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@router.post("/mix/preview", responses={200: {"content": {"audio/mpeg": {}}}})
async def mix_preview(body: MixIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    _, g = aj.video_source(db, cur.workspace_id, body.video_id)
    mix = body.model_dump(mode="json")
    tracks = aj.mix_tracks(db, cur.workspace_id, mix["tracks"])
    try:
        data, info = await run_in_threadpool(_mix_preview, mix, generation_file(g), tracks)
    except Exception as e:
        raise _fail(e) from None
    return _mp3({"X-Duration-S": f"{info['duration_s']:.3f}", "X-Render-Ms": str(info["ms"])}, data)


@router.post("/mix", status_code=202)
def mix(body: MixRenderIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    item, g = aj.video_source(db, cur.workspace_id, body.video_id)
    spec = body.model_dump(mode="json", exclude={"stems", "note"})
    job = aj.queue_mix(db, item, g, spec, body.stems, body.note, cur.id)
    db.commit()
    return {"item": lib.item_out(db, item), "job": job_out(job)}


# ---------------------------------------------------------------- one audio item

@router.get("/{item_id}/peaks")
async def peaks(item_id: str, n: int = Query(4000, ge=200, le=20000), version: str | None = None,
                db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    _, g = aj.audio_source(db, cur.workspace_id, item_id, version)
    try:
        return await run_in_threadpool(aa.peaks, generation_file(g), n)
    except aa.AnalysisError as e:
        raise HTTPException(422, str(e)) from None


@router.get("/{item_id}/analysis")
async def analysis(item_id: str, version: str | None = None, db: Session = Depends(get_db),
                   cur: CurrentUser = Depends(get_current_user)):
    _, g = aj.audio_source(db, cur.workspace_id, item_id, version)
    try:
        return await run_in_threadpool(aa.analyse, generation_file(g))
    except aa.AnalysisError as e:
        raise HTTPException(422, str(e)) from None


def _preview(edit: dict, src, appends) -> tuple[bytes, dict]:
    tmp = Path(tempfile.mkdtemp(prefix="mixai-audio-"))
    try:
        dst = tmp / "preview.mp3"
        t0 = time.monotonic()
        info = ae.render(edit, src, dst, ["-c:a", "libmp3lame", "-b:a", "128k"], appends, meter=True, timeout=300,
                         max_s=ae.PREVIEW_MAX_S)
        info["ms"] = round((time.monotonic() - t0) * 1000)
        return dst.read_bytes(), info
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@router.post("/{item_id}/preview", responses={200: {"content": {"audio/mpeg": {}}}})
async def preview(item_id: str, body: AudioPreviewIn, db: Session = Depends(get_db),
                  cur: CurrentUser = Depends(get_current_user)):
    _, g = aj.audio_source(db, cur.workspace_id, item_id, body.version)
    edit = ae.normalise(body.edit)
    appends = [generation_file(aj.audio_ref(db, cur.workspace_id, i, "Append")) for i in edit["append"]]
    try:
        data, info = await run_in_threadpool(_preview, edit, generation_file(g), appends)
    except Exception as e:
        raise _fail(e) from None
    return _mp3({"X-Duration-S": f"{info['duration_s']:.3f}", "X-Lufs-I": _num(info.get("lufs_i")),
                 "X-True-Peak-Db": _num(info.get("true_peak_db")), "X-Render-Ms": str(info["ms"])}, data)


@router.post("/{item_id}/render", status_code=202)
def render(item_id: str, body: AudioRenderIn, db: Session = Depends(get_db),
           cur: CurrentUser = Depends(require_editor)):
    item, g = aj.audio_source(db, cur.workspace_id, item_id, body.version)
    try:
        job = aj.queue_render(db, item, g, body.edit.model_dump(mode="json"), body.note, cur.id)
    except ae.EditError as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return {"item": lib.item_out(db, item), "job": job_out(job)}


@router.get("/{item_id}/export")
async def export(item_id: str, format: ExportFormat = "wav16", loudness: LoudnessTarget | None = None,
                 version: str | None = None, db: Session = Depends(get_db),
                 cur: CurrentUser = Depends(get_current_user)):
    item, g = aj.audio_source(db, cur.workspace_id, item_id, version)
    _, ext, media_type = ae.FORMATS[format]
    tmp = Path(tempfile.mkdtemp(prefix="mixai-export-"))
    dst = tmp / f"export{ext}"
    try:
        await run_in_threadpool(ae.export, generation_file(g), dst, format, loudness)
    except Exception as e:
        shutil.rmtree(tmp, ignore_errors=True)
        raise _fail(e) from None
    name = safe_name(item.title or "", "audio") + ext
    return FileResponse(dst, media_type=media_type, filename=name, headers={"Cache-Control": "no-store"},
                        background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True))
