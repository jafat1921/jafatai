"""Implant Preview (M22): opt-in access, consent first, one surgeon's patients only, and nothing from it reaching
the rest of the app."""
import io
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app import accounts
from app.config import get_settings
from app.db import SessionLocal
from app.implant import service as im
from app.main import app
from app.models import AdminAudit, Generation, ImplantPatient, Job, utcnow
from app.services import enqueue_generation
from app.worker import process_one

PW = "a-long-password-1"
OPTS = [{"label": "Natural", "left_cc": 300, "right_cc": 300, "profile": "moderate"},
        {"label": "Fuller", "left_cc": 375, "right_cc": 350, "profile": "high", "shape": "teardrop",
         "placement": "submuscular", "fill": "saline"}]


def _client(email: str, admin: bool = False, implant: bool = False) -> TestClient:
    with SessionLocal() as db:
        u = accounts.create_account(db, email, email.split("@")[0].title(), PW, verified=True, admin=admin)
        u.implant_access = implant
        db.commit()
    c = TestClient(app)
    assert c.post("/api/auth/login", json={"email": email, "password": PW}).status_code == 200
    return c


@pytest.fixture
def surgeon(client):
    with _client("dr.ayesha@example.com", implant=True) as c:
        yield c


def _png(size=(600, 800), colour=(200, 160, 140)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, "PNG")
    return buf.getvalue()


def _patient(c, **extra) -> dict:
    body = {"label": "P-0001", "adult_confirmed": True, "consent_attested": True,
            "measurements": {"height_cm": 162, "bw_left_cm": 12.5, "bw_right_cm": 12, "ptosis_grade": 1}, **extra}
    r = c.post("/api/implant/patients", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _photo(c, pid: str, view="front", garment="garment", crop=""):
    return c.post(f"/api/implant/patients/{pid}/photos", files={"file": ("p.png", _png(), "image/png")},
                  data={"view": view, "garment": garment, "crop": crop})


def _run(fast_driver, limit=50):
    for _ in range(limit):
        if not process_one(driver_factory=fast_driver):
            return
    raise AssertionError("the queue never emptied")


def test_it_is_opt_in_and_only_an_admin_switches_it_on(client):
    with _client("plain@example.com") as plain:
        assert plain.get("/api/implant/patients").status_code == 404
        me = plain.get("/api/auth/me").json()
        assert me["implant"] is False
        uid = me["id"]
        # a user can't grant it to themselves
        assert plain.patch(f"/api/admin/users/{uid}", json={"implant_access": True}).status_code == 404
        r = client.patch(f"/api/admin/users/{uid}", json={"implant_access": True})
        assert r.status_code == 200 and r.json()["implant_access"] is True
        assert plain.get("/api/auth/me").json()["implant"] is True
        assert plain.get("/api/implant/patients").status_code == 200
    assert client.get("/api/auth/me").json()["implant"] is True  # admins always have it
    with SessionLocal() as db:
        row = db.scalars(select(AdminAudit).where(AdminAudit.action == "user_update")).all()[-1]
        assert row.detail.get("implant_access") is True


def test_consent_and_age_come_first(surgeon):
    r = surgeon.post("/api/implant/patients", json={"label": "P", "adult_confirmed": True, "consent_attested": False})
    assert r.status_code == 422 and "consent" in r.text
    r = surgeon.post("/api/implant/patients", json={"label": "P", "adult_confirmed": False, "consent_attested": True})
    assert r.status_code == 422 and "18" in r.text
    p = _patient(surgeon)
    # topless needs its own consent tick
    assert _photo(surgeon, p["id"], garment="topless").status_code == 409
    surgeon.patch(f"/api/implant/patients/{p['id']}", json={"topless_ok": True})
    assert _photo(surgeon, p["id"], garment="topless").status_code == 201
    # no photo, no consultation
    q = _patient(surgeon, label="P-0002")
    assert surgeon.post(f"/api/implant/patients/{q['id']}/sessions", json={"options": OPTS}).status_code == 409


def test_a_patient_is_only_its_surgeons(surgeon, client):
    p = _patient(surgeon)
    with _client("dr.other@example.com", implant=True) as other:
        assert other.get(f"/api/implant/patients/{p['id']}").status_code == 404
        assert other.get("/api/implant/patients").json() == []
    # admins included: support access is a later, audited step
    assert client.get(f"/api/implant/patients/{p['id']}").status_code == 404


def test_the_instruction_is_literal_and_keeps_clothes_on():
    words = im.instruction({"left_cc": 375, "right_cc": 325, "profile": "high", "shape": "teardrop",
                            "placement": "dual_plane", "fill": "silicone"}, "garment")
    assert "left breast (375 cc) slightly larger than the right (325 cc)" in words
    assert "Do not remove, open or change any clothing" in words and "Never show more skin" in words
    assert "Keep everything else identical" in words


def test_a_consultation_renders_privately_and_the_approved_option_makes_a_chart(surgeon, client, fast_driver):
    p = _patient(surgeon)
    photo = _photo(surgeon, p["id"], crop="0,0.2,1,0.8")
    assert photo.status_code == 201, photo.text
    photo = photo.json()
    _photo(surgeon, p["id"], view="left_oblique")
    r = surgeon.post(f"/api/implant/patients/{p['id']}/sessions", json={"options": OPTS})
    assert r.status_code == 202, r.text
    session = r.json()["sessions"][0]
    assert len(session["results"]) == 4  # two options x two views
    _run(fast_driver)
    detail = surgeon.get(f"/api/implant/patients/{p['id']}").json()
    results = detail["sessions"][0]["results"]
    assert all(x["status"] == "ready" and x["url"] for x in results)
    data = get_settings().data_dir
    with SessionLocal() as db:
        gens = db.scalars(select(Generation).where(Generation.target_type.in_(("implant_photo", "implant_result"))))
        for g in gens:
            assert g.file_path.startswith("clinic/"), g.file_path
        res = db.get(Generation, results[0]["id"])
        assert res.params["model"] == im.EDIT_MODEL and res.params["reference_ids"] == [photo["id"]]
    # the photo was cropped (the face off) before it was stored
    with Image.open(data / db.get(Generation, photo["id"]).file_path) as pic:
        assert pic.size == (600, 640)
    f = surgeon.get(results[0]["url"])
    assert f.status_code == 200 and f.headers["cache-control"] == "private, no-store"

    pdf = surgeon.get(f"/api/implant/patients/{p['id']}/sessions/{session['id']}/consultation.pdf")
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    assert surgeon.get(f"/api/implant/patients/{p['id']}/chart.pdf").status_code == 404
    r = surgeon.post(f"/api/implant/patients/{p['id']}/sessions/{session['id']}/approve",
                     json={"option": 1, "notes": "Dual plane, inframammary incision."})
    assert r.status_code == 200, r.text
    chart = r.json()["chart"]
    assert chart["option"] == 1 and chart["versions"] == 1 and chart["url"]
    pdf = surgeon.get(chart["url"])
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    # a second approval keeps the first chart as a version
    r = surgeon.post(f"/api/implant/patients/{p['id']}/sessions/{session['id']}/approve", json={"option": 0})
    assert r.json()["chart"]["versions"] == 2

    with SessionLocal() as db:
        actions = {a.action for a in db.scalars(select(AdminAudit).where(AdminAudit.target_id == p["id"]))}
    assert {"implant_patient_create", "implant_photo_upload", "implant_generate", "implant_approve",
            "implant_pdf_download", "implant_chart_download"} <= actions


def test_nothing_reaches_the_rest_of_the_app(surgeon, fast_driver):
    p = _patient(surgeon)
    photo = _photo(surgeon, p["id"]).json()
    surgeon.post(f"/api/implant/patients/{p['id']}/sessions", json={"options": OPTS[:1]})
    # not even while it's queued
    assert surgeon.get("/api/jobs").json() == []
    _run(fast_driver)
    result = surgeon.get(f"/api/implant/patients/{p['id']}").json()["sessions"][0]["results"][0]
    for gid in (photo["id"], result["id"]):
        assert surgeon.get(f"/api/generations/{gid}").status_code == 404
        assert surgeon.get(f"/api/generations/{gid}/download").status_code == 404
        assert surgeon.get(f"/api/media/thumb/{gid}").status_code == 404
        assert surgeon.post(f"/api/generations/{gid}/upscale", json={}).status_code in (404, 422)
        r = surgeon.post("/api/images/edit", json={"source_ids": [gid], "instruction": "make it a painting"})
        assert r.status_code == 404, r.text
    assert surgeon.get("/api/generations?target_type=implant_result").json() == []
    assert surgeon.get("/api/media").json()["items"] == []
    assert surgeon.get("/api/jobs").json() == []

    # and a job from anywhere else that names one is refused by the worker before any GPU work
    with SessionLocal() as db:
        ws = db.get(ImplantPatient, p["id"]).workspace_id
        g = enqueue_generation(db, workspace_id=ws, project_id=None, target_type="media", target_id="x" * 36,
                               kind="image", prompt="edit", params={"reference_ids": [photo["id"]]})
        db.commit()
        job_id = g.job_id
    _run(fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job.status == "failed" and "private Implant Preview" in job.error


def test_every_result_carries_the_simulation_mark(tmp_path):
    path = tmp_path / "r.png"
    Image.new("RGB", (800, 1000), (250, 250, 250)).save(path)
    im.stamp(path)
    with Image.open(path) as pic:
        corner = pic.crop((560, 900, 800, 1000)).convert("L")
        assert corner.getextrema()[0] < 120  # the dark label is there


def test_delete_and_retention_remove_everything(surgeon, fast_driver):
    p = _patient(surgeon)
    _photo(surgeon, p["id"])
    surgeon.post(f"/api/implant/patients/{p['id']}/sessions", json={"options": OPTS[:1]})
    _run(fast_driver)
    data = get_settings().data_dir
    with SessionLocal() as db:
        files = [data / g.file_path for g in db.scalars(select(Generation).where(
            Generation.target_type.in_(("implant_photo", "implant_result"))))]
    assert files and all(f.is_file() for f in files)
    assert surgeon.delete(f"/api/implant/patients/{p['id']}").status_code == 204
    assert not any(f.exists() for f in files)
    with SessionLocal() as db:
        assert db.get(ImplantPatient, p["id"]) is None
        assert not db.scalars(select(Generation).where(Generation.target_type.like("implant_%"))).first()

    q = _patient(surgeon, label="old", retention_months=1)
    keep = _patient(surgeon, label="recent")
    with SessionLocal() as db:
        db.get(ImplantPatient, q["id"]).last_activity_at = utcnow() - timedelta(days=45)
        db.commit()
        assert im.purge_expired(db) == 1
        db.commit()
        assert db.get(ImplantPatient, q["id"]) is None and db.get(ImplantPatient, keep["id"]) is not None
