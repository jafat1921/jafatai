"""Speech on the GPU box (contract v16): the backend half around the engine runners.

The text is split on [pause Ns] tags, the runner speaks every piece in one go (one model load), and
ffmpeg joins the pieces with silence in between, fixes the speed for engines that have no speed knob
and fits a fixed length. The result is FLAC like every other audio take.
"""
import shutil
import subprocess
from pathlib import Path

from app import venv_runner, voice_instruct, voices
from app.audio_analysis import stream_info
from app.audio_edit import atempo
from app.config import get_settings
from app.drivers.base import DriverResult, ProgressCallback

SR = 44100
REF_SR = 24000


def _ffmpeg(args: list[str], timeout: int = 300) -> None:
    cmd = [get_settings().ffmpeg_path(), "-y", "-loglevel", "error", "-nostdin", *args]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=timeout)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg failed: {e.stderr.decode(errors='replace')[-400:]}") from e


def to_wav(src: Path, dst: Path, rate: int = REF_SR) -> Path:
    # uploads arrive as mp3 / m4a / flac; every engine is happiest with plain mono wav
    dst.parent.mkdir(parents=True, exist_ok=True)
    _ffmpeg(["-i", str(src), "-vn", "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s16le", str(dst)])
    return dst


def assemble(parts: list[tuple[Path | None, float]], out_path: Path, tempo: float = 1.0,
             fit_s: float | None = None) -> float:
    """Join spoken pieces (path, _) and silences (None, seconds) into one FLAC; returns its length."""
    args, filters = [], []
    for i, (path, secs) in enumerate(parts):
        if path is not None:
            args += ["-i", str(path)]
        else:
            args += ["-f", "lavfi", "-t", f"{secs:.3f}", "-i", f"anullsrc=r={SR}:cl=mono"]
        filters.append(f"[{i}:a]aresample={SR},aformat=sample_fmts=fltp:channel_layouts=mono[p{i}]")
    n = len(parts)
    chain = "".join(f"[p{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1"
    post = atempo(tempo)
    if fit_s:
        post += [f"apad=whole_dur={fit_s:.3f}", f"atrim=0:{fit_s:.3f}"]
    graph = ";".join(filters) + ";" + chain + ("," + ",".join(post) if post else "") + "[out]"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    _ffmpeg([*args, "-filter_complex", graph, "-map", "[out]", "-ar", str(SR), "-ac", "1", "-c:a", "flac",
             str(out_path)])
    return round(stream_info(out_path).duration, 3)


def runner_job(params: dict, e: voices.Engine, texts: list[str], work: Path, seed: int | None,
               ref: Path | None) -> dict:
    v = params.get("voice") or {}
    speed = float(params.get("speed") or 1.0)
    duration = params.get("duration_s")
    instruct = ", ".join(x for x in ((v.get("design") or {}).get("description"), params.get("emotion")) if x) or None
    if e.id == "omnivoice" and instruct:
        # OmniVoice refuses any word outside its own attribute list; keep what it understands
        ins = voice_instruct.normalise(instruct)
        instruct = ins.text
        hint = (v.get("design") or {}).get("speed") or ins.speed
        if speed == 1.0 and not duration and hint != 1.0:
            speed = float(hint)
    job = {"engine": e.id, "language": params.get("language") or "en", "seed": seed, "device": "cuda",
           "segments": [{"text": t, "out": str(work / f"seg{i}.wav")} for i, t in enumerate(texts)],
           "ref_audio": str(ref) if ref else None, "ref_text": v.get("ref_text") or None,
           "instruct": instruct, "voice": v.get("preset")}
    # a fixed length wins over speed; the engine only gets it when there's one piece to fit
    if duration and e.native_duration and len(texts) == 1:
        job["duration"] = float(duration)
    elif not duration and e.native_speed and speed != 1.0:
        job["speed"] = speed
    for key in ("steps", "guidance", "denoise", "exaggeration"):
        if params.get(key) is not None:
            job[key] = params[key]
    return job


def synthesise(params: dict, seed: int | None, out_path: Path, progress_cb: ProgressCallback,
               lane: str | None = None, run=None) -> DriverResult:
    e = voices.get_engine(params.get("engine") or voices.DEFAULT_ENGINE)
    text = params.get("text") or ""
    segs = voices.segments(text, e)
    texts = [str(v) for k, v in segs if k == "text"]
    if not texts:
        raise RuntimeError("There are no words to speak")
    work = out_path.parent / f".{out_path.stem}.speech"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        ref = None
        ref_file = (params.get("voice") or {}).get("ref_file")
        if ref_file:
            src = get_settings().data_dir / ref_file
            if not src.is_file():
                raise RuntimeError("The voice's reference clip is missing")
            progress_cb(0.02, "Preparing the reference clip")
            ref = to_wav(src, work / "ref.wav")
        job = runner_job(params, e, texts, work, seed, ref)
        progress_cb(0.05, f"Starting {e.label}")
        res = (run or venv_runner.run)(
            e.runner, e.venv, job, lane=lane, need_gb=e.vram_gb,
            progress=lambda f, m: progress_cb(0.05 + 0.85 * f, m or f"Speaking ({e.label})"))

        outs = iter(Path(s["out"]) for s in job["segments"])
        parts: list[tuple[Path | None, float]] = []
        natural = 0.0
        for k, v in segs:
            if k == "text":
                p = next(outs)
                if not p.is_file():
                    raise RuntimeError(f"{e.label} didn't write {p.name}")
                parts.append((p, 0.0))
                natural += stream_info(p).duration
            else:
                parts.append((None, float(v)))
                natural += float(v)
        duration = params.get("duration_s")
        speed = float(params.get("speed") or 1.0)
        tempo = 1.0
        if duration and natural > 0:
            tempo = natural / float(duration)
        elif not e.native_speed and speed != 1.0:
            tempo = speed
        progress_cb(0.93, "Joining the lines" if len(parts) > 1 else "Saving")
        seconds = assemble(parts, out_path, tempo, float(duration) if duration else None)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    progress_cb(1.0, "Done")
    meta = {"duration_s": seconds, "model": e.id, "engine": e.id}
    update = {"text_spoken": voices.spoken_text(text, e),
              "speech": {"natural_s": round(natural, 3), "tempo": round(tempo, 4),
                         "notes": (res or {}).get("notes") or []}}
    return DriverResult(out_path, "audio/flac", meta, update)


def transcribe(path: Path, language: str | None, progress_cb: ProgressCallback, lane: str | None = None,
               run=None) -> dict:
    work = path.parent / f".{path.stem}.stt"
    shutil.rmtree(work, ignore_errors=True)
    try:
        wav = to_wav(path, work / "ref.wav", 16000)
        job = {"audio": str(wav), "language": language, "model": "large-v3", "device": "cuda"}
        w = voices.WHISPER
        return (run or venv_runner.run)(w["runner"], w["venv"], job, lane=lane, need_gb=w["vram_gb"],
                                        progress=lambda f, m: progress_cb(0.05 + 0.9 * f, m or "Transcribing"))
    finally:
        shutil.rmtree(work, ignore_errors=True)
