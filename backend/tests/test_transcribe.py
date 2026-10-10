"""Transcribe (contract v18): timed transcripts, SRT / VTT cues, the LLM tidy-up and subtitles on a video."""
import json
import re
import sqlite3
import subprocess
from pathlib import Path

import httpx
import pytest

from app import transcripts as tr
from app.config import get_settings
from app.db import SessionLocal
from app.llm import set_transport
from app.models import Job, MediaItem, Transcript, Workspace
from tests.test_audio_edit import ff, upload_video
from tests.test_migrations import _alembic
from tests.test_storyboard import _run_all


def talking_clip(path: Path, seconds: float = 6.0) -> Path:
    ff("-f", "lavfi", "-i", f"color=c=black:s=160x90:r=24:d={seconds}", "-f", "lavfi", "-i",
       f"aevalsrc='0.4*sin(2*PI*(if(lt(t,2.4),300,900))*t)':s=48000:d={seconds}", "-c:v", "libx264",
       "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path))
    return path


def probe(path: Path) -> str:
    return subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-i", str(path)], capture_output=True,
                          text=True, encoding="utf-8", errors="replace").stderr


def reply(content: dict) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content, ensure_ascii=False)},
                                                  "finish_reason": "stop"}], "usage": {}})


@pytest.fixture
def tidy_llm():
    calls = []

    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        user = body["messages"][-1]["content"]
        calls.append(body["messages"][0]["content"])
        rows = [row.split(". ", 1) for row in user.split("\n")]
        return reply({"lines": [{"i": int(n), "text": text.replace("Mock", "Tidy")} for n, text in rows]})

    set_transport(httpx.MockTransport(handle))
    yield calls
    set_transport(None)


# ------------------------------------------------------------------ cues

def test_wrap_keeps_two_balanced_lines_of_42():
    assert tr.wrap("short line") == ["short line"]
    two = tr.wrap("This sentence is a little too long to sit on a single subtitle line")
    assert len(two) == 2 and all(len(x) <= 42 for x in two)
    assert abs(len(two[0]) - len(two[1])) < 12
    assert tr.wrap(" ".join(["word"] * 40)) is None


def test_cues_split_on_word_timings_and_by_length():
    words = [{"start": i * 0.4, "end": i * 0.4 + 0.35, "w": w} for i, w in enumerate(
        "The boat left at dawn. Nobody on the deck said a word about the storm that was coming in from "
        "the west that night".split())]
    seg = {"start": 0.0, "end": words[-1]["end"], "text": " ".join(w["w"] for w in words), "words": words}
    cues = tr.cues([seg])
    assert len(cues) >= 2
    assert cues[0][2] == "The boat left at dawn."  # a sentence end is a natural break
    for a, b, text in cues:
        assert b > a and b - a <= tr.MAX_CUE_S + 0.01
        assert tr.wrap(text) is not None
    assert all(cues[i][1] <= cues[i + 1][0] for i in range(len(cues) - 1))

    # no word timings: the time is shared out by the length of each piece
    long = {"start": 10.0, "end": 20.0, "text": " ".join(["alpha"] * 30)}
    parts = tr.cues([long])
    assert len(parts) >= 2 and parts[0][0] == 10.0 and parts[-1][1] == pytest.approx(20.0, abs=0.01)


def test_srt_and_vtt_formats():
    items = [(0.0, 1.5, "Hello there."), (3661.25, 3663.0, "This line is long enough to need two lines here")]
    srt = tr.to_srt(items)
    assert srt.startswith("1\n00:00:00,000 --> 00:00:01,500\nHello there.\n")
    assert "2\n01:01:01,250 --> 01:01:03,000\n" in srt
    block = srt.split("\n\n")[1].strip().split("\n")
    assert len(block) == 4 and all(len(x) <= 42 for x in block[2:])
    vtt = tr.to_vtt(items)
    assert vtt.startswith("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello there.\n")


# ------------------------------------------------------------------ the API

def test_0015_adds_dub_project_and_transcript(tmp_path):
    db = tmp_path / "prod-copy.db"
    _alembic(db, "upgrade", "0015")
    con = sqlite3.connect(db)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"dub_project", "transcript"} <= tables
    cols = {r[1] for r in con.execute("PRAGMA table_info(dub_project)")}
    assert {"video_id", "video_generation_id", "targets", "stages", "segments", "speakers", "glossary",
            "settings", "tracks", "job_id"} <= cols
    con.close()
    _alembic(db, "downgrade", "0014")
    con = sqlite3.connect(db)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "dub_project" not in tables and "transcript" not in tables and "voice_script" in tables
    con.close()
    _alembic(db, "upgrade", "head")


def test_transcribe_a_video_and_download_subtitles(client, tmp_path, fast_driver):
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4"))
    r = client.post("/api/transcribe", json={"media_id": video["id"], "language": "auto"})
    assert r.status_code == 202, r.text
    job = r.json()["job"]
    assert job["type"] == "transcribe" and job["lane"] == "audio"
    tid = r.json()["transcript_id"]
    assert client.get(f"/api/transcripts/{tid}").json()["status"] == "queued"
    _run_all(fast_driver)

    t = client.get(f"/api/transcripts/{tid}").json()
    assert t["status"] == "done" and t["language"] == "en" and t["media_id"] == video["id"]
    assert len(t["segments"]) == 3 and t["text"].startswith("This is a mock transcript")
    w = t["segments"][0]["words"][0]
    assert set(w) == {"start", "end", "w"} and w["w"] == "This"
    assert t["media"]["id"] == video["id"] and t["duration_s"] == pytest.approx(6.0, abs=0.1)
    assert [x["id"] for x in client.get("/api/transcripts").json()] == [tid]

    r = client.get(f"/api/transcripts/{tid}/subtitles?format=srt")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    assert r.headers["content-disposition"].endswith('.srt"')
    assert r.text.startswith("1\n00:00:00,000 --> ")
    vtt = client.get(f"/api/transcripts/{tid}/subtitles?format=vtt")
    assert vtt.text.startswith("WEBVTT") and "text/vtt" in vtt.headers["content-type"]
    assert client.get(f"/api/transcripts/{tid}/subtitles?format=ass").status_code == 422


def test_transcribe_refuses_images_and_silence(client, tmp_path):
    from tests.test_library import png_bytes, upload

    img = upload(client, "a.png", png_bytes(), "image/png").json()
    assert client.post("/api/transcribe", json={"media_id": img["id"]}).status_code == 422
    silent = tmp_path / "silent.mp4"
    ff("-f", "lavfi", "-i", "color=c=black:s=160x90:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(silent))
    v = upload_video(client, silent)
    r = client.post("/api/transcribe", json={"media_id": v["id"]})
    assert r.status_code == 422 and "no sound" in r.json()["detail"]
    assert client.post("/api/transcribe", json={"media_id": "nope"}).status_code == 404


def test_cleanup_with_the_llm(client, tmp_path, fast_driver, tidy_llm):
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4"))
    tid = client.post("/api/transcribe", json={"media_id": video["id"], "cleanup": True,
                                               "words": False}).json()["transcript_id"]
    _run_all(fast_driver)
    t = client.get(f"/api/transcripts/{tid}").json()
    assert t["status"] == "done" and len(tidy_llm) == 1 and "filler" in tidy_llm[0]
    assert "words" not in t["segments"][0]
    assert t["segments"][1]["clean"] == "Tidy line 2 of the transcript."
    assert "Tidy line 3" in t["cleanup_text"] and "Mock" not in t["cleanup_text"]
    srt = client.get(f"/api/transcripts/{tid}/subtitles?clean=true").text
    assert "Tidy line 2" in srt and "Mock line 2" not in srt
    assert "Mock line 2" in client.get(f"/api/transcripts/{tid}/subtitles").text

    # asked again later, through its own endpoint
    r = client.post(f"/api/transcripts/{tid}/cleanup")
    assert r.status_code == 202 and r.json()["type"] == "transcript_cleanup" and r.json()["lane"] == "general"
    _run_all(fast_driver)
    assert len(tidy_llm) == 2


def test_failed_cleanup_keeps_the_transcript(client, tmp_path, fast_driver):
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4"))
    tid = client.post("/api/transcribe", json={"media_id": video["id"], "cleanup": True}).json()["transcript_id"]
    _run_all(fast_driver)  # no LLM listens in the tests
    t = client.get(f"/api/transcripts/{tid}").json()
    assert t["status"] == "done" and t["cleanup_text"] is None and t["error"].startswith("Cleanup failed")
    assert client.get(f"/api/transcripts/{tid}/subtitles").status_code == 200


def test_subtitles_onto_the_video_as_a_new_version(client, tmp_path, fast_driver):
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4"))
    tid = client.post("/api/transcribe", json={"media_id": video["id"], "language": "en"}).json()["transcript_id"]
    _run_all(fast_driver)
    r = client.post(f"/api/transcripts/{tid}/video", json={"mode": "soft"})
    assert r.status_code == 202, r.text
    assert r.json()["job"]["type"] == "transcript_video" and r.json()["job"]["lane"] == "general"
    _run_all(fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, r.json()["job"]["id"])
        assert job.status == "done", job.error
        item = db.get(MediaItem, video["id"])
        assert item.generation_id == r.json()["generation_id"]
        path = get_settings().data_dir / job.result["file_path"]
    info = probe(path)
    assert len(re.findall(r"Stream #\S+.*?: Subtitle: mov_text", info)) == 1
    assert re.search(r"Stream #\S+\(eng\).*?: Subtitle", info)
    assert len(re.findall(r"Stream #\S+.*?: Audio:", info)) == 1


def test_subtitles_burned_in(client, tmp_path, fast_driver):
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4", 3.0))
    tid = client.post("/api/transcribe", json={"media_id": video["id"]}).json()["transcript_id"]
    _run_all(fast_driver)
    r = client.post(f"/api/transcripts/{tid}/video", json={"mode": "burn"})
    _run_all(fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, r.json()["job"]["id"])
        if job.status == "failed" and "fontconfig" in (job.error or "").lower():
            pytest.skip("this ffmpeg build has no fonts for libass")
        assert job.status == "done", job.error
        info = probe(get_settings().data_dir / job.result["file_path"])
    assert "Subtitle" not in info and re.search(r"Video: h264", info)


def test_transcript_is_private_to_its_workspace(client, tmp_path, fast_driver):
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4", 2.0))
    tid = client.post("/api/transcribe", json={"media_id": video["id"]}).json()["transcript_id"]
    with SessionLocal() as db:
        db.add(Workspace(id="ws-other", name="Other"))
        db.flush()
        db.get(Transcript, tid).workspace_id = "ws-other"
        db.commit()
    assert client.get(f"/api/transcripts/{tid}").status_code == 404
    assert client.get("/api/transcripts").json() == []
