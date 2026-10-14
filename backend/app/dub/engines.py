"""The GPU-box half of Dub a video: vocal separation and speaker embeddings in the audio-utils venv,
speech in batches (one model load per voice) and Whisper checks in one pass.

ComfyDriver hands these calls here with its own lane; MockDriver fakes the same four methods.
"""
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np

from app import speech, venv_runner, voices
from app.audio_analysis import _decode_mono, stream_info
from app.config import get_settings

UTILS_VENV = "audio-utils"
SEPARATE_GB = 4.0
STT_RATE = 16000
STT_GAP_S = 1.0


def _ffmpeg(args: list[str], timeout: int = 900, cwd: Path | None = None) -> None:
    cmd = [get_settings().ffmpeg_path(), "-y", "-loglevel", "error", "-nostdin", *args]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=timeout, cwd=cwd)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg failed: {e.stderr.decode(errors='replace')[-600:]}") from e


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------- runners

def separate(src: Path, out_dir: Path, model: str, progress, lane: str | None = None, run=None) -> dict:
    s = get_settings()
    out_dir.mkdir(parents=True, exist_ok=True)
    job = {"audio": str(src), "out_dir": str(out_dir), "model": model, "model_dir": s.dub_separation_model_dir,
           "device": "cuda"}
    res = (run or venv_runner.run)("separate_vocals", UTILS_VENV, job, lane=lane, need_gb=SEPARATE_GB,
                                   progress=lambda f, m: progress(f, m or "Separating the voices"))
    return {"vocals": Path(res["vocals"]), "instrumental": Path(res["instrumental"])}


def separate_stems(src: Path, out_dir: Path, model: str, progress, lane: str | None = None, run=None
                   ) -> dict[str, Path]:
    """The Stems tool's split (contract v21): every stem the model writes, keyed by its lower-case name."""
    s = get_settings()
    out_dir.mkdir(parents=True, exist_ok=True)
    job = {"audio": str(src), "out_dir": str(out_dir), "model": model, "model_dir": s.dub_separation_model_dir,
           "device": "cuda", "all_stems": True}
    res = (run or venv_runner.run)("separate_vocals", UTILS_VENV, job, lane=lane, need_gb=SEPARATE_GB,
                                   progress=lambda f, m: progress(f, m or "Separating the stems"))
    return {name: Path(p) for name, p in (res.get("stems") or {}).items()}


def speaker_embed(src: Path, spans: list[tuple[float, float]], progress, lane: str | None = None,
                  run=None) -> list[list[float]]:
    job = {"audio": str(src), "segments": [[round(a, 3), round(b, 3)] for a, b in spans]}
    res = (run or venv_runner.run)("speaker_embed", UTILS_VENV, job, lane=lane,
                                   progress=lambda f, m: progress(f, m or "Listening for speakers"))
    return res["embeddings"]


def speak_many(params: dict, texts: list[str], outs: list[Path], seed: int | None, progress,
               lane: str | None = None, run=None) -> list[float]:
    """Every line of one voice in one runner call; each comes back as its own FLAC."""
    e = voices.get_engine(params.get("engine") or voices.default_engine())
    work = outs[0].parent / f".batch-{outs[0].stem}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        ref = None
        ref_file = (params.get("voice") or {}).get("ref_file")
        if ref_file:
            src = get_settings().data_dir / ref_file
            if not src.is_file():
                raise RuntimeError("The voice's reference clip is missing")
            ref = speech.to_wav(src, work / "ref.wav")
        job = speech.runner_job({**params, "duration_s": None}, e, texts, work, seed, ref)
        (run or venv_runner.run)(e.runner, e.venv, job, lane=lane, need_gb=e.vram_gb,
                                 progress=lambda f, m: progress(f, m or f"Speaking ({e.label})"))
        durations = []
        for seg, out in zip(job["segments"], outs):
            p = Path(seg["out"])
            if not p.is_file():
                raise RuntimeError(f"{e.label} didn't write {p.name}")
            durations.append(speech.assemble([(p, 0.0)], out))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return durations


def join_for_stt(paths: list[Path], dst: Path, rate: int = STT_RATE) -> list[tuple[float, float]]:
    """All clips in one file with a second of silence between them; returns where each one sits."""
    gap = np.zeros(int(STT_GAP_S * rate), np.float32)
    chunks, spans, t = [], [], 0.0
    for p in paths:
        a = _decode_mono(p, rate)
        spans.append((t, t + len(a) / rate))
        chunks += [a, gap]
        t += (len(a) + len(gap)) / rate
    write_wav(dst, np.concatenate(chunks) if chunks else gap, rate)
    return spans


def split_words(res: dict, spans: list[tuple[float, float]]) -> list[str]:
    words = [w for s in res.get("segments") or [] for w in (s.get("words") or [])]
    if not words:
        # no word timings: whole segments are the next best thing
        words = [{"start": s["start"], "end": s["end"], "word": s.get("text") or ""} for s in res.get("segments") or []]
    out: list[list[str]] = [[] for _ in spans]
    for w in words:
        mid = (float(w["start"]) + float(w["end"])) / 2
        best = min(range(len(spans)), key=lambda i: 0 if spans[i][0] <= mid <= spans[i][1]
                   else min(abs(mid - spans[i][0]), abs(mid - spans[i][1])), default=None)
        if best is not None:
            out[best].append(str(w.get("word") or w.get("w") or ""))
    return [" ".join(" ".join(x).split()) for x in out]


def transcribe_many(paths: list[Path], language: str | None, progress, lane: str | None = None,
                    run=None) -> list[str]:
    if not paths:
        return []
    work = paths[0].parent / ".verify"
    shutil.rmtree(work, ignore_errors=True)
    try:
        joined = work / "all.wav"
        spans = join_for_stt(paths, joined)
        res = speech.transcribe(joined, language, progress, lane=lane, run=run)
        return split_words(res, spans)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- speakers

def cluster(embeddings, n: int | None, threshold: float) -> list[int]:
    """Average-linkage agglomerative clustering on cosine distance. `n` fixes the number of speakers;
    without it merging stops once the closest two groups are further apart than `threshold`."""
    x = np.asarray(embeddings, dtype=np.float64)
    m = len(x)
    if m == 0:
        return []
    if m == 1 or n == 1:
        return [0] * m
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    x = x / np.where(norms == 0, 1, norms)
    dist = np.clip(1.0 - x @ x.T, 0.0, 2.0)
    np.fill_diagonal(dist, np.inf)
    members = {i: [i] for i in range(m)}
    alive = np.ones(m, bool)
    while alive.sum() > 1:
        if n is not None and alive.sum() <= n:
            break
        masked = np.where(alive[:, None] & alive[None, :], dist, np.inf)
        a, b = divmod(int(np.argmin(masked)), m)
        if n is None and masked[a, b] > threshold:
            break
        na, nb = len(members[a]), len(members[b])
        # Lance-Williams update for average linkage
        dist[a, :] = (na * dist[a, :] + nb * dist[b, :]) / (na + nb)
        dist[:, a] = dist[a, :]
        dist[a, a] = np.inf
        alive[b] = False
        members[a] += members.pop(b)
    labels = [0] * m
    # numbered by first appearance, so "Speaker 1" is whoever talks first
    order = sorted(members.values(), key=min)
    for k, idx in enumerate(order):
        for i in idx:
            labels[i] = k
    return labels


def band_embedding(samples: np.ndarray, rate: int, bands: int = 16) -> list[float]:
    """Log energy in log-spaced bands, centred and normalised: what the mock uses instead of MFCCs."""
    if len(samples) < 256:
        return [0.0] * bands
    spec = np.abs(np.fft.rfft(samples * np.hanning(len(samples)))) ** 2
    freqs = np.fft.rfftfreq(len(samples), 1 / rate)
    edges = np.geomspace(60, min(8000, rate / 2), bands + 1)
    e = np.array([spec[(freqs >= lo) & (freqs < hi)].sum() for lo, hi in zip(edges[:-1], edges[1:])])
    v = np.log10(e + 1e-9)
    v -= v.mean()
    norm = np.linalg.norm(v)
    return (v / norm if norm else v).round(5).tolist()


def cut_clip(src: Path, spans: list[tuple[float, float]], dst: Path) -> float:
    parts = [f"[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS[c{i}]" for i, (a, b) in enumerate(spans)]
    graph = ";".join(parts) + ";" + "".join(f"[c{i}]" for i in range(len(spans))) + \
        f"concat=n={len(spans)}:v=0:a=1,aformat=channel_layouts=mono[out]"
    dst.parent.mkdir(parents=True, exist_ok=True)
    _ffmpeg(["-i", str(src), "-filter_complex", graph, "-map", "[out]", "-ar", "44100", "-c:a", "flac", str(dst)])
    return round(stream_info(dst).duration, 3)
