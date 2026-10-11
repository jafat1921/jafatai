"""Dub a video (contract v18): the staged pipeline on a tiny clip with the mock engines and a fake LLM."""
import json
import re
from pathlib import Path

import httpx
import numpy as np
import pytest

from app import venv_runner
from app.audio_analysis import stream_info
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import ComfyDriver
from app.drivers.mock import MockDriver
from app.dub import engines, stages, text as tx
from app.llm import set_transport
from app.models import DubProject, Generation, Job, MediaItem
from tests.test_audio_edit import tone, upload_video
from tests.test_storyboard import _run_all
from tests.test_transcribe import probe, reply, talking_clip

URDU = "یہ ایک لائن ہے"
LONG_URDU = "یہ ایک بہت لمبی لائن ہے جو اپنی جگہ میں کبھی پوری نہیں آئے گی دوست"
SHORT_URDU = "چھوٹی لائن"


class FakeLLM:
    """Answers translate / review / shorten / aerab calls the way a well-behaved model would."""

    def __init__(self):
        self.calls: list[str] = []
        self.long_ids: set[str] = set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        system, user = body["messages"][0]["content"], body["messages"][-1]["content"]
        if "translate film dialogue" in system:
            self.calls.append("translate")
            urdu = "into Urdu" in system
            rows = [row.split(" | ") for row in user.split("\n")]
            return reply({"lines": [{"id": r[0], "text": (LONG_URDU if r[0] in self.long_ids else URDU)
                                     if urdu else f"linea {r[0]}"} for r in rows]})
        if "dubbing editor" in system:
            self.calls.append("review")
            rows = [row.split(" | ") for row in user.split("\n")]
            return reply({"lines": [{"id": r[0], "text": r[3].removeprefix("draft: ")} for r in rows]})
        if "shorten" in system:
            self.calls.append("shorter")
            return reply({"text": SHORT_URDU})
        if "aerab" in system:
            self.calls.append("aerab")
            lines = [row.split(". ", 1)[1] for row in user.split("\n")]
            return reply({"lines": [x.replace("یہ", "یَہ") for x in lines]})
        raise AssertionError(f"unexpected LLM call: {system[:80]}")


@pytest.fixture
def llm():
    fake = FakeLLM()
    set_transport(httpx.MockTransport(fake))
    yield fake
    set_transport(None)


def make_dub(client, tmp_path, **body) -> dict:
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4"))
    body = {"video_id": video["id"], "targets": ["ur", "es"], **body}
    r = client.post("/api/dubs", json=body)
    assert r.status_code == 202, r.text
    return r.json()


def get(client, dub_id) -> dict:
    r = client.get(f"/api/dubs/{dub_id}")
    assert r.status_code == 200
    return r.json()


def statuses(d: dict) -> dict:
    return {k: v["status"] for k, v in d["stages"].items()}


def to_the_end(client, dub_id, fast_driver):
    d = get(client, dub_id)
    while d["stage"] != "mix" or d["stages"]["mix"]["status"] != "done":
        st = d["stages"][d["stage"]]["status"]
        assert st in ("review", "pending", "done"), (d["stage"], d["stages"][d["stage"]])
        if st == "review":
            assert client.post(f"/api/dubs/{dub_id}/continue").status_code == 202
        _run_all(fast_driver)
        d = get(client, dub_id)
    return d


# ------------------------------------------------------------------ pieces

def test_cluster_fixed_count_and_threshold():
    a, b = [1.0, 0.0, 0.1], [0.0, 1.0, 0.1]
    emb = [a, a, b, [0.95, 0.05, 0.1], b]
    assert engines.cluster(emb, None, 0.25) == [0, 0, 1, 0, 1]
    assert engines.cluster(emb, 1, 0.25) == [0] * 5
    assert engines.cluster(emb, 3, 0.25).count(0) >= 2 and len(set(engines.cluster(emb, 3, 0.25))) == 3
    # nothing close enough: everyone's their own speaker
    assert engines.cluster([a, b], None, 0.01) == [0, 1]
    assert engines.cluster([], None, 0.3) == [] and engines.cluster([a], 2, 0.3) == [0]


def test_wer_ignores_case_punctuation_and_aerab():
    assert tx.wer("Hello, there!", "hello there") == 0.0
    assert tx.wer("یَہ ایک لائن ہے", "یہ ایک لائن ہے") == 0.0
    assert tx.wer("one two three four", "one too three") == 0.5
    assert tx.wer("", "") == 0.0 and tx.wer("", "noise") == 1.0


def test_careful_translation_reviews_and_pins_the_glossary(llm):
    seen = []
    real = llm.__call__

    def spy(request):
        seen.append(json.loads(request.content)["messages"][0]["content"])
        return real(request)

    set_transport(httpx.MockTransport(spy))
    batch = [{"id": "a", "start": 0.0, "end": 2.0, "text": "Meet me at the Reef.", "speaker": "Nadia"}]
    glossary = [{"source": "Reef", "target": {"ur": "ریف"}, "note": "the bar"}, {"source": "Nadia"}]
    assert tx.translate_batch(batch, "en", "ur", glossary, careful=False) == {"a": URDU}
    assert tx.translate_batch(batch, "en", "ur", glossary, careful=True) == {"a": URDU}
    assert llm.calls == ["translate", "translate", "review"]
    assert '"Reef" → "ریف" (the bar)' in seen[0] and '"Nadia" stays "Nadia"' in seen[0]
    assert "Urdu script" in seen[0] and '"Reef" → "ریف"' in seen[2]
    assert "at most ~5 words" in tx.translate_messages(batch, "en", "ur", [])[1]["content"]


def test_fit_strategies_change_the_length(tmp_path):
    take = tone(tmp_path / "take.wav", 3.0)

    def fitted(strategy, slot):
        filters, tempo, trimmed = stages.fit_filter(strategy, 3.0, slot)
        out = tmp_path / f"{strategy}-{slot}.flac"
        engines._ffmpeg(["-i", str(take), *(["-af", ",".join(filters)] if filters else []), "-c:a", "flac",
                         str(out)])
        return round(stream_info(out).duration, 2), tempo, trimmed

    assert fitted("smart", 2.0) == (2.4, 1.25, False)  # at most 1.25x faster
    assert fitted("smart", 2.7)[0] == pytest.approx(2.7, abs=0.03)
    assert fitted("smart", 4.0) == (3.0, 1.0, False)  # never slowed down
    assert fitted("stretch", 2.0) == (2.0, 1.5, False)
    assert fitted("stretch", 4.0)[:2] == (4.0, 0.8)
    assert fitted("strict", 2.0) == (2.0, 1.0, True)
    assert fitted("strict", 4.0) == (3.0, 1.0, False)


def test_stt_join_and_word_split(tmp_path):
    a, b = tone(tmp_path / "a.wav", 1.0), tone(tmp_path / "b.wav", 2.0)
    spans = engines.join_for_stt([a, b], tmp_path / "all.wav")
    assert spans[0] == pytest.approx((0.0, 1.0), abs=0.01) and spans[1] == pytest.approx((2.0, 4.0), abs=0.01)
    assert stream_info(tmp_path / "all.wav").duration == pytest.approx(5.0, abs=0.02)
    res = {"segments": [{"start": 0.1, "end": 3.5, "text": "x", "words": [
        {"start": 0.1, "end": 0.5, "word": " one"}, {"start": 2.2, "end": 2.6, "word": " two"},
        {"start": 3.0, "end": 3.5, "word": " three"}]}]}
    assert engines.split_words(res, spans) == ["one", "two three"]


def test_comfy_driver_runs_the_dub_runners_in_audio_utils(tmp_path, monkeypatch):
    calls = []

    def run(runner, venv, job, *, lane=None, progress=None, need_gb=0.0, **kw):
        calls.append((runner, venv, lane, job))
        if runner == "separate_vocals":
            out = Path(job["out_dir"])
            for name in ("v.wav", "i.wav"):
                tone(out / name, 0.5)
            return {"vocals": str(out / "v.wav"), "instrumental": str(out / "i.wav")}
        if runner == "tts_omnivoice":
            for i, s in enumerate(job["segments"]):
                tone(Path(s["out"]), 1.0 + i)
            return {"segments": []}
        if runner == "stt_whisper":
            # one word in each joined clip: 0-1 s, then 2-4 s
            return {"segments": [{"start": 0, "end": 4, "text": "x", "words": [
                {"start": 0.2, "end": 0.6, "word": " ek"}, {"start": 2.5, "end": 3.0, "word": " do"}]}]}
        return {"embeddings": [[1.0, 0.0]] * len(job["segments"])}

    monkeypatch.setattr(venv_runner, "run", run)
    d = ComfyDriver(lane="video")
    src = tone(tmp_path / "src.wav", 1.0)
    res = d.separate(src, tmp_path / "stems", "melband.ckpt", lambda f, m: None)
    assert res["vocals"].is_file() and calls[0][:3] == ("separate_vocals", "audio-utils", "video")
    assert calls[0][3]["model"] == "melband.ckpt" and calls[0][3]["model_dir"]
    assert d.speaker_embed(src, [(0, 0.5), (0.5, 1.0)], lambda f, m: None) == [[1.0, 0.0]] * 2
    assert calls[1][0] == "speaker_embed"

    # every line of one voice in a single runner call
    outs = [tmp_path / "takes" / "a.flac", tmp_path / "takes" / "b.flac"]
    outs[0].parent.mkdir()
    params = {"engine": "omnivoice", "language": "ur", "voice": {"kind": "design", "design": {"description": "female, elderly"}}}
    durs = d.speak_many(params, ["ایک", "دو"], outs, 7, lambda f, m: None)
    assert durs == [pytest.approx(1.0, abs=0.02), pytest.approx(2.0, abs=0.02)] and all(p.is_file() for p in outs)
    tts = [c for c in calls if c[0] == "tts_omnivoice"]
    assert len(tts) == 1 and len(tts[0][3]["segments"]) == 2 and tts[0][3]["instruct"] == "female, elderly"
    # and checked in one Whisper pass, the words handed back to the clip they fell in
    assert d.transcribe_many(outs, "ur", lambda f, m: None) == ["ek", "do"]
    assert sum(1 for c in calls if c[0] == "stt_whisper") == 1


# ------------------------------------------------------------------ the pipeline

def test_full_pipeline_stops_twice_for_review_then_mixes(client, tmp_path, fast_driver, llm):
    d = make_dub(client, tmp_path)
    assert d["stage"] == "extract" and d["job"]["type"] == "dub_stage" and d["job"]["lane"] == "general"
    assert d["settings"]["fit"] == "smart" and d["settings"]["speakers"] == "auto"
    _run_all(fast_driver)

    d = get(client, d["id"])
    st = statuses(d)
    assert [st[s] for s in ("extract", "separate", "transcribe")] == ["done"] * 3
    assert st["speakers"] == "review" and st["translate"] == "pending" and d["source_language"] == "en"
    assert d["duration_s"] == pytest.approx(6.0, abs=0.1) and d["stems"]["vocals"]
    assert len(d["segments"]) == 3 and not llm.calls
    # 300 Hz for the first line, 900 Hz after: two voices
    assert [s["speaker_id"] for s in d["segments"]] == ["spk1", "spk2", "spk2"]
    assert len(d["speakers"]) == 2 and all(s["sample_url"] for s in d["speakers"])
    with SessionLocal() as db:
        jobs = db.query(Job).filter(Job.type == "dub_stage").all()
        lanes = {j.payload["stage"]: j.lane for j in jobs}
    assert lanes == {"extract": "general", "separate": "audio", "transcribe": "audio", "speakers": "general"}

    # fix a word in the transcript while it's waiting
    first = d["segments"][0]["id"]
    llm.long_ids = {d["segments"][1]["id"]}
    r = client.patch(f"/api/dubs/{d['id']}", json={"segments": [{"id": first, "source_text": "Hello, fixed."}],
                                                    "glossary": [{"source": "Reef", "target": {"ur": "ریف"}}]})
    assert r.status_code == 200 and r.json()["segments"][0]["source_text"] == "Hello, fixed."

    assert client.post(f"/api/dubs/{d['id']}/continue").status_code == 202
    _run_all(fast_driver)
    d = get(client, d["id"])
    assert statuses(d)["translate"] == "review" and statuses(d)["cast"] == "pending"
    ur = d["segments"][0]["target"]["ur"]
    assert ur["text"] == "یَہ ایک لائن ہے" and ur["status"] == "translated"  # aerab added
    assert d["segments"][0]["target"]["es"]["text"] == f"linea {first}"
    assert llm.calls.count("translate") == 2 and "aerab" in llm.calls and "review" not in llm.calls

    # careful mode is off; the hearing check gets the second Spanish line wrong
    real = MockDriver.transcribe_many

    def mishear(self, paths, language, progress_cb, expect=None):
        heard = real(self, paths, language, progress_cb, expect)
        return ["something else entirely" if language == "es" and i == 1 else h for i, h in enumerate(heard)]

    MockDriver.transcribe_many = mishear
    try:
        d = to_the_end(client, d["id"], fast_driver)
    finally:
        MockDriver.transcribe_many = real
    assert all(v == "done" for v in statuses(d).values())
    long = d["segments"][1]["target"]["ur"]
    # too long for its slot: the LLM was asked once for a shorter line, which was voiced again
    assert long["shortened"] and long["text"] == SHORT_URDU and long["text_before"].startswith("یَہ ایک بہت")
    assert long["take_id"].endswith(".2")
    # once per line at most: the 1 s last line overran too, even shortened it's only sped up after that
    assert llm.calls.count("shorter") == sum(1 for s in d["segments"] if s["target"]["ur"].get("text_before"))
    es = d["segments"][1]["target"]["es"]
    assert es["verify"]["flags"] == ["wer"] and es["verify"]["wer"] > 0.35
    assert d["segments"][0]["target"]["es"]["verify"]["flags"] == []
    assert all(s["target"]["ur"]["status"] == "verified" for s in d["segments"])
    assert d["segments"][0]["target"]["ur"]["take_url"].startswith("/api/media/")

    assert set(d["tracks"]) == {"ur", "es"} and d["tracks"]["ur"]["url"]
    with SessionLocal() as db:
        g = db.get(Generation, d["tracks"]["ur"]["generation_id"])
        item = db.get(MediaItem, d["tracks"]["ur"]["media_id"])
        path = get_settings().data_dir / g.file_path
        assert item.kind == "audio" and item.generation_id == g.id and g.status == "ready"
    info = stream_info(path)
    assert info.duration == pytest.approx(d["duration_s"], abs=0.03), (info.duration, d["duration_s"])
    assert info.channels == 2 and info.sample_rate == 48000


def test_edit_marks_stale_and_regen_redoes_only_that_line(client, tmp_path, fast_driver, llm):
    d = make_dub(client, tmp_path, targets=["ur"], speakers=1)
    d = to_the_end(client, d["id"], fast_driver)
    assert len(d["speakers"]) == 1
    before = {s["id"]: s["target"]["ur"]["take_id"] for s in d["segments"]}
    track = d["tracks"]["ur"]
    sid = d["segments"][2]["id"]

    r = client.patch(f"/api/dubs/{d['id']}", json={"segments": [{"id": sid, "target": {"ur": {"text": "نئی لائن"}}}]})
    assert r.status_code == 200
    seg = next(s for s in r.json()["segments"] if s["id"] == sid)
    assert seg["target"]["ur"]["status"] == "stale" and "verify" not in seg["target"]["ur"]
    assert client.post(f"/api/dubs/{d['id']}/regen", json={"lang": "fr"}).status_code == 422

    r = client.post(f"/api/dubs/{d['id']}/regen", json={"lang": "ur"})
    assert r.status_code == 202, r.text
    assert r.json()["regen"] == {"lang": "ur", "segment_ids": [sid], "from": "render"}
    assert client.post(f"/api/dubs/{d['id']}/regen", json={"lang": "ur"}).status_code == 409  # busy
    _run_all(fast_driver)
    d = get(client, d["id"])
    after = {s["id"]: s["target"]["ur"]["take_id"] for s in d["segments"]}
    assert after[sid] != before[sid] and all(after[k] == before[k] for k in before if k != sid)
    assert all(v == "done" for v in statuses(d).values())
    # same Library item, a new version of it
    assert d["tracks"]["ur"]["media_id"] == track["media_id"]
    assert d["tracks"]["ur"]["generation_id"] != track["generation_id"]
    assert client.post(f"/api/dubs/{d['id']}/regen", json={"lang": "ur"}).status_code == 422  # nothing stale


def test_failed_render_keeps_the_previous_track(client, tmp_path, fast_driver, llm, monkeypatch):
    d = make_dub(client, tmp_path, targets=["ur"], speakers=1)
    d = to_the_end(client, d["id"], fast_driver)
    track = d["tracks"]["ur"]
    sid = d["segments"][0]["id"]
    client.patch(f"/api/dubs/{d['id']}", json={"segments": [{"id": sid, "target": {"ur": {"text": "پھر سے"}}}]})

    def broken(self, *a, **kw):
        raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(MockDriver, "speak_many", broken)
    client.post(f"/api/dubs/{d['id']}/regen", json={"lang": "ur"})
    _run_all(fast_driver)
    d = get(client, d["id"])
    assert d["stages"]["render"]["status"] == "failed" and "CUDA out of memory" in d["stages"]["render"]["error"]
    assert d["stages"]["mix"]["status"] == "pending"
    assert d["tracks"]["ur"] == {**track, "url": d["tracks"]["ur"]["url"]}
    assert next(s for s in d["segments"] if s["id"] == sid)["target"]["ur"]["status"] == "failed"

    # fixed: continue picks the failed stage up again
    monkeypatch.undo()
    assert client.post(f"/api/dubs/{d['id']}/continue").status_code == 202
    _run_all(fast_driver)
    d = get(client, d["id"])
    assert d["stages"]["mix"]["status"] == "done" and d["tracks"]["ur"]["generation_id"] != track["generation_id"]


def test_continue_skips_cached_stages(client, tmp_path, fast_driver, llm, monkeypatch):
    d = make_dub(client, tmp_path, targets=["ur"])
    _run_all(fast_driver)
    calls = []
    real = MockDriver.separate

    def counting(self, *a, **kw):
        calls.append(1)
        return real(self, *a, **kw)

    monkeypatch.setattr(MockDriver, "separate", counting)
    with SessionLocal() as db:
        dub = db.get(DubProject, d["id"])
        stages_ = dict(dub.stages)
        for s in ("extract", "separate", "transcribe", "speakers"):
            stages_[s] = {**stages_[s], "status": "pending", "progress": 0}
        dub.stages = stages_
        db.commit()
    client.post(f"/api/dubs/{d['id']}/continue")
    _run_all(fast_driver)
    d = get(client, d["id"])
    assert statuses(d)["speakers"] == "review" and calls == []  # the stems on disk were reused
    assert d["stages"]["separate"]["model"] == get_settings().dub_separation_model


def test_split_merge_speakers_and_busy_guard(client, tmp_path, fast_driver, llm):
    d = make_dub(client, tmp_path, targets=["ur"])
    assert client.patch(f"/api/dubs/{d['id']}", json={"segments": [{"id": "x"}]}).status_code == 409
    _run_all(fast_driver)
    d = get(client, d["id"])
    s0 = d["segments"][0]
    r = client.post(f"/api/dubs/{d['id']}/segments/split", json={"segment_id": s0["id"], "at": 1.0})
    assert r.status_code == 200, r.text
    segs = r.json()["segments"]
    assert len(segs) == 4 and segs[0]["end"] == 1.0 and segs[1]["start"] == 1.0
    assert segs[0]["source_text"] + " " + segs[1]["source_text"] == s0["source_text"]
    assert client.post(f"/api/dubs/{d['id']}/segments/split", json={"segment_id": s0["id"], "at": 0.05}
                       ).status_code == 422

    r = client.post(f"/api/dubs/{d['id']}/segments/merge", json={"segment_ids": [segs[0]["id"], segs[1]["id"]]})
    segs = r.json()["segments"]
    assert len(segs) == 3 and segs[0]["source_text"] == s0["source_text"] and segs[0]["end"] == s0["end"]
    assert client.post(f"/api/dubs/{d['id']}/segments/merge", json={"segment_ids": [segs[0]["id"], segs[2]["id"]]}
                       ).status_code == 422

    r = client.patch(f"/api/dubs/{d['id']}", json={"speakers": [{"id": "spk2", "label": "Nadia"}],
                                                    "segments": [{"id": segs[0]["id"], "speaker_id": "spk2"}],
                                                    "settings": {"fit": "strict", "background_db": -6}})
    out = r.json()
    assert out["speakers"][1]["label"] == "Nadia" and out["segments"][0]["speaker_id"] == "spk2"
    assert out["settings"]["fit"] == "strict" and out["settings"]["background_db"] == -6
    assert client.patch(f"/api/dubs/{d['id']}", json={"segments": [{"id": segs[0]["id"], "speaker_id": "spk9"}]}
                        ).status_code == 422
    rows = client.get("/api/dubs").json()
    assert rows[0]["id"] == d["id"] and "segments" not in rows[0] and rows[0]["segment_count"] == 3


def test_export_mp4_has_a_track_per_language_and_subtitles(client, tmp_path, fast_driver, llm):
    d = make_dub(client, tmp_path, speakers=1)
    assert client.post(f"/api/dubs/{d['id']}/export", json={"langs": ["ur"], "default_lang": "ur"}
                       ).status_code == 422  # nothing mixed yet
    d = to_the_end(client, d["id"], fast_driver)
    body = {"langs": ["es", "ur"], "default_lang": "ur", "subtitles": "srt", "include_original": True,
            "stems": True}
    assert client.post(f"/api/dubs/{d['id']}/export", json={**body, "default_lang": "fr"}).status_code == 422
    r = client.post(f"/api/dubs/{d['id']}/export", json=body)
    assert r.status_code == 202, r.text
    assert r.json()["job"]["type"] == "dub_export" and r.json()["job"]["lane"] == "general"
    _run_all(fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, r.json()["job"]["id"])
        assert job.status == "done", job.error
        item = db.get(MediaItem, d["video_id"])
        g = db.get(Generation, item.generation_id)
        assert g.id == r.json()["generation_id"] and g.parent_id == d["video_generation_id"] and g.version == 2
        path = get_settings().data_dir / g.file_path
        assert job.result["stems"].endswith(".stems.zip")
    info = probe(path)
    audio = re.findall(r"Stream #\S+?\((\w+)\): Audio: aac.*?(\(default\))?\n", info)
    assert [lang for lang, _ in audio] == ["urd", "spa", "eng"]
    assert audio[0][1] == "(default)" and not audio[1][1] and not audio[2][1]
    assert "Urdu dub" in info and "Spanish dub" in info and "Original" in info
    subs = re.findall(r"Stream #\S+?\((\w+)\): Subtitle: mov_text", info)
    assert subs == ["urd", "spa"]
    assert len(re.findall(r"Stream #\S+.*?: Video: h264", info)) == 1
    assert stream_info(path).duration == pytest.approx(6.0, abs=0.1)

    # a second export starts from the dubbed version's own source again, never from the first export
    r = client.post(f"/api/dubs/{d['id']}/export", json={"langs": ["ur"], "default_lang": "ur", "subtitles": "burn",
                                                         "include_original": False})
    _run_all(fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, r.json()["job"]["id"])
        assert job.status == "done", job.error
        g = db.get(Generation, job.generation_id)
        assert g.parent_id == d["video_generation_id"]
        info = probe(get_settings().data_dir / g.file_path)
    assert len(re.findall(r": Audio:", info)) == 1 and "Subtitle" not in info


def test_the_mix_voice_track_lines_up_with_the_starts(client, tmp_path, fast_driver, llm):
    d = make_dub(client, tmp_path, targets=["ur"], speakers=1, settings={"keep_background": False})
    d = to_the_end(client, d["id"], fast_driver)
    with SessionLocal() as db:
        dub = db.get(DubProject, d["id"])
        root = get_settings().data_dir / "workspaces" / dub.workspace_id / "dubs" / dub.id
    from app.audio_analysis import _decode_mono

    rate = 8000
    voice = _decode_mono(root / "mix" / "ur.voice.wav", rate)
    assert len(voice) == pytest.approx(d["duration_s"] * rate, abs=40)
    loud = np.abs(voice) > 0.01
    for s in d["segments"]:
        a = int(s["start"] * rate)
        assert loud[a + 160:a + 1600].any(), s["start"]
    # silence between the end of the first line's take and the next start
    first_end = d["segments"][0]["start"] + d["segments"][0]["target"]["ur"]["fitted_s"]
    gap = voice[int((first_end + 0.03) * rate):int((d["segments"][1]["start"] - 0.01) * rate)]
    assert gap.size == 0 or np.abs(gap).max() < 0.01


def test_a_gallery_voice_can_be_cast(client, tmp_path, fast_driver, llm):
    from app import voice_gallery

    d = make_dub(client, tmp_path, targets=["ur"], speakers=1)
    _run_all(fast_driver)
    r = client.patch(f"/api/dubs/{d['id']}", json={"speakers": [{"id": "spk1", "voice_id": "gallery:ur-dadi"}]})
    assert r.status_code == 200, r.text
    dadi = voice_gallery.get("ur-dadi")
    assert r.json()["speakers"][0]["voice_id"] == "gallery:ur-dadi"
    assert r.json()["speakers"][0]["voice_name"] == dadi["name"]
    bad = client.patch(f"/api/dubs/{d['id']}", json={"speakers": [{"id": "spk1", "voice_id": "gallery:nope"}]})
    assert bad.status_code == 422

    d = to_the_end(client, d["id"], fast_driver)
    # the cast stage kept it (it drops voices it can't find) and every line was voiced with it
    assert d["speakers"][0]["voice_id"] == "gallery:ur-dadi"
    assert all(s["target"]["ur"]["status"] == "verified" for s in d["segments"])
    with SessionLocal() as db:
        dub = db.get(DubProject, d["id"])
        params, _ = stages._voice(db, dub, "gallery:ur-dadi", dub.speakers[0], "ur")
    assert params["voice"]["name"] == dadi["name"] and params["language"] == "ur"


def test_runner_scripts_compile():
    import py_compile

    root = Path(__file__).resolve().parents[1] / "runners"
    for name in ("separate_vocals", "speaker_embed"):
        py_compile.compile(str(root / f"{name}.py"), doraise=True)
        src = (root / f"{name}.py").read_text(encoding="utf-8")
        assert "from app" not in src and "rio.main(run)" in src


def test_create_needs_a_video_with_sound(client, tmp_path):
    from tests.test_library import upload

    a = upload(client, "a.wav", tone(tmp_path / "a.wav", 1.0).read_bytes(), "audio/wav").json()
    r = client.post("/api/dubs", json={"video_id": a["id"], "targets": ["ur"]})
    assert r.status_code == 422 and "video" in r.json()["detail"]
    assert client.post("/api/dubs", json={"video_id": "nope", "targets": ["ur"]}).status_code == 404
    assert client.post("/api/dubs", json={"video_id": a["id"], "targets": []}).status_code == 422
    assert client.post("/api/dubs", json={"video_id": a["id"], "targets": ["ur"], "speakers": 40}).status_code == 422
