"""Voice-first features: the lines are spoken before any picture, and the shots are cut to the dialogue track
with the video podcast's planner."""
import json
import re

import httpx
import pytest
from sqlalchemy import select

from app import autopilot as ap_mod
from app import film_audio as fa
from app.audio_analysis import stream_info
from app.config import get_settings
from app.db import SessionLocal
from app.llm import set_transport
from app.models import Generation, Project, Scene, Shot
from app.services import generation_file
from tests.test_ai import oa
from tests.test_autopilot import drive
from tests.test_character_sheet import run_all, studio_character, with_portrait
from tests.test_quick_feature import URDU, FeatureBrain, aerab_calls  # noqa: F401 (fixture)

REPLY = "ہاں، میں بھی یہی سوچ رہا تھا۔"
LONG = " ".join([URDU] * 5)  # 25 words, about 10 s: too long for one shot


def who(names):
    return lambda cue: names.get(cue.title())


def test_beats_from_a_script():
    script = (f"Mara lights the lamps.\n\nMARA\n{URDU}\n\nALI\n(softly)\n{REPLY}\n\n"
              f"The lane goes quiet and the wind picks up over the rooftops tonight.\n\nMARA\n{LONG}\n\n"
              "The last lamp flickers out.")
    bts = fa.beats(script, who({"Mara": "m", "Ali": "a"}))
    kinds = [b["kind"] for b in bts]
    # the action before a line is what we see while it's said; the closing one is a pause of its own
    assert kinds[:2] == ["line", "line"] and kinds[-1] == "silent"
    assert bts[0]["visual"] == "Mara lights the lamps." and bts[1]["character_id"] == "a"
    long = [b for b in bts if b["kind"] == "line" and b["character_id"] == "m"][1:]
    assert len(long) >= 2 and " ".join(b["text"] for b in long).split() == LONG.split()
    assert all(fa.SILENT_S[0] <= b["seconds"] <= fa.SILENT_S[1] for b in bts if b["kind"] == "silent")


def test_shots_are_cut_to_the_track():
    bts = [{"kind": "silent", "visual": "Lamps in a lane", "seconds": 3.0},
           {"kind": "line", "character_id": "m", "text": "one", "visual": "Mara at the door"},
           {"kind": "line", "character_id": "a", "text": "two", "visual": "Ali by the wall"},
           {"kind": "line", "character_id": "m", "text": "three", "visual": "Mara turns"}]
    items, total = fa.timeline(bts, [4.0, 13.0, 3.0])
    assert [round(i["start"], 2) for i in items] == [3.3, 7.65, 21.0]
    assert total == pytest.approx(3.3 + 4 + 0.35 + 13 + 0.35 + 3 + 0.5, abs=0.05)
    plans = fa.cut_plans(bts, fa.cut(items, total, "scene-1"), {"m": "Mara", "a": "Ali"}, ["m", "a"], None)
    # the whole track, end to end, in pieces of at most one LTX pass
    assert plans[0]["audio"]["start"] == 0 and plans[-1]["audio"]["end"] == pytest.approx(total)
    for a, b in zip(plans, plans[1:]):
        assert a["audio"]["end"] == pytest.approx(b["audio"]["start"])
    assert all(p["duration_s"] <= fa.PIECE_S + 1e-6 for p in plans)
    assert plans[0]["shot_type"] == "wide"  # the room before anyone speaks
    ali = [p for p in plans if p["character_ids"] == ["a"] and p["audio"]["lipsync"]]
    assert ali and ali[0]["shot_type"] == "close_up" and ali[0]["dialogue"][0]["text"] == "two"
    # the 13 s turn is cut in two: Ali, then Mara listening while his voice carries on
    reaction = [p for p in plans if p["character_ids"] == ["m"] and not p["audio"]["lipsync"]]
    assert len(reaction) == 1 and reaction[0]["shot_type"] == "over_shoulder"
    assert reaction[0]["audio"]["speaker_id"] == "a" and reaction[0]["dialogue"] == []
    three = fa.pieces([{"camera": "m", "speaker_id": "m", "start": 0.0, "end": 25.0}])
    assert [round(p["duration"], 2) for p in three] == [8.33, 8.33, 8.33]
    assert sum(len(p["dialogue"]) for p in plans) == 3


def test_a_lone_presenter_is_lip_synced_whenever_he_speaks():
    # Ruslan's explainer (23 Oct): the room shots at the top and tail of each scene showed him with his voice
    # running and his mouth still
    bts = [{"kind": "line", "character_id": "r", "text": "Hello and welcome.", "visual": "Ruslan smiles"},
           {"kind": "line", "character_id": "r", "text": "Step one is Create Image.", "visual": "He points"},
           {"kind": "line", "character_id": "r", "text": "Try it today.", "visual": "He waves"}]
    items, total = fa.timeline(bts, [6.0, 9.0, 5.0])
    plans = fa.cut_plans(bts, fa.cut(items, total, "scene-r"), {"r": "Ruslan"}, ["r"], None)
    for p in plans:
        speaking = any(i["start"] < p["audio"]["end"] - 1e-6 and i["end"] > p["audio"]["start"] + 1e-6
                       for i in items)
        assert p["audio"]["lipsync"] == speaking, p
    assert sum(len(p["dialogue"]) for p in plans) == 3


def test_a_speaking_shot_quotes_the_words_it_carries():
    long = ("Mix AI Cinema Studio writes your script, casts your film, draws every frame and renders the whole "
            "thing on its own machines, so you only bring the idea.")
    bts = [{"kind": "line", "character_id": "r", "text": "Hello and welcome.", "visual": ""},
           {"kind": "line", "character_id": "r", "text": long, "visual": ""}]
    items, total = fa.timeline(bts, [2.0, 14.0])
    plans = [p for p in fa.cut_plans(bts, fa.cut(items, total, "scene-q"), {"r": "Ruslan"}, ["r"], None, 6.0)
             if p["audio"]["lipsync"]]
    assert all(p["duration_s"] <= 6.0 + 1e-6 for p in plans)
    said = [re.search(r'says: "([^"]*)"', p["motion_prompt"]).group(1) for p in plans]
    # the long line is shared out across its pieces, every word once, in order
    assert " ".join(said).split() == ("Hello and welcome. " + long).split()
    assert all("Steady locked-off camera" in p["motion_prompt"] for p in plans)


def test_words_in_splits_a_line_by_time():
    bts = [{"kind": "line", "character_id": "r", "text": "one two three four", "start": 0.0, "end": 4.0}]
    assert fa.words_in(bts, "r", 0.0, 2.0) == "one two"
    assert fa.words_in(bts, "r", 2.0, 4.0) == "three four"
    assert fa.words_in(bts, "x", 0.0, 4.0) == ""


def test_the_film_picks_its_lip_sync_engine(client, project):
    r = client.patch(f"/api/projects/{project['id']}", json={"settings": {"lipsync_engine": "ltx"}})
    assert r.status_code == 200, r.text
    bad = client.patch(f"/api/projects/{project['id']}", json={"settings": {"lipsync_engine": "sadtalker"}})
    assert bad.status_code == 422
    with SessionLocal() as db:
        assert fa.lipsync_engine(db.get(Project, project["id"])) == "ltx"
        p = db.get(Project, project["id"])
        p.settings = {}
        assert fa.lipsync_engine(p) == get_settings().film_lipsync_engine


class TalkingBrain(FeatureBrain):
    def outline(self, n):
        out = super().outline(n)
        return {**out, "characters": [{"name": "Mara", "role": "keeper"}, {"name": "Ali", "role": "neighbour"}]}

    def __call__(self, request):
        if request.method == "GET":
            return httpx.Response(200, json={"data": []})
        body = json.loads(request.content)
        if self.kind(body) == "draft":
            self.bodies.setdefault("draft", []).append(body)
            return httpx.Response(200, json=oa(
                f"Mara lights the lamps.\n\nMARA\n{URDU}\n\nAli leans on the wall.\n\nALI\n{REPLY}\n\n"
                f"MARA\n{LONG}\n\nThe last lamp flickers out."))
        return super().__call__(request)


def test_a_voice_first_feature(client, aerab_calls, fast_driver):
    b = TalkingBrain(short_first=False)
    set_transport(httpx.MockTransport(b))
    try:
        mara = studio_character(client, name="Mara", description="Woman, 60s, grey braid")
        ali = studio_character(client, name="Ali", description="Man, 30s, kurta")
        with_portrait(client, fast_driver, mara)
        with_portrait(client, fast_driver, ali)
        r = client.post("/api/quick", json={"prompt": "Ramadan lamps in an old lane", "language": "ur",
                                            "cast_ids": [mara["id"], ali["id"]], "scenes": 1, "scene_seconds": 30})
        assert r.status_code == 201, r.text
        out = r.json()
        job = drive(out["job"]["id"], fast_driver, limit=800)
    finally:
        set_transport(None)
    assert job.status == "done", job.error
    assert "ShotList" not in b.bodies  # the shots come from the voices, not a planner's guess
    with SessionLocal() as db:
        [scene] = db.scalars(select(Scene).where(Scene.project_id == out["project"]["id"])).all()
        assert job.result["voices"]["scenes"] == {scene.id: "voiced"}
        rec = fa.record(db.get(Project, scene.project_id), scene.id)
        lines = [x for x in rec["beats"] if x["kind"] == "line"]
        assert len(lines) >= 4  # the long speech went in as more than one line
        # each line as long as the mock TTS made it (2.5 words a second)
        for x in lines:
            assert x["end"] - x["start"] == pytest.approx(len(x["text"].split()) / 2.5, abs=0.15)
        track = get_settings().data_dir / rec["track"]
        assert stream_info(track).duration == pytest.approx(rec["seconds"], abs=0.1)
        shots = db.scalars(select(Shot).where(Shot.scene_id == scene.id).order_by(Shot.order)).all()
        assert len(shots) == len(rec["shots"]) >= 4
        # the scene runs as long as its dialogue, not the 30 s asked for, and no shot is over one pass
        assert sum(s.duration_s for s in shots) == pytest.approx(rec["seconds"], abs=0.05)
        assert all(s.duration_s <= fa.PIECE_S + 0.01 for s in shots)
        speaking = 0
        for s in shots:
            a = rec["shots"][s.id]
            take = db.scalars(select(Generation).where(Generation.target_id == s.id, Generation.kind == "take",
                                                       Generation.status == "approved")).one()
            assert take.params["mux_audio"] and "dialogue" not in take.params
            assert take.params["duration_s"] == pytest.approx(s.duration_s)
            assert stream_info(generation_file(take)).duration == pytest.approx(s.duration_s, abs=0.15)
            if a["lipsync"]:
                speaking += 1
                assert take.params["lipsync"] is True and take.params["speech_audio"] == take.params["mux_audio"]
                assert stream_info(take.params["speech_audio"]).duration == pytest.approx(a["end"] - a["start"],
                                                                                         abs=0.05)
            else:
                assert "speech_audio" not in take.params
        assert speaking >= 2 and len(shots) - speaking >= 1
        # stitched end to end: the opening title, then the scene exactly as long as its dialogue
        from app import title_intro

        final = db.get(Generation, job.result["final_render_id"])
        assert stream_info(generation_file(final)).duration == pytest.approx(title_intro.SECONDS + rec["seconds"],
                                                                             abs=0.6)



SCRIPT = ("A quiet harbour at dusk.\n\nMARA\nThe boats are late tonight.\n\nALI\nThe wind turned an hour ago.\n\n"
          "MARA\nThen we wait for them together.\n\nALI\nWe always do.")


def _cast(client, project):
    for name in ("Mara", "Ali"):
        r = client.post(f"/api/projects/{project['id']}/characters", json={"name": name, "description": "x"})
        assert r.status_code == 201, r.text


def _build(client, scene_id, fast_driver):
    r = client.post(f"/api/scenes/{scene_id}/build")
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "voicing" and len(r.json()["job_ids"]) == 4
    run_all(fast_driver)
    r = client.post(f"/api/scenes/{scene_id}/build")
    assert r.status_code == 202, r.text
    return r.json()


def test_a_scene_added_by_hand_builds_from_its_dialogue(client, project, fast_driver):
    _cast(client, project)
    scene = client.post(f"/api/projects/{project['id']}/scenes",
                        json={"heading": "EXT. HARBOUR - DUSK", "script_text": SCRIPT}).json()
    assert client.post(f"/api/scenes/{scene['id']}/plan-shots").status_code == 409  # nothing spoken yet
    out = _build(client, scene["id"], fast_driver)
    assert out["status"] == "planned" and out["shot_ids"] and out["new_shot_ids"] == out["shot_ids"]
    assert len(out["frame_job_ids"]) == 2 * len(out["shot_ids"])
    shots = client.get(f"/api/scenes/{scene['id']}/shots").json()
    assert [s["id"] for s in shots] == out["shot_ids"]
    assert sum(s["duration_s"] for s in shots) == pytest.approx(out["seconds"], abs=0.05)
    assert client.get(f"/api/scenes/{scene['id']}/audio").json() == {
        "planned": True, "stale": False, "message": None, "seconds": out["seconds"]}


def test_editing_one_line_revoices_it_and_recuts_only_its_shots(client, project, fast_driver):
    _cast(client, project)
    scene = client.post(f"/api/projects/{project['id']}/scenes",
                        json={"heading": "EXT. HARBOUR - DUSK", "script_text": SCRIPT}).json()
    first = _build(client, scene["id"], fast_driver)
    with SessionLocal() as db:
        rec = fa.record(db.get(Project, project["id"]), scene["id"])
        speech_before = db.scalars(select(Generation).where(Generation.kind == "speech")).all()
    edited = [b for b in rec["beats"] if b["kind"] == "line"][2]["line_id"]
    touched = {sid for sid, a in rec["shots"].items() if any(x[0] == edited for x in a["lines"])}
    assert touched and touched != set(first["shot_ids"])

    r = client.patch(f"/api/scenes/{scene['id']}", json={
        "script_text": SCRIPT.replace("Then we wait for them together.", "Then we wait for them here, together, as always.")})
    assert r.status_code == 200, r.text
    st = client.get(f"/api/scenes/{scene['id']}/audio").json()
    assert st["stale"] is True and st["message"] == "Dialogue changed — re-time shots"

    r = client.post(f"/api/scenes/{scene['id']}/voice")
    assert r.status_code == 202 and r.json()["status"] == "voicing"
    assert len(r.json()["job_ids"]) == 1  # only the edited line is spoken again
    run_all(fast_driver)
    r = client.post(f"/api/scenes/{scene['id']}/plan-shots")
    assert r.status_code == 200, r.text
    out = r.json()
    # the shots cut from the other lines are kept (frames and takes with them); only the edited line's change
    assert set(out["removed_shot_ids"]) == touched
    assert set(first["shot_ids"]) - touched <= set(out["shot_ids"])
    assert out["new_shot_ids"] and not set(out["new_shot_ids"]) & set(first["shot_ids"])
    with SessionLocal() as db:
        assert len(db.scalars(select(Generation).where(Generation.kind == "speech")).all()) == len(speech_before) + 1
    assert client.get(f"/api/scenes/{scene['id']}/audio").json()["stale"] is False
    # reordering scenes regenerates nothing
    other = client.post(f"/api/projects/{project['id']}/scenes", json={"heading": "INT. HUT", "script_text": ""}).json()
    r = client.post(f"/api/projects/{project['id']}/scenes/reorder", json={"scene_ids": [other["id"], scene["id"]]})
    assert r.status_code == 200, r.text
    assert client.get(f"/api/scenes/{scene['id']}/audio").json()["stale"] is False
    assert [s["id"] for s in client.get(f"/api/scenes/{scene['id']}/shots").json()] == out["shot_ids"]
