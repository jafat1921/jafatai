"""Waveform peaks and loudness analysis for audio items (contract v15).

Both are cached as JSON beside the file (<stem>.peaks.json, <stem>.analysis.json) and keyed by the
file's mtime, so a re-rendered file never serves stale numbers. A generation's file doesn't change in
practice, but uploads replaced by hand (and the tests) do.
"""
import json
import logging
import math
import os
import re
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.config import get_settings

log = logging.getLogger("mixai.audio")

CLIP_LEVEL = 10 ** (-0.1 / 20)  # -0.1 dBFS
CLIP_PCT = 0.01
TOO_LOUD = -9.0
TOO_QUIET = -30.0
LONG_SILENCE = 3.0
SILENCE_DB = -50
SILENCE_MIN_S = 0.5
PEAKS_KEEP = 4  # cached bucket counts per file: the editor asks for a couple of zoom levels at most
TIMEOUT = 600


class AnalysisError(RuntimeError):
    pass


def peaks_file(src: Path) -> Path:
    return src.with_name(f"{src.stem}.peaks.json")


def analysis_file(src: Path) -> Path:
    return src.with_name(f"{src.stem}.analysis.json")


def sidecars(src: Path) -> list[Path]:
    return [peaks_file(src), analysis_file(src)]


def _ff() -> str:
    return get_settings().ffmpeg_path()


@dataclass
class StreamInfo:
    duration: float = 0.0
    sample_rate: int = 0
    channels: int = 0
    has_audio: bool = False
    has_video: bool = False


_DUR = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_AUD = re.compile(r"Stream #\S+.*?: Audio: [^,]+, (\d+) Hz, ([^,\n]+)")
_LAYOUTS = {"mono": 1, "stereo": 2, "2.1": 3, "3.0": 3, "quad": 4, "4.0": 4, "5.0": 5, "5.1": 6, "6.1": 7, "7.1": 8}


def stream_info(path: Path) -> StreamInfo:
    # imageio-ffmpeg has no ffprobe; `ffmpeg -i` prints everything we need on stderr
    r = subprocess.run([_ff(), "-hide_banner", "-nostdin", "-i", str(path)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=60)
    info = StreamInfo()
    m = _DUR.search(r.stderr)
    if m:
        info.duration = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
    a = _AUD.search(r.stderr)
    if a:
        info.has_audio, info.sample_rate = True, int(a[1])
        layout = a[2].strip().split("(")[0]
        n = re.match(r"(\d+) channels", layout)
        info.channels = int(n[1]) if n else _LAYOUTS.get(layout, 2)
    info.has_video = bool(re.search(r"Stream #\S+.*?: Video: (?!mjpeg|png)", r.stderr))
    return info


def _read_cache(path: Path, src: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("mtime") != src.stat().st_mtime_ns:
        return None
    return data


def _write_cache(path: Path, data: dict) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        log.warning("couldn't cache %s", path, exc_info=True)
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------- peaks

def _decode_mono(src: Path, rate: int) -> np.ndarray:
    cmd = [_ff(), "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(src), "-vn", "-ac", "1",
           "-ar", str(rate), "-f", "f32le", "-"]
    r = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT)
    if r.returncode != 0:
        raise AnalysisError("Couldn't read this audio: " + r.stderr.decode(errors="replace")[-300:])
    return np.frombuffer(r.stdout[: len(r.stdout) // 4 * 4], dtype="<f4")


def buckets(samples: np.ndarray, n: int) -> list[list[float]]:
    if samples.size == 0:
        return [[0.0, 0.0] for _ in range(n)]
    edges = (np.arange(n) * samples.size) // n
    # reduceat over repeated edges (fewer samples than buckets) gives that one sample, which is fine
    lo = np.minimum.reduceat(samples, edges)
    hi = np.maximum.reduceat(samples, edges)
    lo, hi = np.clip(lo, -1, 1), np.clip(hi, -1, 1)
    return [[round(float(a), 4), round(float(b), 4)] for a, b in zip(lo, hi)]


def peaks(src: Path, n: int = 4000) -> dict:
    cache = peaks_file(src)
    data = _read_cache(cache, src) or {"mtime": src.stat().st_mtime_ns, "entries": {}}
    hit = data["entries"].get(str(n))
    if hit is not None:
        return hit
    info = stream_info(src)
    if not info.has_audio:
        raise AnalysisError("This file has no audio")
    # enough samples for ~16 per bucket, but long files decode at 8 kHz so a two-hour mix stays cheap
    rate = int(min(44100, max(8000, math.ceil(n * 16 / max(info.duration, 0.1)))))
    samples = _decode_mono(src, rate)
    out = {"duration_s": round(info.duration or samples.size / rate, 3), "sample_rate": info.sample_rate,
           "channels": info.channels, "peaks": buckets(samples, n)}
    entries = dict(list(data["entries"].items())[-(PEAKS_KEEP - 1):])
    entries[str(n)] = out
    _write_cache(cache, {"mtime": data["mtime"], "entries": entries})
    return out


# ---------------------------------------------------------------- loudness, peaks, silences

_SUMMARY = re.compile(r"Summary:(.*)", re.S)
_SIL_START = re.compile(r"silence_start: (-?\d+(?:\.\d+)?)")
_SIL_END = re.compile(r"silence_end: (-?\d+(?:\.\d+)?)")


def _num(pattern: str, text: str) -> float | None:
    m = re.search(pattern, text)
    if not m:
        return None
    try:
        v = float(m[1])
    except ValueError:
        return None  # "-inf"
    return v if math.isfinite(v) else None


def parse_ebur128(stderr: str) -> dict:
    """The numbers from ebur128's end-of-stream summary. Silence reads as -70 LUFS and a -inf peak."""
    m = _SUMMARY.search(stderr)
    text = m[1] if m else ""
    tp = text.split("True peak:", 1)[1] if "True peak:" in text else ""
    sp = text.split("Sample peak:", 1)[1].split("True peak:", 1)[0] if "Sample peak:" in text else ""
    return {"lufs_i": _num(r"I:\s+(-?[\d.]+|-inf) LUFS", text), "lra": _num(r"LRA:\s+(-?[\d.]+) LU", text),
            "true_peak_db": _num(r"Peak:\s+(-?[\d.]+|-inf) dBFS", tp),
            "sample_peak_db": _num(r"Peak:\s+(-?[\d.]+|-inf) dBFS", sp)}


def parse_silences(stderr: str, duration: float) -> list[dict]:
    starts = [float(x) for x in _SIL_START.findall(stderr)]
    ends = [float(x) for x in _SIL_END.findall(stderr)]
    out = []
    for i, s in enumerate(starts):
        # a silence still running at the end of the file never gets its silence_end line
        e = ends[i] if i < len(ends) else duration
        out.append({"start": round(max(0.0, s), 3), "end": round(min(duration, e) if duration else e, 3)})
    return out


def flags_for(a: dict, duration: float) -> list[str]:
    flags = []
    if (a.get("clipped_pct") or 0) > CLIP_PCT:
        flags.append("clipping")
    lufs = a.get("lufs_i")
    if lufs is not None and lufs > TOO_LOUD:
        flags.append("too_loud")
    if lufs is None or lufs < TOO_QUIET:
        flags.append("too_quiet")
    edge = 0.05
    for s in a.get("silences") or []:
        if s["end"] - s["start"] > LONG_SILENCE and s["start"] > edge and s["end"] < duration - edge:
            flags.append("long_silence")
            break
    return flags


def measure(src: Path) -> dict:
    """One decode: ebur128 and silencedetect log to stderr while the samples come out on stdout, where
    numpy counts the clipped ones (astats only counts samples *at* the peak, not near full scale)."""
    info = stream_info(src)
    if not info.has_audio:
        raise AnalysisError("This file has no audio")
    af = f"ebur128=peak=true+sample:framelog=quiet,silencedetect=n={SILENCE_DB}dB:d={SILENCE_MIN_S}"
    cmd = [_ff(), "-hide_banner", "-nostats", "-nostdin", "-i", str(src), "-vn", "-af", af, "-f", "f32le", "-"]
    clipped = total = 0
    peak = 0.0
    with tempfile.TemporaryFile() as errf:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errf)
        rest = b""
        try:
            while True:
                chunk = proc.stdout.read(1 << 20)
                if not chunk:
                    break
                chunk = rest + chunk
                cut = len(chunk) // 4 * 4
                rest = chunk[cut:]
                x = np.abs(np.frombuffer(chunk[:cut], dtype="<f4"))
                if x.size:
                    clipped += int(np.count_nonzero(x >= CLIP_LEVEL))
                    total += x.size
                    peak = max(peak, float(x.max()))
            proc.wait(timeout=TIMEOUT)
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        errf.seek(0)
        stderr = errf.read().decode("utf-8", errors="replace")
    if proc.returncode != 0:
        raise AnalysisError("Couldn't analyse this audio: " + stderr[-300:])
    duration = info.duration or (total / max(1, info.channels) / max(1, info.sample_rate))
    loud = parse_ebur128(stderr)
    out = {
        "lufs_i": loud["lufs_i"], "lra": loud["lra"], "true_peak_db": loud["true_peak_db"],
        "sample_peak_db": round(20 * math.log10(peak), 2) if peak > 0 else None,
        "clipped_pct": round(clipped / total * 100, 4) if total else 0.0,
        "silences": parse_silences(stderr, duration),
    }
    # ebur128 floors silence at -70; that's "no programme", not a level
    if out["lufs_i"] is not None and out["lufs_i"] <= -70:
        out["lufs_i"] = None
    out["flags"] = flags_for(out, duration)
    return out


def analyse(src: Path) -> dict:
    cache = analysis_file(src)
    hit = _read_cache(cache, src)
    if hit is not None:
        return hit["result"]
    result = measure(src)
    _write_cache(cache, {"mtime": src.stat().st_mtime_ns, "result": result})
    return result


def summary(g) -> dict | None:
    """The badge numbers for a generation, if they've been worked out already (never computes)."""
    if g is None or not g.file_path or not (g.media_type or "").startswith("audio/"):
        return None
    src = get_settings().data_dir / g.file_path
    try:
        hit = _read_cache(analysis_file(src), src)
    except OSError:
        return None
    if hit is None:
        return None
    r = hit["result"]
    return {"lufs_i": r.get("lufs_i"), "true_peak_db": r.get("true_peak_db"), "flags": r.get("flags") or []}


def on_job_finished(db, job) -> None:
    """Worker hook: analyse new audio right away so the Library badges show without an extra call."""
    from app.models import Generation

    if job.status != "done" or not job.generation_id:
        return
    g = db.get(Generation, job.generation_id)
    if g is None or g.status not in ("ready", "approved") or not g.file_path:
        return
    if not (g.media_type or "").startswith("audio/"):
        return
    src = get_settings().data_dir / g.file_path
    if src.is_file():
        analyse(src)
