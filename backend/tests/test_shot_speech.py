"""Character voices (M12b, contract v26): a character's voice, shot dialogue, lip-synced takes, the dialogue
studio import and the Character Studio test clip."""
import json
from pathlib import Path

from app import shot_speech as ss
from app.audio_analysis import stream_info
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import plan_generation
from app.models import Generation, Job, MediaItem, Shot
from app.voice_instruct import from_profile
from app.worker import process_one
from tests.test_ai import fake_llm, oa, run_job, schema_title  # noqa: F401  (fixture re-export)
from tests.test_character_sheet import Lookup, run_all, studio_character, with_portrait
from tests.test_storyboard import SCRIPT, _approved, _scene, _shot

TEN = "one two three four five six seven eight nine ten"


def preset_voice(client, name="Heart"):
    r = client.post("/api/voices", json={"name": name, "kind": "preset", "preset": {"engine": "kokoro", "id": "af_heart"}})
    assert r.status_code == 201, r.text
    return r.json()


def set_voice(client, character, voice_id):
    r = client.patch(f"/api/characters/{character['id']}", json={"voice_id": voice_id})
    assert r.status_code == 200, r.text
    return r.json()


def talking_shot(client, fast_driver, project, character, **body):
    scene = _scene(client, project)
    shot = _shot(client, scene, character_ids=[character["id"]], **body)
    # a written motion prompt, so the take doesn't ask the (absent) LLM for one
    client.patch(f"/api/shots/{shot['id']}", json={"motion_prompt": "She looks out to sea."})
    _approved(client, fast_driver, "shot", shot["id"], "keyframe_start")
    return shot


def say(client, shot, *lines):
    r = client.patch(f"/api/shots/{shot['id']}", json={"dialogue": list(lines)})
    assert r.status_code == 200, r.text
    return r.json()


def takes(shot_id):
    with SessionLocal() as db:
        return db.query(Generation).filter(Generation.target_id == shot_id, Generation.kind == "take").all()


def hidden_items(tag):
    with SessionLocal() as db:
        return [i for i in db.query(MediaItem).all() if tag in (i.tags or [])]


# ---------------------------------------------------------------- the character's voice

def test_voice_from_the_library_or_the_gallery(client, character):
    v = preset_voice(client)
    assert set_voice(client, character, v["id"])["voice_id"] == v["id"]
    assert set_voice(client, character, "gallery:bm_george")["voice_id"] == "gallery:bm_george"
    for bad in ("gallery:nobody", "no-such-voice"):
        r = client.patch(f"/api/characters/{character['id']}", json={"voice_id": bad})
        assert r.status_code == 422 and "library or the gallery" in r.json()["detail"]
    assert set_voice(client, character, "")["voice_id"] is None


def test_profile_words_become_an_omnivoice_instruct():
    raw, ins = from_profile({"gender": "female", "age": "34", "accent": "British"})
    assert raw == "female, young adult, British accent"
    assert ins.text == "female, young adult, british accent" and not ins.ignored
    _, ins = from_profile({"age": "70", "nationality": "Pakistani"}, extra="deep, slow")
    assert ins.text == "elderly, low pitch, indian accent" and ins.speed == 0.9
    assert from_profile({}).__getitem__(1).text is None


def test_design_a_voice_from_the_profile(client):
    c = studio_character(client)
    r = client.patch(f"/api/characters/{c['id']}", json={"profile": {"gender": "female", "age": "34",
                                                                     "accent": "British", "languages": "Urdu, English"}})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/characters/{c['id']}/voice/design", json={"extra": "warm"})
    assert r.status_code == 201, r.text
    out = r.json()
    v = out["voice"]
    assert v["kind"] == "design" and v["name"] == "Maya's voice" and v["language"] == "ur"
    assert v["design"]["description"] == "female, young adult, british accent"
    assert v["design"]["engine"] == "omnivoice" and isinstance(v["design"]["seed"], int)
    assert v["gender_hint"] == "female" and out["ignored"] == ["warm"]
    assert out["character"]["voice_id"] == v["id"]
    assert any(x["id"] == v["id"] for x in client.get("/api/voices").json())

    blank = studio_character(client, name="Nobody", description="")
    r = client.post(f"/api/characters/{blank['id']}/voice/design")
    assert r.status_code == 422 and "Profile tab" in r.json()["detail"]


# ---------------------------------------------------------------- shot dialogue

def test_dialogue_on_a_shot(client, project, character):
    other = client.post(f"/api/projects/{project['id']}/characters", json={"name": "Tomas"}).json()
    shot = _shot(client, _scene(client, project), character_ids=[character["id"]])
    assert shot["dialogue"] == [] and shot["dialogue_notice"] is None
    shot = say(client, shot, {"character_id": character["id"], "text": "  One more   dive. "},
               {"character_id": character["id"], "text": " "}, {"character_id": character["id"], "text": "Home.",
                                                                "pause_after_s": 0.8})
    assert shot["dialogue"] == [{"character_id": character["id"], "text": "One more dive."},
                                {"character_id": character["id"], "text": "Home.", "pause_after_s": 0.8}]
    # nobody has a voice yet: the shot says so, by name
    assert shot["dialogue_notice"].startswith("Diver has no voice yet")
    r = client.patch(f"/api/shots/{shot['id']}", json={"dialogue": [{"character_id": other["id"], "text": "Hi"}]})
    assert r.status_code == 422 and "shot's characters" in r.json()["detail"]
    # cast and lines in one PATCH, then a speaker taken out of the shot takes their lines along
    r = client.patch(f"/api/shots/{shot['id']}", json={
        "character_ids": [character["id"], other["id"]],
        "dialogue": [{"character_id": other["id"], "text": "Hi"}, {"character_id": character["id"], "text": "Hey"}]})
    assert r.status_code == 200 and len(r.json()["dialogue"]) == 2
    shot = client.patch(f"/api/shots/{shot['id']}", json={"character_ids": [character["id"]]}).json()
    assert shot["dialogue"] == [{"character_id": character["id"], "text": "Hey"}]
    v = preset_voice(client)
    set_voice(client, character, v["id"])
    assert client.get(f"/api/shots/{shot['id']}").json()["dialogue_notice"] is None


def test_lines_become_hidden_takes_a_track_and_a_lip_synced_take(client, project, character, fast_driver):
    set_voice(client, character, preset_voice(client)["id"])
    shot = talking_shot(client, fast_driver, project, character, duration_s=4)
    # the last line's pause is dropped: nothing follows it
    say(client, shot, {"character_id": character["id"], "text": TEN, "pause_after_s": 0.5},
        {"character_id": character["id"], "text": TEN + ".", "pause_after_s": 3})
    r = client.post(f"/api/shots/{shot['id']}/takes", json={"count": 2})
    assert r.status_code == 202, r.text
    tag = ss.shot_tag(shot["id"])
    lines = hidden_items(tag)
    assert len(lines) == 2  # spoken once, shared by both takes
    # working files: the Library hides them unless asked for by the shot's own tag
    listed = client.get("/api/media", params={"kind": "audio"}).json()["items"]
    assert not {i["id"] for i in listed} & {i.id for i in lines}
    assert len(client.get("/api/media", params={"kind": "audio", "tag": tag}).json()["items"]) == 2

    run_all(fast_driver)
    gens = takes(shot["id"])
    assert len(gens) == 2 and all(g.status == "ready" for g in gens)
    p = gens[0].params
    assert p["lipsync"] is True and p["dialogue"]["status"] == "ready" and p["dialogue"]["mode"] == "lipsync"
    assert {r["take_id"] for r in p["dialogue"]["lines"]} == {i.generation_id for i in lines}
    assert {r["take_id"] for r in gens[1].params["dialogue"]["lines"]} == {i.generation_id for i in lines}
    # two 4 s lines, the 0.5 s pause, the lead-in, and half a second to finish on
    speech = p["speech"]["duration_s"]
    assert abs(speech - (ss.LEAD_S + 4.0 + 0.5 + 4.0)) < 0.1
    assert p["duration_s"] == round(speech + ss.TAIL_S, 2) and not p.get("longtake")
    track = Path(p["speech_audio"])
    assert track.is_file() and abs(stream_info(track).duration - p["duration_s"]) < 0.05
    assert "speaks on camera" in gens[0].prompt
    # the shot stretched to fit its lines
    assert client.get(f"/api/shots/{shot['id']}").json()["duration_s"] == p["duration_s"]
    plan = plan_generation("take", gens[0].prompt, p, 7, Lookup(Path(get_settings().data_dir)))
    assert plan.template == "ltx23_ia2v" and plan.images["speech_audio"] == track


def test_long_lines_render_as_a_lip_synced_long_take(client, project, character, fast_driver):
    set_voice(client, character, preset_voice(client)["id"])
    shot = talking_shot(client, fast_driver, project, character, duration_s=4)
    say(client, shot, {"character_id": character["id"], "text": " ".join([TEN] * 3)})  # 12 s of speech
    client.post(f"/api/shots/{shot['id']}/takes", json={"count": 1})
    run_all(fast_driver)
    [g] = takes(shot["id"])
    assert g.status == "ready", g.params
    p = g.params
    assert p["longtake"] is True and p["continuity"] == "extend" and len(p["chunks"]) > 1
    assert p["duration_s"] > 12 and p["speech_audio"]
    assert all(c["status"] == "done" for c in p["chunks"])
    shot = client.get(f"/api/shots/{shot['id']}").json()
    assert shot["shot_type"] == "long_take" and shot["duration_s"] == p["duration_s"]


def test_a_speaker_without_a_voice_falls_back_to_native_audio(client, project, character, fast_driver):
    shot = talking_shot(client, fast_driver, project, character)
    say(client, shot, {"character_id": character["id"], "text": "One more dive."})
    client.post(f"/api/shots/{shot['id']}/takes", json={"count": 1})
    assert hidden_items(ss.shot_tag(shot["id"])) == []
    run_all(fast_driver)
    [g] = takes(shot["id"])
    assert g.status == "ready" and not g.params.get("speech_audio")
    assert g.params["dialogue"]["status"] == "native" and "no voice yet" in g.params["dialogue"]["notice"]
    assert 'Diver says: "One more dive."' in g.prompt


def test_a_take_queued_elsewhere_waits_for_its_lines(client, project, character, fast_driver):
    set_voice(client, character, preset_voice(client)["id"])
    shot = talking_shot(client, fast_driver, project, character)
    say(client, shot, {"character_id": character["id"], "text": "Five words are here now."})
    # the generic route doesn't speak the lines; the take's own job does, then waits
    r = client.post("/api/generations", json={"target_type": "shot", "target_id": shot["id"], "kind": "take",
                                              "prompt": "", "params": {}})
    assert r.status_code == 201, r.text
    take = r.json()
    assert process_one(driver_factory=fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, take["job_id"])
        assert job.status == "queued" and job.priority < 0 and "spoken line" in job.message
        [speech_job] = job.result["waiting_on"]
        assert db.get(Job, speech_job).payload["parent_job_id"] == job.id
    run_all(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, take["id"])
        assert g.status == "ready" and g.params["speech_audio"] and db.get(Job, take["job_id"]).status == "done"


def test_a_line_that_cannot_be_spoken_fails_the_take_readably(client, project, character, fast_driver):
    set_voice(client, character, preset_voice(client)["id"])  # Kokoro's af_heart speaks English only
    shot = talking_shot(client, fast_driver, project, character)
    say(client, shot, {"character_id": character["id"], "text": "یہ میری آواز ہے"})
    r = client.post(f"/api/shots/{shot['id']}/takes", json={"count": 1})
    assert r.status_code == 422 and "Kokoro voice" in r.json()["detail"]


# ---------------------------------------------------------------- the dialogue studio

def test_dialogue_import_matches_by_character(client, project):
    v = preset_voice(client)
    maya = client.post(f"/api/projects/{project['id']}/characters", json={"name": "Maya Khan"}).json()
    set_voice(client, maya, v["id"])
    _scene(client, project)
    s = client.post("/api/scripts", json={"title": "Radio play"}).json()
    s = client.post(f"/api/scripts/{s['id']}/import-project", json={"project_id": project["id"]}).json()
    row = next(c for c in s["cast"] if c.get("character_id") == maya["id"])
    assert row["name"] == "Maya Khan" and row["voice_id"] == v["id"]
    assert s["lines"][0]["speaker_id"] == row["id"]
    # renamed in the studio, still the same speaker on the next import
    cast = [{**c, "name": "Captain"} if c["id"] == row["id"] else c for c in s["cast"]]
    s = client.patch(f"/api/scripts/{s['id']}", json={"cast": cast}).json()
    s = client.post(f"/api/scripts/{s['id']}/import-project", json={"project_id": project["id"]}).json()
    assert [c["name"] for c in s["cast"]].count("Captain") == 1
    assert {ln["speaker_id"] for ln in s["lines"]} == {row["id"]}


# ---------------------------------------------------------------- Character Studio test clip

def test_test_clip(client, fast_driver):
    c = studio_character(client)
    assert client.get(f"/api/characters/{c['id']}/test-clip").json()["item"] is None
    r = client.post(f"/api/characters/{c['id']}/test-clip", json={"text": "Hello there."})
    assert r.status_code == 409 and "no voice yet" in r.json()["detail"]
    set_voice(client, c, preset_voice(client)["id"])
    r = client.post(f"/api/characters/{c['id']}/test-clip", json={"text": "Hello there."})
    assert r.status_code == 409 and "portrait" in r.json()["detail"]
    with_portrait(client, fast_driver, c)
    r = client.post(f"/api/characters/{c['id']}/test-clip", json={"text": " ".join([TEN] * 3)})
    assert r.status_code == 422 and "words" in r.json()["detail"]

    r = client.post(f"/api/characters/{c['id']}/test-clip", json={"text": "Hello there, this is my voice."})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["item"]["kind"] == "video" and out["panel"] == "portrait" and len(out["speech_jobs"]) == 1
    run_all(fast_driver)
    got = client.get(f"/api/characters/{c['id']}/test-clip").json()
    assert got["item"]["status"] == "ready" and got["item"]["media_url"] and got["text"].startswith("Hello there")
    with SessionLocal() as db:
        g = db.get(Generation, got["item"]["generation_id"])
        assert g.kind == "video" and g.params["lipsync"] and ss.TEST_CLIP_S[0] <= g.params["duration_s"] <= 10
    plan = plan_generation("video", g.prompt, g.params, 3, Lookup(Path(get_settings().data_dir)))
    assert plan.template == "ltx23_ia2v"
    # the clip is in the Library, its spoken line isn't
    ids = {i["id"] for i in client.get("/api/media", params={"kind": "video"}).json()["items"]}
    assert out["item"]["id"] in ids and len(hidden_items(ss.clip_tag(c["id"]))) == 1
    assert not {i["id"] for i in client.get("/api/media", params={"kind": "audio"}).json()["items"]}


# ---------------------------------------------------------------- the storyboard writes the lines

def test_storyboard_fills_in_the_dialogue(client, project, character, fake_llm, fast_driver):
    maya = client.post(f"/api/projects/{project['id']}/characters", json={"name": "Maya"}).json()

    def answer(body):
        if schema_title(body) == "SceneFrames":
            asked = body["messages"][-1]["content"]
            assert "dialogue" in asked and "one visible speaker" not in asked
            return oa(json.dumps({"shot_type": "close_up", "description": "Maya speaks", "camera": "static",
                                  "characters": [], "start_prompt": "a", "end_prompt": "b", "motion_prompt": "c",
                                  "dialogue": [{"character": "MAYA", "text": "One more dive."},
                                               {"character": "Narrator", "text": "She went."}]}))
        raise AssertionError(schema_title(body))

    fake_llm(answer)
    _scene(client, project, script=SCRIPT)
    job = client.post(f"/api/projects/{project['id']}/storyboard", json={"generate_frames": False}).json()
    assert run_job(job["id"], fast_driver).status == "done"
    [shot] = client.get(f"/api/projects/{project['id']}/shots").json()
    # the narrator can't be lip-synced; Maya speaks, so she is in the shot
    assert shot["dialogue"] == [{"character_id": maya["id"], "text": "One more dive."}]
    assert shot["character_ids"] == [maya["id"]]
    with SessionLocal() as db:
        assert db.get(Shot, shot["id"]).dialogue == shot["dialogue"]
