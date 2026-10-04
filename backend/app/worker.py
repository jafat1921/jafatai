"""Job worker: `python -m app.worker` (cwd=backend).

One job at a time per process. Jobs are claimed with a conditional UPDATE so
several workers (one per GPU later) can share the same table safely.
"""
import logging
import os
import signal
import socket
import threading
import time
from datetime import timedelta
from pathlib import Path
from typing import Callable

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings
from app.db import SessionLocal
from app.drivers import GenerationDriver, get_driver
from app.models import Generation, Job, UsageLedger, WorkerHeartbeat, utcnow

log = logging.getLogger("mixai.worker")

MAX_ATTEMPTS = 3
STALE_AFTER = timedelta(seconds=90)
HEARTBEAT_EVERY = 5.0
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"

IMAGE_KINDS = {"portrait", "sheet_view", "keyframe_start", "keyframe_end", "keyframe_mid"}
VIDEO_KINDS = {"take", "tile", "render"}
TEXT_KINDS = {"scene_text"}
EXT = {"image/png": ".png", "video/mp4": ".mp4", "text/plain": ".txt"}

_stop = threading.Event()


class JobCancelled(Exception):
    pass


class WorkerStopping(Exception):
    pass


def claim_next(db: Session, gpu: str | None = None) -> Job | None:
    for _ in range(5):
        job_id = db.scalars(
            select(Job.id)
            .where(Job.status == "queued")
            .order_by(Job.priority.desc(), Job.created_at)
            .limit(1)
        ).first()
        if job_id is None:
            return None
        now = utcnow()
        res = db.execute(
            update(Job)
            .where(Job.id == job_id, Job.status == "queued")
            .values(
                status="running",
                started_at=now,
                heartbeat_at=now,
                updated_at=now,
                attempts=Job.attempts + 1,
                gpu=gpu,
                message="Starting",
            )
            .execution_options(synchronize_session=False)
        )
        db.commit()
        if res.rowcount == 1:
            return db.get(Job, job_id, populate_existing=True)
        # someone else won the race; try the next oldest
    return None


def recover_stuck(db: Session, stale_after: timedelta | None = None) -> int:
    """Put orphaned running jobs back in the queue (or fail them after MAX_ATTEMPTS)."""
    q = select(Job).where(Job.status == "running")
    if stale_after is not None:
        cutoff = utcnow() - stale_after
        q = q.where(or_(Job.heartbeat_at.is_(None), Job.heartbeat_at < cutoff))
    n = 0
    for job in db.scalars(q).all():
        gen = db.get(Generation, job.generation_id) if job.generation_id else None
        if job.attempts >= MAX_ATTEMPTS:
            job.status = "failed"
            job.error = f"Gave up after {job.attempts} attempts (worker kept dying mid-job)"
            job.finished_at = utcnow()
            if gen and gen.status in ("queued", "generating"):
                gen.status = "failed"
        else:
            job.status = "queued"
            job.progress = 0.0
            job.message = "Re-queued after worker restart"
            if gen and gen.status == "generating":
                gen.status = "queued"
        n += 1
    db.commit()
    return n


def beat(db: Session) -> None:
    hb = db.get(WorkerHeartbeat, WORKER_ID)
    if hb is None:
        hb = WorkerHeartbeat(id=WORKER_ID, info={"driver": get_settings().gen_driver, "pid": os.getpid()})
        db.add(hb)
    hb.last_seen = utcnow()
    db.commit()


class JobContext:
    def __init__(self, db: Session, job: Job, driver_factory: Callable[[], GenerationDriver]):
        self.db = db
        self.job = job
        self.driver_factory = driver_factory
        self._last_beat = time.monotonic()

    def progress(self, fraction: float, message: str = "") -> None:
        db, job = self.db, self.job
        # status may have been flipped to cancelled by the API in another process
        current = db.scalar(select(Job.status).where(Job.id == job.id))
        if current == "cancelled":
            raise JobCancelled()
        if _stop.is_set():
            raise WorkerStopping()
        job.progress = max(0.0, min(1.0, fraction))
        if message:
            job.message = message[:500]
        job.heartbeat_at = utcnow()
        db.commit()
        # long GPU jobs would otherwise make /system/status report the worker as dead
        if time.monotonic() - self._last_beat >= HEARTBEAT_EVERY:
            beat(db)
            self._last_beat = time.monotonic()


def _out_path(gen: Generation, media_ext: str) -> tuple[Path, str]:
    project = gen.project_id or "_unassigned"
    rel = Path("workspaces") / gen.workspace_id / "projects" / project / "generations" / f"{gen.id}{media_ext}"
    return get_settings().data_dir / rel, rel.as_posix()


def handle_generate(ctx: JobContext) -> dict:
    db, job = ctx.db, ctx.job
    gen = db.get(Generation, job.generation_id) if job.generation_id else None
    if gen is None:
        raise RuntimeError("Generation for this job no longer exists")

    if gen.kind in IMAGE_KINDS:
        method, media_type = "generate_image", "image/png"
    elif gen.kind in VIDEO_KINDS:
        method, media_type = "generate_video", "video/mp4"
    elif gen.kind in TEXT_KINDS:
        method, media_type = "generate_text", "text/plain"
    else:
        raise RuntimeError(f"No handler for generation kind '{gen.kind}'")

    driver = ctx.driver_factory()
    job.gpu = job.gpu or getattr(driver, "name", None)
    gen.status = "generating"
    db.commit()

    abs_path, rel_path = _out_path(gen, EXT[media_type])
    params = {
        **(gen.params or {}),
        "kind": gen.kind,
        "version": gen.version,
        # the comfy driver resolves reference images / project aspect from these
        "generation_id": gen.id,
        "target_type": gen.target_type,
        "target_id": gen.target_id,
        "project_id": gen.project_id,
    }
    result = getattr(driver, method)(gen.prompt, params, gen.seed, abs_path, ctx.progress)

    if getattr(result, "params_update", None):
        gen.params = {**(gen.params or {}), **result.params_update}
    gen.file_path = rel_path
    gen.media_type = result.media_type
    gen.status = "ready"
    return {"file_path": rel_path, "media_type": result.media_type, **result.meta}


HANDLERS: dict[str, Callable[[JobContext], dict]] = {
    "generate": handle_generate,
}

from app.ai_jobs import AI_HANDLERS  # noqa: E402  (LLM writing jobs live in their own module)

HANDLERS.update(AI_HANDLERS)


def _close_generation(db: Session, job: Job, status: str = "failed") -> None:
    if job.generation_id:
        gen = db.get(Generation, job.generation_id)
        if gen and gen.status in ("queued", "generating"):
            gen.status = status


def run_job(db: Session, job: Job, driver_factory: Callable[[], GenerationDriver] | None = None) -> None:
    factory = driver_factory or (lambda: get_driver(get_settings().gen_driver))
    ctx = JobContext(db, job, factory)
    t0 = time.monotonic()
    handler = HANDLERS.get(job.type)
    try:
        if handler is None:
            raise RuntimeError(f"Unknown job type '{job.type}'")
        result = handler(ctx)
    except JobCancelled:
        db.rollback()
        db.refresh(job)
        job.message = "Cancelled"
        job.finished_at = utcnow()
        _close_generation(db, job)
        log.info("job %s cancelled", job.id)
    except WorkerStopping:
        db.rollback()
        db.refresh(job)
        # hand it back untouched; the attempt shouldn't count against it
        job.status = "queued"
        job.progress = 0.0
        job.attempts = max(0, job.attempts - 1)
        job.message = "Re-queued: worker shut down"
        _close_generation(db, job, status="queued")
        log.info("job %s re-queued on shutdown", job.id)
    except Exception as e:
        db.rollback()
        db.refresh(job)
        job.status = "failed"
        job.error = str(e) or type(e).__name__
        job.message = "Failed"
        job.finished_at = utcnow()
        _close_generation(db, job)
        log.exception("job %s failed", job.id)
    else:
        elapsed = round(time.monotonic() - t0, 3)
        # drivers that know the real GPU time (comfy history timestamps) report it
        if isinstance(result, dict) and result.get("gpu_seconds"):
            elapsed = float(result["gpu_seconds"])
        job.status = "done"
        job.progress = 1.0
        job.message = "Done"
        job.result = result
        job.finished_at = utcnow()
        job.gpu_seconds = elapsed
        db.add(UsageLedger(workspace_id=job.workspace_id, job_id=job.id, gpu_seconds=elapsed, kind=job.type))
    db.commit()


def process_one(
    session_factory: sessionmaker | Callable[[], Session] = SessionLocal,
    driver_factory: Callable[[], GenerationDriver] | None = None,
) -> bool:
    """Claim and run a single job. Returns False when the queue was empty."""
    db = session_factory()
    try:
        job = claim_next(db, gpu=get_settings().gen_driver)
        if job is None:
            return False
        log.info("running job %s (%s)", job.id, job.type)
        run_job(db, job, driver_factory)
        return True
    finally:
        db.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = get_settings()
    s.data_dir.mkdir(parents=True, exist_ok=True)

    def _on_signal(signum, _frame):
        if _stop.is_set():
            raise SystemExit(1)  # second Ctrl+C: stop waiting
        log.info("shutting down after the current step (Ctrl+C again to force)")
        _stop.set()

    signal.signal(signal.SIGINT, _on_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _on_signal)

    # fail fast on a bad driver config instead of failing every job
    get_driver(s.gen_driver)

    with SessionLocal() as db:
        # single worker in M1, so anything still "running" belongs to a dead process
        # TODO: with one worker per GPU, only recover by heartbeat staleness here
        n = recover_stuck(db)
        if n:
            log.info("recovered %d job(s) left running by a previous worker", n)
        beat(db)

    log.info("worker %s up, driver=%s, data=%s", WORKER_ID, s.gen_driver, s.data_dir)
    last_beat = 0.0
    while not _stop.is_set():
        now = time.monotonic()
        if now - last_beat >= HEARTBEAT_EVERY:
            with SessionLocal() as db:
                beat(db)
                recover_stuck(db, STALE_AFTER)
            last_beat = now
        try:
            worked = process_one()
        except Exception:
            log.exception("worker loop error")
            worked = False
        if not worked:
            _stop.wait(1.0)

    with SessionLocal() as db:
        hb = db.get(WorkerHeartbeat, WORKER_ID)
        if hb:
            db.delete(hb)
            db.commit()
    log.info("worker stopped")


if __name__ == "__main__":
    main()
