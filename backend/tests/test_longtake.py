import json
from pathlib import Path

import pytest

from app import longtake as lt
from app import worker
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import plan_generation
from app.drivers.mock import MockDriver
from app.models import Generation, Job, Shot
from app.workflows import build, check_template, frames_for
from tests.test_ai import fake_llm, oa, run_job, schema_title  # noqa: F401  (fixture re-export)
from tests.test_storyboard import _approved, _scene, _shot

FIXTURE = Path(__file__).parent / "fixtures" / "comfy_object_info.json"


# ------------------------------------------------------------------ planning

@pytest.mark.parametrize("seconds,count", [(10, 1), (20, 3), (30, 4), (60, 8), (300, 40)])
def test_chunk_plan_math(seconds, count):
    chunks = lt.plan_chunks(seconds)
    assert len(chunks) == count
    assert all((c["frames"] - 1) % 8 == 0 for c in chunks)
    assert all(c["frames"] <= 193 for c in chunks) or count == 1
    # joined length is exactly the single-pass frame count for that duration
    joined = sum(c["frames"] for c in chunks) - 9 * (count - 1)
    assert joined == frames_for(seconds, 24)
    for a, b in zip(chunks, chunks[1:]):
        assert b["start_frame"] == a["start_frame"] + a["frames"] - 9  # 9 shared context frames
    # evenly spread: no stub chunk at the end
    assert max(c["frames"] for c in chunks) - min(c["frames"] for c in chunks) <= 8


def test_fallback_plan_shares_one_frame():
    chunks = lt.plan_chunks(30, overlap=1)
    assert sum(c["frames"] for c in chunks) - (len(chunks) - 1) == frames_for(30, 24)
    assert lt.is_long(11) and not lt.is_long(10.5)


def test_join_command_fade_clamp(monkeypatch, tmp_path):
    files = [tmp_path / f"c{i}.mp4" for i in range(3)]
    # 1 s overlap cap, 9 shared frames: the fade is the 9 frames
    args, info = lt.join_command(files, [193, 193, 185], 9, tmp_path / "out.mp4")
    graph = args[args.index("-filter_complex") + 1]
    assert info["fade_frames"] == [9, 9] and info["frames"] == 193 + 193 + 185 - 18
    assert graph.count("xfade=transition=fade:duration=0.37500") == 2
    assert "acrossfade=d=0.37500:c1=tri:c2=tri" in graph
    assert "offset=7.66667" in graph  # (193 - 9) / 24

    # CHUNK_OVERLAP_S caps it, and the dropped head frames keep the length exact
    monkeypatch.setattr(get_settings(), "chunk_overlap_s", 0.125)
    args, info = lt.join_command(files, [193, 193, 185], 9, tmp_path / "out.mp4")
    graph = args[args.index("-filter_complex") + 1]
    assert info["fade_frames"] == [3, 3] and info["frames"] == 193 + 193 + 185 - 18
    assert "trim=start_frame=6:end_frame=193" in graph

    # a third of the shortest chunk caps it too
    monkeypatch.setattr(get_settings(), "chunk_overlap_s", 1.0)
    _, info = lt.join_command(files[:2], [25, 17], 9, tmp_path / "out.mp4")
    assert info["fade_frames"] == [6]  # 17/3 frames, rounded

    # i2v fallback / failed crossfade: hard joins, still exact length, silence for a mute chunk
    args, info = lt.join_command(files[:2], [193, 185], 1, tmp_path / "out.mp4", audio=[True, False])
    graph = args[args.index("-filter_complex") + 1]
    assert "xfade" not in graph and "concat=n=2:v=1:a=1" in graph and "anullsrc" in " ".join(args)
    assert info["frames"] == 193 + 185 - 1
    _, info = lt.join_command(files[:2], [193, 185], 9, tmp_path / "out.mp4", crossfade=False)
    assert info["fade_frames"] == [0] and info["frames"] == 193 + 185 - 9


def test_extend_template_valid_and_built():
    info = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert check_template("ltx23_extend", info)["ok"]
    broken = json.loads(FIXTURE.read_text(encoding="utf-8"))
    del broken["VHS_LoadVideo"]
    assert check_template("ltx23_extend", broken)["missing_nodes"] == ["VHS_LoadVideo"]

    graph, res = build("ltx23_extend", {"prompt": "go", "context_video": "mixai/t.mp4", "num_frames": 161,
                                        "duration_s": 161 / 24, "context_s": 9 / 24, "width": 768, "height": 448})
    titles = {n["_meta"]["title"]: n for n in graph.values()}
    assert "LastImage" not in titles and titles["Guider"]["inputs"]["positive"] == ["7", 0]
    assert titles["AudioMask"]["inputs"]["audio_start_time"] == 0.375
    assert titles["VideoLatent"]["inputs"]["length"] == 161


def test_comfy_chunk_plans(tmp_path):
    class Lookup:
        def generation_file(self, gid):
            return tmp_path / f"{gid}.png"

    base = {"kind": "take_chunk", "num_frames": 185, "fps": 24, "width": 768, "height": 448}
    p0 = plan_generation("take_chunk", "a", {**base, "first_frame_id": "S"}, 3, Lookup())
    assert p0.template == "ltx23_i2v" and p0.images["first_image"].name == "S.png"
    ext = plan_generation("take_chunk", "b", {**base, "context_video": str(tmp_path / "t.mp4"), "context_frames": 9,
                                              "last_frame_id": "E"}, 3, Lookup())
    assert ext.template == "ltx23_extend" and ext.images["last_image"].name == "E.png"
    assert ext.inputs["duration_s"] == pytest.approx(185 / 24) and ext.inputs["context_s"] == pytest.approx(9 / 24)
    fb = plan_generation("take_chunk", "c", {**base, "first_image_path": str(tmp_path / "last.png")}, 3, Lookup())
    assert fb.template == "ltx23_i2v" and fb.images["first_image"].name == "last.png"


# ------------------------------------------------------------------ API

def _long_shot(client, project, fast_driver, duration=20, end=True):
    scene = _scene(client, project)
    shot = _shot(client, scene, duration_s=duration, description="Maya walks the deck")
    _approved(client, fast_driver, "shot", shot["id"], "keyframe_start")
    if end:
        _approved(client, fast_driver, "shot", shot["id"], "keyframe_end")
    client.patch(f"/api/shots/{shot['id']}", json={"motion_prompt": "Maya walks to the bow and looks out."})
    return shot


def beats_answer(body):
    if schema_title(body) == "BeatList":
        n = body["messages"][1]["content"].count(" s: ")
        return oa(json.dumps({"beats": [{"prompt": f"AI beat {i + 1}"} for i in range(n)]}))
    return oa("?")


def test_long_duration_validation_type_and_estimate(client, project):
    scene = _scene(client, project)
    shot = _shot(client, scene, duration_s=120)
    assert shot["shot_type"] == "long_take" and shot["duration_s"] == 120
    assert _shot(client, scene, duration_s=120, shot_type="wide")["shot_type"] == "wide"
    assert client.post(f"/api/scenes/{scene['id']}/shots", json={"duration_s": 301}).status_code == 422
    short = _shot(client, scene, duration_s=4)
    assert short["shot_type"] == "medium"
    r = client.patch(f"/api/shots/{short['id']}", json={"duration_s": 45})
    assert r.json()["shot_type"] == "long_take"

    est = client.get(f"/api/shots/{shot['id']}/estimate").json()
    assert est["chunks"] == 16 and est["long_take"] and est["frames_total"] == frames_for(120, 24)
    assert est["est_gpu_s"] > 120 * 6 and est["est_wall_s"] >= est["est_gpu_s"]
    one = client.get(f"/api/shots/{shot['id']}/estimate?duration_s=10").json()
    assert one["chunks"] == 1 and not one["long_take"]
    assert client.get(f"/api/shots/{shot['id']}/estimate?duration_s=400").status_code == 422


def test_beats_lock_rules(client, project, fake_llm, fast_driver):
    fake = fake_llm(beats_answer)
    scene = _scene(client, project)
    shot = _shot(client, scene, duration_s=20, description="Maya walks the deck")
    client.patch(f"/api/shots/{shot['id']}", json={"motion_prompt": "Maya walks to the bow."})
    job = client.post(f"/api/shots/{shot['id']}/ai/beats").json()
    assert run_job(job["id"], fast_driver).status == "done"
    beats = client.get(f"/api/shots/{shot['id']}").json()["beats"]
    assert [b["prompt"] for b in beats] == ["AI beat 1", "AI beat 2", "AI beat 3"]
    assert beats[0]["t_start"] == 0 and beats[-1]["t_end"] == 20 and not any(b["locked"] for b in beats)

    # the user edits beat 2: it locks, the others stay AI
    beats[1]["prompt"] = "She stops and kneels by the rope."
    r = client.patch(f"/api/shots/{shot['id']}", json={"beats": beats})
    edited = r.json()["beats"]
    assert edited[1]["locked"] and edited[1]["source"] == "ai_edited" and not edited[0]["locked"]

    # new duration: beats go stale; a rewrite keeps the locked one (re-timed) and rewrites the rest
    r = client.patch(f"/api/shots/{shot['id']}", json={"duration_s": 30})
    assert all(b.get("stale") for b in r.json()["beats"])
    job = client.post(f"/api/shots/{shot['id']}/ai/beats").json()
    assert run_job(job["id"], fast_driver).status == "done"
    beats = client.get(f"/api/shots/{shot['id']}").json()["beats"]
    assert len(beats) == 4 and beats[-1]["t_end"] == 30
    kept = [b for b in beats if b["locked"]]
    assert len(kept) == 1 and kept[0]["prompt"] == "She stops and kneels by the rope."
    # its midpoint (10 s of 20) rescales to 15 s of 30: the start of window 3
    assert beats.index(kept[0]) == 2 and kept[0]["source"] == "ai_edited"
    assert "FIXED (keep exactly): She stops" in fake.requests[-1]["messages"][1]["content"]


# ------------------------------------------------------------------ the take pipeline

class CountingDriver(MockDriver):
    def __init__(self, fail_at=None, stop_at=None):
        super().__init__(step_seconds=0, steps=2)
        self.calls: list[dict] = []
        self.fail_at, self.stop_at = fail_at, stop_at

    def generate_video(self, prompt, params, seed, out_path, progress_cb):
        idx = params.get("chunk_idx")
        if idx == self.stop_at:
            worker._stop.set()  # what a SIGTERM does mid-take
            progress_cb(0.1, "x")
        if idx == self.fail_at:
            raise RuntimeError("GPU fell over")
        self.calls.append({"idx": idx, "prompt": prompt, **{k: params.get(k) for k in (
            "num_frames", "first_frame_id", "last_frame_id", "context_video", "context_frames")}})
        return super().generate_video(prompt, params, seed, out_path, progress_cb)


def _take(client, shot, **body):
    r = client.post(f"/api/shots/{shot['id']}/takes", json=body)
    assert r.status_code == 202, r.text
    return r.json()


def test_long_take_renders_resumes_and_joins(client, project, fake_llm, fast_driver):
    fake_llm(beats_answer)
    shot = _long_shot(client, project, fast_driver)
    jobs = _take(client, shot)
    assert len(jobs) == 1  # long takes default to one

    # first attempt: the worker is told to stop during chunk 2 (index 1)
    first = CountingDriver(stop_at=1)
    try:
        worker.process_one(driver_factory=lambda: first)
    finally:
        worker._stop.clear()
    with SessionLocal() as db:
        job = db.get(Job, jobs[0]["id"])
        gen = db.get(Generation, job.generation_id)
        assert job.status == "queued" and [c["status"] for c in gen.params["chunks"]] == ["done", "pending", "pending"]
        assert gen.params["chunks"][0]["prompt"] == "AI beat 1"
        assert len(db.get(Shot, shot["id"]).beats) == 3
    assert [c["idx"] for c in first.calls] == [0]
    assert first.calls[0]["first_frame_id"] and not first.calls[0]["last_frame_id"]

    # second attempt resumes at chunk index 1
    second = CountingDriver()
    worker.process_one(driver_factory=lambda: second)
    assert [c["idx"] for c in second.calls] == [1, 2]
    assert second.calls[0]["context_frames"] == 9 and second.calls[0]["context_video"].endswith("_tail_0.mp4")
    assert second.calls[1]["last_frame_id"]  # END guide only on the last chunk
    assert "AI beat 2" in second.calls[0]["prompt"]

    with SessionLocal() as db:
        job = db.get(Job, jobs[0]["id"])
        gen = db.get(Generation, job.generation_id)
        assert job.status == "done", job.error
        assert gen.status == "ready" and gen.media_type == "video/mp4"
        assert gen.params["assembly"]["status"] == "done" and gen.params["assembly"]["frames"] == frames_for(20, 24)
        assert gen.params["longtake_stats"]["chunks"] == 3
        out = get_settings().data_dir / gen.file_path
        chunk_dir = get_settings().data_dir / Path(gen.params["chunks"][0]["file"]).parent
    assert out.is_file() and lt.has_audio(out)
    assert lt.count_frames(out) == frames_for(20, 24)
    assert sorted(p.name for p in chunk_dir.glob("chunk_*.mp4")) == ["chunk_0.mp4", "chunk_1.mp4", "chunk_2.mp4"]


def test_chunk_regenerate_cascades(client, project, fake_llm, fast_driver):
    fake_llm(beats_answer)
    shot = _long_shot(client, project, fast_driver, duration=30)
    job = _take(client, shot)[0]
    run_job(job["id"], lambda: CountingDriver())
    gen_id = job["generation_id"]

    assert client.post(f"/api/generations/{gen_id}/chunks/9/regenerate").status_code == 422
    r = client.post(f"/api/generations/{gen_id}/chunks/2/regenerate", json={"prompt": "A wave hits the bow."})
    assert r.status_code == 202, r.text
    assert "redoing 2 of 4 chunks" in r.json()["message"]
    drv = CountingDriver()
    done = run_job(r.json()["id"], lambda: drv)
    assert done.status == "done", done.error
    assert [c["idx"] for c in drv.calls] == [2, 3]
    assert drv.calls[0]["prompt"].startswith("A wave hits the bow.")
    with SessionLocal() as db:
        child = db.get(Generation, done.generation_id)
        assert child.parent_id == gen_id and child.status == "ready"
        assert [c["status"] for c in child.params["chunks"]] == ["done"] * 4
        assert child.params["rerolled_from"] == {"generation_id": gen_id, "chunk": 2}
        assert child.params["chunks"][0]["file"] != db.get(Generation, gen_id).params["chunks"][0]["file"]
        assert lt.count_frames(get_settings().data_dir / child.file_path) == frames_for(30, 24)


def test_failed_chunk_is_recorded_and_short_takes_stay_single_pass(client, project, fake_llm, fast_driver):
    fake_llm(beats_answer)
    shot = _long_shot(client, project, fast_driver, end=False)
    job = _take(client, shot, duration_s=12)[0]
    done = run_job(job["id"], lambda: CountingDriver(fail_at=1))
    assert done.status == "failed" and "GPU fell over" in done.error
    with SessionLocal() as db:
        chunks = db.get(Generation, done.generation_id).params["chunks"]
    assert [c["status"] for c in chunks] == ["done", "failed"] and chunks[1]["error"] == "GPU fell over"

    short = _take(client, shot, duration_s=6, count=1)[0]
    with SessionLocal() as db:
        params = db.get(Generation, short["generation_id"]).params
    assert "chunks" not in params and params["num_frames"] == 145
