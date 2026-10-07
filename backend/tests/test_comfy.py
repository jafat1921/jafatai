import asyncio
import json
from pathlib import Path

import httpx
import pytest

from app.db import SessionLocal
from app.drivers import comfy_client
from app.drivers.comfy import ComfyDriver, exec_seconds, plan_generation
from app.drivers.comfy_client import ComfyClient, ComfyError, history_error, parse_outputs
from app.models import Generation, Job
from app.worker import JobCancelled, process_one
from app.workflows import TemplateError, build, check_template, find_node, frames_for, list_templates, snap_8n1

FIXTURE = Path(__file__).parent / "fixtures" / "comfy_object_info.json"


def node(graph, title):
    return graph[find_node(graph, title)]["inputs"]


# --- templates ---------------------------------------------------------------

def test_zimage_inputs_land_on_titled_nodes():
    g, resolved = build("zimage_t2i", {"prompt": "a lighthouse", "width": 770, "height": 1030, "seed": 99})
    assert node(g, "Positive")["text"] == "a lighthouse"
    assert node(g, "Latent")["width"] == 768 and node(g, "Latent")["height"] == 1024  # snapped to /16
    assert node(g, "Sampler")["seed"] == 99 and node(g, "Sampler")["steps"] == 8
    assert resolved["negative"] == ""


def test_missing_required_input():
    with pytest.raises(TemplateError, match="prompt"):
        build("zimage_t2i", {"width": 512})


def test_ltx_without_last_frame_bypasses_guide():
    g, resolved = build("ltx23_i2v", {"prompt": "p", "first_image": "mixai/a.png", "num_frames": 50})
    titles = {n["_meta"]["title"] for n in g.values()}
    assert not titles & {"LastImage", "LastScale", "LastPre", "LastGuide"}
    cond = find_node(g, "Conditioning")
    assert node(g, "Guider")["positive"] == [cond, 0] and node(g, "Guider")["negative"] == [cond, 1]
    assert node(g, "AVLatent")["video_latent"] == [find_node(g, "FirstFrame"), 0]
    assert node(g, "VideoLatent")["length"] == 49 == node(g, "AudioLatent")["frames_number"]
    assert resolved["last_image"] is None


def test_ltx_with_last_frame_keeps_guide():
    g, _ = build("ltx23_i2v", {"prompt": "p", "first_image": "a.png", "last_image": "b.png", "width": 640, "fps": 25})
    assert node(g, "LastImage")["image"] == "b.png"
    assert node(g, "LastGuide")["frame_idx"] == -1
    assert node(g, "FirstScale")["width"] == node(g, "VideoLatent")["width"] == 640
    assert node(g, "Save")["frame_rate"] == 25.0 == node(g, "Conditioning")["frame_rate"]


def test_qwen_edit_drops_unused_reference_slots_and_inserts_lora():
    g, resolved = build("qwen_edit", {"prompt": "side view", "images": ["r1.png"]}, loras=[("extra.safetensors", 0.7)])
    pos = node(g, "Positive")
    assert "image2" not in pos and "image3" not in pos and pos["image1"] == [find_node(g, "Ref1Scale"), 0]
    assert node(g, "Ref1")["image"] == "r1.png"
    lora_id = find_node(g, "LoRA 1")
    assert node(g, "LoRA 1")["model"] == [find_node(g, "Lightning"), 0]
    assert node(g, "ModelSampling")["model"] == [lora_id, 0]
    assert resolved["loras"] == [{"name": "extra.safetensors", "strength": 0.7}]

    g3, _ = build("qwen_edit", {"prompt": "x", "images": ["a", "b", "c"]})
    assert {"image1", "image2", "image3"} <= set(node(g3, "Negative"))
    with pytest.raises(TemplateError):
        build("qwen_edit", {"prompt": "x", "images": []})


@pytest.mark.parametrize("raw,expected", [(1, 9), (9, 9), (12, 9), (13, 17), (49, 49), (50, 49), (121, 121), (125, 129)])
def test_snap_8n1(raw, expected):
    assert snap_8n1(raw) == expected
    assert (snap_8n1(raw) - 1) % 8 == 0


def test_frames_for_duration():
    assert frames_for(2, 24) == 49
    assert frames_for(5, 24) == 121
    assert frames_for(10, 24) == 241


def test_check_templates_against_fixture():
    info = json.loads(FIXTURE.read_text())
    for name in list_templates():
        assert check_template(name, info)["ok"], name

    broken = json.loads(FIXTURE.read_text())
    del broken["LTXVAddGuide"]
    broken["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0] = ["other.safetensors"]
    broken["KSamplerSelect"]["input"]["required"]["sampler_name"][1]["options"] = ["dpmpp_2m"]
    res = check_template("ltx23_i2v", broken)
    assert not res["ok"]
    assert res["missing_nodes"] == ["LTXVAddGuide"]
    assert res["missing_models"] == ["ltx-2.3-22b-distilled-fp8.safetensors"]
    assert any("SamplerSelect.sampler_name" in m for m in res["invalid"])


# --- history parsing -----------------------------------------------------------

HISTORY = {
    "status": {
        "status_str": "success", "completed": True,
        "messages": [
            ["execution_start", {"prompt_id": "p1", "timestamp": 1_000_000}],
            ["execution_cached", {"nodes": [], "prompt_id": "p1", "timestamp": 1_000_010}],
            ["execution_success", {"prompt_id": "p1", "timestamp": 1_042_500}],
        ],
    },
    "outputs": {
        "10": {"images": [{"filename": "z_00001_.png", "subfolder": "mixai", "type": "output"}]},
        "11": {"images": [{"filename": "preview.png", "subfolder": "", "type": "temp"}]},
        "44": {"gifs": [{"filename": "ltx_00001-audio.mp4", "subfolder": "mixai", "type": "output", "format": "video/h264-mp4"}]},
        "50": {"images": [{"filename": "clip.mp4", "subfolder": "video", "type": "output"}], "animated": [True]},
    },
}


def test_parse_outputs_images_and_videos():
    outs = {o.filename: o for o in parse_outputs(HISTORY)}
    assert set(outs) == {"z_00001_.png", "ltx_00001-audio.mp4", "clip.mp4"}
    assert outs["z_00001_.png"].kind == "image" and outs["z_00001_.png"].node_id == "10"
    assert outs["ltx_00001-audio.mp4"].kind == "video" and outs["clip.mp4"].kind == "video"
    assert outs["clip.mp4"].query == {"filename": "clip.mp4", "subfolder": "video", "type": "output"}


def test_history_error_and_exec_seconds():
    assert history_error(HISTORY) is None
    assert exec_seconds(HISTORY) == 42.5
    failed = {"status": {"status_str": "error", "messages": [
        ["execution_error", {"node_id": "8", "node_type": "KSampler", "exception_message": "CUDA out of memory"}]]}}
    assert "KSampler" in history_error(failed) and "out of memory" in history_error(failed)


# --- client against a fake server (polling path) ---------------------------------

class FakeServer:
    def __init__(self, finish_after=1, error=None):
        self.calls = []
        self.polls = 0
        self.finish_after = finish_after
        self.error = error

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path, request.content))
        if path == "/prompt":
            return httpx.Response(200, json={"prompt_id": "p1", "number": 1, "node_errors": {}})
        if path == "/history/p1":
            self.polls += 1
            if self.polls <= self.finish_after:
                return httpx.Response(200, json={})
            entry = dict(HISTORY)
            if self.error:
                entry = {"status": {"status_str": "error", "messages": [["execution_error", self.error]]}}
            return httpx.Response(200, json={"p1": entry})
        if path == "/queue" and request.method == "GET":
            return httpx.Response(200, json={"queue_running": [[0, "p1", {}, {}, []]], "queue_pending": []})
        if path in ("/queue", "/interrupt"):
            return httpx.Response(200)
        if path == "/view":
            return httpx.Response(200, content=b"\x89PNG fake")
        if path == "/upload/image":
            return httpx.Response(200, json={"name": "ref.png", "subfolder": "mixai", "type": "input"})
        if path == "/system_stats":
            return httpx.Response(200, json={"system": {}})
        return httpx.Response(404)


def fake_client(server):
    return ComfyClient("http://comfy.test", transport=httpx.MockTransport(server), websocket=False)


@pytest.fixture
def fast_poll(monkeypatch):
    monkeypatch.setattr(comfy_client, "POLL_EVERY", 0.0)


def test_client_polls_until_done(fast_poll):
    server = FakeServer(finish_after=2)

    async def go():
        async with fake_client(server) as c:
            return await c.run({"1": {"class_type": "X", "inputs": {}}})

    pid, entry = asyncio.run(go())
    assert pid == "p1" and entry["outputs"]
    assert server.polls == 3


def test_client_raises_execution_error(fast_poll):
    server = FakeServer(error={"node_id": "34", "node_type": "SamplerCustomAdvanced", "exception_message": "boom"})

    async def go():
        async with fake_client(server) as c:
            await c.run({"1": {"class_type": "X", "inputs": {}}})

    with pytest.raises(ComfyError, match="SamplerCustomAdvanced.*boom"):
        asyncio.run(go())


def test_client_cancels_prompt_when_callback_raises(fast_poll):
    server = FakeServer(finish_after=100)

    def cb(frac, msg):
        if server.polls >= 1:
            raise JobCancelled()

    async def go():
        async with fake_client(server) as c:
            await c.run({"1": {"class_type": "X", "inputs": {}}}, cb)

    with pytest.raises(JobCancelled):
        asyncio.run(go())
    paths = [(m, p) for m, p, _ in server.calls]
    assert ("POST", "/queue") in paths and ("POST", "/interrupt") in paths
    delete = next(body for m, p, body in server.calls if m == "POST" and p == "/queue")
    assert json.loads(delete) == {"delete": ["p1"]}


# --- driver dispatch -------------------------------------------------------------

class FakeLookup:
    def __init__(self, tmp_path: Path):
        self.tmp = tmp_path

    def generation_file(self, gen_id):
        p = self.tmp / f"{gen_id}.png"
        p.write_bytes(b"png")
        return p

    def character_portrait(self, character_id):
        return "portrait-gen" if character_id == "char-1" else None

    def project_aspect(self, project_id):
        return "9:16" if project_id == "proj-1" else None


def test_dispatch_by_kind(tmp_path):
    lk = FakeLookup(tmp_path)

    p = plan_generation("portrait", "a diver", {}, 5, lk)
    assert p.template == "zimage_t2i" and (p.inputs["width"], p.inputs["height"]) == (768, 1024)

    p = plan_generation("portrait", "a diver", {"reference_ids": ["g1"]}, 5, lk)
    assert p.template == "qwen_edit" and p.images["images"][0].name == "g1.png"

    p = plan_generation("sheet_view", "", {"target_id": "char-1", "view": "3/4"}, 5, lk)
    assert p.template == "qwen_edit" and p.sources["reference_ids"] == ["portrait-gen"]
    assert "three-quarter" in p.inputs["prompt"] and p.loras == []
    p = plan_generation("sheet_view", "", {"target_id": "char-1", "view": "side", "angles_lora": 0.8}, 5, lk)
    assert p.loras[0][1] == 0.8
    with pytest.raises(ComfyError, match="no portrait"):
        plan_generation("sheet_view", "", {"target_id": "nobody"}, 5, lk)

    p = plan_generation("keyframe_start", "dock at dawn", {"project_id": "proj-1"}, 5, lk)
    assert p.template == "zimage_t2i" and (p.inputs["width"], p.inputs["height"]) == (720, 1280)
    p = plan_generation("keyframe_end", "x", {"reference_ids": ["a", "b", "c", "d"]}, 5, lk)
    assert p.template == "qwen_edit" and len(p.images["images"]) == 3

    p = plan_generation("take", "she turns", {"first_frame_id": "s", "last_frame_id": "e", "duration_s": 2,
                                              "width": 768, "height": 512}, 5, lk)
    assert p.template == "ltx23_i2v" and p.media == "video"
    assert p.inputs["num_frames"] == 49 and set(p.images) == {"first_image", "last_image"}
    p = plan_generation("take", "x", {"first_frame_id": "s", "duration_s": 60}, 5, lk)
    assert p.inputs["num_frames"] == 257 and "last_image" not in p.images
    with pytest.raises(ComfyError, match="first_frame_id"):
        plan_generation("take", "x", {}, 5, lk)
    with pytest.raises(ComfyError):
        plan_generation("scene_text", "x", {}, 5, lk)


class RecordingClient(ComfyClient):
    def __init__(self, server):
        super().__init__("http://comfy.test", transport=httpx.MockTransport(server), websocket=False)
        self.graphs = []

    async def run(self, graph, on_progress=None, timeout=0, weights=None):
        self.graphs.append(graph)
        on_progress(0.5, "Sampler 4/8")
        return "p1", HISTORY


def test_worker_runs_comfy_driver_end_to_end(client, character, tmp_path):
    server = FakeServer()
    made = []

    async def factory():
        c = RecordingClient(server)
        made.append(c)
        return c

    r = client.post("/api/generations", json={
        "target_type": "character", "target_id": character["id"], "kind": "portrait",
        "prompt": "grey-haired diver", "params": {"seed": 1234},
    })
    gen_id = r.json()["id"]
    assert process_one(driver_factory=lambda: ComfyDriver(client_factory=factory, lookup=FakeLookup(tmp_path)))

    with SessionLocal() as db:
        gen = db.get(Generation, gen_id)
        job = db.get(Job, gen.job_id)
        assert gen.status == "ready" and gen.file_path.endswith(".png")
        assert gen.params["comfy"]["template"] == "zimage_t2i"
        assert gen.params["comfy"]["seed"] == 1234 and gen.params["comfy"]["prompt_id"] == "p1"
        assert job.status == "done" and job.gpu_seconds == 42.5
    graph = made[0].graphs[0]
    assert node(graph, "Sampler")["seed"] == 1234
    assert node(graph, "Save")["filename_prefix"] == f"mixai/{gen_id}"
    assert client.get(f"/api/generations?target_id={character['id']}").json()[0]["media_url"]


def test_comfy_check_endpoint(client, monkeypatch):
    info = json.loads(FIXTURE.read_text())
    del info["VHS_VideoCombine"]

    class Fake:
        base_url = "http://comfy.test"

        async def object_info(self):
            return info

        async def close(self):
            pass

    async def fake_pick(*a, **k):
        return Fake()

    monkeypatch.setattr(comfy_client, "pick_client", fake_pick)
    body = client.get("/api/system/comfy-check").json()
    assert body["templates"]["zimage_t2i"]["ok"] and body["templates"]["qwen_edit"]["ok"]
    assert body["templates"]["ltx23_i2v"]["missing_nodes"] == ["VHS_VideoCombine"]
    assert body["ok"] is False


def test_comfy_check_reports_unreachable_server(client):
    # conftest leaves COMFY_URLS empty
    body = client.get("/api/system/comfy-check").json()
    assert body["ok"] is False and "COMFY_URLS" in body["error"]


def _client(handler):
    return ComfyClient("http://comfy.test", transport=httpx.MockTransport(handler), websocket=False)


def _prompt_ok(request):
    return httpx.Response(200, json={"prompt_id": "p1", "number": 1, "node_errors": {}})


def test_client_fails_fast_when_comfy_forgets_the_job(fast_poll):
    # ComfyUI restarted (OOM, crash): empty history, empty queue -> clear error, not an hour-long wait
    def handler(request):
        p = request.url.path
        if p == "/prompt":
            return _prompt_ok(request)
        if p.startswith("/history"):
            return httpx.Response(200, json={})
        if p == "/queue" and request.method == "GET":
            return httpx.Response(200, json={"queue_running": [], "queue_pending": []})
        return httpx.Response(200)

    async def go():
        async with _client(handler) as c:
            await c.run({"1": {"class_type": "X", "inputs": {}}}, timeout=600)

    with pytest.raises(ComfyError, match="no longer has this job"):
        asyncio.run(go())


def test_client_gives_up_when_comfy_stays_down(fast_poll, monkeypatch):
    monkeypatch.setattr(comfy_client, "DOWN_GRACE_S", 0.0)

    def handler(request):
        if request.url.path == "/prompt":
            return _prompt_ok(request)
        raise httpx.ConnectError("connection refused", request=request)

    async def go():
        async with _client(handler) as c:
            await c.run({"1": {"class_type": "X", "inputs": {}}}, timeout=600)

    with pytest.raises(ComfyError, match="stopped responding"):
        asyncio.run(go())


def test_client_rides_out_a_short_comfy_restart(fast_poll):
    state = {"calls": 0}

    def handler(request):
        p = request.url.path
        if p == "/prompt":
            return _prompt_ok(request)
        if p.startswith("/history"):
            state["calls"] += 1
            if state["calls"] <= 2:
                raise httpx.ConnectError("restarting", request=request)
            return httpx.Response(200, json={"p1": {"status": {"completed": True, "status_str": "success"},
                                                    "outputs": {"9": {"images": [{"filename": "a.png", "subfolder": "", "type": "output"}]}}}})
        if p == "/queue" and request.method == "GET":
            return httpx.Response(200, json={"queue_running": [[0, "p1", {}, {}, []]], "queue_pending": []})
        return httpx.Response(200)

    async def go():
        async with _client(handler) as c:
            return await c.run({"1": {"class_type": "X", "inputs": {}}}, timeout=600)

    pid, entry = asyncio.run(go())
    assert pid == "p1" and entry["outputs"]
