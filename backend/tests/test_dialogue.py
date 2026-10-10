"""Dialogue & narration B3 (contract v17): scripts, split + auto-cast, project import, fingerprints, takes,
the mix and the stems."""
import io
import sqlite3
import zipfile

import pytest

from app import dialogue as dl
from app.audio_analysis import stream_info
from app.config import get_settings
from app.db import SessionLocal
from app.lanes import lane_for
from app.models import Generation, Job, MediaItem
from tests.test_aerab import MARKED, PLAIN, llm  # noqa: F401  (llm is a fixture)
from tests.test_migrations import _alembic
from tests.test_storyboard import SCRIPT, _run_all
from tests.test_voices import clone


def make(client, **body):
    body.setdefault("title", "Radio play")
    r = client.post("/api/scripts", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def split(client, s, text, mode="sentences", **extra):
    r = client.post(f"/api/scripts/{s['id']}/split", json={"text": text, "mode": mode, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def patch(client, s, **body):
    r = client.patch(f"/api/scripts/{s['id']}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def get(client, s):
    return client.get(f"/api/scripts/{s['id']}").json()


def render(client, s, line_ids=None):
    r = client.post(f"/api/scripts/{s['id']}/render", json={"line_ids": line_ids} if line_ids is not None else {})
    assert r.status_code == 202, r.text
    return r.json()


def names(s):
    return {c["id"]: c["name"] for c in s["cast"]}


def statuses(s):
    return [ln["status"] for ln in s["lines"]]


DIALOGUE = "Narrator: The rain had not stopped for days.\nMaya: Five words are here now.\nTomas: One two three four."


def test_0014_adds_voice_script(tmp_path):
    db = tmp_path / "prod-copy.db"
    _alembic(db, "upgrade", "0014")
    con = sqlite3.connect(db)
    cols = {r[1] for r in con.execute("PRAGMA table_info(voice_script)")}
    assert {"id", "workspace_id", "title", "language", "engine", "project_id", "cast", "lines", "settings", "mix",
            "created_at", "updated_at"} <= cols
    assert "ix_voice_script_ws_updated" in {r[1] for r in con.execute("PRAGMA index_list(voice_script)")}
    con.close()
    _alembic(db, "downgrade", "0013")
    con = sqlite3.connect(db)
    assert "voice_script" not in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    _alembic(db, "upgrade", "head")


def test_new_job_types_run_on_the_general_lane():
    assert lane_for(dl.MIX_JOB) == "general" and lane_for(dl.STEMS_JOB) == "general"


def test_crud(client, project):
    s = make(client, language="en", project_id=project["id"])
    assert s["engine"] == "auto" and s["project_id"] == project["id"]
    assert [c["id"] for c in s["cast"]] == ["narrator"] and s["cast"][0]["color"]
    assert s["settings"] == {"gap_s": 0.35, "paragraph_gap_s": 0.8, "loudness": "podcast", "aerab": True}
    assert s["mix"] is None and s["lines"] == []

    s = patch(client, s, title="Night shift", settings={"gap_s": 0.5, "paragraph_gap_s": 1.0, "loudness": "web",
                                                        "aerab": False})
    assert s["title"] == "Night shift" and s["settings"]["loudness"] == "web"
    # the narrator can't be removed
    s = patch(client, s, cast=[{"id": "c_1", "name": "Maya"}])
    assert [c["id"] for c in s["cast"]] == ["narrator", "c_1"]
    s = patch(client, s, lines=[{"speaker_id": "c_1", "text": "Hi."}, {"speaker_id": "gone", "text": "Who?"}])
    assert [ln["speaker_id"] for ln in s["lines"]] == ["c_1", "narrator"]
    assert statuses(s) == ["empty", "empty"] and all(ln["fingerprint"] for ln in s["lines"])
    # removing a character hands their lines to the narrator
    s = patch(client, s, cast=[{"id": "narrator", "name": "Narrator"}])
    assert {ln["speaker_id"] for ln in s["lines"]} == {"narrator"}

    rows = client.get("/api/scripts").json()
    assert rows[0]["id"] == s["id"] and rows[0]["counts"]["lines"] == 2 and rows[0]["counts"]["empty"] == 2

    assert client.post("/api/scripts", json={"title": "x", "engine": "espeak"}).status_code == 422
    assert client.post("/api/scripts", json={"title": "x", "project_id": "nope"}).status_code == 404
    assert client.patch(f"/api/scripts/{s['id']}", json={"lines": [{"text": "x", "speed": 3}]}).status_code == 422
    assert client.delete(f"/api/scripts/{s['id']}").status_code == 204
    assert client.get(f"/api/scripts/{s['id']}").status_code == 404


def test_split_modes_and_auto_cast(client):
    s = make(client)
    s = split(client, s, DIALOGUE)
    who = names(s)
    assert [who[ln["speaker_id"]] for ln in s["lines"]] == ["Narrator", "Maya", "Tomas"]
    assert s["lines"][0]["speaker_id"] == "narrator"
    colors = [c["color"] for c in s["cast"]]
    assert len(set(colors)) == len(colors)

    # the same name gets the same colour in another script
    other = split(client, make(client), "Maya: Hello again.")
    assert next(c["color"] for c in other["cast"] if c["name"] == "Maya") == \
        next(c["color"] for c in s["cast"] if c["name"] == "Maya")
    # a known speaker is reused, not added twice
    s = split(client, s, "MAYA: Again. And again!")
    assert sum(c["name"] == "Maya" for c in s["cast"]) == 1
    assert [ln["text"] for ln in s["lines"][-2:]] == ["Again.", "And again!"]

    s = make(client)
    prose = "Mr. Khan walked in. He sat down.\nThe end came quickly.\n\nA new day. It was bright."
    s = split(client, s, prose, "sentences")
    assert [ln["text"] for ln in s["lines"]] == ["Mr. Khan walked in.", "He sat down.", "The end came quickly.",
                                                 "A new day.", "It was bright."]
    assert [ln["para"] for ln in s["lines"]] == [False, False, True, False, True]

    s = split(client, make(client), prose, "paragraphs")
    assert [ln["text"] for ln in s["lines"]] == ["Mr. Khan walked in. He sat down. The end came quickly.",
                                                 "A new day. It was bright."]
    s = split(client, make(client), prose, "lines")
    assert len(s["lines"]) == 3 and s["lines"][1]["para"] is True

    # a screenplay: cues become speakers, parentheticals the emotion, action the narrator
    s = split(client, make(client), "Rain on the roof.\n\nMAYA (V.O.)\n(quietly)\nWe should go.\n\nTOMAS\nNot yet.",
              "paragraphs")
    who = names(s)
    assert [(who[ln["speaker_id"]], ln["text"], ln["emotion"]) for ln in s["lines"]] == [
        ("Narrator", "Rain on the roof.", None), ("Maya", "We should go.", "quietly"), ("Tomas", "Not yet.", None)]

    # unattributed text goes to the chosen speaker
    s = split(client, make(client), "Maya: hi")
    maya = next(c["id"] for c in s["cast"] if c["name"] == "Maya")
    s = split(client, s, "Plain words here.", speaker_id=maya)
    assert s["lines"][-1]["speaker_id"] == maya


def test_import_from_a_project(client, project):
    scene = client.post(f"/api/projects/{project['id']}/scenes",
                        json={"heading": "EXT. BOAT DECK - DAWN", "script_text": SCRIPT}).json()
    client.post(f"/api/projects/{project['id']}/scenes", json={"heading": "INT. CABIN - NIGHT",
                                                               "script_text": "TOMAS\nSleep now."})
    s = make(client)
    r = client.post(f"/api/scripts/{s['id']}/import-project", json={"project_id": project["id"]})
    assert r.status_code == 200, r.text
    s = r.json()
    who = names(s)
    assert [(who[ln["speaker_id"]], ln["text"]) for ln in s["lines"]] == [
        ("Maya", "One more dive. Then we go home."), ("Tomas", "Sleep now.")]
    assert s["project_id"] == project["id"] and s["lines"][0]["para"] is True

    s = make(client)
    r = client.post(f"/api/scripts/{s['id']}/import-project",
                    json={"project_id": project["id"], "scene_ids": [scene["id"]], "include_action": True})
    s = r.json()
    who = names(s)
    assert [(who[ln["speaker_id"]], ln["text"]) for ln in s["lines"]] == [
        ("Narrator", "Maya checks her regulator on the deck."), ("Maya", "One more dive. Then we go home."),
        ("Narrator", "Tomas nods.")]
    assert client.post(f"/api/scripts/{s['id']}/import-project", json={"project_id": "x"}).status_code == 404


def test_render_fingerprints_and_staleness(client, fast_driver):
    s = split(client, make(client), DIALOGUE)
    assert statuses(s) == ["empty"] * 3
    out = render(client, s)
    assert out["queued"] == 3 and all(j["lane"] == "audio" for j in out["jobs"])
    s = get(client, s)
    assert statuses(s) == ["rendering"] * 3 and s["counts"]["rendering"] == 3
    # nothing is queued twice while it renders
    assert render(client, s)["queued"] == 0
    _run_all(fast_driver)
    s = get(client, s)
    assert statuses(s) == ["ready"] * 3
    assert all(ln["take_url"] and ln["duration_s"] for ln in s["lines"])
    assert abs(s["lines"][1]["duration_s"] - 2.0) < 0.05  # 5 words with the mock at 2.5 words/s

    with SessionLocal() as db:
        g = db.get(Generation, s["lines"][0]["take_id"])
        assert g.kind == "speech" and g.params["script"]["line_id"] == s["lines"][0]["id"]
        assert db.get(MediaItem, s["lines"][0]["take_media_id"] if "take_media_id" in s["lines"][0]
                      else g.target_id).tags == [dl.take_tag(s['id'])]

    lines = s["lines"]
    first_fp = lines[0]["fingerprint"]
    # whitespace alone doesn't change what a line sounds like
    lines[0]["text"] = "The rain   had not stopped for days. "
    s = patch(client, s, lines=lines)
    assert s["lines"][0]["fingerprint"] == first_fp and statuses(s) == ["ready"] * 3
    lines = s["lines"]
    lines[0]["text"] = "The rain had stopped."
    lines[2]["speed"] = 1.2
    s = patch(client, s, lines=lines)
    assert statuses(s) == ["stale", "ready", "stale"] and s["counts"]["stale"] == 2
    # a mix of the old takes is refused until everything is ready
    r = client.post(f"/api/scripts/{s['id']}/mix")
    assert r.status_code == 409 and "2 lines aren't ready" in r.json()["detail"]

    out = render(client, s)
    assert out["queued"] == 2
    _run_all(fast_driver)
    s = get(client, s)
    assert statuses(s) == ["ready"] * 3

    # a voice on the cast restales that speaker's lines only
    preset = client.post("/api/voices", json={"name": "Heart", "kind": "preset",
                                              "preset": {"engine": "kokoro", "id": "af_heart"}}).json()
    cast = s["cast"]
    maya = next(c for c in cast if c["name"] == "Maya")
    maya["voice_id"] = preset["id"]
    s = patch(client, s, cast=cast)
    assert statuses(s) == ["ready", "stale", "ready"]
    # an explicit list renders exactly those lines
    out = render(client, s, [s["lines"][0]["id"]])
    assert out["queued"] == 1
    _run_all(fast_driver)
    with SessionLocal() as db:
        assert db.get(Generation, get(client, s)["lines"][0]["take_id"]).params["engine"] == "omnivoice"


def test_unrenderable_line_fails_with_a_readable_error(client, tmp_path, fast_driver):
    v = clone(client, tmp_path, language="en").json()
    s = make(client, engine="kokoro")
    s = split(client, s, "Maya: hello there.")
    cast = s["cast"]
    cast[1]["voice_id"] = v["id"]
    s = patch(client, s, cast=cast)
    out = render(client, s)
    assert out["queued"] == 0 and out["failed"] == 1
    s = get(client, s)
    assert statuses(s) == ["failed"] and "Kokoro can't clone" in s["lines"][0]["error"]
    # fixing the cause clears the failure
    s = patch(client, s, engine="auto")
    assert statuses(s) == ["empty"]


def test_mix_respects_gaps_and_makes_versions(client, fast_driver):
    s = make(client)
    assert client.post(f"/api/scripts/{s['id']}/mix").status_code == 409  # nothing to mix
    s = split(client, s, "Maya: One two three four five.\nTomas: Six seven eight nine ten.\n\nMaya: Eleven twelve.")
    s = patch(client, s, settings={"gap_s": 0.5, "paragraph_gap_s": 1.5, "loudness": "none", "aerab": True})
    lines = s["lines"]
    lines[0]["pause_after_s"] = 1.0
    s = patch(client, s, lines=lines)
    render(client, s)
    _run_all(fast_driver)
    r = client.post(f"/api/scripts/{s['id']}/mix")
    assert r.status_code == 202, r.text
    assert r.json()["type"] == "script_mix" and r.json()["lane"] == "general"
    _run_all(fast_driver)
    s = get(client, s)
    mix = s["mix"]
    assert mix and mix["stale"] is False and s["mix_job"]["status"] == "done"
    takes = sum(ln["duration_s"] for ln in s["lines"])
    # 2 + 2 + 0.8 seconds of speech, a 1.0 s pause after line 1, then the paragraph gap after line 2
    with SessionLocal() as db:
        g = db.get(Generation, mix["generation_id"])
        dur = stream_info(get_settings().data_dir / g.file_path).duration
        item = db.get(MediaItem, mix["media_id"])
        assert item.kind == "audio" and item.generation_id == g.id and g.version == 1
    assert abs(dur - (takes + 1.0 + 1.5)) < 0.1

    # changing a gap makes the mix stale; the next mix is version 2 of the same item
    s = patch(client, s, settings={**s["settings"], "loudness": "podcast"})
    assert s["mix"]["stale"] is True
    client.post(f"/api/scripts/{s['id']}/mix")
    _run_all(fast_driver)
    s2 = get(client, s)
    assert s2["mix"]["media_id"] == mix["media_id"] and s2["mix"]["generation_id"] != mix["generation_id"]
    with SessionLocal() as db:
        g2 = db.get(Generation, s2["mix"]["generation_id"])
        assert g2.version == 2 and g2.parent_id == mix["generation_id"]
        dur2 = stream_info(get_settings().data_dir / g2.file_path).duration
    assert abs(dur2 - dur) < 0.15

    # the takes stay out of the Library; the mix is in it
    ids = {i["id"] for i in client.get("/api/media?kind=audio").json()["items"]}
    assert mix["media_id"] in ids and not ids & {ln["take_media_id"] for ln in s["lines"]}
    tagged = client.get(f"/api/media?kind=audio&tag={dl.take_tag(s['id'])}").json()["items"]
    assert len(tagged) == 3

    # deleting the script keeps the Library items
    client.delete(f"/api/scripts/{s['id']}")
    with SessionLocal() as db:
        assert db.get(MediaItem, mix["media_id"]) is not None


def test_stems_zip(client, fast_driver):
    s = split(client, make(client), DIALOGUE)
    assert client.post(f"/api/scripts/{s['id']}/stems").status_code == 409
    render(client, s)
    _run_all(fast_driver)
    r = client.post(f"/api/scripts/{s['id']}/stems")
    assert r.status_code == 202, r.text
    _run_all(fast_driver)
    s = get(client, s)
    assert s["stems_job"]["status"] == "done"
    with SessionLocal() as db:
        res = db.get(Job, s["stems_job"]["id"]).result
    assert [x["name"] for x in res["stems"]] == ["Narrator", "Maya", "Tomas"]
    raw = client.get(res["url"])
    assert raw.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(raw.content))
    assert z.namelist() == ["01-Narrator.wav", "02-Maya.wav", "03-Tomas.wav"]
    total = sum(ln["duration_s"] for ln in s["lines"]) + 2 * 0.35
    for n in z.namelist():
        p = get_settings().data_dir / f"stem-{n}"
        p.write_bytes(z.read(n))
        # every stem runs the whole timeline so they line up in a mixer
        assert abs(stream_info(p).duration - total) < 0.1


def test_urdu_lines_get_aerab(client, llm, fast_driver):
    fake = llm(lambda x: x.replace("دل", "دِل"))
    s = make(client, language="ur")
    s = split(client, s, f"{PLAIN}۔", "lines")
    render(client, s)
    _run_all(fast_driver)
    assert fake.calls == 1
    s = get(client, s)
    assert statuses(s) == ["ready"]
    with SessionLocal() as db:
        g = db.get(Generation, s["lines"][0]["take_id"])
        assert g.params["language"] == "ur" and g.params["text"] == f"{MARKED}۔"
        assert g.params["text_written"] == f"{PLAIN}۔"

    s = patch(client, s, settings={**s["settings"], "aerab": False})
    lines = s["lines"]
    lines[0]["text"] = f"{PLAIN} ہے۔"
    patch(client, s, lines=lines)
    render(client, s)
    _run_all(fast_driver)
    assert fake.calls == 1


@pytest.mark.parametrize("emotion,engine,key", [("angry", "chatterbox", "exaggeration"),
                                                 ("quietly", "omnivoice", "emotion")])
def test_emotion_reaches_the_engine(client, emotion, engine, key):
    s = make(client, engine=engine)
    s = split(client, s, "Hello there friend.")
    lines = s["lines"]
    lines[0]["emotion"] = emotion
    s = patch(client, s, lines=lines)
    render(client, s)
    with SessionLocal() as db:
        p = db.get(Generation, get(client, s)["lines"][0]["take_id"]).params
    assert key in p
