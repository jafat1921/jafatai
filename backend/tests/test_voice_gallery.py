"""Voice Gallery C1 (contract v19): the catalogue, browsing, samples, adding, and gallery:<id> voices."""
import json
from pathlib import Path

import pytest

from app import manage, voice_gallery as vg, voices
from app.audio_analysis import stream_info
from app.db import SessionLocal
from app.lanes import lane_for
from app.models import Generation, Job, VoiceProfile
from tests.test_dialogue import make, patch, render, split
from tests.test_storyboard import _run_all
from tests.test_voices import fake_runner, speak


def gallery(client, **params):
    r = client.get("/api/voices/gallery", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def facet(body, name):
    return {f["value"]: f["count"] for f in body["facets"][name]}


# ------------------------------------------------------------------ the catalogue

def test_catalogue_is_valid():
    rows = vg.raw()
    assert vg.problems(rows) == []
    ids = [v["id"] for v in rows]
    assert len(ids) == len(set(ids))
    by_engine = {}
    for v in rows:
        by_engine.setdefault(v["engine"], []).append(v)
    assert len(by_engine["omnivoice"]) >= 55 and len(by_engine["kokoro"]) == 54 and by_engine["voxcpm"]
    seeds = [v["seed"] for v in rows if v["engine"] != "kokoro"]
    assert len(seeds) == len(set(seeds))  # two designed voices on one seed would be near twins
    urdu = [v for v in by_engine["omnivoice"] if "ur" in v["languages"]]
    assert len(urdu) >= 16
    # every sample line language is covered for the catalogue's main languages
    assert {v["languages"][0] for v in rows} <= set(vg.SAMPLE_LINES)


def test_problems_catches_bad_entries():
    good = {"id": "x", "name": "X", "languages": ["en"], "gender": "male", "age": "adult", "styles": ["calm"],
            "engine": "omnivoice", "instruct": "male", "seed": 1}
    assert vg.problems([good]) == []
    bad = vg.problems([good, {**good, "seed": None}, {**good, "id": "y", "engine": "espeak"},
                       {**good, "id": "z", "engine": "voxcpm", "languages": ["ur"]},
                       {**good, "id": "k", "engine": "kokoro", "languages": ["en"], "preset": None},
                       {**good, "id": "s", "styles": ["sparkly"], "age": "ancient"}])
    text = " | ".join(bad)
    for want in ("x: duplicate id", "instruct and an int seed", "unknown engine 'espeak'", "VoxCPM2 doesn't speak ur",
                 "k: a Kokoro voice needs its preset id", "style 'sparkly'", "age 'ancient'"):
        assert want in text, want


def test_kokoro_presets_come_from_the_catalogue(client):
    assert len(voices.KOKORO_PRESETS) == 54
    assert voices.kokoro_preset("bf_emma").language == "en" and voices.kokoro_preset("hm_psi").language == "hi"
    kokoro = next(e for e in client.get("/api/voices/engines").json() if e["id"] == "kokoro")
    assert {p["id"] for p in kokoro["presets"]} >= {"af_heart", "zm_yunyang", "pm_santa", "jf_gongitsune"}


# ------------------------------------------------------------------ browsing

def test_filters_and_facets(client):
    everything = gallery(client)
    assert everything["total"] == len(vg.raw()) == len(everything["items"])
    first = everything["items"][0]
    assert first["voice_id"] == f"gallery:{first['id']}" and first["sample_url"].endswith(f"/{first['id']}/sample")
    assert first["sample_ready"] is False and first["added_voice_id"] is None and first["starred"] is False
    assert first["kind"] == "design" and first["instruct"] and isinstance(first["seed"], int)
    heart = next(v for v in everything["items"] if v["id"] == "af_heart")
    assert heart["kind"] == "preset" and heart["preset"] == "af_heart" and "instruct" not in heart

    ur = gallery(client, language="ur")
    assert ur["total"] >= 16 and all("ur" in v["languages"] for v in ur["items"])
    # the language facet ignores its own filter, the others follow it
    assert facet(ur, "language") == facet(everything, "language")
    assert facet(ur, "engine") == {"omnivoice": ur["total"]}
    langs = everything["facets"]["language"]
    assert langs[0]["count"] >= langs[-1]["count"] and any(f["label"] == "Urdu" for f in langs)

    elders = gallery(client, language="ur", gender="female", age="elder")
    assert [v["id"] for v in elders["items"]] == ["ur-dadi"]
    assert gallery(client, style="poetry", engine="omnivoice")["total"] >= 3
    assert gallery(client, q="lahore")["items"][0]["id"] == "ur-lahore-narrator"
    assert gallery(client, q="urdu news")["total"] >= 2  # every word has to match, in any field
    assert gallery(client, q="nothing like this")["total"] == 0
    assert gallery(client, engine="kokoro", language="hi")["total"] == 4


# ------------------------------------------------------------------ samples

def test_sample_queues_once_then_serves_the_cached_file(client, fast_driver):
    assert client.get("/api/voices/gallery/nope/sample").status_code == 404
    r = client.get("/api/voices/gallery/am_michael/sample")
    assert r.status_code == 202, r.text
    job = r.json()["job"]
    assert r.json()["status"] == "preparing" and job["type"] == "voice_sample" and job["lane"] == "audio"
    again = client.get("/api/voices/gallery/am_michael/sample")
    assert again.status_code == 202 and again.json()["job"]["id"] == job["id"]
    with SessionLocal() as db:
        assert db.query(Job).filter(Job.type == "voice_sample").count() == 1

    _run_all(fast_driver)
    with SessionLocal() as db:
        assert db.get(Job, job["id"]).status == "done"
    r = client.get("/api/voices/gallery/am_michael/sample")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and len(r.content) > 1000
    assert stream_info(vg.sample_path("am_michael")).duration > 1.0
    assert next(v for v in gallery(client)["items"] if v["id"] == "am_michael")["sample_ready"] is True


def test_sample_job_type_runs_on_the_audio_lane():
    assert lane_for(vg.SAMPLE_JOB) == "audio"


def test_manage_renders_samples_in_one_runner_call_per_engine(monkeypatch, capsys):
    calls = []
    only = ["ur-dadi", "en-uk-news", "vx-en-narrator", "af_heart", "bm_george", "hf_alpha"]
    assert manage.voice_samples(["--only", ",".join(only)], run=fake_runner(calls)) == 0
    assert "6 made, 0 failed" in capsys.readouterr().out
    assert all(vg.sample_path(i).is_file() for i in only)
    # OmniVoice once, VoxCPM once, Kokoro once per language
    assert sorted(c["runner"] for c in calls) == ["tts_kokoro", "tts_kokoro", "tts_omnivoice", "tts_voxcpm"]
    omni = next(c["job"] for c in calls if c["runner"] == "tts_omnivoice")
    assert omni["per_segment"] is True and len(omni["segments"]) == 2
    dadi = omni["segments"][0]
    assert dadi["instruct"] == vg.get("ur-dadi")["instruct"] and dadi["seed"] == vg.get("ur-dadi")["seed"]
    assert dadi["language"] == "ur" and omni["segments"][1]["language"] == "en"
    en = next(c["job"] for c in calls if c["runner"] == "tts_kokoro" and c["job"]["language"] == "en")
    assert [s["voice"] for s in en["segments"]] == ["af_heart", "bm_george"]

    # cached ones are skipped; --force renders again; one engine alone
    calls.clear()
    assert manage.voice_samples(["--only", ",".join(only)], run=fake_runner(calls)) == 0 and calls == []
    assert manage.voice_samples(["--engine", "voxcpm", "--force", "--only", "vx-en-narrator"],
                                run=fake_runner(calls)) == 0
    assert [c["runner"] for c in calls] == ["tts_voxcpm"]


def test_manage_reports_a_failing_engine(capsys):
    def boom(*a, **kw):
        raise RuntimeError("venv missing")

    assert manage.voice_samples(["--engine", "kokoro", "--only", "af_heart"], run=boom) == 1
    out = capsys.readouterr().out
    assert "Kokoro failed: venv missing" in out and "0 made, 1 failed" in out


# ------------------------------------------------------------------ adding

def test_add_is_idempotent_and_can_star(client):
    assert client.post("/api/voices/gallery/nope/add").status_code == 404
    r = client.post("/api/voices/gallery/ur-lahore-narrator/add")
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["kind"] == "design" and v["language"] == "ur" and v["gender_hint"] == "male"
    lahore = vg.get("ur-lahore-narrator")
    # the slow, measured delivery its description asked for travels as a speed hint
    assert v["design"] == {"description": lahore["instruct"], "seed": lahore["seed"], "engine": "omnivoice",
                           "gallery": "ur-lahore-narrator", **({"speed": lahore["speed"]} if lahore.get("speed") else {})}
    again = client.post("/api/voices/gallery/ur-lahore-narrator/add", json={"starred": True})
    assert again.status_code == 200 and again.json()["id"] == v["id"] and again.json()["starred"] is True

    p = client.post("/api/voices/gallery/bf_emma/add").json()
    assert p["kind"] == "preset" and p["preset"] == {"engine": "kokoro", "id": "bf_emma", "gallery": "bf_emma"}
    with SessionLocal() as db:
        assert db.query(VoiceProfile).count() == 2
    item = next(x for x in gallery(client, language="ur")["items"] if x["id"] == "ur-lahore-narrator")
    assert item["added_voice_id"] == v["id"] and item["starred"] is True
    # the library copy speaks like any designed voice
    assert speak(client, voice_id=v["id"]).status_code == 202


# ------------------------------------------------------------------ gallery:<id> voices

def test_speak_with_a_gallery_voice(client, fast_driver):
    r = speak(client, voice_id="gallery:ur-dadi", text="یہ میری آواز ہے")
    assert r.status_code == 202, r.text
    assert r.json()["engine_resolved"] == "omnivoice" and r.json()["seed"] == vg.get("ur-dadi")["seed"]
    r2 = speak(client, voice_id="gallery:bm_george", text="Good evening.")
    assert r2.json()["engine_resolved"] == "kokoro"
    _run_all(fast_driver)
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["items"][0]["generation_id"])
        assert g.status == "ready" and g.params["voice_id"] == "gallery:ur-dadi" and g.params["language"] == "ur"
        assert g.params["voice"]["design"]["description"] == vg.get("ur-dadi")["instruct"]
        g2 = db.get(Generation, r2.json()["items"][0]["generation_id"])
        assert g2.params["voice"]["preset"] == "bm_george" and g2.params["language"] == "en"
        assert db.query(VoiceProfile).count() == 0  # nothing was added to the library

    bad = speak(client, voice_id="gallery:nope")
    assert bad.status_code == 422 and bad.json()["detail"] == "That gallery voice doesn't exist"
    wrong = speak(client, voice_id="gallery:bm_george", language="hi", text="यह मेरी आवाज़ है")
    assert wrong.status_code == 422 and "speaks English" in wrong.json()["detail"]


def test_dialogue_lines_resolve_gallery_voices(client, fast_driver):
    s = split(client, make(client), "Maya: Five words are here now.\nTomas: One two three four.")
    cast = s["cast"]
    for c in cast:
        c["voice_id"] = "gallery:af_heart" if c["name"] == "Maya" else "gallery:en-uk-narrator"
    s = patch(client, s, cast=cast)
    out = render(client, s)
    assert out["queued"] == 2, out
    _run_all(fast_driver)
    s = client.get(f"/api/scripts/{s['id']}").json()
    assert [ln["status"] for ln in s["lines"]] == ["ready", "ready"]
    with SessionLocal() as db:
        engines = [db.get(Generation, ln["take_id"]).params["engine"] for ln in s["lines"]]
    assert engines == ["kokoro", "omnivoice"]


def test_runner_segments_can_carry_their_own_voice(tmp_path):
    # the real runner_io helper: per_segment hands synth the segment, otherwise only the text
    import subprocess
    import sys

    runners = Path(__file__).resolve().parents[1] / "runners"
    script = tmp_path / "probe.py"
    script.write_text(
        "import sys\n"
        f"sys.path.insert(0, {str(runners)!r})\n"
        "import runner_io as rio\n"
        "seen = []\n"
        "def synth(text, seg=None):\n"
        "    seen.append((text, (seg or {}).get('instruct')))\n"
        "    return [0.0] * 240\n"
        "def run(job):\n"
        "    rio.speak_all(job, synth, 24000)\n"
        "    return {'seen': seen}\n"
        "rio.main(run)\n", encoding="utf-8")
    out = tmp_path / "a.wav"
    job = {"per_segment": True, "segments": [{"text": "hi", "out": str(out), "instruct": "female"}]}
    r = subprocess.run([sys.executable, str(script)], input=json.dumps(job), capture_output=True, text=True,
                       timeout=60)
    if "No module named 'soundfile'" in r.stdout + r.stderr:
        pytest.skip("soundfile isn't installed here")
    done = json.loads(r.stdout.strip().splitlines()[-1])
    assert done["done"]["seen"] == [["hi", "female"]]
