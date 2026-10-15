"""Story books for BlogCreatorPro (contract v28): narration, read-along videos, downloads, and the OmniVoice
licence switch that came with them."""
import os
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import audio_analysis as aa
from app import audio_edit as ae
from app import brand_render as br
from app import stories, venv_runner, voice_gallery, voices
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.mock import MockDriver
from app.main import app
from app.models import Job, Workspace
from app.podcast.publish import GROUND
from app.worker import process_one
from app.llm import set_transport
from tests.test_aerab import Marker
from tests.test_library import png_bytes, upload


def tone(path: Path, seconds: float, freq: int = 330) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([get_settings().ffmpeg_path(), "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                    f"sine=frequency={freq}:duration={seconds}", "-ac", "1", "-ar", "24000", str(path)], check=True,
                   capture_output=True)
    return path


def fake_runner(calls, heard=None, seconds=0.5):
    def run(runner, venv, job, *, lane=None, progress=None, need_gb=0.0, timeout=None, **kw):
        calls.append({"runner": runner, "job": job, "timeout": timeout})
        if runner == "stt_whisper":
            return {"texts": list(heard or [])}
        segs = job["segments"]
        for i, seg in enumerate(segs):
            if progress:
                progress(0.15 + 0.8 * i / len(segs), f"Speaking line {i + 1}/{len(segs)}")
            tone(Path(seg["out"]), seconds + 0.1 * i, 300 + 40 * i)
        return {"segments": [{"out": s["out"]} for s in segs]}
    return run


BOOK = {
    "language": "en", "engine": "voxcpm",
    "cast": {"narrator": {"design": {"description": "warm British storyteller", "seed": 123}},
             "Pip": {"design": {"description": "small excited boy", "seed": 456}}},
    "pages": [
        {"key": "p1", "lines": [{"speaker": "narrator", "text": "Pip ran to the window."},
                                {"speaker": "Pip", "text": "\"It's snowing!\"", "emotion": "excited"}]},
        {"key": "p2", "lines": [{"speaker": "narrator", "text": "And it snowed all night."}]},
    ],
    "gap_line": 0.35, "gap_page": 1.2,
}


def run_all():
    while process_one(driver_factory=lambda: MockDriver(step_seconds=0)):
        pass


def done_job(job_id: str) -> Job:
    with SessionLocal() as db:
        j = db.get(Job, job_id)
        db.expunge(j)
        return j


def narrate(client, monkeypatch, calls=None, **over) -> dict:
    calls = [] if calls is None else calls
    monkeypatch.setattr(venv_runner, "run", fake_runner(calls, over.pop("heard", None)))
    r = client.post("/api/stories/audio", json={**BOOK, **over})
    assert r.status_code == 202, r.text
    run_all()
    j = done_job(r.json()["job"]["id"])
    assert j.status == "done", j.error
    return {"id": j.id, "result": j.result, "calls": calls}


def mint(client, scopes) -> TestClient:
    tok = client.post("/api/tokens", json={"name": "bcp", "scopes": scopes, "expires_days": 30}).json()["token"]
    c = TestClient(app)
    c.headers["Authorization"] = f"Bearer {tok}"
    return c


# ---------------------------------------------------------------- auth and validation

def test_generate_token_can_post_and_read_only_token_gets_403(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "public_api", True)
    gen, ro = mint(client, ["read", "generate"]), mint(client, ["read"])
    r = gen.post("/api/stories/audio", json=BOOK)
    assert r.status_code == 202, r.text
    job = r.json()["job"]
    assert job["type"] == "story_audio" and job["lane"] == "audio" and job["status"] == "queued"
    assert gen.get(f"/api/jobs/{job['id']}").json()["id"] == job["id"]
    assert ro.post("/api/stories/audio", json=BOOK).status_code == 403
    assert ro.post("/api/stories/video", json={"audio_job": job["id"], "pages": [{"key": "p1", "media_id": "x"}]}) \
        .status_code == 403
    assert ro.get(f"/api/jobs/{job['id']}").status_code == 200


def test_omnivoice_needs_the_noncommercial_switch(client, monkeypatch):
    assert get_settings().audio_allow_noncommercial is True
    assert client.post("/api/stories/audio", json={**BOOK, "engine": "omnivoice"}).status_code == 202
    monkeypatch.setattr(get_settings(), "audio_allow_noncommercial", False)
    r = client.post("/api/stories/audio", json={**BOOK, "engine": "omnivoice"})
    assert r.status_code == 422 and r.json()["detail"] == "OmniVoice isn't available on this server"
    r = client.post("/api/stories/audio", json={**BOOK, "engine": "piper"})
    assert r.status_code == 422 and "omnivoice" not in r.json()["detail"]


@pytest.mark.parametrize("change, needle", [
    ({"cast": {}}, "cast"),
    ({"cast": {f"s{i}": {"preset": "af_heart"} for i in range(14)}}, "cast"),
    ({"pages": [{"key": f"p{i}", "lines": [{"speaker": "narrator", "text": "x"}]} for i in range(201)]}, "pages"),
    ({"pages": [{"key": "p1", "lines": [{"speaker": "narrator", "text": "x"}] * 61}]}, "lines"),
    ({"pages": [{"key": "p1", "lines": [{"speaker": "narrator", "text": "x" * 1001}]}]}, "text"),
    ({"pages": [{"key": "p1", "lines": [{"speaker": "Gran", "text": "Hi"}]}]}, "Gran"),
    ({"pages": [{"key": "p1", "lines": [{"speaker": "Pip", "text": "Hi", "emotion": "smug"}]}]}, "emotion"),
    ({"engine": "kokoro"}, "preset"),
    ({"cast": {"narrator": {"preset": "bf_emma"}, "Pip": {"preset": "af_heart"}}}, "designed voice"),
    ({"engine": "kokoro", "cast": {"narrator": {"preset": "ef_dora"}, "Pip": {"preset": "af_heart"}}}, "Spanish"),
    ({"engine": "chatterbox", "language": "ur"}, "Urdu"),
    ({"music": {"prompt": "calm", "model": "minimax"}}, "model"),
])
def test_audio_validation(client, change, needle):
    r = client.post("/api/stories/audio", json={**BOOK, **change})
    assert r.status_code == 422, r.text
    assert needle in str(r.json()["detail"])


# ---------------------------------------------------------------- the narration

def test_audio_job_speaks_the_book_in_one_runner_call(client, monkeypatch):
    out = narrate(client, monkeypatch, check=True,
                  heard=["Pip ran to the window. It's snowing!", "and it snowed all day"])
    calls, res = out["calls"], out["result"]
    tts = [c for c in calls if c["runner"] == "tts_voxcpm"]
    assert len(tts) == 1 and len(tts[0]["job"]["segments"]) == 3 and tts[0]["job"]["per_segment"] is True
    segs = tts[0]["job"]["segments"]
    assert [s["seed"] for s in segs] == [123, 456, 123]
    assert segs[1]["instruct"].startswith("small excited boy") and "excited" in segs[1]["instruct"]
    assert segs[0]["instruct"] == "warm British storyteller"

    p1, p2 = res["pages"]
    assert p1["key"] == "p1" and p1["file"] == "p1.mp3" and [ln["speaker"] for ln in p1["lines"]] == ["narrator", "Pip"]
    # 0.5 s, the 0.35 s gap, then 0.6 s
    assert p1["lines"][0] == {"start": 0.0, "end": pytest.approx(0.5, abs=0.03), "speaker": "narrator",
                              "text": "Pip ran to the window."}
    assert p1["lines"][1]["start"] == pytest.approx(0.85, abs=0.03)
    assert p1["lines"][1]["end"] == pytest.approx(1.45, abs=0.04)
    assert p1["duration"] == pytest.approx(1.45, abs=0.05)
    full = res["full"]
    assert full["file"] == "full.mp3" and [s["key"] for s in full["pages"]] == ["p1", "p2"]
    assert full["pages"][0]["start"] == 0 and full["pages"][0]["end"] == pytest.approx(p1["duration"] + 1.2, abs=0.01)
    assert full["pages"][1]["start"] == full["pages"][0]["end"]
    assert full["duration"] == pytest.approx(full["pages"][1]["end"], abs=0.01)
    assert p1["match"] == 1.0 and 0 < p2["match"] < 1
    assert res["engine"] == "voxcpm" and res["seeds"] == {"narrator": 123, "Pip": 456}
    assert "full_music" not in res

    folder = stories.story_dir(done_job(out["id"]).workspace_id, out["id"])
    info = aa.stream_info(folder / "p1.mp3")
    assert info.sample_rate == 44100 and info.channels == 1
    assert not (folder / ".work").exists()
    whisper = next(c for c in calls if c["runner"] == "stt_whisper")
    assert len(whisper["job"]["audios"]) == 2


def test_progress_names_the_page(client, monkeypatch):
    seen = []
    from app.worker import JobContext

    real = JobContext.progress

    def spy(self, fraction, message=""):
        seen.append(message)
        return real(self, fraction, message)
    monkeypatch.setattr(JobContext, "progress", spy)
    narrate(client, monkeypatch)
    assert "Speaking page 1 of 2" in seen and "Speaking page 2 of 2" in seen


def test_kokoro_and_chatterbox_voices(client, monkeypatch):
    calls = []
    out = narrate(client, monkeypatch, calls, engine="kokoro",
                  cast={"narrator": {"preset": "bf_emma"}, "Pip": {"preset": "am_adam"}})
    job = calls[0]["job"]
    assert calls[0]["runner"] == "tts_kokoro"
    assert [s["voice"] for s in job["segments"]] == ["bf_emma", "am_adam", "bf_emma"]
    assert out["result"]["seeds"] == {}
    calls.clear()
    narrate(client, monkeypatch, calls, engine="chatterbox")
    segs = calls[0]["job"]["segments"]
    assert calls[0]["runner"] == "tts_chatterbox" and segs[1]["exaggeration"] > 1 and "exaggeration" not in segs[0]


# ---------------------------------------------------------------- Urdu narration (v28c)

PLAIN, MARKED = "دل کی بات", "دِل کی بات"
OWN = "دِلْ کِی بَات"
URDU = {
    "language": "ur", "engine": "omnivoice",
    "cast": {"narrator": {"design": {"description": "warm elderly Lahori narrator, female, slow", "seed": 11}},
             "Ali": {"design": {"description": "small boy, bright high voice", "seed": 22}}},
    "pages": [{"key": "p1", "lines": [{"speaker": "narrator", "text": PLAIN},
                                      {"speaker": "Ali", "text": OWN, "emotion": "whisper"}]},
              {"key": "p2", "lines": [{"speaker": "narrator", "text": f"{PLAIN} ہے"}]}],
}


@pytest.fixture
def llm():
    def install(fn):
        fake = Marker(fn)
        set_transport(httpx.MockTransport(fake))
        return fake
    yield install
    set_transport(None)


def test_urdu_book_on_omnivoice_with_designed_voices(client, monkeypatch, llm):
    fake = llm(lambda x: x.replace("دل", "دِل"))
    calls = []
    out = narrate(client, monkeypatch, calls, **URDU)
    tts = [c for c in calls if c["runner"] == "tts_omnivoice"]
    assert len(tts) == 1 and tts[0]["job"]["language"] == "ur" and tts[0]["job"]["per_segment"] is True
    segs = tts[0]["job"]["segments"]
    assert [s["seed"] for s in segs] == [11, 22, 11]
    # the free description is cut down to OmniVoice's own attributes
    assert segs[0]["instruct"] == "female, elderly, indian accent"
    assert segs[1]["instruct"] == "male, child, high pitch, whisper"
    res = out["result"]
    assert res["engine"] == "omnivoice" and res["licence"] == "non-commercial"
    assert res["seeds"] == {"narrator": 11, "Ali": 22}

    # the two bare lines went in one LLM call; the line the writer marked was left alone
    assert fake.calls == 1
    assert [s["text"] for s in segs] == [MARKED, OWN, f"{MARKED} ہے"]
    p1, p2 = res["pages"]
    assert [ln["text"] for ln in p1["lines"]] == [MARKED, OWN] and p2["lines"][0]["text"] == f"{MARKED} ہے"


def test_aerab_false_speaks_the_lines_as_written(client, monkeypatch, llm):
    fake = llm(lambda x: x.replace("دل", "دِل"))
    calls = []
    out = narrate(client, monkeypatch, calls, **URDU, aerab=False)
    assert fake.calls == 0
    assert [s["text"] for s in calls[0]["job"]["segments"]] == [PLAIN, OWN, f"{PLAIN} ہے"]
    assert out["result"]["pages"][0]["lines"][0]["text"] == PLAIN


def test_commercial_engines_carry_no_licence_marker(client, monkeypatch):
    assert "licence" not in narrate(client, monkeypatch)["result"]


def test_match_ignores_aerab():
    assert stories.match(MARKED, PLAIN) == 1.0


def test_music_bed_is_generated_ducked_and_mixed(client, monkeypatch):
    graphs = []
    real_run = ae.run

    def spy(args, *a, **kw):
        if "-filter_complex" in args:
            graphs.append(args[args.index("-filter_complex") + 1])
        return real_run(args, *a, **kw)
    monkeypatch.setattr(ae, "run", spy)
    out = narrate(client, monkeypatch, music={"prompt": "soft lullaby", "model": "sa3", "level": "soft"})
    assert out["result"]["full_music"] == {"file": "full_music.mp3"}
    assert any("sidechaincompress" in g for g in graphs)
    folder = stories.story_dir(done_job(out["id"]).workspace_id, out["id"])
    assert abs(aa.stream_info(folder / "full_music.mp3").duration - out["result"]["full"]["duration"]) < 0.2
    with SessionLocal() as db:
        gens = db.query(Job).filter(Job.type == "generate").all()
        assert len(gens) == 1 and gens[0].status == "done"


# ---------------------------------------------------------------- the video

def pictures(client, n=2) -> list[str]:
    ids = []
    for i in range(n):
        r = upload(client, f"page{i}.jpg", png_bytes((640, 480), (40 + 60 * i, 90, 140), "JPEG"), "image/jpeg")
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    return ids


def test_plan_keeps_whole_pages_for_a_short():
    res = {"pages": [{"key": k, "lines": [{"start": 0.0, "end": 1.0, "text": k}]} for k in ("a", "b", "c")],
           "full": {"duration": 30.0, "pages": [{"key": "a", "start": 0.0, "end": 10.0},
                                                 {"key": "b", "start": 10.0, "end": 20.0},
                                                 {"key": "c", "start": 20.0, "end": 30.0}]}}
    plan = stories.plan_video(res, 3.0, 4.0, 30.0)
    assert [s.get("key") for s in plan["segments"]] == [None, "a", "b", None]
    assert plan["total"] == 27.0 and plan["trimmed"] and plan["chapters"] == [{"key": "a", "start": 3.0},
                                                                            {"key": "b", "start": 13.0}]
    assert plan["cues"][1] == {"start": 13.0, "end": 14.0, "text": "b"}
    full = stories.plan_video(res, 0.0, 0.0, None)
    assert full["total"] == 30.0 and not full["trimmed"] and len(full["chapters"]) == 3
    with pytest.raises(Exception):
        stories.plan_video(res, 3.0, 4.0, 12.0)


def _chapters(path: Path) -> int:
    return br.video_info(path).chapters


def test_video_16x9_with_captions_and_end_card(client, monkeypatch):
    out = narrate(client, monkeypatch)
    ids = pictures(client)
    r = client.post("/api/stories/video", json={
        "audio_job": out["id"], "aspect": "16:9", "use_music": False, "captions": True,
        "pages": [{"key": "p1", "media_id": ids[0]}, {"key": "p2", "media_id": ids[1]}],
        "end_card": {"text": "The End", "seconds": 2}})
    assert r.status_code == 202, r.text
    run_all()
    j = done_job(r.json()["job"]["id"])
    assert j.status == "done", j.error
    res = j.result
    assert res["file"] == "story_16x9.mp4" and res["srt"] == "story_16x9.srt"
    assert (res["width"], res["height"]) == (1920, 1080)
    assert [c["key"] for c in res["chapters"]] == ["p1", "p2"] and res["chapters"][0]["start"] == 0
    assert res["duration"] == pytest.approx(out["result"]["full"]["duration"] + 2, abs=0.15)
    path = stories.story_dir(j.workspace_id, j.id) / res["file"]
    info = br.video_info(path)
    assert (info.width, info.height) == (1920, 1080) and info.has_audio and _chapters(path) == 2
    srt = (path.parent / res["srt"]).read_text(encoding="utf-8")
    assert "Pip ran to the window." in srt and "snowed all night" in srt
    # the small copy to watch before downloading; served by the same files route, with ranges for seeking
    small = br.video_info(path.parent / res["preview"])
    assert res["preview"] == "story_16x9_preview.mp4" and (small.width, small.height) == (640, 360) and small.has_audio
    got = client.get(f"/api/stories/{j.id}/files/{res['preview']}", headers={"Range": "bytes=0-99"})
    assert got.status_code == 206 and len(got.content) == 100


def test_video_9x16_short_with_max_seconds(client, monkeypatch):
    out = narrate(client, monkeypatch, music={"prompt": "lullaby", "model": "sa3", "level": "normal"})
    ids = pictures(client)
    p1_end = out["result"]["full"]["pages"][0]["end"]
    body = {"audio_job": out["id"], "aspect": "9:16", "use_music": True,
            "pages": [{"key": "p1", "media_id": ids[0]}, {"key": "p2", "media_id": ids[1]}],
            "title_card": {"title": "Pip and the First Snow", "seconds": 1.5},
            "end_card": {"text": "The End", "seconds": 1},
            "max_seconds": round(1.5 + p1_end + 1 + 0.5, 2)}
    r = client.post("/api/stories/video", json=body)
    assert r.status_code == 202, r.text
    run_all()
    j = done_job(r.json()["job"]["id"])
    assert j.status == "done", j.error
    res = j.result
    assert res["file"] == "story_9x16.mp4" and (res["width"], res["height"]) == (1080, 1920)
    small = br.video_info(stories.story_dir(j.workspace_id, j.id) / res["preview"])
    assert (small.width, small.height) == (360, 640)
    assert res["chapters"] == [{"key": "p1", "start": 1.5}]
    assert res["duration"] == pytest.approx(1.5 + p1_end + 1, abs=0.15) and res["duration"] <= body["max_seconds"]
    path = stories.story_dir(j.workspace_id, j.id) / res["file"]
    assert (br.video_info(path).width, br.video_info(path).height) == (1080, 1920) and _chapters(path) == 1


def test_video_validation(client, monkeypatch):
    out = narrate(client, monkeypatch)
    ids = pictures(client, 1)

    def post(**over):
        body = {"audio_job": out["id"], "use_music": False, "pages": [{"key": "p1", "media_id": ids[0]},
                                                                      {"key": "p2", "media_id": ids[0]}], **over}
        return client.post("/api/stories/video", json=body)
    assert post(use_music=True).status_code == 422  # no bed in this one
    assert post(pages=[{"key": "p9", "media_id": ids[0]}]).status_code == 422
    assert post(pages=[{"key": "p1", "media_id": ids[0]}]).status_code == 422  # p2 has no picture
    assert post(pages=[{"key": "p1", "media_id": "nope"}, {"key": "p2", "media_id": ids[0]}]).status_code == 422
    assert post(aspect="4:3").status_code == 422
    assert post(audio_job="missing").status_code == 404
    # a 4 s title card plus the first page (about 2.7 s) don't fit in 5 s
    assert post(max_seconds=5, title_card={"title": "Snow", "seconds": 4}).status_code == 422


# ---------------------------------------------------------------- video pages (v28a)

def _ffmpeg_ok() -> bool:
    try:
        return subprocess.run([get_settings().ffmpeg_path(), "-version"], capture_output=True).returncode == 0
    except Exception:
        return False


needs_ffmpeg = pytest.mark.skipif(not _ffmpeg_ok(), reason="ffmpeg isn't available")


def lavfi_clip(path: Path, seconds: float, size: str = "1344x768", rate: int = 24) -> Path:
    # with a tone, so the test can see the clip's own sound is dropped
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([get_settings().ffmpeg_path(), "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}:duration={seconds}",
                    "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-shortest",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path)],
                   check=True, capture_output=True)
    return path


def upload_clip(client, tmp_path, seconds, size="1344x768") -> str:
    clip = lavfi_clip(tmp_path / f"clip_{seconds}_{size}.mp4", seconds, size)
    r = upload(client, clip.name, clip.read_bytes(), "video/mp4")
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "video"
    return r.json()["id"]


@needs_ffmpeg
@pytest.mark.parametrize("have, how", [(1.0, "held"), (1.8, "slowed"), (3.0, "trimmed")])
def test_video_clip_fits_the_page(tmp_path, have, how):
    src = lavfi_clip(tmp_path / "src.mp4", have)
    dst = tmp_path / "out.mp4"
    assert stories.video_clip(src, dst, 60, "16:9") == how
    info = br.video_info(dst)
    assert (info.width, info.height) == (1920, 1080) and info.fps == 30 and not info.has_audio
    assert info.duration == pytest.approx(2.0, abs=0.05)


def test_matching_stills_fill_the_frame():
    red = (200, 30, 30)
    wide = stories.picture_frame(Image.new("RGB", (1344, 768), red), "16:9", scale=1)  # 1.75 against 1.78
    assert wide.size == (1920, 1080) and wide.getpixel((2, 2)) == red and wide.getpixel((1917, 1077)) == red
    tall = stories.picture_frame(Image.new("RGB", (1100, 1920), red), "9:16", scale=1)
    assert tall.size == (1080, 1920) and tall.getpixel((540, 1900)) == red
    # off by more than 3%: the old layouts (blurred copy behind; 9:16 caption area below the picture)
    boxed = stories.picture_frame(Image.new("RGB", (640, 480), red), "16:9", scale=1)
    assert boxed.getpixel((2, 540)) != red
    square = stories.picture_frame(Image.new("RGB", (1080, 1080), red), "9:16", scale=1)
    assert square.getpixel((540, 1900)) == GROUND


@needs_ffmpeg
def test_video_mixes_stills_and_clips_16x9(client, monkeypatch, tmp_path):
    out = narrate(client, monkeypatch)
    still = pictures(client, 1)[0]
    clip = upload_clip(client, tmp_path, 1.0)  # p2 runs about 1.9 s: held on its last frame
    r = client.post("/api/stories/video", json={
        "audio_job": out["id"], "aspect": "16:9", "use_music": False, "captions": True,
        "pages": [{"key": "p1", "media_id": still}, {"key": "p2", "media_id": clip}]})
    assert r.status_code == 202, r.text
    run_all()
    j = done_job(r.json()["job"]["id"])
    assert j.status == "done", j.error
    assert j.payload["videos"] == ["p2"]
    res = j.result
    assert res["duration"] == pytest.approx(out["result"]["full"]["duration"], abs=0.15)
    assert [c["key"] for c in res["chapters"]] == ["p1", "p2"]
    path = stories.story_dir(j.workspace_id, j.id) / res["file"]
    info = br.video_info(path)
    assert (info.width, info.height) == (1920, 1080) and info.has_audio and _chapters(path) == 2


@needs_ffmpeg
def test_video_9x16_clip_first_with_title_card(client, monkeypatch, tmp_path):
    out = narrate(client, monkeypatch)
    clip = upload_clip(client, tmp_path, 4.0, "768x1344")  # longer than p1: trimmed
    r = upload(client, "tall.jpg", png_bytes((1080, 1920), (90, 120, 60), "JPEG"), "image/jpeg")
    tall = r.json()["id"]
    r = client.post("/api/stories/video", json={
        "audio_job": out["id"], "aspect": "9:16", "use_music": False,
        "pages": [{"key": "p1", "media_id": clip}, {"key": "p2", "media_id": tall}],
        "title_card": {"title": "Pip and the First Snow", "seconds": 1.5}})
    assert r.status_code == 202, r.text
    run_all()
    j = done_job(r.json()["job"]["id"])
    assert j.status == "done", j.error
    assert j.payload["title_card"]["video"] is True
    res = j.result
    assert res["duration"] == pytest.approx(1.5 + out["result"]["full"]["duration"], abs=0.15)
    assert res["chapters"][0] == {"key": "p1", "start": 1.5}
    path = stories.story_dir(j.workspace_id, j.id) / res["file"]
    assert (br.video_info(path).width, br.video_info(path).height) == (1080, 1920) and _chapters(path) == 2


def test_video_page_must_be_a_picture_or_video(client, monkeypatch, tmp_path):
    out = narrate(client, monkeypatch)
    wav = tone(tmp_path / "beep.wav", 0.5)
    r = upload(client, "beep.wav", wav.read_bytes(), "audio/wav")
    assert r.status_code == 201, r.text
    body = {"audio_job": out["id"], "use_music": False,
            "pages": [{"key": "p1", "media_id": r.json()["id"]}, {"key": "p2", "media_id": pictures(client, 1)[0]}]}
    r = client.post("/api/stories/video", json=body)
    assert r.status_code == 422 and "picture or video" in r.json()["detail"]
    body["pages"][0]["media_id"] = "nope"
    assert client.post("/api/stories/video", json=body).status_code == 422


# ---------------------------------------------------------------- downloads

def test_download_route_serves_only_listed_files(client, anon, monkeypatch):
    out = narrate(client, monkeypatch)
    base = f"/api/stories/{out['id']}/files"
    r = client.get(f"{base}/p1.mp3")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and len(r.content) > 1000
    assert client.get(f"{base}/full.mp3").status_code == 200
    assert client.get(f"{base}/full_music.mp3").status_code == 404  # not made
    assert client.get(f"{base}/..%2F..%2Fmedia").status_code == 404
    assert client.get(f"{base}/%2E%2E%2Fp1.mp3").status_code == 404
    assert client.get(f"{base}/.work").status_code == 404
    assert anon.get(f"{base}/p1.mp3").status_code == 401

    # someone else's workspace: the same 404
    with SessionLocal() as db:
        other = Workspace(name="Elsewhere")
        db.add(other)
        db.flush()
        db.get(Job, out["id"]).workspace_id = other.id
        db.commit()
    assert client.get(f"{base}/p1.mp3").status_code == 404


def test_download_404_after_cleanup(client, monkeypatch):
    out = narrate(client, monkeypatch)
    ws = done_job(out["id"]).workspace_id
    folder = stories.story_dir(ws, out["id"])
    old = folder.stat().st_mtime - 8 * 86400
    os.utime(folder, (old, old))
    assert stories.prune_old(ws) == 1 and not folder.exists()
    assert client.get(f"/api/stories/{out['id']}/files/p1.mp3").status_code == 404


def test_file_names_from_results():
    assert stories.file_names({"pages": [{"file": "p1.mp3"}], "full": {"file": "full.mp3"},
                               "full_music": {"file": "full_music.mp3"}}) == {"p1.mp3", "full.mp3", "full_music.mp3"}
    video = {"file": "story_16x9.mp4", "srt": "story_16x9.srt"}
    assert stories.file_names(video) == {"story_16x9.mp4", "story_16x9.srt"}
    assert stories.file_names(None) == set()


def test_match_ignores_case_and_punctuation():
    assert stories.match("\"It's snowing!\" said Pip.", "it's snowing said pip") == 1.0
    assert stories.match("Snön föll på taket.", "snön föll på taket") == 1.0
    assert stories.match("one two three four", "one two") == pytest.approx(0.667, abs=0.01)
    assert stories.match("hello", "") == 0.0


# ---------------------------------------------------------------- AUDIO_ALLOW_NONCOMMERCIAL

def test_noncommercial_off_hides_and_refuses_omnivoice(client, monkeypatch):
    rows = {e["id"]: e for e in client.get("/api/voices/engines").json()}
    assert rows["omnivoice"]["noncommercial"] is True and "CC-BY-NC" in rows["omnivoice"]["licence"]
    assert voices.default_engine() == "omnivoice"

    monkeypatch.setattr(get_settings(), "audio_allow_noncommercial", False)
    assert [e["id"] for e in client.get("/api/voices/engines").json()] == ["voxcpm", "chatterbox", "kokoro"]
    assert voices.default_engine() == "voxcpm"
    r = client.post("/api/audio/speak", json={"text": "Hello there", "engine": "omnivoice", "language": "en"})
    assert r.status_code == 422 and r.json()["detail"] == "OmniVoice isn't available on this server right now."
    r = client.post("/api/audio/speak", json={"text": "Hello there", "engine": "auto", "language": "en"})
    assert r.status_code == 202 and r.json()["engine_resolved"] == "voxcpm"
    gallery = client.get("/api/voices/gallery").json()
    assert gallery["items"] and all(v["engine"] != "omnivoice" for v in gallery["items"])
    assert all(f["value"] != "omnivoice" for f in gallery["facets"]["engine"])
    omni = next(v for v in voice_gallery.catalogue().values() if v["engine"] == "omnivoice")
    assert client.post("/api/audio/speak", json={"text": "Hi", "voice_id": f"gallery:{omni['id']}"}).status_code == 422
    # MiniMax goes with it
    ids = [m["id"] for m in client.get("/api/models", params={"type": "audio"}).json()]
    assert "minimax_music3" not in ids
