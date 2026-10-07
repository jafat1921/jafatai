"""UI polish P3: shot-list review gate, merge / split / extend, re-render isolation."""
import json

import pytest

from app.db import SessionLocal
from app.models import Generation, Project
from tests.test_ai import fake_llm, oa, run_job, schema_title  # noqa: F401  (fixture re-export)
from tests.test_storyboard import _approved, _gen, _get, _run_all, _scene, _shot, scene_frames, shotlist


def _ids(client, scene):
    return [s["id"] for s in client.get(f"/api/scenes/{scene['id']}/shots").json()]


def _gens(shot_id):
    with SessionLocal() as db:
        return sorted(g.kind for g in db.query(Generation).filter(Generation.target_id == shot_id).all())


# ------------------------------------------------------------------ merge

def test_merge_combines_neighbours(client, project, character):
    scene = _scene(client, project)
    tomas = client.post(f"/api/projects/{project['id']}/characters", json={"name": "Tomas"}).json()
    a = _shot(client, scene, description="Maya kneels.", duration_s=4, camera="static", character_ids=[character["id"]])
    b = _shot(client, scene, description="She stands.", duration_s=6, camera="tilt up",
              character_ids=[character["id"], tomas["id"]])
    c = _shot(client, scene, description="Tomas waves.", duration_s=3)
    client.patch(f"/api/shots/{a['id']}", json={"brand_placements": [
        {"asset_id": "logo1", "asset_type": "logo", "surface": "tank", "prominence": "background", "source": "ai"}]})
    client.patch(f"/api/shots/{b['id']}", json={"brand_placements": [
        {"asset_id": "logo1", "asset_type": "logo", "surface": "Tank", "prominence": "hero"},
        {"asset_id": "can", "asset_type": "product", "surface": "deck"}]})

    r = client.post("/api/shots/merge", json={"shot_ids": [b["id"], a["id"]]})
    assert r.status_code == 200, r.text
    shots = r.json()
    assert [s["id"] for s in shots] == [a["id"], c["id"]] and [s["order"] for s in shots] == [1, 2]
    m = shots[0]
    assert m["description"] == "Maya kneels. She stands." and m["duration_s"] == 10
    assert m["camera"] == "static; tilt up" and m["character_ids"] == [character["id"], tomas["id"]]
    assert m["locked"] and m["motion_prompt"] == ""
    # one logo on the tank (hero wins, the user's wins) plus the product
    assert sorted((p["asset_id"], p["prominence"], p["source"]) for p in m["brand_placements"]) == [
        ("can", "background", "user"), ("logo1", "hero", "user")]
    assert client.get(f"/api/shots/{b['id']}").status_code == 404


def test_merge_rules(client, project, fast_driver):
    s1, s2 = _scene(client, project), _scene(client, project, heading="EXT. REEF")
    a, b, c = (_shot(client, s1, description=f"shot {i}", duration_s=18) for i in range(3))
    other = _shot(client, s2, description="elsewhere")
    assert client.post("/api/shots/merge", json={"shot_ids": [a["id"], c["id"]]}).status_code == 422
    assert client.post("/api/shots/merge", json={"shot_ids": [c["id"], other["id"]]}).status_code == 422
    assert client.post("/api/shots/merge", json={"shot_ids": [a["id"]]}).status_code == 422

    _approved(client, fast_driver, "shot", c["id"], "keyframe_end")
    r = client.post("/api/shots/merge", json={"shot_ids": [b["id"], c["id"]]})
    assert r.status_code == 409 and "approved" in r.json()["detail"]

    # summed duration is capped at the longest take allowed, and becomes a long take
    merged = client.post("/api/shots/merge", json={"shot_ids": [a["id"], b["id"]]}).json()[0]
    from app.config import get_settings
    assert merged["duration_s"] == min(36, get_settings().longtake_max_s)
    assert merged["shot_type"] == ("long_take" if merged["duration_s"] > 20 else merged["shot_type"])


def test_merge_marks_the_continue_shot_after_it_stale(client, project, fast_driver):
    scene = _scene(client, project)
    a = _shot(client, scene, description="a")
    b = _shot(client, scene, description="b")
    c = _shot(client, scene, description="c", seam_in="continue")
    _gen(client, "shot", c["id"], "keyframe_end", "end of c")
    _run_all(fast_driver)
    assert not _get(client, c)["stale"]
    client.post("/api/shots/merge", json={"shot_ids": [a["id"], b["id"]]})
    # c now opens on the merged shot's END (it used to be b's)
    assert _get(client, c)["stale"]


# ------------------------------------------------------------------ split

def test_split_at_ratio_and_with_descriptions(client, project):
    scene = _scene(client, project)
    a = _shot(client, scene, description="Maya kneels. She checks the valve. She stands.", duration_s=6)
    tail = _shot(client, scene, description="after")
    client.patch(f"/api/shots/{a['id']}", json={"end_prompt": "Maya standing"})

    shots = client.post(f"/api/shots/{a['id']}/split", json={"at_ratio": 0.66}).json()
    assert [s["id"] for s in shots][0] == a["id"] and shots[2]["id"] == tail["id"]
    first, second = shots[0], shots[1]
    assert (first["duration_s"], second["duration_s"]) == (4, 2)
    assert first["description"] == "Maya kneels. She checks the valve." and second["description"] == "She stands."
    assert second["seam_in"] == "continue" and second["end_prompt"] == "Maya standing" and first["end_prompt"] == ""
    assert first["locked"] and second["locked"]

    shots = client.post(f"/api/shots/{second['id']}/split", json={"descriptions": ["up", "out"]}).json()
    assert [s["description"] for s in shots[1:3]] == ["up", "out"] and shots[1]["duration_s"] == 1

    assert client.post(f"/api/shots/{shots[1]['id']}/split").status_code == 422  # 1 s: too short


def test_split_refuses_approved_work(client, project, fast_driver):
    scene = _scene(client, project)
    a = _shot(client, scene, description="one", duration_s=6)
    _approved(client, fast_driver, "shot", a["id"], "keyframe_start")
    assert client.post(f"/api/shots/{a['id']}/split").status_code == 409


# ------------------------------------------------------------------ extend

def beat(body):
    if schema_title(body) == "NextBeat":
        return oa(json.dumps({"description": "Maya swims down.", "camera": "follow", "end_prompt": "Maya below",
                              "motion_prompt": "She kicks downward."}))
    return oa("?")


def test_extend_adds_a_continuing_shot_written_by_ai(client, project, fake_llm, fast_driver):
    fake = fake_llm(beat)
    scene = _scene(client, project)
    a = _shot(client, scene, description="Maya dives in.", camera="wide static")
    b = _shot(client, scene, description="Boat drifts.")
    r = client.post(f"/api/shots/{a['id']}/extend", json={"duration_s": 4})
    assert r.status_code == 201, r.text
    new, job = r.json()["shot"], r.json()["job"]
    assert _ids(client, scene) == [a["id"], new["id"], b["id"]]
    assert new["seam_in"] == "continue" and new["duration_s"] == 4 and job["type"] == "ai_extend_shot"
    assert new["start_linked"]

    done = run_job(job["id"], fast_driver)
    assert done.status == "done", done.error
    got = _get(client, new)
    assert got["description"] == "Maya swims down." and got["motion_prompt"] == "She kicks downward."
    assert got["end_prompt"] == "Maya below" and not got["locked"]
    assert "Maya dives in." in fake.requests[0]["messages"][1]["content"]
    # nothing was generated for anybody
    assert _gens(a["id"]) == [] and _gens(new["id"]) == []

    # the user's words are kept, and steer the AI
    r = client.post(f"/api/shots/{new['id']}/extend", json={"prompt": "She finds the anchor"}).json()
    run_job(r["job"]["id"], fast_driver)
    got = _get(client, r["shot"])
    assert got["description"] == "She finds the anchor" and got["locked"] and got["end_prompt"] == "Maya below"
    assert "She finds the anchor" in fake.requests[1]["messages"][1]["content"]
    assert r["shot"]["duration_s"] == 5


# ------------------------------------------------------------------ review gate

def test_review_first_plans_without_frames_until_approved(client, project, fake_llm, fast_driver):
    fake_llm(scene_frames)
    s1 = _scene(client, project)
    s2 = _scene(client, project, heading="EXT. REEF - DAY")
    done = run_job(client.post(f"/api/projects/{project['id']}/storyboard",
                               json={"review_first": True, "continuity": "chain"}).json()["id"], fast_driver)
    assert done.status == "done", done.error
    assert done.result["frame_job_ids"] == [] and done.result["review_scene_ids"] == [s1["id"], s2["id"]]
    shots = client.get(f"/api/projects/{project['id']}/shots").json()
    assert len(shots) == 2 and all(_gens(s["id"]) == [] for s in shots)
    scenes = client.get(f"/api/projects/{project['id']}/scenes").json()
    assert [s["shots_review"] for s in scenes] == ["pending", "pending"]
    # the project settings PATCH can't touch the gate
    client.patch(f"/api/projects/{project['id']}", json={"settings": {"shots_review": None}})
    assert client.get(f"/api/projects/{project['id']}/scenes").json()[0]["shots_review"] == "pending"

    r = client.post(f"/api/scenes/{s2['id']}/shots-review/approve")
    assert r.status_code == 202, r.text
    assert r.json()["scene"]["shots_review"] is None
    # scene 2 continues from scene 1: only its END is made, and scene 1 stays untouched
    assert len(r.json()["jobs"]) == 1 and _gens(shots[1]["id"]) == ["keyframe_end"] and _gens(shots[0]["id"]) == []
    # approving again doesn't queue duplicates
    assert client.post(f"/api/scenes/{s2['id']}/shots-review/approve").json()["jobs"] == []

    assert client.patch(f"/api/scenes/{s1['id']}/shots-review", json={"status": None}).json()["shots_review"] is None
    assert client.patch(f"/api/scenes/{s1['id']}/shots-review", json={"status": "pending"}).json()["shots_review"] == "pending"


def test_suggest_shots_review_first_and_rerun_without_clears(client, project, fake_llm, fast_driver):
    fake_llm(shotlist)
    scene = _scene(client, project)
    done = run_job(client.post(f"/api/scenes/{scene['id']}/ai/suggest-shots",
                               json={"review_first": True}).json()["id"], fast_driver)
    assert done.status == "done", done.error
    assert client.get(f"/api/projects/{project['id']}/scenes").json()[0]["shots_review"] == "pending"
    run_job(client.post(f"/api/scenes/{scene['id']}/ai/suggest-shots").json()["id"], fast_driver)
    assert client.get(f"/api/projects/{project['id']}/scenes").json()[0]["shots_review"] is None
    with SessionLocal() as db:
        assert "shots_review" not in (db.get(Project, project["id"]).settings or {})


# ------------------------------------------------------------------ re-render isolation

def test_rerender_touches_only_this_shot(client, project, fast_driver):
    scene = _scene(client, project)
    a = _shot(client, scene, description="a")
    b = _shot(client, scene, description="b", seam_in="continue")
    c = _shot(client, scene, description="c")
    for s in (a, b):
        client.patch(f"/api/shots/{s['id']}", json={"start_prompt": "open", "end_prompt": "close", "motion_prompt": "go"})
    _approved(client, fast_driver, "shot", a["id"], "keyframe_start")
    _approved(client, fast_driver, "shot", a["id"], "keyframe_end")
    _approved(client, fast_driver, "shot", b["id"], "keyframe_end")
    before = {s: _gens(s) for s in (a["id"], b["id"], c["id"])}
    client.post(f"/api/shots/{b['id']}/clear-stale")

    r = client.post(f"/api/shots/{a['id']}/rerender", json={"what": "frames"})
    assert r.status_code == 202, r.text
    assert len(r.json()["jobs"]) == 2 and r.json()["linked_next_shot_id"] == b["id"]
    assert _gens(b["id"]) == before[b["id"]] and _gens(c["id"]) == before[c["id"]]
    assert len(_gens(a["id"])) == 4
    _run_all(fast_driver)
    # the next shot is only flagged (never regenerated), and only once a new END is approved
    assert not _get(client, b)["stale"]
    with SessionLocal() as db:
        new_end = db.query(Generation).filter(Generation.target_id == a["id"], Generation.kind == "keyframe_end",
                                              Generation.status == "ready").one()
    client.post(f"/api/generations/{new_end.id}/approve")
    assert _get(client, b)["stale"] and _gens(b["id"]) == before[b["id"]]

    # a linked START isn't made here; takes re-render only this shot
    r = client.post(f"/api/shots/{b['id']}/rerender").json()
    assert len(r["jobs"]) == 1 and r["linked_next_shot_id"] is None
    r = client.post(f"/api/shots/{a['id']}/rerender", json={"what": "takes", "count": 2})
    assert r.status_code == 202 and len(r.json()["jobs"]) == 2
    assert "take" not in _gens(b["id"]) and "take" not in _gens(c["id"])
    assert client.post(f"/api/shots/{c['id']}/rerender", json={"what": "takes"}).status_code == 409


def test_reorder_flags_continue_shots_whose_link_changed(client, project, fast_driver):
    scene = _scene(client, project)
    a = _shot(client, scene, description="a")
    b = _shot(client, scene, description="b")
    c = _shot(client, scene, description="c", seam_in="continue")
    _gen(client, "shot", c["id"], "keyframe_end", "c end")
    _run_all(fast_driver)
    client.post(f"/api/scenes/{scene['id']}/shots/reorder", json={"shot_ids": [a["id"], b["id"], c["id"]]})
    assert not _get(client, c)["stale"]
    client.post(f"/api/scenes/{scene['id']}/shots/reorder", json={"shot_ids": [b["id"], a["id"], c["id"]]})
    assert _get(client, c)["stale"]


@pytest.mark.parametrize("text,ratio,want", [
    ("One. Two. Three. Four.", 0.5, ("One. Two.", "Three. Four.")),
    ("just some words here", 0.25, ("just", "some words here")),
    ("single", 0.5, ("single", "single")),
])
def test_split_text(text, ratio, want):
    from app.storyboard import _split_text
    assert _split_text(text, ratio) == want


def test_shot_activity_lists_work_in_flight_and_failures(client, project, fast_driver):
    scene = _scene(client, project)
    a = _shot(client, scene, description="a")
    client.patch(f"/api/shots/{a['id']}", json={"start_prompt": "open", "end_prompt": "close"})
    g = _gen(client, "shot", a["id"], "keyframe_end").json()
    [act] = _get(client, a)["activity"]
    assert act == {"id": g["id"], "kind": "keyframe_end", "status": "queued", "job_id": g["job_id"], "version": 1}
    _run_all(fast_driver)
    assert _get(client, a)["activity"] == []
    with SessionLocal() as db:
        db.get(Generation, g["id"]).status = "failed"
        db.commit()
    assert [x["status"] for x in _get(client, a)["activity"]] == ["failed"]


def test_camera_rack_is_stored_and_written_into_the_take_prompt(client, project, fast_driver):
    scene = _scene(client, project)
    a = _shot(client, scene, description="a")
    r = client.patch(f"/api/shots/{a['id']}", json={
        "camera_rack": {"size": "ms", "angle": "low", "motion": "push_in"}, "motion_prompt": "She rises."})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["camera_rack"] == {"size": "ms", "angle": "low", "motion": "push_in"} and got["locked"]
    assert got["camera"] == "Medium shot, low-angle shot looking up, slow push-in"
    client.patch(f"/api/shots/{a['id']}", json={"start_prompt": "open", "end_prompt": "close"})
    _approved(client, fast_driver, "shot", a["id"], "keyframe_start")
    g = _gen(client, "shot", a["id"], "take").json()
    assert g["prompt"].startswith("She rises. Medium shot, low-angle shot looking up, slow push-in.")
    # split keeps the rack on both halves
    client.patch(f"/api/shots/{a['id']}", json={"duration_s": 6})
    b = _shot(client, scene, description="b", duration_s=4)
    client.patch(f"/api/shots/{b['id']}", json={"camera_rack": {"motion": "static"}})
    with SessionLocal() as db:
        db.query(Generation).filter(Generation.target_id == a["id"]).delete()
        db.commit()
    merged = client.post("/api/shots/merge", json={"shot_ids": [a["id"], b["id"]]}).json()[0]
    assert merged["camera_rack"] == {}  # different racks: the joined text stays, the rack clears
