"""Voice studio B2 (contract v16): voices, consent, speak, design previews, transcripts and the venv runner."""
import ast
import py_compile
import sqlite3
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from app import speech, venv_runner, voices
from app.audio_analysis import stream_info
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import ComfyDriver
from app.drivers.mock import MockDriver
from app.lanes import lane_for
from app.models import Generation, Job, MediaItem, VoiceProfile
from app.worker import process_one
from tests.test_aerab import MARKED, PLAIN, llm  # noqa: F401  (llm is a fixture)
from tests.test_library import upload
from tests.test_migrations import _alembic
from tests.test_storyboard import _run_all

RUNNERS = Path(__file__).resolve().parents[1] / "runners"


def tone(path: Path, seconds: float, freq: int = 330) -> Path:
    subprocess.run([get_settings().ffmpeg_path(), "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                    f"sine=frequency={freq}:duration={seconds}", "-ac", "1", str(path)], check=True,
                   capture_output=True)
    return path


def ref_item(client, tmp_path, seconds=8.0, name="ref.wav") -> dict:
    p = tone(tmp_path / name, seconds)
    r = upload(client, p.name, p.read_bytes(), "audio/wav", title="Reference")
    assert r.status_code == 201, r.text
    return r.json()


def consent(name="Ayesha Khan", statement=voices.CONSENT):
    return {"name": name, "statement": statement}


def clone(client, tmp_path, seconds=8.0, **extra):
    item = ref_item(client, tmp_path, seconds)
    body = {"name": "Ayesha", "language": "ur", "kind": "clone", "ref_media_id": item["id"],
            "ref_text": "ref words", "consent": consent(), **extra}
    return client.post("/api/voices", json=body)


def speak(client, **body):
    body.setdefault("text", "Hello there, this is a short line.")
    return client.post("/api/audio/speak", json=body)


# ------------------------------------------------------------------ schema

def test_0013_adds_voice_profile(tmp_path):
    db = tmp_path / "prod-copy.db"
    _alembic(db, "upgrade", "0013")
    con = sqlite3.connect(db)
    cols = {r[1] for r in con.execute("PRAGMA table_info(voice_profile)")}
    assert {"id", "workspace_id", "name", "kind", "language", "ref_media_id", "ref_generation_id", "ref_text",
            "design", "preset", "consent", "uses", "starred", "locked", "created_at", "updated_at"} <= cols
    idx = {r[1] for r in con.execute("PRAGMA index_list(voice_profile)")}
    assert "ix_voice_profile_ws_created" in idx
    con.close()
    _alembic(db, "downgrade", "0012")
    con = sqlite3.connect(db)
    assert "voice_profile" not in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    _alembic(db, "upgrade", "head")


def test_transcribe_job_goes_to_the_audio_lane():
    assert lane_for("voice_transcribe") == "audio"
    assert lane_for("generate", "speech") == "audio"


# ------------------------------------------------------------------ engines

def test_engines_endpoint(client):
    r = client.get("/api/voices/engines")
    assert r.status_code == 200
    rows = {e["id"]: e for e in r.json()}
    assert list(rows) == ["omnivoice", "voxcpm", "chatterbox", "kokoro"]
    codes = {e: {lang["code"] for lang in rows[e]["languages"]} for e in rows}
    assert {"ur", "pa", "sd", "ps", "hi", "en"} <= codes["omnivoice"] and len(codes["omnivoice"]) >= 50
    assert len(codes["voxcpm"]) == 30 and "ur" not in codes["voxcpm"] and "hi" in codes["voxcpm"]
    assert len(codes["chatterbox"]) == 23 and "ur" not in codes["chatterbox"]
    assert rows["omnivoice"]["features"] == ["clone", "design", "tags"] and "ur" in rows["omnivoice"]["default_for"]
    assert "Perth" in rows["chatterbox"]["licence"]
    presets = {p["id"]: p for p in rows["kokoro"]["presets"]}
    assert presets["af_heart"]["language"] == "en" and presets["hm_omega"]["language"] == "hi"
    assert "presets" not in rows["omnivoice"]


# ------------------------------------------------------------------ the library

def test_clone_needs_the_exact_consent(client, tmp_path):
    item = ref_item(client, tmp_path)
    base = {"name": "Ayesha", "language": "ur", "kind": "clone", "ref_media_id": item["id"]}
    assert client.post("/api/voices", json=base).status_code == 422
    r = client.post("/api/voices", json={**base, "consent": consent(statement="sure, fine")})
    assert r.status_code == 422 and "exactly" in r.json()["detail"]
    assert client.post("/api/voices", json={**base, "consent": consent(name="  ")}).status_code == 422
    assert client.post("/api/voices", json={**base, "consent": consent()} | {"ref_media_id": None}).status_code == 422

    r = client.post("/api/voices", json={**base, "consent": consent()})
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["consent"]["name"] == "Ayesha Khan" and v["consent"]["statement"] == voices.CONSENT
    assert v["consent"]["at"] and v["consent"]["user_id"]
    assert v["ref"]["media_id"] == item["id"] and v["ref"]["generation_id"] == item["generation_id"]
    assert v["ref"]["url"].startswith("/api/media/") and abs(v["ref"]["duration_s"] - 8.0) < 0.1
    assert v["warnings"] == [] and v["uses"] == 0 and v["kind"] == "clone"


@pytest.mark.parametrize("seconds,status,warnings", [
    (2.0, 422, None), (4.0, 201, ["short"]), (10.0, 201, []), (20.0, 201, ["long"]), (35.0, 422, None),
])
def test_reference_clip_length(client, tmp_path, seconds, status, warnings):
    r = clone(client, tmp_path, seconds)
    assert r.status_code == status, r.text
    if warnings is not None:
        assert r.json()["warnings"] == warnings
    else:
        assert "3 to 30 seconds" in r.json()["detail"]


def test_reference_must_be_a_finished_audio_item_of_the_workspace(client, tmp_path):
    from tests.test_library import png_bytes

    pic = upload(client, "p.png", png_bytes(), "image/png").json()
    body = {"name": "X", "kind": "clone", "ref_media_id": pic["id"], "consent": consent()}
    assert client.post("/api/voices", json=body).status_code == 422
    assert client.post("/api/voices", json={**body, "ref_media_id": "nope"}).status_code == 404


def test_design_and_preset_voices(client):
    r = client.post("/api/voices", json={"name": "Narrator", "kind": "design",
                                         "design": {"description": "warm elderly Lahori narrator, slow"}})
    assert r.status_code == 201, r.text
    d = r.json()["design"]
    assert d["engine"] == "omnivoice" and isinstance(d["seed"], int)
    assert client.post("/api/voices", json={"name": "N", "kind": "design"}).status_code == 422
    r = client.post("/api/voices", json={"name": "N", "kind": "design",
                                         "design": {"description": "x", "engine": "kokoro"}})
    assert r.status_code == 422 and "Kokoro can't design" in r.json()["detail"]

    r = client.post("/api/voices", json={"name": "Omega", "kind": "preset", "language": "en",
                                         "preset": {"engine": "kokoro", "id": "hm_omega"}})
    assert r.status_code == 201 and r.json()["language"] == "hi" and r.json()["preset"]["id"] == "hm_omega"
    r = client.post("/api/voices", json={"name": "?", "kind": "preset", "preset": {"engine": "kokoro", "id": "zz"}})
    assert r.status_code == 422


def test_crud_filters_and_delete_keeps_the_clip(client, tmp_path):
    a = clone(client, tmp_path).json()
    b = client.post("/api/voices", json={"name": "Radio host", "kind": "design", "language": "en", "starred": True,
                                         "notes": "late night show", "design": {"description": "smooth"}}).json()
    names = lambda **q: [v["name"] for v in client.get("/api/voices", params=q).json()]  # noqa: E731
    assert names() == ["Radio host", "Ayesha"]  # newest first
    assert names(q="night") == ["Radio host"] and names(language="ur") == ["Ayesha"]
    assert names(kind="clone") == ["Ayesha"] and names(starred=True) == ["Radio host"]

    r = client.patch(f"/api/voices/{a['id']}", json={"name": "Ayesha (calm)", "notes": "n", "gender_hint": "female",
                                                    "starred": True})
    assert r.status_code == 200 and r.json()["name"] == "Ayesha (calm)" and r.json()["gender_hint"] == "female"
    assert client.get(f"/api/voices/{a['id']}").json()["starred"] is True

    assert client.delete(f"/api/voices/{a['id']}").status_code == 204
    assert client.get(f"/api/voices/{a['id']}").status_code == 404
    with SessionLocal() as db:
        assert db.get(MediaItem, a["ref"]["media_id"]) is not None
    assert client.delete(f"/api/voices/{b['id']}").status_code == 204


def test_locked_voice_keeps_its_ref_and_design(client, tmp_path):
    v = clone(client, tmp_path, locked=True).json()
    other = ref_item(client, tmp_path, 6.0, "other.wav")
    r = client.patch(f"/api/voices/{v['id']}", json={"ref_media_id": other["id"]})
    assert r.status_code == 409 and "locked" in r.json()["detail"]
    assert client.patch(f"/api/voices/{v['id']}", json={"kind": "design", "design": {"description": "x"}}
                        ).status_code == 409
    # same ref again isn't a change; names and notes are fine
    assert client.patch(f"/api/voices/{v['id']}", json={"ref_media_id": v["ref"]["media_id"], "name": "A"}
                        ).status_code == 200
    r = client.patch(f"/api/voices/{v['id']}", json={"locked": False, "ref_media_id": other["id"]})
    assert r.status_code == 200 and r.json()["ref"]["media_id"] == other["id"] and not r.json()["locked"]

    d = client.post("/api/voices", json={"name": "D", "kind": "design", "locked": True,
                                         "design": {"description": "deep", "seed": 7}}).json()
    assert client.patch(f"/api/voices/{d['id']}", json={"design": {"description": "bright"}}).status_code == 409
    assert client.patch(f"/api/voices/{d['id']}", json={"design": {"description": "deep"}}).status_code == 200


def test_switching_to_clone_needs_consent(client, tmp_path):
    d = client.post("/api/voices", json={"name": "D", "kind": "design", "design": {"description": "deep"}}).json()
    item = ref_item(client, tmp_path)
    assert client.patch(f"/api/voices/{d['id']}", json={"kind": "clone", "ref_media_id": item["id"]}
                        ).status_code == 422
    r = client.patch(f"/api/voices/{d['id']}", json={"kind": "clone", "ref_media_id": item["id"],
                                                    "consent": consent()})
    assert r.status_code == 200 and r.json()["kind"] == "clone"


# ------------------------------------------------------------------ tags

def test_tags_kept_for_omnivoice_stripped_for_the_rest():
    text = "[pause 1s] Hello [laughter] there. [pause 0.5s][pause 0.25s] [whisper] Quiet now [sigh] [pause] "
    omni = voices.segments(text, voices.ENGINES["omnivoice"])
    assert omni == [("text", "Hello [laughter] there."), ("pause", 0.75), ("text", "Quiet now [sigh]")]
    kokoro = voices.segments(text, voices.ENGINES["kokoro"])
    assert kokoro == [("text", "Hello there."), ("pause", 0.75), ("text", "Quiet now")]
    assert voices.spoken_text(text, voices.ENGINES["kokoro"]) == "Hello there. [pause 0.75s] Quiet now"
    assert voices.segments("[pause 99s] a [pause 99s] b", voices.ENGINES["kokoro"])[1] == ("pause", 10.0)
    assert voices.segments("[laughter]", voices.ENGINES["kokoro"]) == []


# ------------------------------------------------------------------ speak

def test_speak_default_engine_with_the_mock(client, fast_driver):
    r = speak(client, text="One two three four five [pause 1s] six seven eight nine ten.", language="en")
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["engine_resolved"] == "omnivoice" and len(body["items"]) == 1
    assert body["items"][0]["kind"] == "audio" and body["jobs"][0]["lane"] == "audio"
    _run_all(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, body["items"][0]["generation_id"])
        assert g.kind == "speech" and g.status == "ready" and g.media_type == "audio/flac"
        p = g.params
        assert p["engine"] == "omnivoice" and p["language"] == "en" and p["voice_id"] is None
        assert p["text_spoken"] == "One two three four five [pause 1s] six seven eight nine ten."
        # 10 words / 2.5 + the pause
        assert abs(stream_info(get_settings().data_dir / g.file_path).duration - 5.0) < 0.1
        item = db.get(MediaItem, body["items"][0]["id"])
        assert abs(item.duration_s - 5.0) < 0.1


def test_speak_with_voices_and_engines(client, tmp_path, fast_driver):
    v = clone(client, tmp_path).json()
    preset = client.post("/api/voices", json={"name": "Heart", "kind": "preset",
                                              "preset": {"engine": "kokoro", "id": "af_heart"}}).json()
    r = speak(client, voice_id=preset["id"], text="Hi [laughter] there", count=2, seed=10)
    assert r.status_code == 202, r.text
    assert r.json()["engine_resolved"] == "kokoro" and len(r.json()["items"]) == 2
    with SessionLocal() as db:
        gens = [db.get(Generation, i["generation_id"]) for i in r.json()["items"]]
        assert [g.seed for g in gens] == [10, 11]
        assert gens[0].params["text_spoken"] == "Hi there" and gens[0].params["voice"]["preset"] == "af_heart"
        assert db.get(VoiceProfile, preset["id"]).uses == 2

    r = speak(client, voice_id=v["id"], engine="chatterbox", language="en", exaggeration=1.2)
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        p = db.get(Generation, r.json()["items"][0]["generation_id"]).params
        assert p["voice"]["ref_file"] and p["voice"]["ref_text"] == "ref words" and p["exaggeration"] == 1.2

    r = speak(client, voice_id=v["id"], engine="chatterbox")  # the voice's language: Urdu
    assert r.status_code == 422 and r.json()["detail"] == "Chatterbox doesn't speak Urdu. Use OmniVoice."
    r = speak(client, engine="voxcpm", language="ur")
    assert r.status_code == 422 and r.json()["detail"] == "VoxCPM2 doesn't speak Urdu. Use OmniVoice."
    r = speak(client, voice_id=v["id"], engine="kokoro", language="en")
    assert r.status_code == 422 and "Kokoro can't clone" in r.json()["detail"]
    r = speak(client, voice_id=preset["id"], engine="omnivoice")
    assert r.status_code == 422
    r = speak(client, voice_id=preset["id"], language="hi")
    assert r.status_code == 422 and "speaks English" in r.json()["detail"]
    assert speak(client, voice_id="missing").status_code == 422
    assert speak(client, engine="espeak").status_code == 422
    assert speak(client, text="[pause 1s] [sigh]", engine="kokoro").status_code == 422
    assert speak(client, speed=3).status_code == 422 and speak(client, count=5).status_code == 422
    assert speak(client, text="یہ اردو ہے", language="ur").status_code == 202  # OmniVoice speaks Urdu
    _run_all(fast_driver)


def test_urdu_speech_gets_aerab(client, llm, fast_driver):
    fake = llm(lambda x: x.replace("دل", "دِل"))
    r = speak(client, text=f"{PLAIN} [pause 0.5s] [sigh]", language="ur")
    assert r.status_code == 202, r.text
    _run_all(fast_driver)
    assert fake.calls == 1
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["items"][0]["generation_id"])
        assert g.status == "ready"
        assert g.params["text"] == f"{MARKED} [pause 0.5s] [sigh]"
        assert g.params["text_written"] == f"{PLAIN} [pause 0.5s] [sigh]"
        assert g.params["text_spoken"] == f"{MARKED} [pause 0.5s] [sigh]"

    off = speak(client, text=PLAIN, language="ur", aerab=False)
    _run_all(fast_driver)
    assert fake.calls == 1
    with SessionLocal() as db:
        assert "text_written" not in db.get(Generation, off.json()["items"][0]["generation_id"]).params


def test_design_preview_returns_its_seed(client, fast_driver):
    r = client.post("/api/voices/design/preview", json={"description": "deep radio voice", "language": "ur"})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["engine_resolved"] == "omnivoice" and isinstance(body["seed"], int) and len(body["items"]) == 1
    with SessionLocal() as db:
        g = db.get(Generation, body["items"][0]["generation_id"])
        assert g.seed == body["seed"] and g.params["voice"]["design"]["seed"] == body["seed"]
        assert g.params["text"] == voices.PANGRAMS["ur"]
    r = client.post("/api/voices/design/preview", json={"description": "bright", "seed": 1234, "engine": "voxcpm",
                                                         "text": "Hello."})
    assert r.json()["seed"] == 1234 and r.json()["engine_resolved"] == "voxcpm"
    r = client.post("/api/voices/design/preview", json={"description": "x", "engine": "chatterbox"})
    assert r.status_code == 422
    # save as voice keeps the identity
    saved = client.post("/api/voices", json={"name": "Bright", "kind": "design", "language": "en",
                                             "design": {"description": "bright", "seed": 1234, "engine": "voxcpm"}})
    r = speak(client, voice_id=saved.json()["id"])
    assert r.json()["engine_resolved"] == "voxcpm" and r.json()["seed"] == 1234
    _run_all(fast_driver)


def test_speech_estimate(client):
    r = client.get("/api/estimate", params={"kind": "speech", "chars": 150, "count": 2})
    assert r.status_code == 200, r.text
    e = r.json()
    assert e["basis"] == "rough" and e["model"] == "omnivoice" and e["load_s"] == 20
    assert e["low_s"] < e["high_s"] and 30 <= e["high_s"] <= 60
    assert client.get("/api/estimate", params={"kind": "speech", "model": "nope"}).status_code == 422


# ------------------------------------------------------------------ the backend side of the runners

def fake_runner(calls, seconds=1.0):
    def run(runner, venv, job, *, lane=None, progress=None, need_gb=0.0, **kw):
        calls.append({"runner": runner, "venv": venv, "job": job, "lane": lane, "need_gb": need_gb,
                      "ref_exists": bool(job.get("ref_audio")) and Path(job["ref_audio"]).is_file()})
        for n, seg in enumerate(job.get("segments") or []):
            tone(Path(seg["out"]), seconds, 300 + 50 * n)
        if progress:
            progress(0.5, "half")
        return {"segments": [{"out": s["out"]} for s in job.get("segments") or []]}
    return run


def test_synthesise_joins_pieces_with_silence_and_fits_lengths(tmp_path):
    calls = []
    out = tmp_path / "a.flac"
    seen = []
    params = {"engine": "kokoro", "text": "One [pause 0.5s] two [laughter]", "voice": {"preset": "af_heart"},
              "language": "en", "speed": 1.0}
    res = speech.synthesise(params, 5, out, lambda f, m: seen.append(f), run=fake_runner(calls))
    assert [s["text"] for s in calls[0]["job"]["segments"]] == ["One", "two"]
    assert calls[0]["runner"] == "tts_kokoro" and calls[0]["venv"] == "tts-kokoro" and calls[0]["need_gb"] == 1.0
    assert abs(res.meta["duration_s"] - 2.5) < 0.05 and res.media_type == "audio/flac"
    assert res.params_update["text_spoken"] == "One [pause 0.5s] two" and seen[-1] == 1.0
    assert not any(p.name.startswith(".") for p in tmp_path.iterdir())  # the work folder is gone

    # Chatterbox has no speed knob: atempo does it
    res = speech.synthesise({"engine": "chatterbox", "text": "Hi", "speed": 2.0}, 1, tmp_path / "b.flac",
                            lambda f, m: None, run=fake_runner(calls, 2.0))
    assert "speed" not in calls[-1]["job"] and abs(res.meta["duration_s"] - 1.0) < 0.05
    # Kokoro has one, so the engine gets it and nothing is stretched
    speech.synthesise({"engine": "kokoro", "text": "Hi", "speed": 1.5}, 1, tmp_path / "c.flac",
                      lambda f, m: None, run=fake_runner(calls))
    assert calls[-1]["job"]["speed"] == 1.5
    # a fixed length is exact whatever the engine returned; OmniVoice is also told it when there's one piece
    res = speech.synthesise({"engine": "omnivoice", "text": "Hi there", "duration_s": 3.0}, 1, tmp_path / "d.flac",
                            lambda f, m: None, run=fake_runner(calls, 2.0))
    assert calls[-1]["job"]["duration"] == 3.0 and abs(stream_info(tmp_path / "d.flac").duration - 3.0) < 0.03
    res = speech.synthesise({"engine": "omnivoice", "text": "a [pause 1s] b", "duration_s": 1.5}, 1,
                            tmp_path / "e.flac", lambda f, m: None, run=fake_runner(calls))
    assert "duration" not in calls[-1]["job"] and abs(res.meta["duration_s"] - 1.5) < 0.03


def test_comfy_driver_speaks_a_cloned_voice_through_the_runner(client, tmp_path, monkeypatch):
    v = clone(client, tmp_path).json()
    calls = []
    monkeypatch.setattr(venv_runner, "run", fake_runner(calls))
    r = speak(client, voice_id=v["id"], text="آج [pause 0.5s] کل", aerab=False, steps=20, guidance=2.5)
    assert r.status_code == 202, r.text
    while process_one(driver_factory=lambda: ComfyDriver(lane="video")):
        pass
    c = calls[0]
    assert c["runner"] == "tts_omnivoice" and c["lane"] == "video" and c["ref_exists"]
    assert c["job"]["ref_text"] == "ref words" and c["job"]["language"] == "ur" and c["job"]["steps"] == 20
    assert c["job"]["guidance"] == 2.5 and len(c["job"]["segments"]) == 2
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["items"][0]["generation_id"])
        assert g.status == "ready" and g.file_path.endswith(".flac")
        assert g.params["speech"]["natural_s"] == pytest.approx(2.5, abs=0.05)


def test_transcribe_with_the_mock_and_with_the_runner(client, tmp_path, monkeypatch, fast_driver):
    v = clone(client, tmp_path, ref_text="").json()
    r = client.post(f"/api/voices/{v['id']}/transcribe")
    assert r.status_code == 202, r.text
    assert r.json()["type"] == "voice_transcribe" and r.json()["lane"] == "audio"
    _run_all(fast_driver)
    assert client.get(f"/api/voices/{v['id']}").json()["ref_text"].startswith("This is a mock transcript")

    calls = []

    def run(runner, venv, job, *, lane=None, progress=None, need_gb=0.0, **kw):
        calls.append((runner, venv, job, lane, need_gb, Path(job["audio"]).is_file()))
        progress(0.5, "Transcribing")
        return {"text": " آج موسم اچھا ہے ", "language": "ur",
                "segments": [{"start": 0.0, "end": 1.2, "text": "آج موسم اچھا ہے", "words": []}]}

    monkeypatch.setattr(venv_runner, "run", run)
    job_id = client.post(f"/api/voices/{v['id']}/transcribe").json()["id"]
    while process_one(driver_factory=lambda: ComfyDriver(lane="image")):
        pass
    assert calls[0][:2] == ("stt_whisper", "stt-whisperx") and calls[0][2]["language"] == "ur"
    assert calls[0][4] == 5.0 and calls[0][5]
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job.status == "done" and job.result["segments"][0]["end"] == 1.2
    assert client.get(f"/api/voices/{v['id']}").json()["ref_text"] == "آج موسم اچھا ہے"

    d = client.post("/api/voices", json={"name": "D", "kind": "design", "design": {"description": "x"}}).json()
    assert client.post(f"/api/voices/{d['id']}/transcribe").status_code == 422


def test_mock_speech_length_follows_the_words(tmp_path):
    d = MockDriver(step_seconds=0)
    res = d.generate_audio("", {"kind": "speech", "engine": "omnivoice", "text": " ".join(["word"] * 10),
                                "speed": 2.0}, 1, tmp_path / "s.flac", lambda f, m: None)
    assert abs(res.meta["duration_s"] - 2.0) < 0.01
    res = d.generate_audio("", {"kind": "speech", "text": "a b", "duration_s": 4}, 1, tmp_path / "t.flac",
                           lambda f, m: None)
    assert abs(stream_info(tmp_path / "t.flac").duration - 4.0) < 0.05


# ------------------------------------------------------------------ venv_runner

@pytest.fixture
def runners(tmp_path, monkeypatch):
    folder = tmp_path / "runners"
    folder.mkdir()
    monkeypatch.setattr(venv_runner, "RUNNERS_DIR", folder)

    def make(name, body):
        (folder / f"{name}.py").write_text(textwrap.dedent(body), encoding="utf-8")
        return name
    return make


def test_runner_protocol_progress_and_env(runners):
    name = runners("ok", """
        import json, os, sys
        job = json.load(sys.stdin)
        print("some banner a library printed")
        print(json.dumps({"progress": 0.25, "message": "loading"}), flush=True)
        print("not json {", flush=True)
        print(json.dumps({"progress": 2, "message": ""}), flush=True)
        sys.stderr.write("warming up\\n")
        print(json.dumps({"done": {"echo": job["x"], "cuda": os.environ.get("CUDA_VISIBLE_DEVICES")}}))
    """)
    seen = []
    res = venv_runner.run(name, "any", {"x": "سلام"}, lane="video", progress=lambda f, m: seen.append((f, m)),
                          python=sys.executable)
    assert res == {"echo": "سلام", "cuda": "1"}
    assert seen == [(0.25, "loading"), (1.0, "")]
    assert venv_runner.run(name, "any", {"x": 1}, lane="image", python=sys.executable)["cuda"] == "0"


def test_runner_errors_and_exit_codes(runners):
    err = runners("err", """
        import json, sys
        sys.stderr.write("Traceback: CUDA out of memory\\n")
        print(json.dumps({"error": "RuntimeError: no GPU"}))
        sys.exit(1)
    """)
    with pytest.raises(venv_runner.RunnerError, match="no GPU") as e:
        venv_runner.run(err, "any", {}, python=sys.executable)
    assert "out of memory" in str(e.value)
    crash = runners("crash", """
        import sys
        sys.stderr.write("ImportError: No module named omnivoice\\n")
        sys.exit(3)
    """)
    with pytest.raises(venv_runner.RunnerError, match="code 3") as e:
        venv_runner.run(crash, "any", {}, python=sys.executable)
    assert "omnivoice" in str(e.value)


def test_runner_timeout_and_cancel(runners):
    slow = runners("slow", """
        import json, sys, time
        print(json.dumps({"progress": 0.1, "message": "x"}), flush=True)
        time.sleep(30)
    """)
    with pytest.raises(venv_runner.RunnerError, match="longer than"):
        venv_runner.run(slow, "any", {}, timeout=1.5, python=sys.executable)

    class Cancelled(Exception):
        pass

    def cancel(f, m):
        raise Cancelled()

    with pytest.raises(Cancelled):
        venv_runner.run(slow, "any", {}, progress=cancel, python=sys.executable)


def test_missing_venv_is_a_readable_error(monkeypatch, tmp_path):
    monkeypatch.setattr(get_settings(), "audio_venvs_dir", str(tmp_path))
    monkeypatch.setattr(venv_runner, "ensure_vram", lambda *a, **k: pytest.fail("checked VRAM first"))
    with pytest.raises(venv_runner.RunnerError, match="tts-omnivoice venv isn't installed"):
        venv_runner.run("tts_omnivoice", "tts-omnivoice", {})


def test_low_vram_asks_comfy_to_free_memory(monkeypatch):
    posts, queries = [], []

    def fake_smi(cmd, **kw):
        queries.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout=f"{free}\n", stderr="")

    monkeypatch.setattr(venv_runner.subprocess, "run", fake_smi)
    monkeypatch.setattr(venv_runner.httpx, "post", lambda url, **kw: posts.append((url, kw["json"])))
    monkeypatch.setattr(get_settings(), "comfy_video_urls", ["http://gpu1:8189"])
    monkeypatch.setattr(get_settings(), "comfy_image_urls", ["http://gpu0:8188"])

    free = 3000
    venv_runner.ensure_vram("video", 6.0)
    assert queries[-1][-1] == "1" and "memory.free" in queries[-1][1]
    assert posts == [("http://gpu1:8189/free", {"unload_models": True, "free_memory": True})]
    free = 20000
    venv_runner.ensure_vram("image", 6.0)
    assert queries[-1][-1] == "0" and len(posts) == 1

    free = 100

    def boom(url, **kw):
        raise venv_runner.httpx.ConnectError("down")

    monkeypatch.setattr(venv_runner.httpx, "post", boom)
    venv_runner.ensure_vram("image", 1.0)  # tolerated

    def no_smi(cmd, **kw):
        raise FileNotFoundError("nvidia-smi")

    monkeypatch.setattr(venv_runner.subprocess, "run", no_smi)
    venv_runner.ensure_vram("image", 8.0)


# ------------------------------------------------------------------ runner scripts

@pytest.mark.parametrize("name", ["runner_io", "tts_omnivoice", "tts_voxcpm", "tts_chatterbox", "tts_kokoro",
                                  "stt_whisper"])
def test_runner_scripts_compile_and_stay_out_of_the_app(name, tmp_path):
    path = RUNNERS / f"{name}.py"
    py_compile.compile(str(path), cfile=str(tmp_path / f"{name}.pyc"), doraise=True)
    tree = ast.parse(path.read_text(encoding="utf-8"))
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            mods.add((node.module or "").split(".")[0])
    # they run inside the engine venvs, where the app (and its deps) aren't installed
    assert not mods & {"app", "fastapi", "sqlalchemy", "httpx", "pydantic"}, mods
    allowed = {"json", "os", "random", "sys", "traceback", "numpy", "soundfile", "torch", "runner_io", "omnivoice",
               "voxcpm", "chatterbox", "kokoro", "faster_whisper"}
    assert mods <= allowed, mods - allowed


def test_runner_io_protocol_with_the_real_helper(tmp_path):
    script = tmp_path / "echo.py"
    script.write_text(textwrap.dedent(f"""
        import sys
        sys.path.insert(0, {str(RUNNERS)!r})
        import runner_io as rio
        def run(job):
            print("library chatter")  # goes to stderr, not the protocol
            rio.progress(0.5, "half")
            return {{"got": job["a"]}}
        rio.main(run)
    """), encoding="utf-8")
    r = subprocess.run([sys.executable, str(script)], input='{"a": 3}', capture_output=True, text=True, timeout=30)
    assert r.stdout.splitlines() == ['{"progress": 0.5, "message": "half"}', '{"done": {"got": 3}}']
    assert "library chatter" in r.stderr
