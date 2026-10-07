"""Long takes (contract v2): one continuous video built from LTX chunks.

A take longer than one LTX pass is planned as N chunks of 8n+1 frames. Chunk 0 starts
from the approved START frame; every later chunk is conditioned on the last few frames
(and the audio) of the chunk before it, so motion carries across the join; the last
chunk is pulled towards the END frame. The chunks share those context frames, which is
where the joiner crossfades. Finished chunks are kept on disk, so a re-queued job picks
up at the first unfinished one.
"""
import logging
import math
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import storyboard as sb
from app.config import get_settings
from app.llm import LLMError, chat_sync
from app.llm import prompts as P
from app.models import Character, Generation, Location, Project, Scene, Shot
from app.workflows import frames_for, snap_8n1

log = logging.getLogger("mixai.longtake")

FPS = 24.0
SINGLE_MAX_FRAMES = sb.MAX_TAKE_FRAMES  # 257: one LTX pass
MAX_FADE_S = 2.0
# contract figure: ~6 GPU-s per output second, plus a model (re)load when something else ran in between
GPU_S_PER_OUTPUT_S = 6.0
MODEL_LOAD_S = 120.0
# colour drift correction limits (8-bit code values), so a bad measurement can't wreck a chunk
MAX_LUMA_SHIFT = 12.0
MAX_CHROMA_SHIFT = 6.0


class LongTakeError(RuntimeError):
    pass


# ---------------------------------------------------------------- planning

def chunk_max_s() -> float:
    return (SINGLE_MAX_FRAMES - 1) / FPS


def is_long(duration_s: float) -> bool:
    return frames_for(float(duration_s), FPS) > SINGLE_MAX_FRAMES


def method() -> str:
    m = (get_settings().longtake_method or "extend").strip().lower()
    return m if m in ("extend", "i2v") else "extend"


def context_frames(how: str | None = None) -> int:
    # the i2v fallback restarts from the previous chunk's last frame: one shared frame, nothing to fade over
    if (how or method()) == "i2v":
        return 1
    return snap_8n1(max(1, get_settings().chunk_context_frames))


def plan_chunks(duration_s: float, *, fps: float = FPS, chunk_s: float | None = None,
                overlap: int | None = None) -> list[dict]:
    """Split a take into chunks. Every chunk is 8n+1 frames; chunk k>0 repeats the last
    `overlap` frames of chunk k-1 as its first frames. The new frames are spread evenly so
    no chunk ends up a stub, and the joined length is exactly frames_for(duration)."""
    s = get_settings()
    total = frames_for(float(duration_s), fps)
    overlap = context_frames() if overlap is None else overlap
    cmax = min(snap_8n1((chunk_s or s.chunk_s) * fps + 1), SINGLE_MAX_FRAMES)
    if total <= SINGLE_MAX_FRAMES:
        n = 1
    else:
        n = math.ceil((total - overlap) / (cmax - overlap))
    # total and overlap are both 8n+1 (or overlap is 1), so the remainder is whole latent steps of 8
    units = (total - overlap) // 8
    base, extra = divmod(units, n)
    chunks, start = [], 0
    for i in range(n):
        frames = overlap + 8 * (base + (1 if i < extra else 0))
        chunks.append({
            "idx": i,
            "start_frame": start,
            "frames": frames,
            "t_start": round(start / fps, 3),
            "t_end": round((start + frames - 1) / fps, 3),
            "status": "pending",
        })
        start += frames - overlap
    return chunks


def fade_seconds(overlap_frames: int, shortest_s: float, fps: float = FPS) -> float:
    """Crossfade at a join: never longer than the footage the two chunks share, the configured
    overlap, a third of the shorter chunk, or 2 s."""
    return max(0.0, min(overlap_frames / fps, get_settings().chunk_overlap_s, shortest_s / 3.0, MAX_FADE_S))


# TODO: measure from warm chunks only; chunk 0 often pays the model load that estimate() adds separately
def measured_rate(db: Session, workspace_id: str | None = None) -> float | None:
    """GPU seconds per output second from recent finished long takes, if there are any."""
    q = (select(Generation.params)
         .where(Generation.kind == "take", Generation.status.in_(("ready", "approved")))
         .order_by(Generation.created_at.desc()).limit(40))
    if workspace_id:
        q = q.where(Generation.workspace_id == workspace_id)
    rates = [p["longtake_stats"]["gpu_per_output_s"] for p in db.scalars(q).all()
             if isinstance(p, dict) and (p.get("longtake_stats") or {}).get("gpu_per_output_s")]
    rates = rates[:10]
    return sum(rates) / len(rates) if rates else None


def estimate(duration_s: float, rate: float | None = None) -> dict:
    chunks = plan_chunks(duration_s)
    frames_total = frames_for(float(duration_s), FPS)
    generated = sum(c["frames"] for c in chunks)
    gpu = generated / FPS * (rate or GPU_S_PER_OUTPUT_S) + MODEL_LOAD_S
    # wall adds uploads/downloads per chunk and the join (re-encode runs at several x realtime)
    wall = gpu + 4.0 * len(chunks) + frames_total / FPS * 0.3
    return {
        "chunks": len(chunks),
        "frames_total": frames_total,
        "duration_s": round((frames_total - 1) / FPS, 3),
        "long_take": len(chunks) > 1,
        "method": method() if len(chunks) > 1 else "single",
        "est_gpu_s": round(gpu),
        "est_wall_s": round(wall),
        "rate_gpu_s_per_output_s": round(rate or GPU_S_PER_OUTPUT_S, 2),
    }


def init_params(params: dict) -> dict:
    """Turn ordinary take params into a long-take plan (called from prepare_shot_generation)."""
    duration = float(params["duration_s"])
    how = method()
    chunks = plan_chunks(duration, overlap=context_frames(how))
    params.update(
        longtake=True,
        num_frames=frames_for(duration, FPS),
        continuity=how,
        context_frames=context_frames(how),
        chunks=chunks,
        assembly={"status": "pending"},
    )
    return params


# ---------------------------------------------------------------- beats

class BeatText(BaseModel):
    prompt: str


class BeatList(BaseModel):
    beats: list[BeatText]


def beat_windows(chunks: list[dict], duration_s: float) -> list[tuple[float, float]]:
    # beats don't overlap: each runs from its chunk's start to the next chunk's start
    starts = [c["t_start"] for c in chunks]
    ends = starts[1:] + [round(float(duration_s), 3)]
    return list(zip(starts, ends))


def beats_fit(beats: list[dict] | None, chunks: list[dict], duration_s: float) -> bool:
    if not beats or len(beats) != len(chunks):
        return False
    for b, (t0, t1) in zip(beats, beat_windows(chunks, duration_s)):
        if b.get("stale") or not str(b.get("prompt", "")).strip():
            return False
        if abs(float(b.get("t_start", -1)) - t0) > 0.05 or abs(float(b.get("t_end", -1)) - t1) > 0.05:
            return False
    return True


def place_locked(beats: list[dict] | None, windows: list[tuple[float, float]],
                 old_duration: float | None) -> dict[int, dict]:
    """Locked beats survive a re-plan: each goes to the new window holding its (rescaled) midpoint.
    Two locked beats landing in one window are merged rather than dropped."""
    out: dict[int, dict] = {}
    locked = [b for b in beats or [] if b.get("locked") and str(b.get("prompt", "")).strip()]
    if not locked:
        return out
    new_duration = windows[-1][1] or 1.0
    scale = new_duration / old_duration if old_duration else 1.0
    for b in locked:
        mid = (float(b.get("t_start", 0)) + float(b.get("t_end", 0))) / 2 * scale
        idx = next((i for i, (t0, t1) in enumerate(windows) if t0 <= mid < t1), len(windows) - 1)
        if idx in out:
            out[idx]["prompt"] += f" Then {b['prompt'].strip()}"
        else:
            out[idx] = {"prompt": b["prompt"].strip(), "source": b.get("source") or "user"}
    return out


def beats_messages(project, scene, shot, characters, location, motion: str, windows, fixed: dict[int, dict]) -> list[dict]:
    rows = []
    for i, (t0, t1) in enumerate(windows):
        rows.append(f"{i + 1}. {t0:g}-{t1:g} s: " + (f"FIXED (keep exactly): {fixed[i]['prompt']}" if i in fixed else "(write this one)"))
    user = (
        f"Film: {project.title}. {project.logline}\n\nPeople in this shot:\n{P._people(characters)}\n\n"
        f"{P._place(location, scene)}\n\nThe shot: {shot.description or '(see the motion)'}\n"
        f"Camera: {shot.camera or 'as the motion says'}\n\nWhat happens over the whole take:\n{motion}\n\n"
        f"This is ONE continuous {windows[-1][1]:g}-second camera take with no cuts. A video model renders it in "
        f"{len(windows)} consecutive pieces, each continuing exactly where the previous one stopped. Write one "
        "beat per piece: what moves during that piece only (performance, gestures, the camera move, light), in "
        "order, so the action flows from beat to beat and reaches the end of the motion in the last beat. "
        "Keep every beat physically doable in its time, describe the people by appearance, present tense, one "
        "short paragraph under 60 words, plain text. Never introduce a cut, a new location or a time jump.\n\n"
        "Pieces:\n" + "\n".join(rows) + "\n\nAnswer as JSON {\"beats\": [{\"prompt\": ...}, ...]} with exactly "
        f"{len(windows)} beats in order; for FIXED pieces repeat the given text unchanged."
    )
    return [{"role": "system", "content": "You are a director breaking one long take into timed action beats. "
                                          "Answer only with JSON."},
            {"role": "user", "content": user}]


def write_beats(db: Session, shot: Shot, duration_s: float, *, tick=None, old_duration: float | None = None) -> tuple[list[dict], dict]:
    """Ask the creative model for one beat per chunk. Locked beats are kept (lock rule)."""
    chunks = plan_chunks(duration_s)
    windows = beat_windows(chunks, duration_s)
    fixed = place_locked(shot.beats, windows, old_duration or beats_span(shot.beats))
    project = db.get(Project, shot.project_id)
    scene = db.get(Scene, shot.scene_id)
    chars = [c for c in (db.get(Character, cid) for cid in shot.character_ids or []) if c is not None]
    loc_id = shot.location_id or (scene.location_id if scene else None)
    location = db.get(Location, loc_id) if loc_id else None
    motion = (shot.motion_prompt or shot.description or shot.prompt).strip()
    if not motion:
        raise LongTakeError("This shot has no motion prompt or description to split into beats.")

    if len(fixed) == len(windows):
        texts, info = [fixed[i]["prompt"] for i in range(len(windows))], {"model": None, "seconds": 0}
    else:
        res = chat_sync("creative", beats_messages(project, scene, shot, chars, location, motion, windows, fixed),
                        schema=BeatList, temperature=0.6, max_tokens=300 + 140 * len(windows), tick=tick)
        texts = [P.clean_line(b.prompt) for b in res.data.beats]
        info = res.call_info("creative")
        # models miscount on long lists; pad with the overall motion rather than fail the render
        texts = (texts + [motion] * len(windows))[:len(windows)]
    beats = []
    for i, (t0, t1) in enumerate(windows):
        if i in fixed:
            beats.append({"t_start": t0, "t_end": t1, **fixed[i], "locked": True})
        else:
            beats.append({"t_start": t0, "t_end": t1, "prompt": texts[i] or motion, "source": "ai", "locked": False})
    return beats, info


def beats_span(beats) -> float | None:
    try:
        return max(float(b.get("t_end", 0)) for b in beats) if beats else None
    except (TypeError, ValueError):
        return None


def mark_beats_stale(shot: Shot) -> None:
    if shot.beats:
        shot.beats = [{**b, "stale": True} for b in shot.beats]


def handle_beats(ctx) -> dict:
    """Job ai_beats: POST /shots/{id}/ai/beats."""
    db, job = ctx.db, ctx.job
    shot = db.get(Shot, job.payload.get("shot_id"))
    if shot is None or shot.workspace_id != job.workspace_id:
        raise RuntimeError("Shot no longer exists")
    duration = float(job.payload.get("duration_s") or shot.duration_s)
    ctx.progress(0.1, "Splitting the take into beats…")
    t0 = time.monotonic()
    try:
        beats, info = write_beats(db, shot, duration, old_duration=job.payload.get("old_duration_s"),
                                  tick=lambda: ctx.progress(0.1, f"Splitting the take into beats… {int(time.monotonic() - t0)} s"))
    except LLMError as e:
        raise RuntimeError(f"Couldn't write beats ({e}). Edit them by hand or try again when the AI is reachable.") from e
    shot.beats = beats
    return {"outcome": "written", "shot_ids": [shot.id], "beats": len(beats), "calls": [info] if info.get("model") else []}


# ---------------------------------------------------------------- media helpers

def _ffmpeg(args: list[str], timeout: float = 1800, tick=None) -> None:
    """Run ffmpeg; `tick` is called every few seconds (heartbeat / cancel check) and may raise."""
    cmd = [get_settings().ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", *args]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                _, err = proc.communicate(timeout=5)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() > deadline:
                    raise LongTakeError("ffmpeg timed out") from None
                if tick:
                    tick()
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    if proc.returncode != 0:
        raise LongTakeError(f"ffmpeg failed: {err.decode(errors='replace')[-600:]}")


def has_audio(path: Path) -> bool:
    # no ffprobe in imageio-ffmpeg; the stream list on stderr is enough
    r = subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-i", str(path)], capture_output=True, timeout=60)
    return b"Audio:" in r.stderr


def count_frames(path: Path) -> int:
    r = subprocess.run([get_settings().ffmpeg_path(), "-hide_banner", "-i", str(path), "-map", "0:v:0", "-f", "null", "-"],
                       capture_output=True, timeout=300)
    text = r.stderr.decode(errors="replace")
    found = [int(x) for x in re.findall(r"frame=\s*(\d+)", text)]
    return found[-1] if found else 0


def extract_tail(src: Path, frames_in_src: int, n: int, dest: Path, fps: float = FPS) -> Path:
    """The last n frames (+ their audio) as a small near-lossless clip for VHS_LoadVideo."""
    start = max(0, frames_in_src - n)
    args = ["-i", str(src), "-vf", f"select=gte(n\\,{start}),setpts=PTS-STARTPTS", "-fps_mode", "passthrough",
            "-frames:v", str(n), "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p"]
    if has_audio(src):
        args += ["-af", f"atrim=start={start / fps:.5f}:end={(start + n) / fps:.5f},asetpts=PTS-STARTPTS",
                 "-c:a", "aac", "-b:a", "192k"]
    _ffmpeg(args + [str(dest)])
    return dest


def extract_last_frame(src: Path, frames_in_src: int, dest: Path) -> Path:
    _ffmpeg(["-i", str(src), "-vf", f"select=eq(n\\,{max(0, frames_in_src - 1)})", "-fps_mode", "passthrough",
             "-frames:v", "1", str(dest)])
    return dest


def yuv_means(path: Path, first: int, count: int) -> tuple[float, float, float]:
    """Mean Y/U/V of frames [first, first+count) on a 64x36 thumbnail; plain Python, no numpy."""
    w, h = 64, 36
    cmd = [get_settings().ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-vf",
           f"select=between(n\\,{first}\\,{first + count - 1}),scale={w}:{h},format=yuv444p",
           "-fps_mode", "passthrough", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, timeout=300, check=True).stdout
    plane = w * h
    n = len(raw) // (plane * 3)
    if n == 0:
        raise LongTakeError(f"no frames read from {path.name}")
    sums = [0, 0, 0]
    for f in range(n):
        base = f * plane * 3
        for c in range(3):
            sums[c] += sum(raw[base + c * plane: base + (c + 1) * plane])
    return tuple(s / (n * plane) for s in sums)  # type: ignore[return-value]


# TODO: apply the running offset when extracting each tail too; the live 60 s take drifted ~1 luma level
# darker per chunk, which this corrects at the join but which still compounds inside generation
def colour_offsets(files: list[Path], frames: list[int], overlap: int) -> list[tuple[float, float, float]]:
    """Drift correction chained back to chunk 0: the frames two chunks share show the same
    moment, so any difference in their means is drift, not content."""
    out = [(0.0, 0.0, 0.0)]
    n = max(1, min(overlap, 9))
    for k in range(1, len(files)):
        try:
            tail = yuv_means(files[k - 1], frames[k - 1] - n, n)
            head = yuv_means(files[k], 0, n)
        except (LongTakeError, subprocess.SubprocessError) as e:
            log.warning("colour match skipped for chunk %d: %s", k, e)
            out.append(out[-1])
            continue
        prev = out[-1]
        y, u, v = (prev[i] + tail[i] - head[i] for i in range(3))
        out.append((max(-MAX_LUMA_SHIFT, min(MAX_LUMA_SHIFT, y)),
                    max(-MAX_CHROMA_SHIFT, min(MAX_CHROMA_SHIFT, u)),
                    max(-MAX_CHROMA_SHIFT, min(MAX_CHROMA_SHIFT, v))))
    return out


def _lut(off: tuple[float, float, float]) -> str:
    if all(abs(x) < 0.5 for x in off):
        return ""
    y, u, v = off
    return f",lutyuv=y=clip(val{y:+.1f}\\,0\\,255):u=clip(val{u:+.1f}\\,0\\,255):v=clip(val{v:+.1f}\\,0\\,255)"


def join_command(files: list[Path], frames: list[int], overlap: int, out: Path, *, audio: list[bool] | None = None,
                 offsets: list[tuple[float, float, float]] | None = None, crossfade: bool = True,
                 fps: float = FPS) -> tuple[list[str], dict]:
    """ffmpeg args (without the binary) that join chunks into one h264/AAC mp4.

    Chunk k>0 repeats the last `overlap` frames of chunk k-1. With a fade of F frames the
    first overlap-F of them are dropped and the remaining F are crossfaded (video xfade +
    triangular acrossfade), so the result has exactly sum(frames) - overlap*(n-1) frames."""
    n = len(files)
    audio = audio if audio is not None else [True] * n
    offsets = offsets or [(0.0, 0.0, 0.0)] * n
    args: list[str] = []
    for f in files:
        args += ["-i", str(f)]
    silent_idx = {}
    for k in range(n):
        if not audio[k]:
            silent_idx[k] = n + len(silent_idx)
            args += ["-f", "lavfi", "-t", f"{frames[k] / fps:.5f}", "-i", "anullsrc=r=48000:cl=stereo"]

    fades: list[int] = [0]
    for k in range(1, n):
        shortest = min(frames[k - 1], frames[k]) / fps
        f = int(round(fade_seconds(overlap, shortest, fps) * fps)) if crossfade else 0
        fades.append(f if f >= 2 else 0)

    parts = []
    for k in range(n):
        drop = overlap - fades[k] if k else 0
        # trim and reset timestamps before fps=: xfade refuses inputs whose frame rate setpts has blanked
        parts.append(f"[{k}:v]trim=start_frame={drop}:end_frame={frames[k]},setpts=PTS-STARTPTS,fps={fps:g},"
                     f"format=yuv420p{_lut(offsets[k])}[v{k}]")
        src = f"{silent_idx[k]}:a" if k in silent_idx else f"{k}:a"
        parts.append(f"[{src}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,"
                     f"atrim=start={drop / fps:.5f}:end={frames[k] / fps:.5f},asetpts=PTS-STARTPTS[a{k}]")
    vcur, acur = "v0", "a0"
    length = frames[0]
    for k in range(1, n):
        kept = frames[k] - (overlap - fades[k])
        vo, ao = f"vx{k}", f"ax{k}"
        if fades[k]:
            d = fades[k] / fps
            parts.append(f"[{vcur}][v{k}]xfade=transition=fade:duration={d:.5f}:offset={(length - fades[k]) / fps:.5f}[{vo}]")
            parts.append(f"[{acur}][a{k}]acrossfade=d={d:.5f}:c1=tri:c2=tri[{ao}]")
            length += kept - fades[k]
        else:
            parts.append(f"[{vcur}][{acur}][v{k}][a{k}]concat=n=2:v=1:a=1[{vo}][{ao}]")
            length += kept
        vcur, acur = vo, ao

    args += ["-filter_complex", ";".join(parts), "-map", f"[{vcur}]", "-map", f"[{acur}]",
             "-frames:v", str(length), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
             "-r", f"{fps:g}", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(out)]
    return args, {"fade_frames": fades[1:], "frames": length, "crossfade": crossfade}


def assemble(files: list[Path], frames: list[int], overlap: int, out: Path, tick=None) -> dict:
    audio = [has_audio(f) for f in files]
    offsets = colour_offsets(files, frames, overlap) if len(files) > 1 else None
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".join.mp4")
    if len(files) == 1:
        args, info = join_command(files, frames, overlap, tmp, audio=audio)
        _ffmpeg(args, tick=tick)
    else:
        try:
            args, info = join_command(files, frames, overlap, tmp, audio=audio, offsets=offsets)
            _ffmpeg(args, tick=tick)
        except LongTakeError as e:
            # same fallback as the Reel: a hard join beats no take at all
            log.warning("crossfade join failed, retrying with hard joins: %s", e)
            args, info = join_command(files, frames, overlap, tmp, audio=audio, offsets=offsets, crossfade=False)
            _ffmpeg(args, tick=tick)
            info["fallback"] = str(e)[:300]
    tmp.replace(out)
    info["colour_offsets"] = [[round(x, 2) for x in o] for o in (offsets or [])]
    return info


# ---------------------------------------------------------------- the take job

def _owner_dir(gen: Generation) -> Path:
    # Create Video clips (target "media") live with the rest of the library, not under a project
    # TODO: library.delete_item only removes the final file; a long clip's chunk folder stays behind
    if gen.target_type == "media":
        return Path("workspaces") / gen.workspace_id / "media"
    return Path("workspaces") / gen.workspace_id / "projects" / (gen.project_id or "_unassigned")


def take_dir(gen: Generation) -> tuple[Path, str]:
    rel = _owner_dir(gen) / "takes" / gen.id
    return get_settings().data_dir / rel, rel.as_posix()


def _chunk_ok(c: dict) -> bool:
    return c.get("status") == "done" and bool(c.get("file")) and (get_settings().data_dir / c["file"]).is_file()


def _publish(db: Session, gen: Generation, **changes) -> None:
    # a fresh dict so the JSON column (and the SSE generation event) sees the change
    gen.params = {**(gen.params or {}), **changes}
    db.commit()


def resolve_beats(ctx, gen: Generation, shot: Shot | None, chunks: list[dict], duration: float) -> tuple[list[str], str]:
    """Prompt text per chunk. Beats on the shot are used when they fit this plan; otherwise
    they are written now (and saved on the shot when the take uses the shot's own duration)."""
    if any(c.get("prompt") for c in chunks):
        # a chunk re-roll pins its prompts in params; keep them
        return [c.get("prompt") or "" for c in chunks], "params"
    if shot is None:
        return [gen.prompt] * len(chunks), "take_prompt"
    if beats_fit(shot.beats, chunks, duration):
        return [b["prompt"] for b in shot.beats], "shot"
    ctx.progress(0.01, "Writing the take's beats…")
    try:
        beats, _ = write_beats(ctx.db, shot, duration, tick=lambda: ctx.progress(0.01, "Writing the take's beats…"))
    except (LLMError, LongTakeError) as e:
        # the take still renders, every chunk just follows the whole-take motion prompt
        log.warning("beats unavailable for %s, using the take prompt: %s", gen.id, e)
        return [gen.prompt] * len(chunks), f"take_prompt ({str(e)[:120]})"
    if abs(float(shot.duration_s) - duration) < 0.05:
        shot.beats = beats
        ctx.db.commit()
    return [b["prompt"] for b in beats], "ai"


def chunk_prompt(db: Session, shot: Shot | None, beat: str, take_prompt: str) -> str:
    if shot is None or beat.strip() == take_prompt.strip():
        return take_prompt
    anchors = sb.world_anchors(db, shot)
    text = f"{beat.strip()}\n{anchors}" if anchors and anchors not in beat else beat.strip()
    return sb.with_style(db.get(Project, shot.project_id), text)


def run_take(ctx, gen: Generation, driver) -> dict:
    db = ctx.db
    params = dict(gen.params or {})
    chunks = [dict(c) for c in params.get("chunks") or []]
    if not chunks:
        raise LongTakeError("This take has no chunk plan")
    n = len(chunks)
    how = params.get("continuity") or "extend"
    overlap = int(params.get("context_frames") or (1 if how == "i2v" else 9))
    fps = float(params.get("fps") or FPS)
    duration = float(params.get("duration_s") or 0)
    folder, rel_folder = take_dir(gen)
    folder.mkdir(parents=True, exist_ok=True)
    shot = db.get(Shot, gen.target_id) if gen.target_type == "shot" else None

    beats, beat_source = resolve_beats(ctx, gen, shot, chunks, duration)
    for c, b in zip(chunks, beats):
        c["prompt"] = b
    _publish(db, gen, chunks=chunks, beats_source=beat_source)

    todo = sum(c["frames"] for c in chunks if not _chunk_ok(c)) or 1
    done_frames = 0
    gpu_this_run = 0.0
    t_run = time.monotonic()

    for c in chunks:
        k = c["idx"]
        if _chunk_ok(c):
            continue
        out_path = folder / f"chunk_{k}.mp4"
        cparams = {
            "kind": "take_chunk", "chunk_idx": k, "num_frames": c["frames"], "duration_s": c["frames"] / fps,
            "fps": fps, "width": params.get("width"), "height": params.get("height"),
            "aspect_ratio": params.get("aspect_ratio"), "generation_id": f"{gen.id}_c{k}",
            "project_id": gen.project_id, "target_type": gen.target_type, "target_id": gen.target_id,
            "loras": params.get("loras"), "negative": params.get("negative"),
        }
        if k == n - 1 and params.get("last_frame_id"):
            cparams["last_frame_id"] = params["last_frame_id"]
        if k == 0:
            if params.get("first_frame_id"):
                cparams["first_frame_id"] = params["first_frame_id"]
            else:
                cparams["text_start"] = True
        else:
            prev = chunks[k - 1]
            prev_file = get_settings().data_dir / prev["file"]
            if how == "i2v":
                cparams["first_image_path"] = str(extract_last_frame(prev_file, prev["frames"], folder / f"last_{k - 1}.png"))
            else:
                # unique per take/chunk: the upload lands in a shared ComfyUI input folder
                tail = extract_tail(prev_file, prev["frames"], overlap, folder / f"{gen.id[:8]}_tail_{k - 1}.mp4", fps)
                cparams.update(context_video=str(tail), context_frames=overlap)
        seed = int(c.get("seed") or (gen.seed + 7919 * k) % (2**31 - 1))
        c.update(status="generating", seed=seed)
        c.pop("error", None)
        _publish(db, gen, chunks=chunks)

        base = done_frames

        def cb(frac: float, msg: str = "", _c=c, _base=base) -> None:
            overall = (_base + max(0.0, min(1.0, frac)) * _c["frames"]) / todo
            ctx.progress(0.02 + 0.92 * overall, f"Chunk {_c['idx'] + 1} of {n} · {int(overall * 100)}%")

        cb(0.0)
        t0 = time.monotonic()
        prompt = chunk_prompt(db, shot, c["prompt"], gen.prompt)
        try:
            result = driver.generate_video(prompt, cparams, seed, out_path, cb)
        except Exception as e:
            db.rollback()
            if type(e).__name__ in ("JobCancelled", "WorkerStopping"):
                c["status"] = "pending"
            else:
                c.update(status="failed", error=str(e)[:300])
            gen.params = {**(gen.params or {}), "chunks": chunks}
            db.commit()
            raise
        gpu = float((result.meta or {}).get("gpu_seconds") or round(time.monotonic() - t0, 3))
        actual = count_frames(out_path)
        if actual and actual != c["frames"]:
            # the join and the next chunk's context are cut by frame index, so trust the file
            log.warning("chunk %d of %s has %d frames, planned %d", k, gen.id, actual, c["frames"])
            c["frames_planned"], c["frames"] = c["frames"], actual
        gpu_this_run += gpu
        c.update(status="done", file=f"{rel_folder}/chunk_{k}.mp4", gpu_seconds=round(gpu, 3),
                 template=(result.meta or {}).get("template"))
        if result.params_update.get("comfy"):
            c["prompt_id"] = result.params_update["comfy"].get("prompt_id")
        done_frames += c["frames"]
        _publish(db, gen, chunks=chunks)

    ctx.progress(0.95, f"Joining {n} chunk{'s' if n > 1 else ''}")
    _publish(db, gen, assembly={"status": "running"})
    final, rel_final = _final_path(gen)
    files = [get_settings().data_dir / c["file"] for c in chunks]
    t_join = time.monotonic()
    info = assemble(files, [c["frames"] for c in chunks], overlap, final,
                    tick=lambda: ctx.progress(0.95, f"Joining {n} chunks · {int(time.monotonic() - t_join)} s"))
    info["join_seconds"] = round(time.monotonic() - t_join, 1)
    total_gpu = sum(float(c.get("gpu_seconds") or 0) for c in chunks)
    out_s = info["frames"] / fps
    _publish(db, gen, assembly={"status": "done", **info},
             longtake_stats={"chunks": n, "method": how, "gpu_seconds": round(total_gpu, 1),
                       "gpu_per_output_s": round(total_gpu / out_s, 2) if out_s else None,
                       "wall_seconds_last_run": round(time.monotonic() - t_run, 1)})
    gen.file_path = rel_final
    gen.media_type = "video/mp4"
    gen.status = "ready"
    for p in folder.glob("*_tail_*.mp4"):
        p.unlink(missing_ok=True)
    return {"file_path": rel_final, "media_type": "video/mp4", "duration_s": round(out_s, 3), "chunks": n,
            "gpu_seconds": round(gpu_this_run, 3) or None, "method": how}


def _final_path(gen: Generation) -> tuple[Path, str]:
    sub = "" if gen.target_type == "media" else "generations"
    rel = _owner_dir(gen) / sub / f"{gen.id}.mp4"
    return get_settings().data_dir / rel, rel.as_posix()


# ---------------------------------------------------------------- chunk re-roll

def reroll_params(parent: Generation, idx: int, prompt: str | None, seed: int | None) -> dict:
    """Params for a new take version that keeps chunks < idx and redoes idx..end (they all
    depend on the tail of the chunk before). Files for kept chunks are copied in later."""
    params = dict(parent.params or {})
    chunks = [dict(c) for c in params.get("chunks") or []]
    if not (0 <= idx < len(chunks)):
        raise LongTakeError(f"chunk {idx} doesn't exist (this take has {len(chunks)})")
    for c in chunks[idx:]:
        for key in ("file", "gpu_seconds", "prompt_id", "template", "error", "seed"):
            c.pop(key, None)
        c["status"] = "pending"
    if prompt:
        chunks[idx]["prompt"] = prompt.strip()
    if seed is not None:
        chunks[idx]["seed"] = int(seed)
    else:
        chunks[idx]["seed"] = int.from_bytes(os.urandom(4), "big") % (2**31 - 1)
    params.update(chunks=chunks, assembly={"status": "pending"}, rerolled_from={"generation_id": parent.id, "chunk": idx})
    for key in ("comfy", "longtake_stats", "beats_source"):
        params.pop(key, None)
    return params


def copy_kept_chunks(parent: Generation, child: Generation) -> None:
    src_dir, _ = take_dir(parent)
    dst_dir, rel_dst = take_dir(child)
    dst_dir.mkdir(parents=True, exist_ok=True)
    chunks = [dict(c) for c in child.params.get("chunks") or []]
    for c in chunks:
        if c.get("status") != "done" or not c.get("file"):
            continue
        src = get_settings().data_dir / c["file"]
        dst = dst_dir / f"chunk_{c['idx']}.mp4"
        if not src.is_file():
            # parent's file is gone: render it again rather than fail later
            c["status"] = "pending"
            c.pop("file", None)
            continue
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
        c["file"] = f"{rel_dst}/chunk_{c['idx']}.mp4"
    child.params = {**child.params, "chunks": chunks}
