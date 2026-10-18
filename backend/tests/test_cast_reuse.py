"""The cast stage: reusing a studio character's finished portrait, and fresh tries after a job retry."""
import pytest
from PIL import Image
from sqlalchemy import select

from app import autopilot as ap_mod
from app import character_sheet
from app.db import SessionLocal
from app.models import Character, Generation, Job
from app.worker import JobContext
from tests.test_character_sheet import run_all, studio_character


def portrait(client, character, prompt):
    r = client.post("/api/generations", json={"target_type": "character", "target_id": character["id"],
                                              "kind": "portrait", "prompt": prompt})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def cast_stage(client, db, fast_driver, cast_id):
    r = client.post("/api/quick", json={"prompt": "A keeper's farewell", "duration_s": 10, "cast_ids": [cast_id]})
    assert r.status_code == 201, r.text
    job = db.get(Job, r.json()["job"]["id"])
    job.status = "running"  # driven by hand, the worker mustn't claim it
    db.commit()
    a = ap_mod.Autopilot(JobContext(db, job, fast_driver))
    a.current = "cast"
    a.r["cast"] = {"extracted": True}
    return a


def portraits(db, cid):
    return db.scalars(select(Generation).where(Generation.target_id == cid, Generation.kind == "portrait")
                      .order_by(Generation.version)).all()


def test_newest_finished_portrait_is_approved_not_redrawn(client, fast_driver):
    mara = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
    old = portrait(client, mara, "first try")
    new = portrait(client, mara, "second try")
    run_all(fast_driver)
    with SessionLocal() as db:
        a = cast_stage(client, db, fast_driver, mara["id"])
        assert a.stage_cast() is None
        db.commit()
        gens = portraits(db, mara["id"])
        assert [g.id for g in gens] == [old, new]  # nothing new queued
        assert db.get(Generation, new).status == "approved"
        assert db.get(Generation, new).params["auto_check"] == "reused"
        assert db.get(Generation, old).status == "ready"
        # no portrait prompt was written either: the look is settled
        assert mara["id"] not in a.r["cast"].get("portrait_prompts", {})


def test_an_approved_portrait_is_left_alone(client, fast_driver):
    mara = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
    old = portrait(client, mara, "first try")
    run_all(fast_driver)
    assert client.post(f"/api/generations/{old}/approve").json()["status"] == "approved"
    portrait(client, mara, "newer, unapproved")
    run_all(fast_driver)
    with SessionLocal() as db:
        a = cast_stage(client, db, fast_driver, mara["id"])
        assert a.stage_cast() is None
        db.commit()
        assert db.get(Generation, old).status == "approved"
        assert "auto_check" not in (db.get(Generation, old).params or {})


def test_sheet_hero_stands_in_when_there_is_no_portrait(client, fast_driver):
    mara = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
    with SessionLocal() as db:
        c = db.get(Character, mara["id"])
        hero = character_sheet.add_own(db, c, Image.new("RGB", (48, 96), (200, 30, 30)), panel="hero",
                                       approved=False)
        db.commit()
        hero_id = hero.id
    with SessionLocal() as db:
        a = cast_stage(client, db, fast_driver, mara["id"])
        assert a.stage_cast() is None
        db.commit()
        [g] = portraits(db, mara["id"])
        assert g.status == "approved" and g.params["source"] == "sheet_hero"
        assert g.params["from_generation_id"] == hero_id and g.job_id is None
        assert g.file_path != db.get(Generation, hero_id).file_path


def test_autopilot_attempts_still_go_through_the_vision_check(client, fast_driver):
    mara = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
    with SessionLocal() as db:
        a = cast_stage(client, db, fast_driver, mara["id"])
        g = Generation(workspace_id=a.project.workspace_id, project_id=a.project.id, target_type="character",
                       target_id=mara["id"], kind="portrait", version=1, status="ready", prompt="p", seed=0,
                       file_path="nowhere.png", params={"autopilot": a.job.id})
        db.add(g)
        db.flush()
        assert a.reuse_portrait(db.get(Character, mara["id"])) is None
        assert g.status == "ready"


def test_a_retried_job_gets_fresh_tries_after_failed_ones(client, fast_driver):
    from datetime import timedelta

    from app.models import Location, utcnow
    from app.services import enqueue_generation

    mara = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
    with SessionLocal() as db:
        a = cast_stage(client, db, fast_driver, mara["id"])
        loc = Location(workspace_id=a.project.workspace_id, project_id=a.project.id, name="Mohalla Lane")
        db.add(loc)
        db.flush()
        for k in range(1 + a.s.auto_retries):
            db.add(Generation(workspace_id=loc.workspace_id, project_id=loc.project_id, target_type="location",
                              target_id=loc.id, kind="establishing", version=k + 1, status="failed", prompt="p",
                              seed=0, params={"autopilot": a.job.id}, created_at=utcnow() - timedelta(minutes=5)))
        db.commit()

        def make():
            return enqueue_generation(db, workspace_id=loc.workspace_id, project_id=loc.project_id,
                                      target_type="location", target_id=loc.id, kind="establishing", prompt="p",
                                      params={})

        def slot(run):
            return run.image_slot("location", loc.id, "establishing", make, "a lane", None, "the lane")

        with pytest.raises(ap_mod.StageFailed, match="after 3 tries"):
            slot(a)
        job = db.get(Job, a.job.id)
        job.result = {**(job.result or {}), "stitch": {"render_id": "gone", "attempts": 2}}
        ap_mod.on_retry(job)
        db.commit()
        assert job.result["stitch"]["attempts"] == 0 and job.result["resumed_at"]
        again = ap_mod.Autopilot(JobContext(db, job, fast_driver))
        waits = slot(again)
        assert len(waits) == 1
        assert db.get(Job, waits[0]).status == "queued"
