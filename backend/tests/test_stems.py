"""Stems (contract v21): two- and four-stem splits into new Library items, with the mock driver."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import audio_analysis as aa
from app import thumbs, venv_runner
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import ComfyDriver
from app.drivers.mock import MockDriver
from app.lanes import lane_for
from app.models import Generation, Job, MediaItem, Workspace
from app.stems import source_tag
from tests.test_audio_edit import ff, tone, upload_audio, upload_video
from tests.test_storyboard import _run_all
from tests.test_transcribe import talking_clip

RUNNERS = Path(__file__).resolve().parents[1] / "runners"


def split(client, item_id, **body):
    r = client.post(f"/api/audio/{item_id}/stems", json=body)
    assert r.status_code == 202, r.text
    assert r.json()["items"] == []
    return r.json()["job"]


def finished(job_id) -> Job:
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job.status == "done", job.error
        return job


def test_two_stems_of_a_track(client, tmp_path, fast_driver):
    a = upload_audio(client, tone(tmp_path / "song.wav", 2.0, 330), title="Harbour song")
    job = split(client, a["id"])
    assert job["type"] == "audio_stems" and job["lane"] == "audio"
    _run_all(fast_driver)
    res = finished(job["id"]).result
    assert res["mode"] == "two" and list(res["stems"]) == ["vocals", "instrumental"] and len(res["items"]) == 2

    with SessionLocal() as db:
        for name, item_id in res["stems"].items():
            item = db.get(MediaItem, item_id)
            g = db.get(Generation, item.generation_id)
            assert item.kind == "audio" and item.origin == "generated"
            assert item.title == f"Harbour song — {name.title()}"
            assert item.tags == ["stems", source_tag(a["id"])] and len(item.tags[1]) <= 40
            assert g.params["kind"] == "stem" and g.params["stem"] == name and g.params["source_id"] == a["id"]
            assert g.params["mode"] == "two" and g.status == "ready" and g.media_type == "audio/flac"
            path = get_settings().data_dir / g.file_path
            info = aa.stream_info(path)
            assert info.sample_rate == 48000 and info.duration == pytest.approx(2.0, abs=0.05)
            # the finished hooks ran: waveform thumb and loudness are there for the tiles
            assert thumbs.wave_file(path).is_file() and aa.analysis_file(path).is_file()

    out = client.get(f"/api/audio/{a['id']}/stems").json()
    assert out["source_id"] == a["id"] and out["jobs"] == []
    assert len(out["splits"]) == 1 and out["splits"][0]["id"] == job["id"]
    assert out["splits"][0]["stems"] == ["vocals", "instrumental"]
    assert [i["title"] for i in out["items"]] == ["Harbour song — Vocals", "Harbour song — Instrumental"]
    assert out["items"][0]["media_url"] and out["items"][0]["analysis"] is not None


def test_four_stems_of_a_video_and_the_list_newest_first(client, tmp_path, fast_driver):
    v = upload_video(client, talking_clip(tmp_path / "talk.mp4", 3.0))
    first = split(client, v["id"], mode="two")
    _run_all(fast_driver)
    job = split(client, v["id"], mode="four")
    _run_all(fast_driver)
    res = finished(job["id"]).result
    assert list(res["stems"]) == ["vocals", "drums", "bass", "other"] and res["model"] == get_settings().stems_four_model
    with SessionLocal() as db:
        for item_id in res["items"]:
            g = db.get(Generation, db.get(MediaItem, item_id).generation_id)
            info = aa.stream_info(get_settings().data_dir / g.file_path)
            assert not info.has_video and info.sample_rate == 48000
            assert info.duration == pytest.approx(3.0, abs=0.1)

    out = client.get(f"/api/audio/{v['id']}/stems").json()
    assert [s["id"] for s in out["splits"]] == [job["id"], first["id"]]
    assert out["splits"][0]["mode"] == "four" and out["splits"][0]["stems"] == ["vocals", "drums", "bass", "other"]
    assert len(out["items"]) == 6
    # stems are ordinary Library audio items
    lib = client.get("/api/media", params={"kind": "audio", "tag": source_tag(v["id"])}).json()["items"]
    assert len(lib) == 6


def test_one_split_at_a_time_and_readable_errors(client, tmp_path, fast_driver):
    a = upload_audio(client, tone(tmp_path / "a.wav", 1.0))
    split(client, a["id"], mode="four")
    r = client.post(f"/api/audio/{a['id']}/stems", json={"mode": "four"})
    assert r.status_code == 409 and "already" in r.json()["detail"]
    listed = client.get(f"/api/audio/{a['id']}/stems").json()
    assert [j["type"] for j in listed["jobs"]] == ["audio_stems"] and listed["splits"] == []

    assert client.post("/api/audio/nope/stems", json={}).status_code == 404
    assert client.get("/api/audio/nope/stems").json()["detail"] == "Track not found"
    assert client.post(f"/api/audio/{a['id']}/stems", json={"mode": "six"}).status_code == 422
    assert client.post(f"/api/audio/{a['id']}/stems", json={"version": "nope"}).status_code == 404

    from tests.test_library import png_bytes, upload

    img = upload(client, "a.png", png_bytes(), "image/png").json()
    r = client.post(f"/api/audio/{img['id']}/stems", json={})
    assert r.status_code == 422 and "audio clip or a video" in r.json()["detail"]
    silent = tmp_path / "silent.mp4"
    ff("-f", "lavfi", "-i", "color=c=black:s=160x90:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(silent))
    r = client.post(f"/api/audio/{upload_video(client, silent)['id']}/stems", json={})
    assert r.status_code == 422 and r.json()["detail"] == "This video has no sound to split"


def test_a_failed_split_leaves_nothing_behind(client, tmp_path, fast_driver, monkeypatch):
    a = upload_audio(client, tone(tmp_path / "a.wav", 1.0))

    real = MockDriver.separate_stems

    def no_bass(self, *args):
        return {k: v for k, v in real(self, *args).items() if k != "bass"}

    monkeypatch.setattr(MockDriver, "separate_stems", no_bass)
    job = split(client, a["id"], mode="four")
    _run_all(fast_driver)
    with SessionLocal() as db:
        j = db.get(Job, job["id"])
        assert j.status == "failed" and j.error == "The model didn't write bass"
        assert db.query(MediaItem).filter(MediaItem.title.like("% — %")).count() == 0
    assert client.get(f"/api/audio/{a['id']}/stems").json()["splits"] == []


def test_stems_stay_in_their_workspace(client, tmp_path, fast_driver):
    a = upload_audio(client, tone(tmp_path / "a.wav", 1.0))
    with SessionLocal() as db:
        db.add(Workspace(id="ws-other", name="Other"))
        db.flush()
        db.get(MediaItem, a["id"]).workspace_id = "ws-other"
        db.commit()
    assert client.post(f"/api/audio/{a['id']}/stems", json={}).status_code == 404
    assert client.get(f"/api/audio/{a['id']}/stems").status_code == 404


def test_lane():
    assert lane_for("audio_stems") == "audio"


# ------------------------------------------------------------------ the runner

def test_comfy_driver_sends_four_stem_splits_to_the_runner(tmp_path, monkeypatch):
    calls = []

    def run(runner, venv, job, *, lane=None, progress=None, need_gb=0.0, **kw):
        calls.append((runner, venv, lane, job))
        out = Path(job["out_dir"])
        return {"stems": {n: str(tone(out / f"x_({n.title()}).wav", 0.5)) for n in ("vocals", "drums", "bass", "other")}}

    monkeypatch.setattr(venv_runner, "run", run)
    res = ComfyDriver(lane="image").separate_stems(tone(tmp_path / "s.wav", 0.5), tmp_path / "out", "htdemucs_ft.yaml",
                                                   lambda f, m: None)
    assert sorted(res) == ["bass", "drums", "other", "vocals"] and all(p.is_file() for p in res.values())
    runner, venv, lane, job = calls[0]
    assert (runner, venv, lane) == ("separate_vocals", "audio-utils", "image")
    assert job["all_stems"] is True and job["model"] == "htdemucs_ft.yaml" and job["model_dir"]


def test_runner_compiles_and_stays_out_of_app():
    import py_compile

    py_compile.compile(str(RUNNERS / "separate_vocals.py"), doraise=True)
    src = (RUNNERS / "separate_vocals.py").read_text(encoding="utf-8")
    assert "from app" not in src and "rio.main(run)" in src


FAKE_SEPARATOR = '''
import os


class Separator:
    def __init__(self, model_file_dir, output_dir, output_format):
        self.out = output_dir

    def load_model(self, model_filename):
        self.model = model_filename.split(".")[0]

    def separate(self, path):
        base = os.path.splitext(os.path.basename(path))[0]
        names = os.environ["FAKE_STEMS"].split(",")
        files = [f"{base}_({n})_{self.model}.wav" for n in names]
        for f in files:
            open(os.path.join(self.out, f), "wb").close()
        return files
'''


def _run_runner(tmp_path, stems: str, **job):
    pkg = tmp_path / "fake" / "audio_separator"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "separator.py").write_text(FAKE_SEPARATOR)
    src = tmp_path / "Song (live).wav"
    src.write_bytes(b"")
    job = {"audio": str(src), "out_dir": str(tmp_path / "out"), "model_dir": str(tmp_path / "models"), **job}
    env = {**os.environ, "PYTHONPATH": str(tmp_path / "fake"), "FAKE_STEMS": stems}
    r = subprocess.run([sys.executable, str(RUNNERS / "separate_vocals.py")], input=json.dumps(job), text=True,
                       capture_output=True, env=env, timeout=60)
    last = json.loads(r.stdout.strip().splitlines()[-1])
    return r.returncode, last


def test_runner_names_every_stem_and_keeps_the_dub_pair(tmp_path):
    code, msg = _run_runner(tmp_path, "Vocals,Drums,Bass,Other", model="htdemucs_ft.yaml", all_stems=True)
    assert code == 0, msg
    stems = msg["done"]["stems"]
    # the "(live)" in the source's own name isn't taken for a stem
    assert sorted(stems) == ["bass", "drums", "other", "vocals"]
    assert stems["drums"].endswith("Song (live)_(Drums)_htdemucs_ft.wav")


def test_runner_dub_contract(tmp_path):
    code, msg = _run_runner(tmp_path, "Vocals,Instrumental", model="melband.ckpt")
    assert code == 0, msg
    done = msg["done"]
    assert done["vocals"].endswith("(Vocals)_melband.wav") and done["instrumental"].endswith("(Instrumental)_melband.wav")
    assert sorted(done["stems"]) == ["instrumental", "vocals"]


def test_runner_refuses_stems_it_cannot_tell_apart(tmp_path):
    code, msg = _run_runner(tmp_path, "Piano", model="m.ckpt")
    assert code == 1 and "Couldn't tell the stems apart" in msg["error"]
