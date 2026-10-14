"""Run a backend/runners/<name>.py script inside one of the audio engine venvs on the GPU box.

Protocol: the job goes in as one JSON document on stdin. The runner prints JSON lines on stdout:
{"progress": 0.4, "message": "..."} while it works, then {"done": {...}} or {"error": "..."}.
Anything else on stdout is ignored; stderr is kept (the tail) for the error message.
"""
import json
import logging
import os
import subprocess
import threading
from collections import deque
from pathlib import Path
from typing import Callable

import httpx

from app.config import get_settings

log = logging.getLogger("mixai.runner")

RUNNERS_DIR = Path(__file__).resolve().parents[1] / "runners"
STDERR_TAIL = 30


class RunnerError(RuntimeError):
    pass


def python_for(venv: str) -> Path:
    # the venvs are Linux ones on the GPU box; on a Windows laptop this path simply doesn't exist
    return Path(get_settings().audio_venvs_dir) / venv / "bin" / "python"


def gpu_index(lane: str | None) -> int:
    s = get_settings()
    return s.audio_gpu_video if lane == "video" else s.audio_gpu_image


def free_mib(index: int) -> int | None:
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits", "-i",
                            str(index)], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    try:
        return int(float(r.stdout.strip().splitlines()[0]))
    except (ValueError, IndexError):
        return None


def ensure_vram(lane: str | None, need_gb: float, label: str = "the runner") -> None:
    """ComfyUI keeps its models resident; ask the worker's own ComfyUI to let go when the card is too full."""
    if need_gb <= 0:
        return
    free = free_mib(gpu_index(lane))
    if free is None or free >= need_gb * 1024:
        return
    urls = get_settings().comfy_urls_for(lane)
    if not urls:
        return
    log.info("GPU %s has %d MiB free, %s needs ~%.0f GB: asking %s to free memory",
             gpu_index(lane), free, label, need_gb, urls[0])
    try:
        httpx.post(f"{urls[0]}/free", json={"unload_models": True, "free_memory": True}, timeout=20,
                   verify=get_settings().comfy_verify_tls)
    except httpx.HTTPError as e:
        # not fatal: the runner may still fit, and if not its own OOM error says so
        log.warning("ComfyUI /free failed: %s", e)


def run(runner: str, venv: str, job: dict, *, lane: str | None = None,
        progress: Callable[[float, str], None] | None = None, need_gb: float = 0.0,
        timeout: float | None = None, python: str | None = None) -> dict:
    script = RUNNERS_DIR / f"{runner}.py"
    exe = python or str(python_for(venv))
    if python is None and not Path(exe).is_file():
        raise RunnerError(f"The {venv} venv isn't installed on this machine ({exe})")
    ensure_vram(lane, need_gb, runner)
    timeout = timeout or get_settings().audio_runner_timeout_s
    env = {**os.environ, "CUDA_VISIBLE_DEVICES": str(gpu_index(lane)), "PYTHONUNBUFFERED": "1",
           "PYTHONIOENCODING": "utf-8"}
    # systemd doesn't source the shell profile, so the models' cache has to be named here or every
    # engine would download its weights again into ~/.cache
    hf_home = get_settings().audio_hf_home
    if hf_home:
        env["HF_HOME"] = hf_home

    # its own session, so a Ctrl+C reaches the worker, which decides what happens to the job, instead of
    # killing the runner mid-book behind its back
    detach = {"start_new_session": True} if os.name == "posix" else {}
    proc = subprocess.Popen([exe, str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, text=True, encoding="utf-8", errors="replace",
                            **detach)
    tail: deque[str] = deque(maxlen=STDERR_TAIL)
    timed_out = threading.Event()

    def drain():
        for line in proc.stderr:
            tail.append(line.rstrip())

    def kill():
        timed_out.set()
        proc.kill()

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    timer = threading.Timer(timeout, kill)
    timer.start()
    done = error = None
    try:
        try:
            proc.stdin.write(json.dumps(job))
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass  # it died before reading; the exit code below says why
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "done" in msg:
                done = msg["done"] or {}
            elif "error" in msg:
                error = str(msg["error"])
            elif "progress" in msg and progress is not None:
                progress(max(0.0, min(1.0, float(msg["progress"]))), str(msg.get("message") or ""))
        proc.wait()
    except BaseException:
        # cancel / shutdown raised from the progress callback: don't leave the model running on the GPU
        proc.kill()
        proc.wait()
        raise
    finally:
        timer.cancel()
        reader.join(timeout=5)

    stderr = "\n".join(tail)
    _requeue_if_stopping(proc.returncode, done is not None)
    if timed_out.is_set():
        raise RunnerError(f"{runner} took longer than {timeout:g} s and was stopped")
    if error is not None:
        raise RunnerError(f"{runner}: {error}" + (f"\n{stderr[-1500:]}" if stderr else ""))
    if proc.returncode != 0 or done is None:
        raise RunnerError(f"{runner} exited with code {proc.returncode} without a result"
                          + (f":\n{stderr[-1500:]}" if stderr else ""))
    return done


def _requeue_if_stopping(returncode: int | None, finished: bool) -> None:
    # a runner that died while the worker is shutting down hands its job back to the queue instead of
    # failing it: a restart shouldn't throw away half a book's narration
    from app import worker

    if worker._stop.is_set() and (returncode != 0 or not finished):
        raise worker.WorkerStopping()
