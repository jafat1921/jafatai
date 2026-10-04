import json
from pathlib import Path

import pytest

from app.api.events import collect_changes
from app.db import SessionLocal
from app.drivers.comfy import plan_generation
from app.models import Generation, Job, utcnow
from app.storyboard import script_duration
from app.worker import process_one
from tests.test_ai import fake_llm, oa, run_job, schema_title  # noqa: F401  (fixture re-export)

SCRIPT = "Maya checks her regulator on the deck.\n\nMAYA\nOne more dive. Then we go home.\n\nTomas nods."


def _run_all(fast_driver):
    while process_one(driver_factory=fast_driver):
        pass


def _scene(client, project, heading="EXT. BOAT DECK - DAWN", script=SCRIPT):
    r = client.post(f"/api/projects/{project['id']}/scenes", json={"heading": heading, "script_text": script})
    assert r.status_code == 201, r.text
    return r.json()


def _shot(client, scene, **body):
    r = client.post(f"/api/scenes/{scene['id']}/shots", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _gen(client, target_type, target_id, kind, prompt="", **params):
    return client.post("/api/generations", json={"target_type": target_type, "target_id": target_id, "kind": kind,
                                                  "prompt": prompt, "params": params})


def _approved(client, fast_driver, target_type, target_id, kind, prompt="frame"):
    r = _gen(client, target_type, target_id, kind, prompt)
    assert r.status_code == 201, r.text
    _run_all(fast_driver)
    r = client.post(f"/api/generations/{r.json()['id']}/approve")
    assert r.status_code == 200, r.text
    return r.json()


def _get(client, shot):
    return client.get(f"/api/shots/{shot['id']}").json()


# ------------------------------------------------------------------ CRUD

def test_shot_crud_reorder_and_lock_rule(client, project):
    scene = _scene(client, project)
    a = _shot(client, scene, shot_type="wide", duration_s=5)
    b = _shot(client, scene, description="Maya rolls backwards off the boat")
    c = _shot(client, scene, after_shot_id=a["id"])
    assert [s["id"] for s in client.get(f"/api/scenes/{scene['id']}/shots").json()] == [a["id"], c["id"], b["id"]]
    assert a["source"] == "user" and not a["locked"] and b["locked"] and a["status"] == "draft"
    assert client.get(f"/api/projects/{project['id']}").json()["counts"]["shots"] == 3

    r = client.patch(f"/api/shots/{a['id']}", json={"camera": "slow push in"}).json()
    assert r["locked"] and r["source"] == "user" and r["prompt_mode"] == "auto"
    r = client.patch(f"/api/shots/{a['id']}", json={"start_prompt": "    a diver on deck  "}).json()
    assert r["prompt_mode"] == "manual" and r["start_prompt"] == "a diver on deck"
    assert client.patch(f"/api/shots/{a['id']}", json={"character_ids": ["nope"]}).status_code == 422

    order = [b["id"], a["id"], c["id"]]
    got = client.post(f"/api/scenes/{scene['id']}/shots/reorder", json={"shot_ids": order}).json()
    assert [s["id"] for s in got] == order and [s["order"] for s in got] == [1, 2, 3]
    assert client.post(f"/api/scenes/{scene['id']}/shots/reorder", json={"shot_ids": order[:2]}).status_code == 422

    assert client.delete(f"/api/shots/{b['id']}").status_code == 204
    left = client.get(f"/api/projects/{project['id']}/shots").json()
    assert [s["order"] for s in left] == [1, 2]


def test_locations_crud_and_establishing(client, project, fast_driver):
    r = client.post(f"/api/projects/{project['id']}/locations", json={"name": "Harbour", "description": "Stone quay"})
    loc = r.json()
    assert r.status_code == 201 and loc["locked"] and loc["approved_establishing"] is None
    scene = _scene(client, project)
    assert client.patch(f"/api/scenes/{scene['id']}", json={"location_id": loc["id"]}).json()["location_id"] == loc["id"]
    assert _shot(client, scene)["location_id"] == loc["id"]  # inherits the scene's location

    g = _approved(client, fast_driver, "location", loc["id"], "establishing", prompt="")
    assert g["prompt"].startswith("Establishing shot of Harbour") and g["params"]["aspect_ratio"] == "16:9"
    assert client.get(f"/api/projects/{project['id']}/locations").json()[0]["approved_establishing"]["id"] == g["id"]
    assert _gen(client, "location", loc["id"], "take").status_code == 422

    assert client.delete(f"/api/locations/{loc['id']}").status_code == 204
    assert client.get(f"/api/scenes/{scene['id']}/shots").json()[0]["location_id"] is None
    assert client.get(f"/api/projects/{project['id']}/scenes").json()[0]["location_id"] is None


# ------------------------------------------------------------------ seams + staleness

def test_continue_seam_links_previous_end_frame(client, project, fast_driver):
    scene = _scene(client, project)
    s1 = _shot(client, scene)
    s2 = _shot(client, scene, seam_in="continue")
    end1 = _approved(client, fast_driver, "shot", s1["id"], "keyframe_end")

    got = _get(client, s2)
    assert got["start_linked"] and got["start_frame"]["id"] == end1["id"]
    r = _gen(client, "shot", s2["id"], "keyframe_start", "x")
    assert r.status_code == 409 and r.json()["detail"] == "linked to previous shot's end frame"

    # takes start from the linked frame; no END frame means plain I2V
    takes = client.post(f"/api/shots/{s2['id']}/takes", json={"count": 1})
    assert takes.status_code == 202, takes.text
    with SessionLocal() as db:
        g = db.get(Generation, db.get(Job, takes.json()[0]["id"]).generation_id)
        assert g.params["first_frame_id"] == end1["id"] and g.params["last_frame_id"] is None

    # the first shot of the film has nothing to continue from
    first = client.patch(f"/api/shots/{s1['id']}", json={"seam_in": "continue"}).json()
    assert not first["start_linked"]


def test_staleness_rules(client, project, fast_driver):
    scene = _scene(client, project)
    s1 = _shot(client, scene)
    s2 = _shot(client, scene, seam_in="continue")

    client.patch(f"/api/scenes/{scene['id']}", json={"script_text": "Something else happens."})
    assert all(s["stale"] for s in client.get(f"/api/scenes/{scene['id']}/shots").json())
    for s in (s1, s2):
        assert client.post(f"/api/shots/{s['id']}/clear-stale").json()["stale"] is False
        client.patch(f"/api/shots/{s['id']}", json={"motion_prompt": "the sea moves"})

    _approved(client, fast_driver, "shot", s1["id"], "keyframe_start")
    _approved(client, fast_driver, "shot", s1["id"], "keyframe_end")
    assert _get(client, s1)["status"] == "frames_ready"
    _approved(client, fast_driver, "shot", s2["id"], "keyframe_end")
    client.post(f"/api/shots/{s2['id']}/takes", json={"count": 1})
    assert _get(client, s2)["status"] == "rendering"
    _run_all(fast_driver)
    assert _get(client, s2)["status"] == "take_ready" and not _get(client, s2)["stale"]

    # a new approved END on s1 changes s2's START: s2 and its takes go stale
    new_end = _approved(client, fast_driver, "shot", s1["id"], "keyframe_end", prompt="new end")
    got = _get(client, s2)
    assert got["stale"] and got["start_frame"]["id"] == new_end["id"]
    assert not _get(client, s1)["stale"]  # s1 has no takes

    client.post(f"/api/shots/{s1['id']}/takes", json={"count": 1})
    _run_all(fast_driver)
    _approved(client, fast_driver, "shot", s1["id"], "keyframe_start", prompt="new start")
    assert _get(client, s1)["stale"]


def test_shot_events_follow_generation_changes(client, project, fast_driver):
    scene = _scene(client, project)
    s1 = _shot(client, scene)
    s2 = _shot(client, scene, seam_in="continue")
    since = utcnow()
    _approved(client, fast_driver, "shot", s1["id"], "keyframe_end")
    with SessionLocal() as db:
        ws = db.get(Job, client.get("/api/jobs").json()[0]["id"]).workspace_id
    shots = {obj_id: data for kind, obj_id, _, data in collect_changes(ws, since) if kind == "shot"}
    assert {s1["id"], s2["id"]} <= set(shots) and shots[s2["id"]]["start_linked"]


# ------------------------------------------------------------------ generation inputs

def test_reference_autofill_and_template_choice(client, project, character, fast_driver, tmp_path):
    portrait = _approved(client, fast_driver, "character", character["id"], "portrait", prompt="a diver")
    loc = client.post(f"/api/projects/{project['id']}/locations", json={"name": "Reef"}).json()
    est = _approved(client, fast_driver, "location", loc["id"], "establishing", prompt="a reef")
    scene = _scene(client, project)
    bare = _shot(client, scene)
    shot = _shot(client, scene, character_ids=[character["id"]], location_id=loc["id"])

    g = _gen(client, "shot", shot["id"], "keyframe_start", "she surfaces").json()
    assert g["params"]["reference_ids"] == [portrait["id"], est["id"]]
    assert g["params"]["reference_labels"] == ["Diver", "the location (Reef)"]
    plain = _gen(client, "shot", bare["id"], "keyframe_end", "empty sea").json()
    assert "reference_ids" not in plain["params"]

    class Lookup:
        def generation_file(self, gid):
            p = tmp_path / f"{gid}.png"
            p.write_bytes(b"png")
            return p

        def project_aspect(self, _):
            return "16:9"

    p = plan_generation("keyframe_start", g["prompt"], g["params"], 1, Lookup())
    assert p.template == "qwen_edit" and len(p.images["images"]) == 2
    assert p.inputs["prompt"].startswith("Picture 1 shows Diver; Picture 2 shows the location (Reef)")
    assert (p.inputs["width"], p.inputs["height"]) == (1280, 720)
    p = plan_generation("keyframe_end", plain["prompt"], plain["params"], 1, Lookup())
    assert p.template == "zimage_t2i"
    assert plan_generation("establishing", "x", {"aspect_ratio": "9:16"}, 1, Lookup()).inputs["width"] == 720


@pytest.mark.parametrize("aspect,size", [("16:9", (768, 448)), ("9:16", (448, 768)), ("1:1", (576, 576)),
                                         ("2.39:1", (1024, 416))])
def test_take_params_filled(client, aspect, size, fast_driver):
    project = client.post("/api/projects", json={"title": "T", "authoring_mode": "scene_by_scene",
                                                 "aspect_ratio": aspect, "style_bible": "35mm film grain"}).json()
    scene = _scene(client, project)
    shot = _shot(client, scene, duration_s=2)
    assert _gen(client, "shot", shot["id"], "take").status_code == 409  # no START yet
    start = _approved(client, fast_driver, "shot", shot["id"], "keyframe_start")
    end = _approved(client, fast_driver, "shot", shot["id"], "keyframe_end")
    client.patch(f"/api/shots/{shot['id']}", json={"motion_prompt": "She turns to the sea."})

    g = _gen(client, "shot", shot["id"], "take").json()
    p = g["params"]
    assert p["first_frame_id"] == start["id"] and p["last_frame_id"] == end["id"]
    assert p["num_frames"] == 49 and (p["num_frames"] - 1) % 8 == 0
    assert (p["width"], p["height"]) == size
    assert g["prompt"].startswith("She turns to the sea.") and g["prompt"].endswith("35mm film grain")
    _run_all(fast_driver)
    done = client.get(f"/api/generations?target_id={shot['id']}&kind=take").json()[0]
    assert done["status"] == "ready" and done["media_type"] == "video/mp4"


def test_scene_render_batch_is_ordered_by_shot(client, project, fast_driver):
    scene = _scene(client, project)
    s1, s2, s3 = (_shot(client, scene) for _ in range(3))
    for s in (s2, s1):  # approve out of order on purpose
        _approved(client, fast_driver, "shot", s["id"], "keyframe_start")
    r = client.post(f"/api/scenes/{scene['id']}/render", json={"count": 2})
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        targets = [db.get(Generation, db.get(Job, j["id"]).generation_id).target_id for j in r.json()]
    assert targets == [s1["id"], s1["id"], s2["id"], s2["id"]]  # s3 has no START, skipped

    empty = _scene(client, project, heading="INT. CABIN")
    _shot(client, empty)
    assert client.post(f"/api/scenes/{empty['id']}/render").status_code == 409


# ------------------------------------------------------------------ AI

def shotlist(body):
    if schema_title(body) == "ShotList":
        return oa(json.dumps({"shots": [
            {"shot_type": "Wide shot", "duration_s": 6, "description": "Maya checks her gear.", "camera": "static",
             "characters": ["MAYA"], "start_visual": "  Maya kneels by her tank", "end_visual": "Maya stands",
             "handoff": "", "continuous": False},
            {"shot_type": "close-up", "duration_s": 40, "description": "She speaks.", "camera": "push in",
             "characters": ["Maya", "Nobody"], "start_visual": "Maya's face", "end_visual": "Maya smiles",
             "handoff": "the regulator in her hand", "continuous": True},
        ]}), reasoning="two beats")
    if schema_title(body) == "FramePrompts":
        return oa(json.dumps({"start_prompt": "   A woman kneels.", "end_prompt": "She stands.",
                              "motion_prompt": "She rises slowly."}))
    return oa("?")


def test_suggest_shots_writes_then_respects_locks(client, project, fake_llm, fast_driver):
    fake_llm(shotlist)
    maya = client.post(f"/api/projects/{project['id']}/characters", json={"name": "Maya"}).json()
    scene = _scene(client, project)
    job = client.post(f"/api/scenes/{scene['id']}/ai/suggest-shots", json={"max_shots": 4}).json()
    done = run_job(job["id"], fast_driver)
    assert done.status == "done", done.error and done.result["outcome"] == "written"

    shots = client.get(f"/api/scenes/{scene['id']}/shots").json()
    assert [s["shot_type"] for s in shots] == ["wide", "close_up"]
    assert [s["seam_in"] for s in shots] == ["cut", "continue"]
    assert shots[1]["duration_s"] == 20 and shots[1]["handoff_text"] == "the regulator in her hand"
    assert shots[0]["character_ids"] == [maya["id"]] and shots[0]["start_prompt"] == "Maya kneels by her tank"
    assert all(s["source"] == "ai" and not s["locked"] for s in shots)

    # re-running over untouched AI shots replaces them
    done = run_job(client.post(f"/api/scenes/{scene['id']}/ai/suggest-shots").json()["id"], fast_driver)
    assert done.result["outcome"] == "written"
    shots = client.get(f"/api/scenes/{scene['id']}/shots").json()

    client.patch(f"/api/shots/{shots[0]['id']}", json={"description": "My own shot"})
    done = run_job(client.post(f"/api/scenes/{scene['id']}/ai/suggest-shots").json()["id"], fast_driver)
    assert done.result["outcome"] == "suggested"
    after = client.get(f"/api/scenes/{scene['id']}/shots").json()
    assert [s["id"] for s in after] == [s["id"] for s in shots] and after[0]["description"] == "My own shot"

    [sug] = client.get(f"/api/projects/{project['id']}/suggestions?target_id={scene['id']}").json()
    assert sug["field"] == "shots"
    assert client.post(f"/api/suggestions/{sug['id']}/accept").status_code == 200
    replaced = client.get(f"/api/scenes/{scene['id']}/shots").json()
    assert len(replaced) == 2 and all(s["locked"] and s["source"] == "ai_edited" for s in replaced)


def test_compile_prompts_and_manual_noop(client, project, fake_llm, fast_driver):
    fake = fake_llm(shotlist)
    client.patch(f"/api/projects/{project['id']}", json={"style_bible": "Kodak 2383 print look"})
    maya = client.post(f"/api/projects/{project['id']}/characters",
                       json={"name": "Maya", "description": "short black hair, teal wetsuit"}).json()
    scene = _scene(client, project)
    shot = _shot(client, scene, description="She gears up", character_ids=[maya["id"]])
    done = run_job(client.post(f"/api/shots/{shot['id']}/ai/compile-prompts").json()["id"], fast_driver)
    assert done.status == "done", done.error
    got = _get(client, shot)
    assert got["start_prompt"] == "A woman kneels." and got["motion_prompt"] == "She rises slowly."
    sent = fake.requests[0]["messages"][1]["content"]
    assert "teal wetsuit" in sent and "Kodak 2383 print look" in sent and fake.requests[0]["model"] == "fake-writer"

    client.patch(f"/api/shots/{shot['id']}", json={"prompt_mode": "manual"})
    done = run_job(client.post(f"/api/shots/{shot['id']}/ai/compile-prompts").json()["id"], fast_driver)
    assert done.result["outcome"] == "unchanged" and len(fake.requests) == 1


def test_empty_frame_prompt_compiles_inside_the_job(client, project, fake_llm, fast_driver):
    fake_llm(shotlist)
    scene = _scene(client, project)
    shot = _shot(client, scene, description="She gears up")
    g = _gen(client, "shot", shot["id"], "keyframe_end").json()
    assert g["params"]["compile_first"] and g["prompt"] == ""
    _run_all(fast_driver)
    with SessionLocal() as db:
        gen = db.get(Generation, g["id"])
        assert gen.status == "ready" and gen.prompt == "She stands." and "compile_first" not in gen.params
    assert _get(client, shot)["end_prompt"] == "She stands."


def test_empty_prompt_without_llm_fails_with_plain_message(client, project, fast_driver):
    scene = _scene(client, project)
    shot = _shot(client, scene, description="She gears up")
    g = _gen(client, "shot", shot["id"], "keyframe_start").json()
    _run_all(fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, g["job_id"])
        assert job.status == "failed" and "Couldn't write this shot's prompts" in job.error


def scene_frames(body):
    title = schema_title(body)
    if title == "SceneFrames":
        return oa(json.dumps({"shot_type": "medium", "description": "One take of the scene", "camera": "handheld",
                              "characters": ["Maya"], "start_prompt": "Opening frame", "end_prompt": "Closing frame",
                              "motion_prompt": "Things happen"}))
    return shotlist(body)


def _frame_gens(project_id):
    with SessionLocal() as db:
        rows = db.query(Generation).filter(Generation.project_id == project_id, Generation.target_type == "shot").all()
        return sorted((g.target_id, g.kind, g.status) for g in rows)


def test_storyboard_scene_mode_one_shot_per_scene(client, project, fake_llm, fast_driver):
    fake_llm(scene_frames)
    s1 = _scene(client, project)
    s2 = _scene(client, project, heading="EXT. REEF - DAY", script=" ".join(["word"] * 200))
    _scene(client, project, heading="INT. CABIN - NIGHT", script="")  # nothing to board

    job = client.post(f"/api/projects/{project['id']}/storyboard", json={}).json()
    assert job["type"] == "ai_storyboard"
    done = run_job(job["id"], fast_driver)
    assert done.status == "done", done.error

    shots = client.get(f"/api/projects/{project['id']}/shots").json()
    assert [s["scene_id"] for s in shots] == [s1["id"], s2["id"]]
    assert all(s["start_prompt"] == "Opening frame" and s["motion_prompt"] == "Things happen" for s in shots)
    assert [s["seam_in"] for s in shots] == ["cut", "cut"]
    assert shots[0]["duration_s"] == script_duration(SCRIPT) and shots[1]["duration_s"] == 20
    gens = _frame_gens(project["id"])
    assert len(gens) == 4 and {k for _, k, _ in gens} == {"keyframe_start", "keyframe_end"}
    assert len(done.result["frame_job_ids"]) == 4
    # child jobs carry the prompts already, so they render without another LLM call
    _run_all(fast_driver)
    assert all(st == "ready" for _, _, st in _frame_gens(project["id"]))


def test_storyboard_chain_links_scenes_and_skips_boarded_ones(client, project, fake_llm, fast_driver):
    fake_llm(scene_frames)
    s1, s2, s3 = (_scene(client, project, heading=f"EXT. PLACE {i}") for i in range(3))
    mine = _shot(client, s1, description="hand-made shot")

    job = client.post(f"/api/projects/{project['id']}/storyboard",
                      json={"continuity": "chain", "overwrite": False}).json()
    done = run_job(job["id"], fast_driver)
    assert done.status == "done", done.error
    assert done.result["skipped_scene_ids"] == [s1["id"]]

    shots = client.get(f"/api/projects/{project['id']}/shots").json()
    assert shots[0]["id"] == mine["id"] and shots[0]["description"] == "hand-made shot"
    assert [s["seam_in"] for s in shots[1:]] == ["continue", "continue"]
    gens = _frame_gens(project["id"])
    # every new shot continues from the one before: only END frames are generated
    assert sorted(k for _, k, _ in gens) == ["keyframe_end", "keyframe_end"]

    # overwrite over a scene with a user shot makes a suggestion instead of deleting it
    done = run_job(client.post(f"/api/projects/{project['id']}/storyboard",
                               json={"scene_ids": [s1["id"]], "overwrite": True}).json()["id"], fast_driver)
    assert done.result["outcome"] == "suggested"
    assert client.get(f"/api/shots/{mine['id']}").status_code == 200


def test_storyboard_chain_first_scene_generates_start(client, project, fake_llm, fast_driver):
    fake_llm(scene_frames)
    _scene(client, project, heading="EXT. A")
    _scene(client, project, heading="EXT. B")
    done = run_job(client.post(f"/api/projects/{project['id']}/storyboard",
                               json={"continuity": "chain"}).json()["id"], fast_driver)
    assert done.status == "done", done.error
    kinds = [k for _, k, _ in _frame_gens(project["id"])]
    assert sorted(kinds) == ["keyframe_end", "keyframe_end", "keyframe_start"]
    shots = client.get(f"/api/projects/{project['id']}/shots").json()
    assert [s["seam_in"] for s in shots] == ["cut", "continue"]


def test_storyboard_needs_script(client, project):
    assert client.post(f"/api/projects/{project['id']}/storyboard", json={}).status_code == 409


def test_extract_locations_links_scenes(client, project, fake_llm, fast_driver):
    s1 = _scene(client, project, heading="EXT. HARBOUR - DAWN")
    s2 = _scene(client, project, heading="EXT. REEF - DAY")
    keep = client.post(f"/api/projects/{project['id']}/locations",
                       json={"name": "Reef", "description": "my reef"}).json()
    client.patch(f"/api/scenes/{s2['id']}", json={"location_id": keep["id"]})
    fake_llm(lambda b: oa(json.dumps({"locations": [
        {"name": "harbour", "description": "Old stone quay, fishing boats", "time_of_day_variants": ["Dawn"],
         "scenes": [1]},
        {"name": "Reef", "description": "Bleached coral", "time_of_day_variants": ["day"], "scenes": [2]},
    ]})))
    done = run_job(client.post(f"/api/projects/{project['id']}/ai/extract-locations").json()["id"], fast_driver)
    assert done.status == "done", done.error
    locs = {loc["name"]: loc for loc in client.get(f"/api/projects/{project['id']}/locations").json()}
    assert locs["Harbour"]["source"] == "ai" and locs["Harbour"]["time_of_day_variants"] == ["dawn"]
    assert locs["Reef"]["description"] == "my reef"  # locked: suggestion instead
    assert len(done.result["suggestion_ids"]) == 1
    scenes = {s["id"]: s for s in client.get(f"/api/projects/{project['id']}/scenes").json()}
    assert scenes[s1["id"]]["location_id"] == locs["Harbour"]["id"] and scenes[s2["id"]]["location_id"] == keep["id"]


def test_script_duration():
    assert script_duration("") == 2.0
    assert script_duration("MAYA\n" + " ".join(["go"] * 25)) == 10.0  # 25 spoken words at 2.5 w/s
    assert script_duration(" ".join(["x"] * 500)) == 20.0
