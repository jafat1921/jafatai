"""Server-sent events. The worker is a separate process, so we poll the DB rather than use an in-memory bus."""
import asyncio
import json
import time
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool
from sqlalchemy import select

from app.db import SessionLocal
from app import storyboard as sb
from app.library import items_out
from app.models import Generation, Job, MediaItem, Shot, utcnow
from app.reel import reel_events
from app.security import COOKIE_NAME, load_current, read_session_token
from app.services import gen_out, job_out

router = APIRouter(tags=["events"])

POLL_SECONDS = 1.0
PING_SECONDS = 15.0
# rows are stamped before commit, so a slow commit can land "in the past";
# re-scan a small window and de-dupe instead of trusting a strict cursor
OVERLAP = timedelta(seconds=3)


def _frame(event: str, data: dict, event_id: str | None = None) -> str:
    out = f"event: {event}\n"
    if event_id:
        out += f"id: {event_id}\n"
    return out + f"data: {json.dumps(data, separators=(',', ':'))}\n\n"


def collect_changes(workspace_id: str, since: datetime) -> list[tuple[str, str, datetime, dict]]:
    db = SessionLocal()
    try:
        jobs = db.scalars(
            select(Job).where(Job.workspace_id == workspace_id, Job.updated_at > since).order_by(Job.updated_at)
        ).all()
        gens = db.scalars(
            select(Generation)
            .where(Generation.workspace_id == workspace_id, Generation.updated_at > since)
            .order_by(Generation.updated_at)
        ).all()
        out = [("job", j.id, j.updated_at, job_out(j).model_dump(mode="json")) for j in jobs]
        out += [("generation", g.id, g.updated_at, gen_out(g).model_dump(mode="json")) for g in gens]
        out += _shot_changes(db, workspace_id, since, gens)
        out += reel_events(db, workspace_id, since, jobs)
        out += _media_changes(db, workspace_id, since)
    finally:
        db.close()
    out.sort(key=lambda r: r[2])
    return out


def _shot_changes(db, workspace_id: str, since: datetime, gens) -> list[tuple[str, str, datetime, dict]]:
    # a shot's status/frames are derived from its generations, so those count as shot changes too
    stamps: dict[str, datetime] = {}
    shots: dict[str, Shot] = {}
    for s in db.scalars(select(Shot).where(Shot.workspace_id == workspace_id, Shot.updated_at > since)).all():
        shots[s.id], stamps[s.id] = s, s.updated_at
    for g in gens:
        if g.target_type != "shot":
            continue
        s = shots.get(g.target_id) or db.get(Shot, g.target_id)
        if s is None:
            continue
        related = [s]
        if g.kind == "keyframe_end":
            _, nxt = sb.neighbours(db, s)
            if nxt is not None and nxt.seam_in == "continue":
                related.append(nxt)  # its linked START frame is this generation
        for r in related:
            shots[r.id] = r
            stamps[r.id] = max(stamps.get(r.id, r.updated_at), g.updated_at, r.updated_at)
    if not shots:
        return []
    return [("shot", o.id, stamps[o.id], o.model_dump(mode="json")) for o in sb.shots_out(db, list(shots.values()))]


def _media_changes(db, workspace_id: str, since: datetime) -> list[tuple[str, str, datetime, dict]]:
    # create, rename/tag, new version queued and finish all bump updated_at (app.library.touch)
    items = db.scalars(select(MediaItem).where(MediaItem.workspace_id == workspace_id, MediaItem.updated_at > since)
                       .order_by(MediaItem.updated_at)).all()
    return [("media", o.id, i.updated_at, o.model_dump(mode="json")) for i, o in zip(items, items_out(db, items))]


def _parse_last_id(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _auth_workspace(request: Request) -> str:
    # not using the get_db dependency: its session would stay open (and pin a
    # WAL snapshot) for as long as the stream lives
    token = request.cookies.get(COOKIE_NAME)
    uid = read_session_token(token) if token else None
    db = SessionLocal()
    try:
        cur = load_current(db, uid) if uid else None
        if not cur:
            raise HTTPException(401, "Not signed in")
        return cur.workspace_id
    finally:
        db.close()


@router.get("/events")
async def events(request: Request):
    workspace_id = await run_in_threadpool(_auth_workspace, request)
    start = _parse_last_id(request.headers.get("last-event-id")) or utcnow()

    async def stream():
        cursor = start
        seen: dict[str, datetime] = {}
        last_ping = time.monotonic()
        yield "retry: 3000\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                rows = await run_in_threadpool(collect_changes, workspace_id, cursor - OVERLAP)
                for kind, obj_id, stamp, data in rows:
                    key = f"{kind}:{obj_id}"
                    if seen.get(key) == stamp:
                        continue
                    seen[key] = stamp
                    cursor = max(cursor, stamp)
                    yield _frame(kind, data, stamp.isoformat())
                # forget anything older than the overlap window so `seen` stays small
                horizon = cursor - OVERLAP * 2
                seen = {k: v for k, v in seen.items() if v >= horizon}

                if time.monotonic() - last_ping >= PING_SECONDS:
                    last_ping = time.monotonic()
                    yield ": ping\n\n"
                await asyncio.sleep(POLL_SECONDS)
        except asyncio.CancelledError:
            # client went away mid-sleep; nothing to clean up beyond stopping
            return

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
    return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)
