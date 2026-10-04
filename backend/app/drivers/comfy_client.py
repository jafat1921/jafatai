"""Thin async client for the ComfyUI HTTP + websocket API."""
import asyncio
import json
import logging
import ssl
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit, urlunsplit

import httpx

log = logging.getLogger("mixai.comfy")

# (fraction 0..1, message). May raise to abort; the client interrupts the prompt and re-raises.
OnProgress = Callable[[float, str], None]

POLL_EVERY = 2.0
TICK_EVERY = 3.0
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".gif"}


class ComfyError(RuntimeError):
    pass


class ComfyTimeout(ComfyError):
    pass


@dataclass
class ComfyOutput:
    node_id: str
    filename: str
    subfolder: str
    type: str
    kind: str  # image | video

    @property
    def query(self) -> dict:
        return {"filename": self.filename, "subfolder": self.subfolder, "type": self.type}


def parse_outputs(entry: dict) -> list[ComfyOutput]:
    """Flatten one /history/{id} entry into downloadable files.

    SaveImage puts files under 'images', core SaveVideo under 'images' too (with
    animated=True) or 'videos', VHS_VideoCombine under 'gifs'."""
    found: list[ComfyOutput] = []
    for node_id, out in (entry.get("outputs") or {}).items():
        for key in ("images", "videos", "gifs", "video"):
            items = out.get(key) or []
            if isinstance(items, dict):
                items = [items]
            for it in items:
                if not isinstance(it, dict) or not it.get("filename"):
                    continue
                if it.get("type") == "temp":
                    continue  # previews
                ext = Path(it["filename"]).suffix.lower()
                kind = "video" if key in ("videos", "gifs", "video") or ext in VIDEO_EXT else "image"
                found.append(ComfyOutput(str(node_id), it["filename"], it.get("subfolder", ""), it.get("type", "output"), kind))
    return found


def history_error(entry: dict) -> str | None:
    status = entry.get("status") or {}
    for msg in status.get("messages") or []:
        if isinstance(msg, list) and len(msg) == 2 and msg[0] == "execution_error":
            return format_exec_error(msg[1])
        if isinstance(msg, list) and len(msg) == 2 and msg[0] == "execution_interrupted":
            return "Interrupted on the ComfyUI server"
    if status.get("status_str") == "error":
        return "ComfyUI reported an error (no details in history)"
    return None


def format_exec_error(data: dict) -> str:
    node = data.get("node_type") or "?"
    nid = data.get("node_id")
    text = (data.get("exception_message") or data.get("exception_type") or "unknown error").strip()
    return f"ComfyUI {node} (node {nid}) failed: {text[:600]}"


def format_prompt_error(body: dict) -> str:
    err = body.get("error") or {}
    parts = [err.get("message", "prompt rejected") if isinstance(err, dict) else str(err)]
    for nid, ne in (body.get("node_errors") or {}).items():
        for e in ne.get("errors", [])[:3]:
            parts.append(f"{ne.get('class_type', nid)}: {e.get('message')} {e.get('details', '')}".strip())
    return "ComfyUI rejected the workflow: " + "; ".join(parts)


class _ProgressTracker:
    def __init__(self, graph: dict, weights: dict[str, float]):
        self.weights = {nid: float(weights.get(nid, 1.0)) for nid in graph}
        self.total = sum(self.weights.values()) or 1.0
        self.done: set[str] = set()
        self.current: str | None = None
        self.current_frac = 0.0
        self.label = "Queued"

    def node_started(self, nid: str | None, title: str) -> None:
        if self.current and self.current != nid:
            self.done.add(self.current)
        self.current, self.current_frac = nid, 0.0
        if nid:
            self.label = title

    def cached(self, nodes) -> None:
        self.done.update(str(n) for n in nodes)

    def fraction(self) -> float:
        acc = sum(self.weights.get(n, 1.0) for n in self.done)
        if self.current and self.current not in self.done:
            acc += self.weights.get(self.current, 1.0) * self.current_frac
        return min(0.99, acc / self.total)


class ComfyClient:
    def __init__(self, base_url: str, token: str = "", verify_tls: bool = True, timeout: float = 60.0,
                 transport: httpx.AsyncBaseTransport | None = None, websocket: bool = True):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.verify_tls = verify_tls
        self.client_id = uuid.uuid4().hex
        self.websocket = websocket
        self._http = httpx.AsyncClient(
            base_url=self.base_url, headers=self._headers(), verify=verify_tls,
            timeout=httpx.Timeout(timeout, connect=10.0), transport=transport,
        )

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.close()

    async def close(self) -> None:
        await self._http.aclose()

    async def _json(self, method: str, path: str, **kw):
        r = await self._http.request(method, path, **kw)
        r.raise_for_status()
        return r.json() if r.content else None

    async def healthy(self) -> bool:
        try:
            r = await self._http.get("/system_stats", timeout=5.0)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    async def object_info(self) -> dict:
        return await self._json("GET", "/object_info")

    async def queue_state(self) -> dict:
        return await self._json("GET", "/queue")

    async def history(self, prompt_id: str) -> dict | None:
        data = await self._json("GET", f"/history/{prompt_id}")
        return (data or {}).get(prompt_id)

    async def upload_image(self, path: Path, name: str | None = None, subfolder: str = "mixai") -> str:
        """Upload and return the value a LoadImage node needs ('sub/name.png').
        Videos go through the same endpoint; VHS_LoadVideo reads them from the input folder."""
        name = name or path.name
        mime = "video/mp4" if path.suffix.lower() in VIDEO_EXT else "image/png"
        with open(path, "rb") as fh:
            files = {"image": (name, fh, mime)}
            data = {"type": "input", "subfolder": subfolder, "overwrite": "true"}
            r = await self._http.post("/upload/image", files=files, data=data)
        r.raise_for_status()
        body = r.json()
        sub = body.get("subfolder") or ""
        return f"{sub}/{body['name']}" if sub else body["name"]

    async def queue_prompt(self, graph: dict) -> str:
        r = await self._http.post("/prompt", json={"prompt": graph, "client_id": self.client_id})
        if r.status_code >= 400:
            try:
                raise ComfyError(format_prompt_error(r.json()))
            except ValueError:
                raise ComfyError(f"ComfyUI /prompt returned {r.status_code}: {r.text[:300]}") from None
        body = r.json()
        if body.get("node_errors"):
            raise ComfyError(format_prompt_error(body))
        return body["prompt_id"]

    async def cancel(self, prompt_id: str) -> None:
        """Drop it from the pending queue, and interrupt it if it's the one running."""
        try:
            await self._http.post("/queue", json={"delete": [prompt_id]})
            q = await self.queue_state()
            running = [item[1] for item in q.get("queue_running", []) if len(item) > 1]
            if prompt_id in running:
                await self._http.post("/interrupt", json={"prompt_id": prompt_id})
        except httpx.HTTPError as e:
            log.warning("cancel of %s failed: %s", prompt_id, e)

    async def download(self, out: ComfyOutput, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        async with self._http.stream("GET", "/view", params=out.query, timeout=300.0) as r:
            r.raise_for_status()
            with open(tmp, "wb") as fh:
                async for chunk in r.aiter_bytes(1 << 20):
                    fh.write(chunk)
        tmp.replace(dest)
        return dest

    def _ws_url(self) -> str:
        parts = urlsplit(self.base_url)
        scheme = "wss" if parts.scheme == "https" else "ws"
        return urlunsplit((scheme, parts.netloc, parts.path.rstrip("/") + "/ws", f"clientId={self.client_id}", ""))

    def _ssl(self):
        if not self.base_url.startswith("https"):
            return None
        ctx = ssl.create_default_context()
        if not self.verify_tls:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        return ctx

    async def run(
        self,
        graph: dict,
        on_progress: OnProgress | None = None,
        timeout: float = 3600.0,
        weights: dict[str, float] | None = None,
    ) -> tuple[str, dict]:
        """Queue a graph and wait for it. Returns (prompt_id, history_entry)."""
        tracker = _ProgressTracker(graph, weights or {})
        titles = {nid: n.get("_meta", {}).get("title") or n["class_type"] for nid, n in graph.items()}
        report = on_progress or (lambda f, m: None)

        ws = None
        try:
            if not self.websocket:
                raise RuntimeError("disabled")
            import websockets

            ws = await websockets.connect(
                self._ws_url(), additional_headers=self._headers(), ssl=self._ssl(),
                max_size=None, open_timeout=10, ping_interval=20,
            )
        except Exception as e:  # no websocket (proxy, auth, missing lib): polling still works
            log.warning("websocket unavailable (%s); polling /history instead", e)
            ws = None

        prompt_id = None
        try:
            prompt_id = await self.queue_prompt(graph)
            report(0.01, "Queued on ComfyUI")
            deadline = time.monotonic() + timeout
            if ws is not None:
                entry = await self._wait_ws(ws, prompt_id, tracker, titles, report, deadline)
            else:
                entry = await self._wait_poll(prompt_id, report, deadline)
            return prompt_id, entry
        except BaseException:
            # cancel, shutdown, timeout or a crash on our side: don't leave the GPU busy
            if prompt_id:
                await asyncio.shield(self.cancel(prompt_id))
            raise
        finally:
            if ws is not None:
                try:
                    await ws.close()
                except Exception:
                    pass

    async def _finish(self, prompt_id: str) -> dict:
        # history is written right after the success message; give it a moment
        for _ in range(10):
            entry = await self.history(prompt_id)
            if entry and (entry.get("status", {}).get("completed") or entry.get("outputs")):
                err = history_error(entry)
                if err:
                    raise ComfyError(err)
                return entry
            if entry:
                err = history_error(entry)
                if err:
                    raise ComfyError(err)
            await asyncio.sleep(0.5)
        raise ComfyError(f"prompt {prompt_id} finished but has no history entry")

    async def _wait_poll(self, prompt_id: str, report: OnProgress, deadline: float) -> dict:
        while True:
            entry = await self.history(prompt_id)
            if entry:
                err = history_error(entry)
                if err:
                    raise ComfyError(err)
                if entry.get("status", {}).get("completed"):
                    return entry
            if time.monotonic() > deadline:
                raise ComfyTimeout(f"prompt {prompt_id} timed out")
            report(0.5, "Generating (no live progress)")
            await asyncio.sleep(POLL_EVERY)

    async def _wait_ws(self, ws, prompt_id, tracker: _ProgressTracker, titles, report, deadline) -> dict:
        last_tick = 0.0
        last_history_check = time.monotonic()
        while True:
            now = time.monotonic()
            if now > deadline:
                raise ComfyTimeout(f"prompt {prompt_id} timed out")
            # tick even when the server is silent (model loads can take minutes) so
            # cancellation and heartbeats keep working
            if now - last_tick >= TICK_EVERY:
                report(tracker.fraction(), tracker.label)
                last_tick = now
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=TICK_EVERY)
            except asyncio.TimeoutError:
                # belt and braces: a missed 'executing: None' must not hang us forever
                if time.monotonic() - last_history_check > 15:
                    last_history_check = time.monotonic()
                    entry = await self.history(prompt_id)
                    if entry and (entry.get("status", {}).get("completed") or history_error(entry)):
                        return await self._finish(prompt_id)
                continue
            except Exception as e:
                log.warning("websocket dropped (%s); falling back to polling", e)
                return await self._wait_poll(prompt_id, report, deadline)
            if isinstance(raw, (bytes, bytearray)):
                continue  # latent previews
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            mtype, data = msg.get("type"), msg.get("data") or {}
            if data.get("prompt_id") not in (None, prompt_id):
                continue  # someone else's job on the shared box
            if mtype == "execution_cached":
                tracker.cached(data.get("nodes") or [])
            elif mtype == "executing":
                nid = data.get("node")
                if nid is None and data.get("prompt_id") == prompt_id:
                    return await self._finish(prompt_id)
                if nid is not None:
                    tracker.node_started(str(nid), titles.get(str(nid), str(nid)))
                    report(tracker.fraction(), tracker.label)
                    last_tick = time.monotonic()
            elif mtype == "progress":
                nid, val, mx = str(data.get("node")), data.get("value", 0), data.get("max") or 1
                if nid != tracker.current:
                    tracker.node_started(nid, titles.get(nid, nid))
                tracker.current_frac = max(0.0, min(1.0, val / mx))
                report(tracker.fraction(), f"{tracker.label} {val}/{mx}")
                last_tick = time.monotonic()
            elif mtype == "execution_success":
                return await self._finish(prompt_id)
            elif mtype == "execution_error":
                raise ComfyError(format_exec_error(data))
            elif mtype == "execution_interrupted":
                raise ComfyError("Interrupted on the ComfyUI server")


async def pick_client(urls: list[str], token: str = "", verify_tls: bool = True) -> ComfyClient:
    # TODO: real GPU pool scheduling (one job per instance, least-busy first) instead of first-healthy
    errors = []
    for url in urls:
        c = ComfyClient(url, token, verify_tls)
        if await c.healthy():
            return c
        errors.append(url)
        await c.close()
    raise ComfyError(f"no healthy ComfyUI instance (tried {', '.join(errors) or 'none: COMFY_URLS is empty'})")
