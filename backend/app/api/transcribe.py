"""Transcribe (contract v18): timed transcripts, subtitles, LLM cleanup and subtitles onto a video."""
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import library as lib
from app import transcripts as tr
from app.db import get_db
from app.dub.schemas import TranscribeIn, TranscriptVideoIn
from app.models import Job, Transcript
from app.security import CurrentUser, get_current_user, require_editor
from app.services import get_owned, job_out

router = APIRouter(tags=["transcribe"])


def _owned(db: Session, cur: CurrentUser, tid: str) -> Transcript:
    return get_owned(db, Transcript, tid, cur.workspace_id, "Transcript")


def _out(db: Session, t: Transcript) -> dict:
    out = tr.transcript_out(t)
    job = db.get(Job, t.job_id) if t.job_id else None
    out["job"] = job_out(job) if job is not None else None
    item = lib.detail(db, t.workspace_id, t.media_id)
    out["media"] = item.model_dump(mode="json") if item is not None else None
    return out


@router.post("/transcribe", status_code=202)
def transcribe(body: TranscribeIn, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    t, job = tr.queue_transcribe(db, cur.workspace_id, body.media_id, body.language, body.words, body.cleanup)
    db.commit()
    return {"transcript_id": t.id, "job": job_out(job)}


@router.get("/transcripts")
def list_transcripts(media_id: str | None = Query(None, max_length=36), db: Session = Depends(get_db),
                     cur: CurrentUser = Depends(get_current_user)):
    q = select(Transcript).where(Transcript.workspace_id == cur.workspace_id)
    if media_id:
        q = q.where(Transcript.media_id == media_id)
    rows = db.scalars(q.order_by(Transcript.created_at.desc(), Transcript.id).limit(100)).all()
    # the list is for picking one; the segments come with GET /transcripts/{id}
    return [{k: v for k, v in tr.transcript_out(t).items() if k != "segments"} for t in rows]


@router.get("/transcripts/{tid}")
def get_transcript(tid: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    return _out(db, _owned(db, cur, tid))


@router.delete("/transcripts/{tid}", status_code=204)
def delete_transcript(tid: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    db.delete(_owned(db, cur, tid))
    db.commit()
    return Response(status_code=204)


def _ready(t: Transcript) -> None:
    if t.status not in ("done", "cleaning"):
        raise HTTPException(409, "The transcript isn't finished yet")
    if not t.segments:
        raise HTTPException(409, "The transcript is empty")


@router.get("/transcripts/{tid}/subtitles")
def subtitles(tid: str, format: str = Query("srt", pattern="^(srt|vtt)$"), clean: bool = False,
              db: Session = Depends(get_db), cur: CurrentUser = Depends(get_current_user)):
    t = _owned(db, cur, tid)
    _ready(t)
    items = tr.cues(t.segments, clean=clean and t.cleanup_text is not None)
    body = tr.to_srt(items) if format == "srt" else tr.to_vtt(items)
    name = lib.short_title(t.title or "transcript", 6).replace('"', "") or "transcript"
    kind = "application/x-subrip" if format == "srt" else "text/vtt"
    return Response(body, media_type=f"{kind}; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{_ascii(name)}.{format}"'})


def _ascii(name: str) -> str:
    out = "".join(ch if ch.isascii() and (ch.isalnum() or ch in " -_") else "_" for ch in name).strip()
    return out or "transcript"


@router.post("/transcripts/{tid}/cleanup", status_code=202)
def cleanup(tid: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    t = _owned(db, cur, tid)
    _ready(t)
    job = tr.queue_cleanup(db, t)
    t.status = "cleaning"
    db.commit()
    return job_out(job)


@router.post("/transcripts/{tid}/video", status_code=202)
def subtitle_video(tid: str, body: TranscriptVideoIn, db: Session = Depends(get_db),
                   cur: CurrentUser = Depends(require_editor)):
    t = _owned(db, cur, tid)
    _ready(t)
    item, job = tr.queue_video(db, t, body.mode, body.clean and t.cleanup_text is not None, cur.id)
    db.commit()
    return {"job": job_out(job), "item_id": item.id, "generation_id": job.generation_id}
