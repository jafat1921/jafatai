"""Implant Preview (M22): opt-in access, consent first, one surgeon's patients only, and nothing from it reaching
the rest of the app."""
import io
import json
from datetime import timedelta

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app import accounts
from app.config import get_settings
from app.db import SessionLocal
from app.implant import finish, planning
from app.implant import service as im
from app.llm import set_transport
from app.main import app
from app.models import AdminAudit, Generation, ImplantPatient, Job, utcnow
from app.services import enqueue_generation
from app.worker import process_one
from tests.test_ai import oa

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


# ---------------------------------------------------------------- phase 1.5: the surgeon's gaps

def test_implant_size_and_the_planners_warnings():
    width, proj = planning.dimensions(300, "moderate_plus")
    assert 11.5 <= width <= 12.2 and proj == pytest.approx(width * 0.38, abs=0.1)  # Mentor: 11.6 cm
    assert planning.dimensions(300, "high")[0] < width < planning.dimensions(300, "moderate")[0]
    assert planning.cup_change(300, 12.5) == 1.5 and planning.cup_change(300, 14) == 1.0
    opt = {"left_cc": 400, "right_cc": 400, "profile": "moderate", "shape": "round", "placement": "subglandular"}
    m = {"bw_left_cm": 11, "bw_right_cm": 12.5, "pinch_cm": 1.5, "ptosis_grade": 2, "nimf_left_cm": 7}
    texts = " | ".join(c["text"] for c in planning.assess(opt, m)["checks"])
    for bit in ("wider than her breast base", "pinch 1.5 cm is thin", "Ptosis grade 2", "differ by 1.5 cm",
                "fold may need lowering"):
        assert bit in texts, texts
    calm = {"bw_left_cm": 12.5, "bw_right_cm": 12.5, "pinch_cm": 3, "ptosis_grade": 0, "nimf_left_cm": 9}
    assert planning.assess({**opt, "left_cc": 300, "right_cc": 300, "placement": "dual_plane",
                            "profile": "moderate_plus"}, calm)["checks"] == []


def _scene(path, chest_colour=(200, 160, 140), legs=(90, 120, 160), scale=1.0):
    from PIL import ImageDraw

    im = Image.new("RGB", (400, 500), (180, 180, 185))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 330, 400, 500), fill=legs)
    d.ellipse((120, 60, 280, 200), fill=chest_colour)
    for x in range(0, 400, 25):  # texture, so the alignment has something to lock on
        d.line((x, 0, x, 500), fill=(150, 150, 160))
    if scale != 1.0:
        w, h = round(400 * scale), round(500 * scale)
        small = im.resize((w, h))
        im = Image.new("RGB", (400, 500), (0, 0, 0))
        im.paste(small, ((400 - w) // 2, (500 - h) // 2))
    im.save(path)


def test_only_the_chest_comes_from_the_result(tmp_path):
    photo, result = tmp_path / "photo.png", tmp_path / "result.png"
    _scene(photo)
    # the edit drew a bigger chest, but also nudged the legs' colour and re-framed by 1%: only the chest may stay
    _scene(result, chest_colour=(230, 120, 110), legs=(60, 160, 90), scale=1.01)
    box = [80, 200, 460, 800]
    finish.composite(photo, result, box)
    with Image.open(photo) as a, Image.open(result) as b:
        before, after = np.asarray(a.convert("RGB")), np.asarray(b.convert("RGB"))
    assert (before[420:, :] == after[420:, :]).all()  # the legs: the photo's, pixel for pixel
    assert (before[:, :40] == after[:, :40]).all()
    centre = after[120:140, 190:210].reshape(-1, 3).mean(0)
    assert centre[1] < 145  # the result's chest (greener-free red), not the photo's


def test_the_chest_box_falls_back_without_the_vision_model(tmp_path):
    photo = tmp_path / "p.png"
    _scene(photo)
    box, source = finish.find_chest(photo, "left_oblique")
    assert source == "default" and box == finish.DEFAULT_BOX["left_oblique"]
    assert finish.clean_box([10, 10, 50, 900]) is None and finish.clean_box([0, 100, 620, 900]) == [0, 100, 620, 900]


class _Eye:
    """The vision model: a chest box, then the garment verdicts in order."""

    def __init__(self, verdicts):
        self.verdicts = list(verdicts)
        self.calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": m} for m in ("fake-eye", "fake-writer", "fake-reasoner")]})
        body = json.loads(request.content)
        text = json.dumps(body.get("messages", []))
        if "bounding box" in text:
            return httpx.Response(200, json=oa(json.dumps({"box": [50, 150, 600, 850]})))
        self.calls += 1
        uncovered = self.verdicts.pop(0) if self.verdicts else False
        return httpx.Response(200, json=oa(json.dumps({"uncovered": uncovered, "why": "test"})))


@pytest.fixture
def eye():
    def install(verdicts):
        e = _Eye(verdicts)
        set_transport(httpx.MockTransport(e))
        return e

    yield install
    set_transport(None)


def _one_render(surgeon, fast_driver, garment="garment"):
    p = _patient(surgeon, topless_ok=garment == "topless")
    _photo(surgeon, p["id"], garment=garment)
    surgeon.post(f"/api/implant/patients/{p['id']}/sessions", json={"options": OPTS[:1]})
    _run(fast_driver)
    return surgeon.get(f"/api/implant/patients/{p['id']}").json()


def test_a_result_that_uncovers_skin_is_redrawn_once_then_refused(surgeon, fast_driver, eye):
    e = eye([True, False])
    detail = _one_render(surgeon, fast_driver)
    res = detail["sessions"][0]["results"][0]
    assert res["status"] == "ready" and res["garment_check"] is True and e.calls == 2
    assert res["chest_box"] == [50, 150, 600, 850]  # the vision model's box, kept on the photo too
    assert detail["photos"]["front"]["chest_box"] == [50, 150, 600, 850]

    e = eye([True, True])
    detail = _one_render(surgeon, fast_driver)
    res = detail["sessions"][0]["results"][0]
    assert res["status"] == "failed" and e.calls == 2
    with SessionLocal() as db:
        assert "changed the clothing" in db.get(Job, res["job_id"]).error


def test_topless_photos_skip_the_garment_check(surgeon, fast_driver, eye):
    e = eye([True])
    res = _one_render(surgeon, fast_driver, garment="topless")["sessions"][0]["results"][0]
    assert res["status"] == "ready" and e.calls == 0


def test_options_share_a_seed_per_view_and_the_planner_answers(surgeon):
    p = _patient(surgeon)
    _photo(surgeon, p["id"])
    _photo(surgeon, p["id"], view="right_lateral")
    surgeon.post(f"/api/implant/patients/{p['id']}/sessions", json={"options": OPTS})
    with SessionLocal() as db:
        gens = db.scalars(select(Generation).where(Generation.target_type == "implant_result")).all()
        seeds = {}
        for g in gens:
            seeds.setdefault(g.params["implant"]["view"], set()).add(g.seed)
    assert set(seeds) == {"front", "right_lateral"} and all(len(s) == 1 for s in seeds.values())
    assert seeds["front"] != seeds["right_lateral"]

    r = surgeon.post(f"/api/implant/patients/{p['id']}/check", json={"options": OPTS})
    assert r.status_code == 200
    a, b = r.json()
    assert a["sides"]["left"]["width_cm"] > 0 and b["sides"]["left"]["cup_change"] > a["sides"]["left"]["cup_change"]


def test_the_surgeon_sets_the_chest_area(surgeon, client):
    p = _patient(surgeon)
    photo = _photo(surgeon, p["id"]).json()
    r = surgeon.patch(f"/api/implant/photos/{photo['id']}", json={"chest_box": [20, 120, 640, 880]})
    assert r.status_code == 200 and r.json()["chest_box"] == [20, 120, 640, 880]
    assert surgeon.patch(f"/api/implant/photos/{photo['id']}", json={"chest_box": [0, 0, 50, 50]}).status_code == 422
    # not someone else's photo
    assert client.patch(f"/api/implant/photos/{photo['id']}", json={"chest_box": [20, 120, 640, 880]}).status_code == 404


def test_her_bra_size_names_the_step():
    assert planning.cup_of("34B") == planning.CUPS.index("B") and planning.cup_of("75 dd") == planning.CUPS.index("DD")
    assert planning.cup_of("") is None and planning.cup_of("34") is None
    m = {"bw_left_cm": 12, "bw_right_cm": 12, "bra_size": "32A"}
    words = [im.instruction({"left_cc": cc, "right_cc": cc, "profile": "moderate", "shape": "round",
                             "placement": "dual_plane"}, "garment", m) for cc in (275, 350, 425)]
    # 350 and 425 cc were both "about two cup sizes" and drew alike
    assert "fills a B cup" in words[0] and "fills a full B cup" in words[1] and "fills a C cup" in words[2]
    assert "about" in im.instruction({"left_cc": 300, "right_cc": 300, "profile": "moderate", "shape": "round",
                                      "placement": "dual_plane"}, "garment", {})


def test_a_lift_is_drawn_and_planned(surgeon):
    opt = {"left_cc": 300, "right_cc": 300, "profile": "moderate", "shape": "round", "placement": "dual_plane"}
    words = im.instruction({**opt, "procedure": "augmentation_lift"}, "garment")
    assert "breast lift (mastopexy)" in words and "bra cups sit higher" in words
    assert "mastopexy" not in im.instruction(opt, "garment")
    sag = {"ptosis_grade": 2, "bra_size": "34A", "bw_left_cm": 12.5, "bw_right_cm": 12.5}
    plain = planning.assess(opt, sag)
    assert any("Augmentation with lift" in c["text"] for c in plain["checks"])
    lifted = planning.assess({**opt, "procedure": "augmentation_lift"}, sag)
    assert not any(c["level"] == "warn" for c in lifted["checks"]) and any("scars" in c["text"] for c in lifted["checks"])
    assert plain["sides"]["left"]["target_cup"] == "a full B cup"  # A + 1.5 cups at 200 cc a cup
    p = _patient(surgeon)
    _photo(surgeon, p["id"])
    r = surgeon.post(f"/api/implant/patients/{p['id']}/sessions",
                     json={"options": [{**OPTS[0], "procedure": "augmentation_lift"}]})
    assert r.status_code == 202 and r.json()["sessions"][0]["options"][0]["procedure"] == "augmentation_lift"


def test_big_phone_photos_are_kept_at_a_consultation_size(surgeon):
    p = _patient(surgeon)
    buf = io.BytesIO()
    Image.new("RGB", (3000, 4000), (200, 160, 140)).save(buf, "JPEG")
    r = surgeon.post(f"/api/implant/patients/{p['id']}/photos", files={"file": ("p.jpg", buf.getvalue(), "image/jpeg")},
                     data={"view": "front", "garment": "garment"})
    assert r.status_code == 201
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["id"])
        with Image.open(get_settings().data_dir / g.file_path) as pic:
            assert pic.size == (1200, 1600)


def test_a_demo_patient_from_ai_pictures(surgeon, fast_driver):
    from app import manage

    me = surgeon.get("/api/auth/me").json()
    with SessionLocal() as db:
        g = enqueue_generation(db, workspace_id=me["workspace_id"], project_id=None, target_type="media",
                               target_id="m" * 36, kind="image", prompt="sample", params={})
        rel = f"workspaces/{me['workspace_id']}/media/{g.id}.png"
        (get_settings().data_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        (get_settings().data_dir / rel).write_bytes(_png())
        g.file_path, g.status, g.media_type = rel, "ready", "image/png"
        db.query(Job).filter(Job.id == g.job_id).delete()
        db.commit()
        gid = g.id
    assert manage.main(["implant-demo", "--email", "dr.ayesha@example.com", "--photo", f"{gid}:front:topless",
                        "--label", "AI sample 3 (topless)", "--bra", "34B", "--bw", "12.5", "--ptosis", "2",
                        "--options", "lift"]) == 0
    _run(fast_driver)
    p = surgeon.get("/api/implant/patients").json()[0]
    assert p["label"] == "DEMO · AI sample 3 (topless)" and p["consent"]["topless_ok"] is True
    detail = surgeon.get(f"/api/implant/patients/{p['id']}").json()
    assert detail["photos"]["front"]["garment"] == "topless"
    s = detail["sessions"][0]
    assert [o["procedure"] for o in s["options"]] == ["augmentation_lift"] * 2
    assert len(s["results"]) == 2 and all(r["status"] == "ready" for r in s["results"])
    # an implant picture can't be the source of a demo
    assert manage.main(["implant-demo", "--email", "dr.ayesha@example.com", "--photo",
                        f"{detail['photos']['front']['id']}:front:topless", "--label", "x"]) == 1


def test_her_own_photo_is_always_clothed_and_keeps_her_clothes(surgeon, fast_driver, eye):
    p = _patient(surgeon, topless_ok=True)
    # even with topless consent, her own photo can't be marked topless
    r = _photo(surgeon, p["id"], view="own", garment="topless")
    assert r.status_code == 422 and "clothes" in r.json()["detail"]
    assert _photo(surgeon, p["id"], view="own").status_code == 201

    opt = {"left_cc": 300, "right_cc": 300, "profile": "moderate", "shape": "round", "placement": "dual_plane",
           "fill": "silicone"}
    own = im.instruction(opt, "garment", view="own")
    assert "kameez" in own and "dupatta" in own and "same face" in own
    assert "Do not remove, open, lift, shorten or change any clothing" in own and "Never show more skin" in own
    lift = im.instruction({**opt, "procedure": "augmentation_lift"}, "garment", view="own")
    assert "under the clothes" in lift and "bra cups" not in lift
    # the clinical views read exactly as before
    for g in ("garment", "topless"):
        assert im.instruction(opt, g, view="front") == im.instruction(opt, g)
        assert "kameez" not in im.instruction(opt, g) and "same face" not in im.instruction(opt, g)

    e = eye([False])
    surgeon.post(f"/api/implant/patients/{p['id']}/sessions", json={"options": OPTS[:1]})
    _run(fast_driver)
    detail = surgeon.get(f"/api/implant/patients/{p['id']}").json()
    res = detail["sessions"][0]["results"][0]
    # rendered from her own photo, and the clothing check still ran
    assert res["view"] == "own" and res["status"] == "ready" and res["garment_check"] is True and e.calls == 1
    assert list(detail["views"])[0] == "own"
