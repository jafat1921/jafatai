"""Audio Studio A1 (contract v14): lane, mock driver, /audio/generate, uploads, waveforms, lyrics, templates."""
import json
import subprocess
from pathlib import Path

import httpx
import pytest

from app import estimate as est
from app import models_catalog as mc
from app import reel, thumbs, worker
from app.config import get_settings
from app.db import SessionLocal
from app.drivers.comfy import audio_plan, style_tags
from app.drivers.comfy_client import parse_outputs
from app.lanes import gpu_lane, lane_for
from app.llm import set_transport
from app.models import Generation, Job, MediaItem
from app.workflows import build, check_template, find_node
from app.worker import process_one
from tests.test_library import upload
from tests.test_storyboard import _run_all

AUDIO_INFO = Path(__file__).parent / "fixtures" / "object_info_audio.json"
URDU = "دل کی بات"


def gen(client, **body):
    body.setdefault("prompt", "warm acoustic folk, fingerpicked guitar")
    body.setdefault("duration_s", 3)
    return client.post("/api/audio/generate", json=body)


def tone(path: Path, seconds: float = 1.5, *args: str) -> bytes:
    subprocess.run([get_settings().ffmpeg_path(), "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                    f"sine=frequency=440:duration={seconds}", *args, str(path)], check=True, capture_output=True)
    return path.read_bytes()


# ------------------------------------------------------------------ lane

def test_audio_kinds_get_their_own_lane():
    for kind in ("song", "music", "sfx", "speech"):
        assert lane_for("generate", kind) == "audio"
    assert gpu_lane(("video", "audio")) == "video"
    assert gpu_lane(("image", "audio")) == "image"
    assert gpu_lane(("audio",)) == "image" and gpu_lane(None) == "image"


def test_both_gpu_workers_claim_audio_and_drive_their_own_gpu(client, db, monkeypatch):
    from app.drivers.mock import MockDriver

    seen = []

    def fake_get_driver(name, lane=None):
        seen.append(lane)
        return MockDriver(step_seconds=0)

    monkeypatch.setattr(worker, "get_driver", fake_get_driver)
    jobs = gen(client, kind="music", count=2).json()["jobs"]
    assert {db.get(Job, j["id"]).lane for j in jobs} == {"audio"}

    assert not process_one(lanes=("general",))  # the CPU worker leaves it alone
    assert process_one(lanes=("video", "audio"))
    assert process_one(lanes=("image", "audio"))
    assert seen == ["video", "image"]

    gen(client, kind="sfx")
    assert process_one()  # the all-lanes dev worker uses the image GPU
    assert seen[-1] == "image"


def test_heartbeat_maps_audio_to_the_workers_gpu(db, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "comfy_image_urls", ["http://img:8188"])
    monkeypatch.setattr(s, "comfy_video_urls", ["http://vid:8189"])
    monkeypatch.setattr(worker, "WORKER_ID", "box:video-audio")
    worker.beat(db, ("video", "audio"))
    hb = db.get(worker.WorkerHeartbeat, "box:video-audio")
    assert hb.info["comfy"] == {"video": ["http://vid:8189"], "audio": ["http://vid:8189"]}


# ------------------------------------------------------------------ generate (mock driver)

def test_generate_song_runs_to_a_flac_of_the_asked_length(client, fast_driver):
    r = gen(client, kind="song", lyrics="[verse]\nla la la", vocal="female", bpm=96, seed=7, duration_s=3.5,
            title="Morning song")
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["model_resolved"] == "ace15_turbo" and len(out["items"]) == 1 and len(out["jobs"]) == 1
    item = out["items"][0]
    assert item["kind"] == "audio" and item["title"] == "Morning song" and item["duration_s"] == 3.5
    assert item["width"] is None and item["height"] is None

    _run_all(fast_driver)
    item = client.get(f"/api/media/{item['id']}").json()
    assert item["status"] == "ready" and item["media_type"] == "audio/flac" and item["media_url"].endswith(".flac")
    assert item["duration_s"] == pytest.approx(3.5, abs=0.05)
    with SessionLocal() as db:
        g = db.get(Generation, item["generation_id"])
        assert g.kind == "song" and g.seed == 7
        assert g.params["lyrics"] == "[verse]\nla la la" and g.params["vocal"] == "female" and g.params["bpm"] == 96
        assert g.params["language"] == "en" and g.params["model"] == "ace15_turbo" and g.params["kind"] == "song"
        path = get_settings().data_dir / g.file_path
    assert reel.probe(path).duration == pytest.approx(3.5, abs=0.05)
    assert path.read_bytes()[:4] == b"fLaC"

    # the waveform is the tile, and the file plays with ranges (seeking in <audio>)
    assert item["thumb_url"]
    t = client.get(item["thumb_url"])
    assert t.status_code == 200 and t.headers["content-type"] == "image/png"
    assert thumbs.wave_file(path).is_file()
    from PIL import Image

    with Image.open(thumbs.wave_file(path)) as im:
        assert im.size == (800, 160) and im.mode == "RGBA"
    m = client.get(item["media_url"], headers={"Range": "bytes=0-99"})
    assert m.status_code == 206 and m.headers["content-type"] == "audio/flac" and len(m.content) == 100


@pytest.mark.parametrize("kind,model", [("song", "ace15_turbo"), ("music", "sa3_small_music"),
                                        ("sfx", "sa3_small_sfx")])
def test_each_kind_gets_its_default_model_and_count_makes_takes(client, kind, model, fast_driver):
    r = gen(client, kind=kind, count=2, seed=40, model="auto" if kind == "music" else None)
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["model_resolved"] == model and len(out["items"]) == 2 and len(out["jobs"]) == 2
    with SessionLocal() as db:
        gens = [db.get(Generation, i["generation_id"]) for i in out["items"]]
        assert [g.seed for g in gens] == [40, 41] and {g.kind for g in gens} == {kind}
        if kind != "song":
            assert "lyrics" not in gens[0].params
    _run_all(fast_driver)
    rows = client.get("/api/media", params={"kind": "audio"}).json()["items"]
    assert len(rows) == 2 and all(x["media_type"] == "audio/flac" for x in rows)


def test_generate_errors_are_readable(client, db):
    def detail(**body):
        r = gen(client, **body)
        assert r.status_code == 422, r.text
        return r.json()["detail"]

    assert "not songs" in detail(kind="song", model="sa3_small_sfx")
    assert "up to 120 s" in detail(kind="music", model="sa3_small_music", duration_s=200)
    assert "turned off" in detail(kind="song", model="minimax_music3")
    assert "choose one of: ace15_turbo, sa3_small_music" in detail(kind="song", model="zimage_turbo")
    assert detail(kind="song", prompt="   ") == "A prompt is required"
    assert gen(client, kind="song", duration_s=400).status_code == 422
    assert gen(client, kind="speech").status_code == 422  # A3

    # Medium takes long pieces the small model can't
    assert gen(client, kind="music", model="sa3_medium", duration_s=300).status_code == 202

    # a timbre reference: ACE-Step only, and it has to be audio
    pic = client.post("/api/images/generate", json={"prompt": "a lighthouse"}).json()["items"][0]
    assert "pick ACE-Step" in detail(kind="music", timbre_ref_id=pic["id"])
    assert "isn't a finished audio clip" in detail(kind="song", timbre_ref_id=pic["id"])


def test_timbre_reference_is_recorded(client, tmp_path, fast_driver):
    ref = upload(client, "voice.wav", tone(tmp_path / "v.wav"), "audio/wav").json()
    r = gen(client, kind="song", lyrics="[chorus]\nhey", timbre_ref_id=ref["id"])
    assert r.status_code == 202, r.text
    with SessionLocal() as db:
        g = db.get(Generation, r.json()["items"][0]["generation_id"])
        assert g.params["timbre_ref_id"] == ref["generation_id"]


def test_minimax_hidden_unless_allowed(client, monkeypatch):
    ids = [m["id"] for m in client.get("/api/models", params={"type": "audio"}).json()]
    assert ids == ["auto", "ace15_turbo", "sa3_small_music", "sa3_medium", "sa3_small_sfx"]

    monkeypatch.setattr(get_settings(), "audio_allow_noncommercial", True)
    rows = {m["id"]: m for m in client.get("/api/models", params={"type": "audio"}).json()}
    mm = rows["minimax_music3"]
    assert mm["label"] == "MiniMax-Music3" and mm["extra"]["noncommercial"] is True
    assert "MiniMax-Music3 Community Licence" in mm["description"] and mm["max_duration_s"] == 240
    assert rows["ace15_turbo"]["extra"] == {"licence": "MIT licence: free for commercial use"}
    assert "Stability AI Community Licence" in rows["sa3_medium"]["extra"]["licence"]
    assert rows["sa3_medium"]["max_duration_s"] == 380 and rows["ace15_turbo"]["capabilities"] == [
        "song", "lyrics", "vocals", "timbre_ref"]
    assert gen(client, kind="song", model="minimax_music3").json()["model_resolved"] == "minimax_music3"


def test_estimate_for_audio_scales_with_length_and_takes(client):
    one = client.get("/api/estimate", params={"kind": "audio", "model": "ace15_turbo", "duration_s": 60}).json()
    four = client.get("/api/estimate", params={"kind": "audio", "model": "ace15_turbo", "duration_s": 60,
                                               "count": 4}).json()
    assert one["basis"] == "rough" and one["model"] == "ace15_turbo" and one["units"] == 60
    assert four["units"] == 240 and four["high_s"] > one["high_s"]
    assert client.get("/api/estimate", params={"kind": "audio", "model": "zimage_turbo"}).status_code == 422

    # measured once there's history: GPU seconds per output second
    rows = [{"comfy": {"template": "sa3_music", "gpu_seconds": 6.0}, "duration_s": 60.0}] * 3
    assert est.sample(rows[0], None) == ("sa3_small_music", 0.0, 0.1)
    assert mc.measured_seconds(rows)["sa3_music"] == pytest.approx(0.1)


# ------------------------------------------------------------------ uploads

@pytest.mark.parametrize("name,args,mime", [
    ("take.wav", (), "audio/wav"),
    ("take.mp3", ("-c:a", "libmp3lame"), "audio/mpeg"),
    ("take.m4a", ("-c:a", "aac"), "audio/mp4"),
    ("take.flac", (), "audio/flac"),
    ("take.ogg", ("-c:a", "libvorbis"), "audio/ogg"),
])
def test_upload_audio_becomes_an_audio_item(client, tmp_path, name, args, mime):
    data = tone(tmp_path / name, 1.5, *args)
    r = upload(client, name, data, "application/octet-stream")
    assert r.status_code == 201, r.text
    item = r.json()
    assert item["kind"] == "audio" and item["media_type"] == mime and item["width"] is None
    assert item["duration_s"] == pytest.approx(1.5, abs=0.1)
    assert client.get(item["thumb_url"]).headers["content-type"] == "image/png"
    assert client.get(item["media_url"]).status_code == 200
    assert client.get("/api/media", params={"kind": "audio"}).json()["items"][0]["id"] == item["id"]


def test_audio_only_mp4_is_audio_not_a_broken_video(client, tmp_path):
    r = upload(client, "memo.mp4", tone(tmp_path / "memo.mp4", 1.0, "-c:a", "aac", "-f", "mp4"))
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "audio" and r.json()["media_type"] == "audio/mp4"


def test_upload_rejects_non_audio_and_names_audio_in_the_help(client):
    r = upload(client, "x.mp3", b"not really an mp3 at all, just text" * 4)
    assert r.status_code == 415 and "FLAC" in r.json()["detail"]


def test_deleting_an_audio_item_removes_its_waveform(client, tmp_path):
    item = upload(client, "a.wav", tone(tmp_path / "a.wav"), "audio/wav").json()
    with SessionLocal() as db:
        path = get_settings().data_dir / db.get(Generation, item["generation_id"]).file_path
    assert thumbs.wave_file(path).is_file()
    assert client.delete(f"/api/media/{item['id']}").status_code == 204
    assert not path.exists() and not thumbs.wave_file(path).exists()


# ------------------------------------------------------------------ lyrics

class FakeWriter:
    def __init__(self, reply):
        self.reply = reply
        self.messages = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.messages = json.loads(request.content)["messages"]
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(self.reply)},
                                                      "finish_reason": "stop"}], "usage": {}})


@pytest.fixture
def writer():
    def install(reply):
        fake = FakeWriter(reply)
        set_transport(httpx.MockTransport(fake))
        return fake
    yield install
    set_transport(None)


def test_lyrics_in_urdu_script(client, writer):
    fake = writer({"lyrics": f"[Verse 1]\n{URDU}\n\n\n\n[CHORUS]\n{URDU}", "tags": " ghazal,  harmonium, male vocal "})
    r = client.post("/api/audio/lyrics", json={"topic": "monsoon longing", "language": "ur", "mood": "tender",
                                                "sections": ["verse", "chorus"]})
    assert r.status_code == 200, r.text
    assert r.json() == {"lyrics": f"[verse]\n{URDU}\n\n[chorus]\n{URDU}", "tags": "ghazal, harmonium, male vocal"}
    system, user = fake.messages[0]["content"], fake.messages[-1]["content"]
    assert "Urdu" in system and "Urdu script" in system and "[verse], [chorus]" in system
    assert "monsoon longing" in user and "tender" in user


def test_lyrics_roman_urdu_and_default_sections(client, writer):
    fake = writer({"lyrics": "[verse]\ndil ki baat", "tags": "pop"})
    assert client.post("/api/audio/lyrics", json={"topic": "first love", "language": "ur-latn"}).status_code == 200
    system = fake.messages[0]["content"]
    assert "Roman Urdu" in system and "Latin letters" in system
    assert "[verse], [chorus], [verse], [chorus], [bridge], [chorus]" in system


def test_lyrics_offline_is_503(client):
    r = client.post("/api/audio/lyrics", json={"topic": "the sea", "language": "en"})
    assert r.status_code == 503 and r.json()["detail"] == "The lyrics writer is offline"


# ------------------------------------------------------------------ prompt templates

def test_audio_prompt_templates(client):
    rows = client.get("/api/prompt-templates", params={"type": "audio"}).json()
    assert len(rows) >= 12 and {r["type"] for r in rows} == {"audio"}
    assert {r["category"] for r in rows} == {"Song", "Score", "Sound effects", "Ambience"}
    assert {"audio-qawwali", "audio-ghazal", "audio-bollywood-romance"} <= {r["id"] for r in rows}
    for t in rows:
        d = t["defaults"]
        m = mc.audio_default(d["kind"])
        assert d["duration_s"] <= m.max_duration_s and set(t["examples"]), t["id"]

    r = client.post("/api/prompt-templates/audio-qawwali/start").json()
    assert r["target"] == "audio"
    p = r["prefill"]
    assert p["kind"] == "song" and p["language"] == "ur" and "[verse]" in p["lyrics"]
    assert p["template_id"] == "audio-qawwali" and set(p["placeholders"]) == {"theme", "setting"}


# ------------------------------------------------------------------ ComfyUI workflows

def node(graph, title):
    return graph[find_node(graph, title)]["inputs"]


@pytest.mark.parametrize("name", ["ace15_song", "sa3_music", "sa3_medium", "sa3_sfx", "minimax_music3"])
def test_audio_templates_pass_against_the_audio_object_info(name):
    info = json.loads(AUDIO_INFO.read_text())
    assert check_template(name, info)["ok"], check_template(name, info)


def test_ace_song_graph():
    g, resolved = build("ace15_song", {"tags": "qawwali, harmonium", "lyrics": "[verse]\nx", "seed": 9, "bpm": 92,
                                       "duration_s": 45, "language": "ur"})
    enc = node(g, "Encode")
    assert enc["tags"] == "qawwali, harmonium" and enc["lyrics"] == "[verse]\nx" and enc["language"] == "ur"
    assert enc["seed"] == 9 == node(g, "Sampler")["seed"] and enc["bpm"] == 92
    assert enc["duration"] == 45.0 == node(g, "Latent")["seconds"]
    # no reference clip: the timbre nodes go and the sampler reads the text conditioning directly
    titles = {n["_meta"]["title"] for n in g.values()}
    assert not titles & {"TimbreAudio", "TimbreEncode", "Timbre"}
    assert node(g, "Sampler")["positive"] == [find_node(g, "Encode"), 0]
    assert resolved["timbre_audio"] is None

    g, _ = build("ace15_song", {"tags": "x", "timbre_audio": "mixai/ref.wav", "audio_codes": False})
    assert node(g, "TimbreAudio")["audio"] == "mixai/ref.wav"
    assert node(g, "Sampler")["positive"] == [find_node(g, "Timbre"), 0]
    assert node(g, "Encode")["generate_audio_codes"] is False


def test_sa3_and_minimax_graphs():
    g, _ = build("sa3_sfx", {"prompt": "door slam", "duration_s": 4, "seed": 3})
    assert node(g, "Positive")["text"] == "door slam" and node(g, "Latent")["seconds"] == 4.0
    assert node(g, "Checkpoint")["ckpt_name"] == "stable_audio_3_small_sfx.safetensors"
    g, _ = build("sa3_medium", {"prompt": "x", "duration_s": 300, "steps": 12})
    assert node(g, "Sampler")["steps"] == 12 and node(g, "Latent")["seconds"] == 300.0
    g, _ = build("minimax_music3", {"caption": "city pop", "lyrics": "[verse]\nhi", "duration_s": 90, "seed": 5})
    assert node(g, "Encode")["max_duration"] == 90.0 and node(g, "Encode")["caption"] == "city pop"
    assert node(g, "Latent")["seconds"] == [find_node(g, "Encode"), 1]  # the encoder decides the length


class Lookup:
    def __init__(self, tmp_path):
        self.tmp = tmp_path

    def generation_file(self, gen_id):
        p = self.tmp / f"{gen_id}.wav"
        p.write_bytes(b"RIFF")
        return p


def test_audio_plans(tmp_path):
    lk = Lookup(tmp_path)
    p = audio_plan("song", "dreamy synth pop", {"model": "ace15_turbo", "duration_s": 60, "lyrics": "[verse]\nhi",
                                                "vocal": "female", "bpm": 100, "language": "ur-latn"}, 4, lk)
    assert p.template == "ace15_song" and p.media == "audio"
    assert p.inputs["tags"] == "dreamy synth pop, female vocals, 100 bpm" and p.inputs["language"] == "ur"
    assert p.inputs["bpm"] == 100 and p.inputs["seed"] == 4 and p.inputs["duration_s"] == 60
    p = audio_plan("song", "sea shanty", {"language": "gd", "timbre_ref_id": "g1"}, 1, lk)
    assert p.inputs["language"] == "unknown" and p.inputs["lyrics"] == "[Instrumental]"
    assert p.inputs["tags"] == "sea shanty, instrumental" and p.inputs["audio_codes"] is False
    assert p.images["timbre_audio"].name == "g1.wav" and p.sources["timbre_ref_id"] == "g1"
    p = audio_plan("music", "warm pads", {"model": "sa3_small_music", "category": "loop", "bpm": 90}, 1, lk)
    assert p.template == "sa3_music" and p.inputs["prompt"] == "warm pads, seamless loop, 90 BPM"
    p = audio_plan("sfx", "glass breaking", {}, 1, lk)
    assert p.template == "sa3_sfx" and p.inputs["prompt"] == "glass breaking"
    p = audio_plan("song", "city pop", {"model": "minimax_music3", "lyrics": "[verse]\nhi", "vocal": "duet"}, 1, lk)
    assert p.inputs["caption"] == "city pop, male and female duet vocals" and p.inputs["lyrics"] == "[verse]\nhi"
    assert style_tags("instrumental jazz", {"vocal": "none"}) == "instrumental jazz"


def test_save_audio_history_is_parsed_as_audio():
    outs = parse_outputs({"outputs": {"11": {"audio": [{"filename": "ace_00001_.flac", "subfolder": "mixai",
                                                        "type": "output"}]}}})
    assert [(o.node_id, o.kind) for o in outs] == [("11", "audio")]


def test_worker_runs_an_audio_job_through_the_comfy_driver(client, tmp_path):
    from app.drivers.comfy import ComfyDriver
    from tests.test_comfy import FakeServer, RecordingClient

    history = {"status": {"messages": [["execution_start", {"timestamp": 1_000}],
                                       ["execution_success", {"timestamp": 13_000}]]},
               "outputs": {"11": {"audio": [{"filename": "ace_00001_.flac", "subfolder": "mixai", "type": "output"}]}}}
    made = []

    class AudioClient(RecordingClient):
        async def run(self, graph, on_progress=None, timeout=0, weights=None):
            self.graphs.append(graph)
            return "p1", history

    async def factory():
        made.append(AudioClient(FakeServer()))
        return made[-1]

    item = gen(client, kind="song", lyrics="[verse]\nhello", vocal="male", seed=11, duration_s=20).json()["items"][0]
    assert process_one(driver_factory=lambda: ComfyDriver(client_factory=factory, lookup=Lookup(tmp_path)))
    with SessionLocal() as db:
        g = db.get(Generation, item["generation_id"])
        assert g.status == "ready" and g.media_type == "audio/flac" and g.file_path.endswith(".flac")
        assert g.params["comfy"]["template"] == "ace15_song" and db.get(Job, g.job_id).gpu_seconds == 12.0
        assert db.get(MediaItem, item["id"]).duration_s == 20  # the fake file can't be probed; the asked length stays
    graph = made[0].graphs[0]
    assert node(graph, "Encode")["tags"] == "warm acoustic folk, fingerpicked guitar, male vocals"
    assert node(graph, "Save")["filename_prefix"] == f"mixai/{item['generation_id']}"
