from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Generation, Job, utcnow
from app.schemas import JobOut
from app.security import CurrentUser, get_current_user, require_editor
from app.services import get_owned, job_out

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=list[JobOut])
def list_jobs(
    status: str | None = None,
    project_id: str | None = None,
    db: Session = Depends(get_db),
    cur: CurrentUser = Depends(get_current_user),
):
    q = select(Job).where(Job.workspace_id == cur.workspace_id)
    if status:
        q = q.where(Job.status.in_([s.strip() for s in status.split(",") if s.strip()]))
    if project_id:
        q = q.where(Job.project_id == project_id)
    q = q.order_by(Job.created_at.desc()).limit(100)
    return [job_out(j) for j in db.scalars(q).all()]


@router.post("/{job_id}/cancel", response_model=JobOut)
def cancel_job(job_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    job = get_owned(db, Job, job_id, cur.workspace_id, "Job")
    if job.status not in ("queued", "running"):
        raise HTTPException(409, f"Job is already {job.status}")
    was_running = job.status == "running"
    job.status = "cancelled"
    job.message = "Cancelling…" if was_running else "Cancelled"
    if not was_running:
        job.finished_at = utcnow()
        # a running job's generation is closed out by the worker when it notices
        if job.generation_id:
            g = db.get(Generation, job.generation_id)
            if g and g.status in ("queued", "generating"):
                g.status = "failed"
    db.commit()
    return job_out(job)


@router.post("/{job_id}/retry", response_model=JobOut)
def retry_job(job_id: str, db: Session = Depends(get_db), cur: CurrentUser = Depends(require_editor)):
    job = get_owned(db, Job, job_id, cur.workspace_id, "Job")
    if job.status not in ("failed", "cancelled"):
        raise HTTPException(409, "Only failed or cancelled jobs can be retried")
    job.status = "queued"
    job.progress = 0.0
    job.error = None
    job.message = "Waiting for a worker"
    job.attempts = 0
    job.started_at = job.finished_at = job.heartbeat_at = None
    job.gpu_seconds = None
    if job.generation_id:
        g = db.get(Generation, job.generation_id)
        if g and g.status == "failed":
            g.status = "queued"
    db.commit()
    return job_out(job)
