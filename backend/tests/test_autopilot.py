import json

import httpx
import pytest
from sqlalchemy import select

from app import autopilot as ap_mod
from app import reel as rl
from app import vision
from app.config import get_settings
from app.db import SessionLocal
from app.llm import chat_sync, set_transport
from app.models import Character, Generation, Job, Scene, Shot
from app.services import generation_file
from app.worker import JobContext, process_one

from tests.test_ai import oa, schema_title


def outline(scenes, title="The Keeper"):
    return {"title": title, "logline": "A keeper keeps the light.", "characters": [{"name": "Mara", "role": "keeper"}],
            "scenes": [{"heading": f"EXT. LIGHTHOUSE {i} - DUSK", "logline": "Mara lights the lamp", "duration_s": d,
                        "characters": ["Mara"], "mood": "quiet", "time_of_day": "dusk"}
                       for i, d in enumerate(scenes, 1)]}


class Brain:
    """Fake LLM for the whole pipeline. `vision` is a list of scores served in order (last one repeats)."""

    def __init__(self, scenes=(10,), vision_scores=(8,), fail=()):
        self.scenes, self.vision_scores, self.fail = list(scenes), list(vision_scores), set(fail)
        self.seen: list[str] = []
        self.images: list[list] = []

    def kind(self, body) -> str:
        title = schema_title(body)
        if title:
            return title
        system = body["messages"][0]["content"]
        if "photorealistic image models" in system:
            return "portrait"
        if system.startswith("You are a screenwriter"):
            return "draft"
        return "other"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        k = self.kind(body)
        self.seen.append(k)
        if k in self.fail:
            return httpx.Response(500, json={"error": f"{k} is broken"})
        if k == "VisionScore":
            self.images.append([p for m in body["messages"] if isinstance(m["content"], list) for p in m["content"]])
            score = self.vision_scores.pop(0) if len(self.vision_scores) > 1 else self.vision_scores[0]
            return httpx.Response(200, json=oa(json.dumps({"score": score, "issues": [] if score >= 6 else ["off"]})))
        answer = {
            "QuickOutline": lambda: json.dumps(outline(self.scenes)),
            "CastLooks": lambda: json.dumps({"characters": [{"name": "Mara", "description": "Woman, 60s, grey braid"}]}),
            "LocationList": lambda: json.dumps({"locations": [{"name": "Lighthouse", "description": "White tower",
                                                               "time_of_day_variants": ["dusk"], "scenes": [1]}]}),
            "SceneFrames": lambda: json.dumps({"shot_type": "wide", "description": "Mara lights the lamp",
                                               "camera": "slow push", "characters": ["Mara"],
                                               "start_prompt": "A grey-haired woman at the stairs",
                                               "end_prompt": "The lamp blazes", "motion_prompt": "She climbs"}),
            "portrait": lambda: "Portrait of a woman in her sixties, grey braid",
            "draft": lambda: "Mara climbs the spiral stairs and strikes a match.",
        }.get(k, lambda: "ok")()
        return httpx.Response(200, json=oa(answer))


@pytest.fixture
def brain():
    holder = {}

    def install(**kw):
        b = Brain(**kw)
        set_transport(httpx.MockTransport(b))
        holder["b"] = b
        return b

    yield install
    set_transport(None)


def create(client, **body):
    r = client.post("/api/quick", json={"prompt": "An old keeper lights the lighthouse one last time",
                                        "duration_s": 10, **body})
    assert r.status_code == 201, r.text
    return r.json()


def drive(job_id, fast_driver, limit=80):
    for _ in range(limit):
        with SessionLocal() as db:
            if db.get(Job, job_id).status in ("done", "failed", "cancelled"):
                break
        if not process_one(driver_factory=fast_driver):
            break
    with SessionLocal() as db:
        return db.get(Job, job_id)


def stages(job) -> dict:
    return {s["key"]: s["status"] for s in job.result["stages"]}


# ------------------------------------------------------------------ end to end

def test_ten_seconds_end_to_end(client, brain, fast_driver):
    b = brain()
    out = create(client)
    assert out["project"]["authoring_mode"] == "quick"
    job = drive(out["job"]["id"], fast_driver)
    assert job.status == "done", job.error
    assert stages(job) == {"outline": "done", "cast": "done", "storyboard": "done", "render": "done",
                           "stitch": "done", "upscale": "skipped"}
    assert job.result["eta_s"] == 0 and job.result["preview_ids"]
    # P3: per-stage thumbnail strips for the progress page
    media = job.result["stage_media"]
    assert media["outline"]["text"] == "1 scene" and job.result["eta_range_s"] == [0, 0]
    assert {m["kind"] for m in media["cast"]} == {"portrait", "establishing"} and media["stitch"][0]["video"]
    assert all(m["url"] for k in ("cast", "storyboard", "render", "stitch") for m in media[k])

    with SessionLocal() as db:
        pid = out["project"]["id"]
        assert len(db.scalars(select(Scene).where(Scene.project_id == pid)).all()) == 1
        shots = db.scalars(select(Shot).where(Shot.project_id == pid)).all()
        assert len(shots) == 1 and shots[0].duration_s == 10
        final = db.get(Generation, job.result["final_render_id"])
        assert final.kind == "render" and final.status == "ready" and generation_file(final).exists()
        assert rl.probe(generation_file(final)).duration == pytest.approx(10, abs=0.6)
        approved = db.scalars(select(Generation).where(Generation.project_id == pid,
                                                       Generation.status == "approved")).all()
        # portrait, establishing, start + end frame, take
        assert sorted(g.kind for g in approved) == ["establishing", "keyframe_end", "keyframe_start", "portrait", "take"]
        assert all(g.params["approved_by"] == "autopilot" for g in approved)
        assert {g.params["auto_check"] for g in approved if g.kind != "take"} == {"passed"}
        # mock takes have no audio track: re-rolled once, then the best one is approved and flagged
        take = next(g for g in approved if g.kind == "take")
        assert take.params["auto_check"] == "flagged" and "no audio stream" in take.params["auto_issues"]
        assert len(db.scalars(select(Generation).where(Generation.kind == "take")).all()) == 2
    assert client.get(f"/api/projects/{pid}").json()["title"] == "The Keeper"
    # the vision model was shown the image (and, for frames, the character's portrait) as data URLs
    assert all(any(p.get("type") == "image_url" and p["image_url"]["url"].startswith("data:image/jpeg;base64,")
                   for p in parts) for parts in b.images)
    assert max(len([p for p in parts if p.get("type") == "image_url"]) for parts in b.images) == 2
    assert b.seen.count("QuickOutline") == 1

    g = client.get(f"/api/generations/{job.result['preview_ids'][0]}")
    assert g.status_code == 200 and g.json()["media_url"]
    assert client.get("/api/generations/not-a-real-id").status_code == 404

    recent = client.get("/api/quick/recent").json()
    assert recent[0]["project"]["id"] == pid and recent[0]["final_render"]["id"] == final.id


def test_sixty_seconds_is_at_most_three_scenes(client, brain, fast_driver):
    brain(scenes=(10, 15, 20, 25, 30))
    out = create(client, duration_s=60, dialogue=False)
    process_one(driver_factory=fast_driver)  # outline + cast setup, then it waits for the portraits
    with SessionLocal() as db:
        job = db.get(Job, out["job"]["id"])
        assert job.status == "queued" and job.priority == ap_mod.WAIT_PRIORITY
        assert stages(job)["outline"] == "done" and stages(job)["cast"] == "running"
        assert job.result["waiting_on"]
        scenes = db.scalars(select(Scene).where(Scene.project_id == out["project"]["id"])).all()
        assert 1 <= len(scenes) <= 3
        assert sum(job.result["outline"]["durations"].values()) == pytest.approx(60)


def test_no_dialogue_prompt_and_sizing():
    assert ap_mod.scene_range(10) == (1, 1)
    assert ap_mod.scene_range(60) == (1, 3)
    lo, hi = ap_mod.scene_range(300)
    assert lo == 8 and hi == 15
    assert sum(ap_mod.fit_durations([5, 5, 5], 60)) == 60

    class P:
        brief = "A storm"

    msgs = ap_mod.outline_messages(P(), "documentary", False, 10)
    assert "exactly 1 scene" in msgs[1]["content"] and "no voice-over" in msgs[1]["content"]


# ------------------------------------------------------------------ auto-approval

def _autopilot(client, db, fast_driver):
    out = create(client)
    job = db.get(Job, out["job"]["id"])
    job.status = "running"  # driven by hand below, so the worker must not claim it
    db.commit()
    a = ap_mod.Autopilot(JobContext(db, job, fast_driver))
    a.current = "cast"
    ch = Character(workspace_id=job.workspace_id, project_id=out["project"]["id"], name="Mara",
                   description="grey braid")
    db.add(ch)
    db.commit()
    return a, ch


def _settle(a, ch, fast_driver):
    from app.services import enqueue_generation

    def make():
        return enqueue_generation(a.db, workspace_id=ch.workspace_id, project_id=ch.project_id,
                                  target_type="character", target_id=ch.id, kind="portrait", prompt="p", params={})

    for _ in range(10):
        waits = a.image_slot("character", ch.id, "portrait", make, "grey braid", None, "portrait")
        a.db.commit()
        if not waits:
            return
        for _ in waits:
            process_one(driver_factory=fast_driver)
    raise AssertionError("never settled")


def test_retries_keep_the_best_score(client, brain, db, fast_driver):
    b = brain(vision_scores=(3, 5, 4))
    a, ch = _autopilot(client, db, fast_driver)
    _settle(a, ch, fast_driver)
    gens = db.scalars(select(Generation).where(Generation.target_id == ch.id).order_by(Generation.created_at)).all()
    assert len(gens) == 1 + get_settings().auto_retries
    assert [g.score["vision"] for g in gens] == [3, 5, 4]
    assert gens[1].status == "approved" and gens[1].params["auto_check"] == "below_threshold"
    assert b.seen.count("VisionScore") == 3


def test_good_first_image_is_approved_without_retries(client, brain, db, fast_driver):
    brain(vision_scores=(9,))
    a, ch = _autopilot(client, db, fast_driver)
    _settle(a, ch, fast_driver)
    [g] = db.scalars(select(Generation).where(Generation.target_id == ch.id)).all()
    assert g.status == "approved" and g.params["auto_check"] == "passed" and g.params["approved_by"] == "autopilot"


def test_vision_down_approves_newest_unchecked(client, brain, db, fast_driver):
    brain(fail={"VisionScore"})
    a, ch = _autopilot(client, db, fast_driver)
    _settle(a, ch, fast_driver)
    [g] = db.scalars(select(Generation).where(Generation.target_id == ch.id)).all()
    assert g.status == "approved" and g.params["auto_check"] == "unchecked"
    assert "broken" in a.r["vision_unavailable"]


def test_take_checks(tmp_path):
    def clip(name, src, audio=True, dur=2):
        p = tmp_path / f"{name}.mp4"
        args = ["-f", "lavfi", "-i", f"{src}:duration={dur}"]
        if audio:
            args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}", "-c:a", "aac", "-shortest"]
        rl.run_ff([*args, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(p)])
        return p

    good = clip("good", "testsrc=size=160x90:rate=24")
    assert vision.check_take(good, 2.0).ok
    long = vision.check_take(good, 4.0)
    assert not long.ok and "instead of 4.0 s" in long.issues[0]
    dark = vision.check_take(clip("dark", "color=c=black:size=160x90:rate=24"), 2.0)
    assert not dark.ok and any("mostly black" in i for i in dark.issues)
    mute = vision.check_take(clip("mute", "testsrc=size=160x90:rate=24", audio=False), 2.0)
    assert mute.issues == ["no audio stream"]
    assert not vision.check_take(tmp_path / "nope.mp4", 2).ok


def test_images_go_native_and_openai(brain, monkeypatch, tmp_path):
    from PIL import Image

    from app.llm.client import openai_messages

    img = tmp_path / "x.png"
    Image.new("RGB", (2000, 1000), (200, 10, 10)).save(img)
    msgs = vision.score_messages(img, "a red frame")
    [b64] = msgs[1]["images"]
    conv = openai_messages(msgs)
    assert conv[1]["content"][0]["type"] == "text" and "images" not in conv[1]
    assert conv[1]["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,/9j/")

    seen = []

    def native(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"message": {"content": '{"score": 7, "issues": []}'}, "done_reason": "stop"})

    monkeypatch.setattr(get_settings(), "llm_api", "ollama")
    set_transport(httpx.MockTransport(native))
    res = chat_sync("vision", msgs, schema=vision.VisionScore)
    assert res.data.score == 7
    assert seen[0]["messages"][1]["images"] == [b64] and seen[0]["model"] == "fake-eye"


# ------------------------------------------------------------------ resume / cancel / API

def test_resume_continues_from_the_failed_stage(client, brain, fast_driver):
    b = brain(fail={"SceneFrames"})
    out = create(client)
    job = drive(out["job"]["id"], fast_driver)
    assert job.status == "failed" and "Storyboard failed" in job.error
    st = stages(job)
    assert st["outline"] == st["cast"] == "done" and st["storyboard"] == "failed"
    with SessionLocal() as db:
        portraits = len(db.scalars(select(Generation).where(Generation.kind == "portrait")).all())

    b.fail.clear()
    r = client.post(f"/api/jobs/{out['job']['id']}/retry")
    assert r.status_code == 200, r.text
    job = drive(out["job"]["id"], fast_driver)
    assert job.status == "done", job.error
    assert b.seen.count("QuickOutline") == 1 and b.seen.count("draft") == 1
    with SessionLocal() as db:
        assert len(db.scalars(select(Generation).where(Generation.kind == "portrait")).all()) == portraits


def test_cancel_takes_the_children_along(client, brain, fast_driver):
    brain()
    out = create(client)
    process_one(driver_factory=fast_driver)
    with SessionLocal() as db:
        waiting = db.get(Job, out["job"]["id"]).result["waiting_on"]
    assert waiting
    r = client.post(f"/api/jobs/{out['job']['id']}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    with SessionLocal() as db:
        assert {db.get(Job, i).status for i in waiting} == {"cancelled"}
    assert not process_one(driver_factory=fast_driver)


def test_quick_validation_and_recent(client):
    r = client.post("/api/quick", json={"prompt": "A storm at sea", "duration_s": 2})
    assert r.status_code == 422
    r = client.post("/api/quick", json={"prompt": "A storm at sea", "duration_s": 99999})
    assert r.status_code == 422
    out = create(client, aspect_ratio="9:16", style="animated", upscale={"engine": "fast", "target": "1080p"})
    p = out["project"]
    assert p["aspect_ratio"] == "9:16" and "animated" in p["style_bible"]
    assert p["title"].startswith("An old keeper lights")
    assert [s["status"] for s in out["job"]["result"]["stages"]] == ["pending"] * 6
    rows = client.get("/api/quick/recent").json()
    assert len(rows) == 1 and rows[0]["job"]["id"] == out["job"]["id"] and rows[0]["final_render"] is None


def test_upscale_skipped_when_module_missing(monkeypatch):
    monkeypatch.setattr(ap_mod, "upscale_entry", lambda: None)

    class Fake(ap_mod.Autopilot):
        def __init__(self):
            self.p = {"upscale": {"engine": "best", "target": "1080p"}}
            self.r = {"final_render_id": "x"}
            self.db = type("D", (), {"get": lambda *_: object()})()

    out = Fake().stage_upscale()
    assert isinstance(out, ap_mod.Skip) and "isn't available" in out.detail


def test_upscale_skipped_when_engine_unavailable(monkeypatch):
    def refuse(db, source, engine, target):
        raise ap_mod.UpscaleUnavailable("FlashVSR isn't available on the GPU server: missing nodes")

    monkeypatch.setattr(ap_mod, "upscale_entry", lambda: refuse)

    class Fake(ap_mod.Autopilot):
        def __init__(self):
            self.p = {"upscale": {"engine": "fast", "target": "1080p"}}
            self.r = {"final_render_id": "x"}
            self.db = type("D", (), {"get": lambda *_: object()})()

    out = Fake().stage_upscale()
    assert isinstance(out, ap_mod.Skip) and "missing nodes" in out.detail
