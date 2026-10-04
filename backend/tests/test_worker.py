from datetime import timedelta
from pathlib import Path

from PIL import Image

from app.db import SessionLocal
from app.drivers.mock import MockDriver
from app.models import Generation, Job, UsageLedger, utcnow
from app.worker import MAX_ATTEMPTS, claim_next, process_one, recover_stuck


def _queue(client, character, n=1):
    ids = []
    for _ in range(n):
        r = client.post(
            "/api/generations",
            json={"target_type": "character", "target_id": character["id"], "kind": "portrait", "prompt": "p"},
        )
        ids.append(r.json()["job_id"])
    return ids


def test_claim_is_atomic(client, character):
    [job_id] = _queue(client, character)
    a, b = SessionLocal(), SessionLocal()
    try:
        # both workers see the same queued row...
        assert a.get(Job, job_id).status == "queued"
        assert b.get(Job, job_id).status == "queued"
        first = claim_next(a)
        second = claim_next(b)
    finally:
        a.close()
        b.close()
    # ...but only one of them gets it
    assert first is not None and first.id == job_id and first.attempts == 1
    assert second is None


def test_claim_order_is_oldest_first(client, character, db):
    ids = _queue(client, character, 3)
    claimed = [claim_next(db).id for _ in range(3)]
    assert claimed == ids
    assert claim_next(db) is None


def test_stuck_running_requeued_then_failed(client, character, db):
    [job_id] = _queue(client, character)
    job = claim_next(db)
    gen = db.get(Generation, job.generation_id)
    gen.status = "generating"
    db.commit()

    # simulated crash: job left "running"
    assert recover_stuck(db) == 1
    db.refresh(job)
    db.refresh(gen)
    assert job.status == "queued" and gen.status == "queued"

    # keep crashing until it gives up (the first crash above was attempt 1)
    for _ in range(MAX_ATTEMPTS - 2):
        assert claim_next(db).id == job_id
        recover_stuck(db)
    db.refresh(job)
    assert job.status == "queued" and job.attempts == MAX_ATTEMPTS - 1
    claim_next(db)
    recover_stuck(db)
    db.refresh(job)
    db.refresh(gen)
    assert job.status == "failed" and "Gave up" in job.error
    assert gen.status == "failed"


def test_stale_only_recovery_skips_live_jobs(client, character, db):
    _queue(client, character)
    job = claim_next(db)
    assert recover_stuck(db, timedelta(seconds=90)) == 0
    job.heartbeat_at = utcnow() - timedelta(minutes=5)
    db.commit()
    assert recover_stuck(db, timedelta(seconds=90)) == 1


def test_cancel_while_running(client, character, db):
    [job_id] = _queue(client, character)

    class CancelMidway(MockDriver):
        def generate_image(self, prompt, params, seed, out_path, progress_cb):
            client.post(f"/api/jobs/{job_id}/cancel")
            return super().generate_image(prompt, params, seed, out_path, progress_cb)

    assert process_one(driver_factory=lambda: CancelMidway(step_seconds=0))
    job = db.get(Job, job_id)
    assert job.status == "cancelled" and job.finished_at is not None
    assert db.get(Generation, job.generation_id).status == "failed"

    retried = client.post(f"/api/jobs/{job_id}/retry").json()
    assert retried["status"] == "queued" and retried["attempts"] == 0


def test_cancel_queued_and_unknown_job_type(client, character, db):
    [job_id] = _queue(client, character)
    r = client.post(f"/api/jobs/{job_id}/cancel").json()
    assert r["status"] == "cancelled"
    assert client.post(f"/api/jobs/{job_id}/cancel").status_code == 409

    job = Job(workspace_id=db.get(Job, job_id).workspace_id, type="mystery")
    db.add(job)
    db.commit()
    assert process_one()
    db.refresh(job)
    assert job.status == "failed" and "Unknown job type" in job.error


def test_done_job_records_usage(client, character, db, fast_driver):
    [job_id] = _queue(client, character)
    assert process_one(driver_factory=fast_driver)
    rows = db.query(UsageLedger).filter_by(job_id=job_id).all()
    assert len(rows) == 1 and rows[0].kind == "generate"


def test_mock_driver_writes_png(tmp_path: Path):
    seen = []
    out = tmp_path / "x" / "g.png"
    res = MockDriver(step_seconds=0).generate_image(
        "A diver drifts over pale coral", {"width": 640, "height": 360}, 1234, out, lambda p, m: seen.append(p)
    )
    assert res.media_type == "image/png" and out.is_file()
    with Image.open(out) as im:
        assert im.format == "PNG" and im.size == (640, 360)
    assert seen[-1] == 1.0 and seen == sorted(seen)


def test_comfy_driver_builds_without_network():
    from app.drivers import get_driver

    # constructing must not touch the GPU box (worker calls this at startup)
    assert get_driver("comfy").name == "comfy"
