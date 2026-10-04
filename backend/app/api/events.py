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
from app.models import Generation, Job, utcnow
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
    finally:
        db.close()
    out.sort(key=lambda r: r[2])
    return out


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
