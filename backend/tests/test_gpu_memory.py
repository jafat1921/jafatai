"""ComfyUI out of memory: Ollama lets go of its models, ComfyUI frees its cache, the graph runs once more."""
import asyncio
import json

import httpx
import pytest

from app import aerab, gpu_memory
from app.config import get_settings
from app.drivers.comfy import ComfyDriver, Plan
from app.drivers.comfy_client import ComfyClient, ComfyError
from app.llm import chat_sync, set_transport
from app.llm import translate as tr
from tests.test_ai import oa
from tests.test_comfy import HISTORY

OOM = "ComfyUI CLIPTextEncode (node 6) failed: VRAM grow failed: 777912320 bytes"


class Ollama:
    def __init__(self, loaded=("gemma4:26b", "translategemma:27b"), down=False, native=True):
        self.loaded, self.down, self.native = list(loaded), down, native
        self.calls = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("refused", request=request)
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, body))
        if not self.native:
            return httpx.Response(404, text="not found")
        if request.url.path == "/api/ps":
            return httpx.Response(200, json={"models": [{"name": n, "model": n} for n in self.loaded]})
        if request.url.path == "/api/generate":
            return httpx.Response(200, json={"done": True, "done_reason": "unload"})
        return httpx.Response(404)


def test_oom_markers():
    assert gpu_memory.is_oom(OOM)
    assert gpu_memory.is_oom("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB")
    assert gpu_memory.is_oom("Allocation on device 0 would exceed allowed memory")
    assert not gpu_memory.is_oom("ComfyUI KSampler (node 3) failed: boom")
    assert not gpu_memory.is_oom("")


def test_unload_asks_ollama_to_drop_every_loaded_model():
    o = Ollama()
    done = gpu_memory.unload_ollama("http://gpu.test:11434/v1", transport=httpx.MockTransport(o))
    assert done == ["gemma4:26b", "translategemma:27b"]
    assert o.calls[0][:2] == ("GET", "/api/ps")
    assert [c[2] for c in o.calls[1:]] == [{"model": "gemma4:26b", "keep_alive": 0},
                                           {"model": "translategemma:27b", "keep_alive": 0}]


def test_unload_is_skipped_when_ollama_is_away_or_not_ollama():
    assert gpu_memory.unload_ollama("http://gpu.test/v1", transport=httpx.MockTransport(Ollama(down=True))) == []
    o = Ollama(native=False)
    assert gpu_memory.unload_ollama("http://vllm.test/v1", transport=httpx.MockTransport(o)) == []
    assert [c[1] for c in o.calls] == ["/api/ps"]
    assert gpu_memory.ollama_root("http://h:11434/v1/") == "http://h:11434"


class FlakyClient(ComfyClient):
    """run() fails with `errors` in turn, then succeeds; the rest of the HTTP goes to a mock."""

    def __init__(self, errors):
        self.http_calls = []

        def server(request):
            self.http_calls.append((request.url.path, json.loads(request.content) if request.content else None))
            if request.url.path == "/view":
                return httpx.Response(200, content=b"\x89PNG fake")
            return httpx.Response(200, json={})

        super().__init__("http://comfy.test", transport=httpx.MockTransport(server), websocket=False)
        self.errors = list(errors)
        self.runs = 0

    async def run(self, graph, on_progress=None, timeout=0, weights=None):
        self.runs += 1
        if self.errors:
            raise ComfyError(self.errors.pop(0))
        return "p1", HISTORY


def _execute(client, tmp_path, monkeypatch):
    unloads = []
    monkeypatch.setattr(gpu_memory, "unload_ollama", lambda: unloads.append(1) or ["gemma4:26b"])

    async def factory():
        return client

    d = ComfyDriver(client_factory=factory, lookup=object())
    plan = Plan("zimage_t2i", {"prompt": "a lighthouse", "width": 512, "height": 512, "seed": 1}, {}, [], "image", {})
    res = asyncio.run(d._execute(plan, tmp_path / "out.png", lambda f, m="": None, {}))
    return res, unloads


def test_oom_frees_vram_and_retries_once(tmp_path, monkeypatch):
    c = FlakyClient([OOM])
    res, unloads = _execute(c, tmp_path, monkeypatch)
    assert res.path.read_bytes().startswith(b"\x89PNG") and c.runs == 2 and unloads == [1]
    assert ("/free", {"unload_models": False, "free_memory": True}) in c.http_calls


def test_second_oom_is_the_jobs_error(tmp_path, monkeypatch):
    c = FlakyClient([OOM, OOM])
    with pytest.raises(ComfyError, match="VRAM grow failed"):
        _execute(c, tmp_path, monkeypatch)
    assert c.runs == 2


def test_other_errors_dont_unload_or_retry(tmp_path, monkeypatch):
    c = FlakyClient(["ComfyUI KSampler (node 3) failed: boom"])
    unloads = []
    monkeypatch.setattr(gpu_memory, "unload_ollama", lambda: unloads.append(1) or [])
    with pytest.raises(ComfyError, match="boom"):
        _execute(c, tmp_path, monkeypatch)
    assert c.runs == 1 and unloads == [] and all(p != "/free" for p, _ in c.http_calls)


# ---------------------------------------------------------------- our own big models don't linger

class Chat:
    def __init__(self, reply="ok"):
        self.bodies = []
        self.reply = reply

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/version":
            return httpx.Response(200, json={"version": "0.12.0"})
        body = json.loads(request.content)
        self.bodies.append(body)
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(200, json=oa(self.reply))
        return httpx.Response(200, json={"message": {"content": self.reply}, "done_reason": "stop"})


@pytest.fixture
def llm(monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_api", "ollama")

    def install(reply="ok"):
        c = Chat(reply)
        set_transport(httpx.MockTransport(c))
        return c

    yield install
    set_transport(None)


def test_keep_alive_reaches_the_native_body_only_when_asked(llm, monkeypatch):
    monkeypatch.setattr(get_settings(), "llm_model_creative", "gemma4:e4b")
    c = llm()
    chat_sync("creative", [{"role": "user", "content": "hi"}], keep_alive="30s")
    chat_sync("creative", [{"role": "user", "content": "hi"}])
    assert c.bodies[0]["keep_alive"] == "30s" and "keep_alive" not in c.bodies[1]
    # Ollama's /v1 has no keep_alive field
    monkeypatch.setattr(get_settings(), "llm_api", "openai")
    chat_sync("creative", [{"role": "user", "content": "hi"}], keep_alive="30s")
    assert "keep_alive" not in c.bodies[-1]


def test_translategemma_and_the_aerab_model_are_short_lived(llm, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "llm_model_creative", "gemma4:e4b")
    monkeypatch.setattr(s, "translate_llm_model", "translategemma:27b")
    assert tr.keep_alive(s.translate_llm_model) == s.ollama_keep_alive_big == "30s"
    assert tr.keep_alive("gemma4:e4b") is None  # the creative fallback keeps Ollama's default
    c = llm("hello")
    tr._ask(s.translate_llm_model, "سلام", "ur", "en", None)
    assert c.bodies[-1]["model"] == s.translate_llm_model and c.bodies[-1]["keep_alive"] == "30s"

    async def have():
        return "gemma4:26b"

    monkeypatch.setattr(aerab, "marking_model", have)
    c = llm(json.dumps({"lines": ["دِل کی بات"]}))
    aerab.mark_sync("دل کی بات", "ur")
    assert c.bodies and all(b["model"] == "gemma4:26b" and b["keep_alive"] == "30s" for b in c.bodies)
