import shutil
import threading
from pathlib import Path

import pytest
from sqlalchemy import select

from app import reel as rl
from app.api.events import collect_changes
from app.config import get_settings
from app.db import SessionLocal
from app.models import Generation, Job, Project, Reel, UsageLedger, new_id, utcnow
from app.worker import claim_next, process_one, run_job

SIZE = [160, 90]


@pytest.fixture(scope="session")
def clips(tmp_path_factory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("clips")

    def mk(name, dur, freq=None, size="200x120"):
        p = d / f"{name}.mp4"
        args = ["-f", "lavfi", "-i", f"testsrc=size={size}:rate=25:duration={dur}"]
        if freq:
            args += ["-f", "lavfi", "-i", f"sine=frequency={freq}:duration={dur}", "-c:a", "aac", "-shortest"]
        rl.run_ff([*args, "-c:v", "libx264", "-pix_fmt", "yuv420p", str(p)])
        return p

    return {"tone2": mk("tone2", 2, 440), "silent15": mk("silent15", 1.5), "tone1": mk("tone1", 1, 880, "120x120")}


def _take(db, project_id: str, shot_id: str, clip: Path) -> Generation:
    p = db.get(Project, project_id)
    g = Generation(id=new_id(), workspace_id=p.workspace_id, project_id=p.id, target_type="shot", target_id=shot_id,
                   kind="take", status="approved", approved_at=utcnow(), media_type="video/mp4", params={})
    rel = f"takes/{g.id}.mp4"
    dst = get_settings().data_dir / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(clip, dst)
    g.file_path = rel
    db.add(g)
    db.commit()
    return g


def _film(client, db, project, layout) -> list[tuple[str, list[str]]]:
    out = []
    for i, names in enumerate(layout, start=1):
        sc = client.post(f"/api/projects/{project['id']}/scenes", json={"heading": f"SCENE {i}"}).json()
        shots = []
        for clip in names:
            sh = client.post(f"/api/scenes/{sc['id']}/shots", json={}).json()
            if clip is not None:
                _take(db, project["id"], sh["id"], clip)
            shots.append(sh["id"])
        out.append((sc["id"], shots))
    reel = client.get(f"/api/projects/{project['id']}/reel").json()
    r = db.get(Reel, reel["id"])
    r.settings = {"size": SIZE}
    db.commit()
    return out


def _clips_of(reel: dict, scene_id: str) -> list[dict]:
    return next(s for s in reel["scenes"] if s["scene_id"] == scene_id)["clips"]


def _assemble(client, project, **body) -> Job:
    job = client.post(f"/api/projects/{project['id']}/reel/assemble", json={"quality": "draft", **body})
    assert job.status_code == 202, job.text
    assert process_one(SessionLocal)
    with SessionLocal() as s:
        j = s.get(Job, job.json()["id"])
        assert j.status == "done", j.error
        return j


def test_dissolve_clamp():
    assert rl.clamp_transition(0.5, 4, 4) == 0.5
    assert rl.clamp_transition(0.5, 1.2, 4) == pytest.approx(0.4)  # a third of the shorter neighbour
    assert rl.clamp_transition(5.0, 30, 30) == 2.0
    assert rl.clamp_transition(0.01, 4, 4) == 0.05
    assert rl.clamp_transition(1.0, 0.09, 3) == 0.05  # floor wins over the third-rule


def test_normalise_adds_silence_and_fits_frame(clips, tmp_path):
    out = tmp_path / "n.mp4"
    rl.run_ff(rl.normalise_cmd(clips["silent15"], out, size=(160, 90), trim_in=0.25, duration=1.0, has_audio=False))
    p = rl.probe(out)
    assert p.has_audio and (p.width, p.height) == (160, 90)
    assert p.duration == pytest.approx(1.0, abs=0.06)


def test_sync_keeps_user_edits_and_flags_changed(client, db, project, clips):
    [(scene, shots)] = _film(client, db, project, [[clips["tone2"], clips["tone1"], clips["tone2"], None]])
    reel = client.get(f"/api/projects/{project['id']}/reel").json()
    a, b, c = _clips_of(reel, scene)
    assert [x["shot_id"] for x in (a, b, c)] == shots[:3]
    assert reel["missing"] == [{"shot_id": shots[3], "scene_id": scene, "reason": "no approved take"}]

    r = client.patch(f"/api/reel-clips/{b['id']}", json={"trim_in_s": 0.2, "transition_in": "dissolve"})
    assert r.status_code == 200 and r.json()["duration_s"] == pytest.approx(0.8, abs=0.05)
    assert client.patch(f"/api/reel-clips/{b['id']}", json={"trim_out_s": 5}).status_code == 422
    r = client.post(f"/api/projects/{project['id']}/reel/reorder", json={"clip_ids": [c["id"], a["id"], b["id"]]})
    assert [x["id"] for x in _clips_of(r.json(), scene)] == [c["id"], a["id"], b["id"]]

    # a new take gets approved for shot 2, and the 4th shot finally gets one too
    old = db.scalars(select(Generation).where(Generation.target_id == shots[1])).one()
    old.status = "ready"
    db.commit()
    new = _take(db, project["id"], shots[1], clips["tone2"])
    _take(db, project["id"], shots[3], clips["tone1"])

    reel = client.post(f"/api/projects/{project['id']}/reel/sync").json()
    got = _clips_of(reel, scene)
    assert [x["id"] for x in got[:3]] == [c["id"], a["id"], b["id"]]  # user order survives
    assert got[3]["shot_id"] == shots[3]  # new clip lands after its storyboard neighbours
    moved = got[2]
    assert moved["generation_id"] == new.id and moved["changed"] is True
    assert moved["trim_in_s"] == 0.2 and moved["transition_in"] == "dissolve"
    assert not any(x["changed"] for x in got if x["id"] != b["id"])
    assert reel["missing"] == []


def test_assemble_caches_scenes_and_matches_expected_length(client, db, project, clips):
    layout = [[clips["tone2"], clips["silent15"]], [clips["tone1"], clips["tone2"]]]
    (s1, _), (s2, _) = _film(client, db, project, layout)
    reel = client.get(f"/api/projects/{project['id']}/reel").json()
    c1 = _clips_of(reel, s1)
    c2 = _clips_of(reel, s2)
    client.patch(f"/api/reel-clips/{c1[1]['id']}", json={"transition_in": "dissolve", "transition_s": 0.5})
    # the first clip's transition is the scene seam, rendered at film level
    client.patch(f"/api/reel-clips/{c2[0]['id']}", json={"transition_in": "dissolve", "transition_s": 0.5})

    est = client.get(f"/api/projects/{project['id']}/reel/estimate").json()
    assert est["clips"] == 4 and est["stale_scenes"] == 2
    # scene 1: 2 + 1.5 - 0.5 dissolve; scene 2: 1 + 2; seam dissolve min(0.5, 3/3) = 0.5
    assert est["duration_s"] == pytest.approx(5.5, abs=0.01)

    job = _assemble(client, project)
    assert sorted(job.result["scenes_built"]) == sorted([s1, s2]) and job.result["scenes_cached"] == []
    assert job.result["wall_seconds"] > 0 and job.gpu_seconds == 0
    ledger = db.scalars(select(UsageLedger).where(UsageLedger.job_id == job.id)).one()
    assert ledger.kind == "assembly" and ledger.gpu_seconds == 0

    renders = client.get(f"/api/projects/{project['id']}/renders").json()
    assert len(renders) == 1 and renders[0]["status"] == "ready" and renders[0]["kind"] == "render"
    render = db.get(Generation, renders[0]["id"])
    assert render.params["loudness"]["loudnorm"] is True
    assert render.params["join"] == "copy" and render.params["fallbacks"] == []
    film = rl.probe(get_settings().data_dir / render.file_path)
    assert film.has_audio and (film.width, film.height) == tuple(SIZE)
    assert film.duration == pytest.approx(5.5, abs=0.1)
    # scene 2's chapter opens where the seam into it starts (3.0 - 0.5)
    assert len(film.chapters) == 2 and film.chapters[1][0] == pytest.approx(2.5, abs=0.05)

    reel = client.get(f"/api/projects/{project['id']}/reel").json()
    assert [s["mezzanine"]["status"] for s in reel["scenes"]] == ["fresh", "fresh"]
    assert reel["last_render"]["id"] == render.id

    # touch only scene 2: scene 1's mezzanine is reused
    client.patch(f"/api/reel-clips/{c2[1]['id']}", json={"trim_out_s": 0.5})
    reel = client.get(f"/api/projects/{project['id']}/reel").json()
    assert [s["mezzanine"]["status"] for s in reel["scenes"]] == ["fresh", "stale"]
    job2 = _assemble(client, project)
    assert job2.result["scenes_built"] == [s2] and job2.result["scenes_cached"] == [s1]
    assert job2.result["duration_s"] == pytest.approx(5.0, abs=0.01)
    # a seam-only change doesn't rebuild anything
    client.patch(f"/api/reel-clips/{c2[0]['id']}", json={"transition_in": "fade_black"})
    assert client.get(f"/api/projects/{project['id']}/reel/estimate").json()["stale_scenes"] == 0


def test_cancelled_assembly_closes_render(client, db, project, clips):
    _film(client, db, project, [[clips["tone1"]]])
    r = client.post(f"/api/projects/{project['id']}/reel/assemble", json={})
    job = claim_next(db)
    assert job.id == r.json()["id"]
    assert client.post(f"/api/jobs/{job.id}/cancel").status_code == 200
    run_job(db, job)
    db.refresh(job)
    assert job.message == "Cancelled"
    assert db.get(Generation, job.generation_id).status == "failed"
    assert not (get_settings().data_dir / "tmp" / "reel" / job.id).exists()


def test_reel_event_after_sync(client, db, project, clips):
    since = utcnow()
    _film(client, db, project, [[clips["tone1"]]])
    me = client.get("/api/auth/me").json()
    kinds = {k for k, *_ in collect_changes(me["workspace_id"], since)}
    assert "reel" in kinds


def test_concat_lists_are_per_job(clips, tmp_path):
    # two films joined at once from the same mezzanines must not share any temp file
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    for src, dst in ((clips["tone2"], a), (clips["tone1"], b)):
        norm = dst.with_suffix(".n.mp4")
        dur = rl.frames(rl.probe(src).duration)
        rl.run_ff(rl.normalise_cmd(src, norm, size=(160, 90), trim_in=0, duration=dur, has_audio=True))
        args, _ = rl.mezzanine_cmd([norm], [rl.Item(dur)], dst)
        rl.run_ff(args)
    mezz = [rl.Mezz(a, rl.probe(a).duration, "A"), rl.Mezz(b, rl.probe(b).duration, "B", "dissolve", 0.3)]
    results, errors = {}, []

    def go(name):
        try:
            results[name] = rl.join_film(mezz, tmp_path / name, tmp_path / f"{name}.mp4")
        except Exception as e:  # pragma: no cover - surfaced by the assert below
            errors.append(e)

    threads = [threading.Thread(target=go, args=(n,)) for n in ("job1", "job2")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert Path(results["job1"]["list"]).parent == tmp_path / "job1"
    assert Path(results["job2"]["list"]).parent == tmp_path / "job2"
    for n in ("job1", "job2"):
        assert rl.probe(tmp_path / f"{n}.mp4").duration == pytest.approx(results[n]["length"], abs=0.1)
