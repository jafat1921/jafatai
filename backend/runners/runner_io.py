"""Shared plumbing for the engine runners. Runs inside the engine venvs: numpy / soundfile / torch only,
never `app.*`.

(Not called _io.py: that name is a built-in module and would shadow-import the C one instead.)
"""
import json
import os
import random
import sys
import traceback

# engines print banners and progress bars to stdout; keep the real stdout for protocol lines only
_OUT = sys.stdout
sys.stdout = sys.stderr


def emit(**msg) -> None:
    _OUT.write(json.dumps(msg, ensure_ascii=False) + "\n")
    _OUT.flush()


def progress(fraction: float, message: str = "") -> None:
    emit(progress=round(max(0.0, min(1.0, fraction)), 4), message=message)


def read_job() -> dict:
    return json.loads(sys.stdin.read() or "{}")


def seed_all(seed) -> None:
    if seed is None:
        return
    seed = int(seed) % 2**31
    random.seed(seed)
    try:
        import numpy as np

        np.random.seed(seed)
    except ImportError:
        pass
    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except ImportError:
        pass


def to_numpy(audio):
    import numpy as np

    if hasattr(audio, "detach"):
        audio = audio.detach().float().cpu().numpy()
    a = np.asarray(audio, dtype=np.float32)
    a = np.squeeze(a)
    if a.ndim == 2 and a.shape[0] < a.shape[1]:
        a = a.T  # (channels, samples) -> (samples, channels)
    return a


def write_wav(path: str, audio, sample_rate: int) -> float:
    import soundfile as sf

    a = to_numpy(audio)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    sf.write(path, a, int(sample_rate), subtype="PCM_16")
    return round(len(a) / float(sample_rate), 3)


def device(job: dict) -> str:
    want = job.get("device") or "cuda"
    try:
        import torch

        if want.startswith("cuda") and not torch.cuda.is_available():
            return "cpu"
    except ImportError:
        return "cpu"
    return want


def main(fn) -> None:
    try:
        result = fn(read_job())
    except Exception as e:  # noqa: BLE001  (everything goes back to the worker as one readable line)
        traceback.print_exc(file=sys.stderr)
        emit(error=f"{type(e).__name__}: {e}"[:2000])
        sys.exit(1)
    emit(done=result or {})


def speak_all(job: dict, synth, sample_rate) -> dict:
    """Run `synth(text) -> audio` over every segment of a TTS job and write each one's wav."""
    segs = job.get("segments") or []
    out = []
    for i, seg in enumerate(segs):
        progress(0.15 + 0.8 * i / max(1, len(segs)), f"Speaking line {i + 1}/{len(segs)}")
        audio = synth(seg["text"])
        rate = sample_rate() if callable(sample_rate) else sample_rate
        out.append({"out": seg["out"], "sample_rate": rate, "duration_s": write_wav(seg["out"], audio, rate)})
    progress(1.0, "Spoken")
    return {"segments": out}
