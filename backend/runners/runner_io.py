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
    """Run `synth(text) -> audio` over every segment of a TTS job and write each one's wav.

    With "per_segment": true (the gallery's sample batches) each segment may carry its own voice, so
    synth is called as synth(text, seg) and reads instruct / seed / voice / language from seg."""
    segs = job.get("segments") or []
    per_segment = bool(job.get("per_segment"))
    out, warnings = [], []

    def say(text, seg):
        return synth(text, seg) if per_segment else synth(text)

    for i, seg in enumerate(segs):
        progress(0.15 + 0.8 * i / max(1, len(segs)), f"Speaking line {i + 1}/{len(segs)}")
        text = seg["text"]
        audio = None
        # a line of only punctuation, a dash or an emoji gives the model nothing to say, and some engines
        # crash on the empty result (OmniVoice: "zero-size array to reduction operation maximum")
        if has_letters(text):
            try:
                audio = say(text, seg)
            except Exception as e:  # noqa: BLE001
                bare = strip_marks(text)
                try:
                    audio = say(bare, seg) if bare != text else None
                except Exception:  # noqa: BLE001
                    audio = None
                if audio is None:
                    warnings.append(f"line {i + 1} ({text[:120]!r}): {type(e).__name__}: {e}"[:400])
                    print(f"speak_all: skipped {warnings[-1]}", file=sys.stderr, flush=True)
        rate = sample_rate() if callable(sample_rate) else sample_rate
        if audio is None or len(to_numpy(audio)) == 0:
            # one bad line shouldn't lose the whole book: a short pause keeps the timing
            audio = silence(rate, 0.4)
        out.append({"out": seg["out"], "sample_rate": rate, "duration_s": write_wav(seg["out"], audio, rate)})
    progress(1.0, "Spoken")
    return {"segments": out, **({"warnings": warnings} if warnings else {})}


def has_letters(text: str) -> bool:
    import unicodedata

    return any(unicodedata.category(ch).startswith("L") for ch in text or "")


def strip_marks(text: str) -> str:
    import unicodedata

    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn")


def silence(rate: int, seconds: float):
    import numpy as np

    return np.zeros(max(1, int(rate * seconds)), dtype=np.float32)
