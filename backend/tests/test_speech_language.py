"""Spoken language: every TTS path tells the engine the language each piece is really in (real users heard
English, Urdu and mixed lines come out in some other language)."""
import sys
import types
from pathlib import Path

import numpy as np
import pytest

from app import speech, speech_language as sl, stories, voices
from app.db import SessionLocal
from app.dub import engines as dub_engines
from app.models import Generation
from tests.test_voices import fake_runner, speak

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runners"))
import runner_io  # noqa: E402

URDU = "یہ میری آواز ہے۔"


@pytest.mark.parametrize("text,requested,fallback,want", [
    ("Hello there, my friend.", "en", None, "en"),
    (URDU, "ur", None, "ur"),
    # the Speak page's English default with Urdu typed in
    (URDU, "en", None, "ur"),
    (URDU, None, None, "ur"),
    # an Urdu voice reading an English line
    ("Hello there, my friend.", "ur", None, "en"),
    ("Hello there, my friend.", None, "ur", "en"),
    # a short Urdu line aerab alone would call Persian
    ("آج کل", "en", None, "ur"),
    ("آج کل", None, "ur", "ur"),
    ("این صدای من است", "en", None, "fa"),
    ("هذا صوتي في البيت", "en", None, "ar"),
    # a request the letters agree with stands
    ("هذا صوتي", "ar", None, "ar"),
    ("Aap kaise hain, sab theek hai?", "ur-latn", None, "ur-latn"),
    ("Aap kaise hain, sab theek hai?", "ur", None, "ur"),
    ("यह मेरी आवाज़ है", "en", None, "hi"),
    ("Bonjour mes amis", "fr", None, "fr"),
    # tags aren't words to read: an Urdu line with a [laughter] is still Urdu
    ("ہاں [laughter] ٹھیک", "en", None, "ur"),
    ("...", "ur", None, "ur"),
])
def test_language_of(text, requested, fallback, want):
    assert sl.language_of(text, requested, fallback) == want


def test_mixed_text_runs_per_sentence():
    text = "Welcome to the show. آج ہم ایک کہانی سنیں گے۔ It starts now! Ready?"
    assert sl.runs(text, "en") == [("Welcome to the show.", "en"), ("آج ہم ایک کہانی سنیں گے۔", "ur"),
                                   ("It starts now! Ready?", "en")]
    # an English word inside an Urdu sentence stays with the sentence
    assert sl.runs("میں نے نیا laptop خریدا۔", "ur") == [("میں نے نیا laptop خریدا۔", "ur")]
    assert sl.dominant(text, "en") == "en" and sl.dominant(f"Hi. {URDU} {URDU}", "en") == "ur"


def test_synthesise_sends_each_piece_in_its_own_language(tmp_path):
    calls = []
    params = {"engine": "omnivoice", "language": "en", "voice": {"design": {"description": "male, indian accent"}},
              "text": "Welcome to the show. آج ہم ایک کہانی سنیں گے۔ [pause 0.5s] Thanks!", "speed": 1.0}
    speech.synthesise(params, 5, tmp_path / "a.flac", lambda f, m: None, run=fake_runner(calls))
    job = calls[0]["job"]
    assert [(s["text"], s["language"]) for s in job["segments"]] == [
        ("Welcome to the show.", "en"), ("آج ہم ایک کہانی سنیں گے۔", "ur"), ("Thanks!", "en")]
    assert job["language"] == "en" and job["instruct"] == "male, indian accent"

    # an Urdu voice's language on English text: the engine is told English
    speech.synthesise({**params, "language": "ur", "text": "Hello there."}, 5, tmp_path / "b.flac",
                      lambda f, m: None, run=fake_runner(calls))
    assert [s["language"] for s in calls[-1]["job"]["segments"]] == ["en"]


def test_an_engine_that_cannot_speak_the_letters_keeps_the_request(tmp_path):
    e = voices.get_engine("chatterbox")
    job = speech.runner_job({"language": "en"}, e, ["Hello.", URDU], tmp_path, 1, None)
    assert [s["language"] for s in job["segments"]] == ["en", "en"]
    job = speech.runner_job({"language": "en"}, e, ["Hello.", "هذا صوتي في البيت"], tmp_path, 1, None)
    assert [s["language"] for s in job["segments"]] == ["en", "ar"]


def test_speak_files_the_take_under_the_language_of_its_letters(client, fast_driver):
    r = speak(client, voice_id="gallery:ur-dadi", text="Good evening, everyone.")
    assert r.status_code == 202, r.text
    r2 = speak(client, text=URDU, language="en")
    assert r2.status_code == 202, r2.text
    with SessionLocal() as db:
        assert db.get(Generation, r.json()["items"][0]["generation_id"]).params["language"] == "en"
        assert db.get(Generation, r2.json()["items"][0]["generation_id"]).params["language"] == "ur"
    # Kokoro's English voice can't read Urdu, whatever the language chip says
    r3 = speak(client, voice_id="gallery:bm_george", text=URDU, language="en")
    assert r3.status_code == 422 and "not Urdu" in r3.json()["detail"]


def test_dub_lines_carry_their_language(tmp_path):
    calls = []
    outs = [tmp_path / "a.flac", tmp_path / "b.flac"]
    params = {"engine": "omnivoice", "language": "ur", "voice": {"kind": "design", "design": {"description": "male"}}}
    dub_engines.speak_many(params, [URDU, "OK, thank you."], outs, 3, lambda f, m: None, run=fake_runner(calls))
    assert [s["language"] for s in calls[0]["job"]["segments"]] == ["ur", "en"]


def test_story_lines_carry_their_language(tmp_path):
    e = voices.get_engine("omnivoice")
    cast = {"n": {"seed": 1, "instruct": "female, elderly, indian accent"}}
    rows = [{"speaker": "n", "spoken": URDU}, {"speaker": "n", "spoken": "The end."}]
    segs = stories.runner_segments(e, cast, rows, tmp_path, "ur")
    assert [s["language"] for s in segs] == ["ur", "en"]
    # BlogCreatorPro sending "en" for an Urdu book
    assert stories.runner_segments(e, cast, rows[:1], tmp_path, "en")[0]["language"] == "ur"


def test_check_script_flags_a_take_heard_in_another_language(client, fast_driver, monkeypatch, capsys):
    import importlib.util

    from app import venv_runner
    from tests.test_storyboard import _run_all

    from datetime import timedelta

    ur = speak(client, text=URDU, language="ur").json()["items"][0]["generation_id"]
    en = speak(client, text="Good evening, everyone.", language="en").json()["items"][0]["generation_id"]
    _run_all(fast_driver)
    with SessionLocal() as db:  # same-tick timestamps would leave the order to chance
        db.get(Generation, en).created_at = db.get(Generation, ur).created_at + timedelta(seconds=5)
        db.commit()
    path = Path(__file__).resolve().parents[2] / "scripts" / "check-speech-language.py"
    spec = importlib.util.spec_from_file_location("check_speech_language", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    jobs = []

    def whisper(runner, venv, job, **kw):
        jobs.append(job)
        # newest first: the English take, then the Urdu one, heard as Persian
        return {"texts": ["good evening", "..."], "languages": [{"language": "en", "probability": 0.99},
                                                                {"language": "fa", "probability": 0.8}]}

    monkeypatch.setattr(venv_runner, "run", whisper)
    assert mod.main(["--last", "2"]) == 1
    out = capsys.readouterr().out
    assert jobs[0]["language"] is None and len(jobs[0]["audios"]) == 2
    assert "expected: ur   heard: fa (0.8)   -> MISMATCH" in out and "1 mismatch(es) in 2 take(s)" in out
    assert mod.verdict("ur", "hi") == "close" and mod.verdict("ur-latn", "ur") == "ok"


# ------------------------------------------------------------------ the runners themselves

@pytest.fixture
def quiet_runner_io(monkeypatch, tmp_path):
    monkeypatch.setattr(runner_io, "progress", lambda *a, **k: None)

    def fake_wav(path, audio, rate):  # soundfile lives in the engine venvs
        Path(path).write_bytes(b"wav")
        return 0.1

    monkeypatch.setattr(runner_io, "write_wav", fake_wav)
    torch = types.SimpleNamespace(float16="f16", float32="f32", manual_seed=lambda s: None,
                                  cuda=types.SimpleNamespace(is_available=lambda: False, manual_seed_all=lambda s: None))
    monkeypatch.setitem(sys.modules, "torch", torch)
    return tmp_path


def fake_omnivoice(monkeypatch, calls):
    class Model:
        sampling_rate = 24000

        def generate(self, text, **kw):
            calls.append({"text": text, **kw})
            return np.ones(240, dtype=np.float32)

    mod = types.SimpleNamespace(OmniVoice=types.SimpleNamespace(from_pretrained=lambda *a, **k: Model()),
                                OmniVoiceGenerationConfig=lambda **kw: kw)
    monkeypatch.setitem(sys.modules, "omnivoice", mod)


def test_omnivoice_runner_language_ids_and_accents(monkeypatch, quiet_runner_io):
    import tts_omnivoice

    calls = []
    fake_omnivoice(monkeypatch, calls)
    out = quiet_runner_io
    job = {"language": "en", "instruct": "male, middle-aged, indian accent", "seed": 4, "segments": [
        {"text": "Hello.", "out": str(out / "0.wav"), "language": "en"},
        {"text": URDU, "out": str(out / "1.wav"), "language": "ur"},
        {"text": "هذا صوتي", "out": str(out / "2.wav"), "language": "ar"},
        {"text": "Aap kaise hain", "out": str(out / "3.wav"), "language": "ur-latn"}]}
    tts_omnivoice.run(job)
    # no per_segment flag, and still every line in its own language
    assert [c["language"] for c in calls] == ["en", "ur", "arb", "ur"]
    # English accents only go with English text
    assert calls[0]["instruct"] == "male, middle-aged, indian accent"
    assert calls[1]["instruct"] == "male, middle-aged" and calls[2]["instruct"] == "male, middle-aged"

    calls.clear()
    tts_omnivoice.run({"language": "ur", "instruct": "indian accent",
                       "segments": [{"text": URDU, "out": str(out / "4.wav"), "language": "ur"}]})
    assert "instruct" not in calls[0] and calls[0]["language"] == "ur"
    assert tts_omnivoice.omni_language("auto") is None and tts_omnivoice.omni_language("pa-arab") == "pnb"


def test_chatterbox_runner_switches_to_multilingual_for_a_mixed_job(monkeypatch, quiet_runner_io):
    import tts_chatterbox

    calls, loaded = [], []

    class Model:
        sr = 24000

        def __init__(self, kind):
            loaded.append(kind)

        def generate(self, text, **kw):
            calls.append({"text": text, **kw})
            return np.ones(240, dtype=np.float32)

    en = types.SimpleNamespace(ChatterboxTTS=types.SimpleNamespace(from_pretrained=lambda **k: Model("en")))
    mtl = types.SimpleNamespace(SUPPORTED_LANGUAGES={"en": "English", "ar": "Arabic"},
                                ChatterboxMultilingualTTS=types.SimpleNamespace(from_pretrained=lambda **k: Model("mtl")))
    monkeypatch.setitem(sys.modules, "chatterbox", types.SimpleNamespace())
    monkeypatch.setitem(sys.modules, "chatterbox.tts", en)
    monkeypatch.setitem(sys.modules, "chatterbox.mtl_tts", mtl)
    out = quiet_runner_io
    tts_chatterbox.run({"language": "en", "segments": [{"text": "Hi.", "out": str(out / "0.wav"), "language": "en"}]})
    assert loaded == ["en"] and "language_id" not in calls[0]
    tts_chatterbox.run({"language": "en", "segments": [
        {"text": "Hi.", "out": str(out / "1.wav"), "language": "en"},
        {"text": "هذا صوتي", "out": str(out / "2.wav"), "language": "ar"}]})
    assert loaded[-1] == "mtl" and [c["language_id"] for c in calls[1:]] == ["en", "ar"]
