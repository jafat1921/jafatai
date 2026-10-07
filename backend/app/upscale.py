"""Upscaling a stitched video (contract v4).

The source is cut into overlapping segments (UPSCALE_SEGMENT_S long, sharing UPSCALE_OVERLAP_S with
the next one). Each segment goes through one ComfyUI upscale template as a video-only clip and the
result is checkpointed under .../upscales/{generation_id}/seg_{i}.mp4, so a restarted job carries on
at the first missing segment. The join cuts every segment into a body (the frames nobody else has)
plus one crossfaded seam clip per overlap, encodes them all with the same recipe and stitches them
with the concat demuxer, so even an hour-long film is one encode pass with a bounded filter graph.
The original audio (and chapters) are then muxed back with -c copy: the upscale never touches sound.
"""
import logging
import math
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import longtake as lt
from app import reel as rl
from app.config import get_settings
from app.models import Generation, Job, Project, new_id
from app.services import generation_file, new_seed, next_version

log = logging.getLogger("mixai.upscale")

JOB_TYPE = "upscale"
TARGETS = {"1080p": (1920, 1080), "1440p": (2560, 1440), "4k": (3840, 2160)}
TARGET_LABELS = {"1080p": "1080p (Full HD)", "1440p": "1440p (QHD)", "4k": "4K (UHD)"}
ALIASES = {"seedvr2": "best", "seedvr": "best", "flashvsr": "fast", "esrgan": "quick", "realesrgan": "quick"}
# one model load per job (SeedVR2 3B + VAE, or the FlashVSR pipeline); later segments run warm
MODEL_LOAD_S = 60.0
REF_MP = 1536 * 896 / 1e6  # x2 of our 768x448 drafts; the options endpoint quotes rates at this size
ENC = ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-profile:v", "high"]


class UpscaleError(RuntimeError):
    pass


@dataclass(frozen=True)
class Engine:
    id: str
    label: str
    template: str
    max_scale: float
    fixed_scales: tuple[int, ...] = ()  # FlashVSR only does x2 / x4
    # GPU seconds per output second per output megapixel. Provisional until the server benchmark
    # (scripts/bench_upscale.py) or finished jobs give real numbers; see measured_rates().
    rate_mp: float = 30.0
    blurb: str = ""


ENGINES = {
    "best": Engine("best", "Best · SeedVR2", "upscale_seedvr2", 4.0, rate_mp=30.0,
                   blurb="Diffusion restoration with temporal chunks; most detail, steady from frame to frame."),
    "fast": Engine("fast", "Fast · FlashVSR", "upscale_flashvsr", 4.0, (2, 4), rate_mp=6.0,
                   blurb="Streaming video super-resolution; much quicker, a little softer."),
    "quick": Engine("quick", "Quick preview · RealESRGAN", "upscale_esrgan", 4.0, rate_mp=2.5,
                    blurb="Frame-by-frame GAN upscale; fastest, fine texture can shimmer."),
}
SEEDVR2_RATE_7B = 60.0


def engine_id(value: str | None) -> str:
    v = (value or get_settings().upscale_default_engine or "best").strip().lower()
    v = ALIASES.get(v, v)
    if v not in ENGINES:
        raise UpscaleError(f"Unknown upscale engine '{value}' (expected one of {', '.join(ENGINES)})")
    return v


def default_engine() -> str:
    try:
        return engine_id(None)
    except UpscaleError:
        log.warning("UPSCALE_DEFAULT_ENGINE=%r isn't an engine; using best", get_settings().upscale_default_engine)
        return "best"


def seedvr2_variant(value: str | None) -> str:
    v = (value or get_settings().upscale_seedvr2_model or "3b").strip().lower()
    return v if v in ("3b", "7b") else "3b"


# ---------------------------------------------------------------- sizes

def _even(x: float) -> int:
    return max(2, int(x) // 2 * 2)


def target_box(target: str, src_w: int, src_h: int) -> tuple[int, int]:
    if target not in TARGETS:
        raise UpscaleError(f"Unknown target '{target}' (expected {', '.join(TARGETS)})")
    bw, bh = TARGETS[target]
    # a vertical film gets a vertical box: "1080p" for 9:16 means 1080x1920, not 608x1080
    return (bh, bw) if src_h > src_w else (bw, bh)


def fit_inside(src_w: int, src_h: int, box: tuple[int, int]) -> tuple[int, int, float]:
    s = min(box[0] / src_w, box[1] / src_h)
    w = min(box[0], round(src_w * s))
    h = min(box[1], round(src_h * s))
    return _even(w), _even(h), s


def engine_scale(engine: Engine, needed: float) -> float:
    if not engine.fixed_scales:
        return min(needed, engine.max_scale)
    lower = [k for k in engine.fixed_scales if k <= needed]
    # x2 then a lanczos nudge up to x2.4 looks the same as x4 and down, at a quarter of the GPU time
    if lower and needed / max(lower) <= 1.25:
        return float(max(lower))
    higher = [k for k in engine.fixed_scales if k >= needed]
    return float(min(higher) if higher else max(engine.fixed_scales))


@dataclass
class SizePlan:
    width: int  # final
    height: int
    engine_width: int  # what ComfyUI returns; ffmpeg lanczos covers the rest
    engine_height: int
    scale: float  # engine scale actually used
    needed: float


def size_plan(engine: Engine, src_w: int, src_h: int, target: str) -> SizePlan:
    w, h, needed = fit_inside(src_w, src_h, target_box(target, src_w, src_h))
    if needed <= 1.01:
        raise UpscaleError(f"This video is already {src_w}x{src_h}, at or above {target}")
    k = engine_scale(engine, needed)
    if not engine.fixed_scales and k >= needed:
        ew, eh = w, h  # the graph resizes straight to the final size
    else:
        ew, eh = _even(src_w * k), _even(src_h * k)
    return SizePlan(w, h, ew, eh, round(k, 3), round(needed, 3))


# ---------------------------------------------------------------- segments

def plan_segments(total_frames: int, fps: float, seg_s: float | None = None, overlap_s: float | None = None) -> list[dict]:
    """Overlapping segments over [0, total_frames). Segment k>0 starts `ov` frames before segment
    k-1 ends. New frames are spread evenly so the last segment is never a stub."""
    s = get_settings()
    seg = max(2, round((seg_s or s.upscale_segment_s) * fps))
    ov = max(0, round((s.upscale_overlap_s if overlap_s is None else overlap_s) * fps))
    # a body must survive both overlaps being cut off it
    ov = min(ov, max(0, (seg - 1) // 3))
    if total_frames <= seg:
        n = 1
    else:
        n = math.ceil((total_frames - ov) / (seg - ov))
    base, extra = divmod(total_frames - ov if n > 1 else total_frames, n)
    out, start = [], 0
    for i in range(n):
        frames = (ov if n > 1 else 0) + base + (1 if i < extra else 0)
        out.append({"idx": i, "start_frame": start, "frames": frames, "t_start": round(start / fps, 3),
                    "t_end": round((start + frames) / fps, 3), "status": "pending"})
        start += frames - ov
    return out


def overlap_frames(segments: list[dict]) -> int:
    if len(segments) < 2:
        return 0
    a, b = segments[0], segments[1]
    return a["start_frame"] + a["frames"] - b["start_frame"]


# ---------------------------------------------------------------- media

_FPS = re.compile(r"Video: .*?, (\d+(?:\.\d+)?) fps")
NTSC = {23.98: "24000/1001", 23.976: "24000/1001", 29.97: "30000/1001", 59.94: "60000/1001"}


@dataclass
class Source:
    path: Path
    width: int
    height: int
    fps: float
    fps_str: str
    frames: int
    has_audio: bool
    chapters: int


def probe_source(path: Path) -> Source:
    p = rl.probe(path)
    if not p.has_video:
        raise UpscaleError(f"{path.name} has no video stream")
    # rl.probe doesn't keep the frame rate; one more header read is cheap
    err = subprocess.run([rl.ffmpeg(), "-hide_banner", "-nostdin", "-i", str(path)], capture_output=True, text=True,
                         encoding="utf-8", errors="replace", timeout=60).stderr
    m = _FPS.search(err)
    fps = float(m[1]) if m else 24.0
    fps_str = NTSC.get(round(fps, 3)) or NTSC.get(round(fps, 2)) or f"{fps:g}"
    if "/" in fps_str:
        a, b = fps_str.split("/")
        fps = int(a) / int(b)
    return Source(path, p.width, p.height, fps, fps_str, lt.count_frames(path), p.has_audio, len(p.chapters))


def ff(args: list[str], tick=None, timeout: float = 3600) -> None:
    lt._ffmpeg(args, timeout=timeout, tick=tick)


def cut_segment(src: Source, seg: dict, dest: Path, tick=None) -> Path:
    """Frames [start, start+frames) as a near-lossless video-only clip for VHS_LoadVideo."""
    start = seg["start_frame"]
    args = []
    if start:
        # accurate input seek, half a frame early so rounding can't eat the first frame
        args += ["-ss", f"{max(0.0, (start - 0.5) / src.fps):.5f}"]
    args += ["-i", str(src.path), "-map", "0:v:0", "-an", "-frames:v", str(seg["frames"]),
             "-vf", "setpts=PTS-STARTPTS", "-r", src.fps_str,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-pix_fmt", "yuv420p", str(dest)]
    ff(args, tick=tick)
    return dest


def _scaled(label_in: str, w: int, h: int, fps: str, label_out: str, pre: str = "") -> str:
    # fps= first, while the stream is whole: after trim it rounds the last frame away
    return (f"[{label_in}]fps={fps},{pre}setpts=PTS-STARTPTS,scale={w}:{h}:flags=lanczos,setsar=1,"
            f"format=yuv420p[{label_out}]")


def body_cmd(seg_file: Path, frames: int, actual: int, head: int, tail: int, size: tuple[int, int],
             fps: str, dest: Path) -> list[str]:
    pad = f"tpad=stop_mode=clone:stop={frames - actual}," if actual and actual < frames else ""
    keep = frames - head - tail
    g = _scaled("0:v", size[0], size[1], fps, "v", pre=f"{pad}trim=start_frame={head}:end_frame={frames - tail},")
    return ["-i", str(seg_file), "-filter_complex", g, "-map", "[v]", "-frames:v", str(keep), *ENC,
            "-r", fps, "-an", str(dest)]


def seam_cmd(left: Path, left_frames: int, left_actual: int, right: Path, right_actual: int, ov: int,
             size: tuple[int, int], fps: str, dest: Path) -> list[str]:
    lpad = f"tpad=stop_mode=clone:stop={left_frames - left_actual}," if left_actual and left_actual < left_frames else ""
    rpad = f"tpad=stop_mode=clone:stop={ov - right_actual}," if right_actual and right_actual < ov else ""
    w, h = size
    g = ";".join([
        _scaled("0:v", w, h, fps, "l", pre=f"{lpad}trim=start_frame={left_frames - ov}:end_frame={left_frames},"),
        _scaled("1:v", w, h, fps, "r", pre=f"{rpad}trim=end_frame={ov},"),
        # a linear mix by frame number; xfade wants frame-rate metadata that trim has already dropped
        f"[l][r]blend=all_expr='A*(1-(N+1)/{ov + 1})+B*(N+1)/{ov + 1}',format=yuv420p[v]",
    ])
    return ["-i", str(left), "-i", str(right), "-filter_complex", g, "-map", "[v]", "-frames:v", str(ov), *ENC,
            "-r", fps, "-an", str(dest)]


def mux_cmd(video: Path, source: Path, dest: Path) -> list[str]:
    # audio and chapters straight from the source, bit for bit
    return ["-i", str(video), "-i", str(source), "-map", "0:v:0", "-map", "1:a?", "-map_metadata", "1",
            "-map_chapters", "1", "-c", "copy", "-movflags", "+faststart", str(dest)]


def join(files: list[Path], segments: list[dict], size: tuple[int, int], src: Source, workdir: Path,
         dest: Path, progress=None) -> dict:
    workdir.mkdir(parents=True, exist_ok=True)
    n = len(segments)
    ov = overlap_frames(segments)
    parts: list[Path] = []
    tick = (lambda: progress(None)) if progress else None
    for k, (f, seg) in enumerate(zip(files, segments)):
        if progress:
            progress(k / n)
        actual = int(seg.get("frames_out") or seg["frames"])
        if k:
            prev = segments[k - 1]
            seam = workdir / f"seam_{k:05d}.mp4"
            ff(seam_cmd(files[k - 1], prev["frames"], int(prev.get("frames_out") or prev["frames"]), f, actual, ov,
                        size, src.fps_str, seam), tick=tick)
            parts.append(seam)
        head = ov if k else 0
        tail = ov if k < n - 1 else 0
        if seg["frames"] - head - tail > 0:
            body = workdir / f"body_{k:05d}.mp4"
            ff(body_cmd(f, seg["frames"], actual, head, tail, size, src.fps_str, body), tick=tick)
            parts.append(body)

    lst = rl.write_concat_list(workdir, [rl.Entry(p) for p in parts], name="video.ffconcat")
    video = workdir / "video.mp4"
    mode = "copy"
    ff(["-f", "concat", "-safe", "0", "-i", str(lst), "-map", "0:v", "-c", "copy", str(video)], tick=tick)
    got = lt.count_frames(video)
    if got != src.frames:
        log.warning("concat copy gave %d frames, expected %d; re-encoding the join", got, src.frames)
        mode = "reencode"
        ff(["-f", "concat", "-safe", "0", "-i", str(lst), "-map", "0:v", *ENC, "-r", src.fps_str,
            "-frames:v", str(src.frames), str(video)], tick=tick)
        got = lt.count_frames(video)
    tmp = dest.with_name(dest.stem + ".mux.mp4")
    ff(mux_cmd(video, src.path, tmp), tick=tick)
    tmp.replace(dest)
    return {"frames": got, "join": mode, "parts": len(parts), "overlap_frames": ov}


# ---------------------------------------------------------------- estimates and options

def rate_for(engine: Engine, variant: str = "3b", measured: dict | None = None) -> tuple[float, str]:
    key = f"{engine.id}:{variant}" if engine.id == "best" else engine.id
    if measured and measured.get(key):
        return measured[key], "measured"
    if engine.id == "best" and variant == "7b":
        return SEEDVR2_RATE_7B, "provisional"
    return engine.rate_mp, "provisional"


def measured_rates(db: Session, limit: int = 60) -> dict[str, float]:
    """Mean GPU s per output second per output MP of recent finished upscales, keyed engine[:variant]."""
    rows = db.scalars(select(Generation.params).where(
        Generation.kind == "render", Generation.parent_id.is_not(None), Generation.status.in_(("ready", "approved")),
    ).order_by(Generation.created_at.desc()).limit(limit)).all()
    acc: dict[str, list[float]] = {}
    for p in rows:
        st, up = (p or {}).get("upscale_stats") or {}, (p or {}).get("upscale") or {}
        if not st.get("rate_mp") or not up.get("engine"):
            continue
        key = f"best:{up.get('variant') or '3b'}" if up["engine"] == "best" else up["engine"]
        acc.setdefault(key, []).append(float(st["rate_mp"]))
    return {k: sum(v[:10]) / len(v[:10]) for k, v in acc.items()}


def estimate(engine: Engine, sp: SizePlan, duration_s: float, variant: str = "3b", measured: dict | None = None) -> dict:
    rate, source = rate_for(engine, variant, measured)
    mp = sp.engine_width * sp.engine_height / 1e6
    # overlaps are upscaled twice
    s = get_settings()
    redo = 1.0 + (s.upscale_overlap_s / s.upscale_segment_s if duration_s > s.upscale_segment_s else 0.0)
    gpu = rate * mp * duration_s * redo + MODEL_LOAD_S
    return {"est_gpu_s": round(gpu), "rate_gpu_s_per_output_s": round(rate * mp, 2), "estimate_source": source}


def _model_options(object_info: dict, cls: str, field: str) -> list:
    from app.workflows import _enum_options

    spec = (object_info.get(cls, {}).get("input", {}).get("required", {}) or {}).get(field)
    return _enum_options(spec) or []


# FlashVSR's weights (FlashVSR1_1, plus the older Wan2_1-T2V-1_3B_FlashVSR) are installed on the server.
# AILab_FlashVSR_Advanced only picks Tiny/Full and loads v1.1 itself, so there's no version to choose.


def engine_options(object_info: dict | None, *, driver: str, measured: dict | None = None,
                   error: str | None = None) -> dict:
    from app.workflows import check_template, load

    engines = []
    for e in ENGINES.values():
        item = {"id": e.id, "label": e.label, "description": e.blurb, "template": e.template,
                "available": True, "scales": list(e.fixed_scales) or [2, 4], "max_scale": e.max_scale}
        rate, source = rate_for(e, seedvr2_variant(None), measured)
        item["est_gpu_s_per_output_s"] = round(rate * REF_MP, 1)
        item["estimate_source"] = source
        if e.id == "best":
            item["variants"] = ["3b", "7b"]
            item["default_variant"] = seedvr2_variant(None)
        if driver == "mock":
            item["reason"] = None
        elif object_info is None:
            item.update(available=False, reason=f"ComfyUI isn't reachable ({error or 'no answer'})")
        else:
            res = check_template(e.template, object_info)
            problems = ([f"missing nodes: {', '.join(res['missing_nodes'])}"] if res["missing_nodes"] else []) + \
                       ([f"missing models: {', '.join(res['missing_models'])}"] if res["missing_models"] else []) + \
                       res["invalid"][:3]
            if e.id == "best":
                have = set(_model_options(object_info, "UNETLoader", "unet_name"))
                variants = load(e.template).manifest.get("variants", {})
                item["variants"] = [v for v, f in variants.items() if f in have]
                if not item["variants"]:
                    problems.append("missing models: " + ", ".join(variants.values()))
                elif item["default_variant"] not in item["variants"]:
                    item["default_variant"] = item["variants"][0]
            if e.id == "fast":
                versions = _model_options(object_info, "AILab_FlashVSR_Advanced", "model_version")
                if versions and "Tiny (Fast)" not in versions:
                    problems.append("FlashVSR node has no 'Tiny (Fast)' model option")
            if problems:
                item.update(available=False, reason="; ".join(problems))
        engines.append(item)
    default = default_engine()
    if not next(x for x in engines if x["id"] == default)["available"]:
        default = next((x["id"] for x in engines if x["available"]), default)
    return {"engines": engines, "default_engine": default,
            "targets": [{"id": k, "label": TARGET_LABELS[k], "width": w, "height": h} for k, (w, h) in TARGETS.items()]}


# last /object_info seen by the options endpoint, so queueing can refuse an engine the server lacks
# without a network call of its own
_INFO_CACHE: dict = {"at": 0.0, "info": None, "error": None}
INFO_TTL_S = 600.0


async def fetch_object_info(max_age: float = 120.0) -> tuple[dict | None, str | None]:
    if _INFO_CACHE["info"] is not None and time.monotonic() - _INFO_CACHE["at"] < max_age:
        return _INFO_CACHE["info"], None
    from app.drivers.comfy_client import pick_client

    s = get_settings()
    try:
        client = await pick_client(s.comfy_urls, s.comfy_auth_token, s.comfy_verify_tls)
    except Exception as e:
        return None, str(e) or type(e).__name__
    try:
        info = await client.object_info()
    except Exception as e:
        return None, f"object_info failed: {e}"
    finally:
        await client.close()
    _INFO_CACHE.update(at=time.monotonic(), info=info, error=None)
    return info, None


def known_unavailable(eid: str) -> str | None:
    """Reason the engine can't run, if a recent /object_info said so; None when fine or unknown."""
    if get_settings().gen_driver == "mock":
        return None
    info = _INFO_CACHE["info"]
    if info is None or time.monotonic() - _INFO_CACHE["at"] > INFO_TTL_S:
        return None
    item = next(e for e in engine_options(info, driver="comfy")["engines"] if e["id"] == eid)
    return None if item["available"] else item["reason"]


def source_size(g: Generation) -> tuple[int, int]:
    size = (g.params or {}).get("size")
    if isinstance(size, list) and len(size) == 2 and all(size):
        return int(size[0]), int(size[1])
    path = generation_file(g)
    p = rl.probe(path) if path and path.is_file() else None
    if not p or not p.width:
        raise UpscaleError("Couldn't read this video's size")
    return p.width, p.height


def source_estimates(g: Generation, measured: dict | None = None) -> dict:
    w, h = source_size(g)
    dur = float((g.params or {}).get("duration_s") or 0) or rl.probe(generation_file(g)).duration
    out = {}
    for e in ENGINES.values():
        per = {}
        for t in TARGETS:
            try:
                sp = size_plan(e, w, h, t)
            except UpscaleError as err:
                per[t] = {"allowed": False, "reason": str(err)}
                continue
            per[t] = {"allowed": True, "width": sp.width, "height": sp.height, "engine_scale": sp.scale,
                      **estimate(e, sp, dur, seedvr2_variant(None), measured)}
        out[e.id] = per
    return {"source": {"width": w, "height": h, "duration_s": round(dur, 3)}, "estimates": out}


# ---------------------------------------------------------------- queueing

def active_job(db: Session, source_id: str, engine: str, target: str, variant: str | None) -> Job | None:
    jobs = db.scalars(select(Job).where(Job.type == JOB_TYPE, Job.status.in_(("queued", "running")))).all()
    for j in jobs:
        p = j.payload or {}
        if (p.get("source_id"), p.get("engine"), p.get("target"), p.get("variant")) == (source_id, engine, target, variant):
            return j
    return None


def is_media_video(g: Generation) -> bool:
    """An uploaded (or already upscaled) standalone video from the Library."""
    return g.target_type == "media" and (g.media_type or "").startswith("video/")


def queue_upscale(db: Session, source: Generation, engine: str | None, target: str, variant: str | None = None,
                  user_id: str | None = None, flow: str = "upscale") -> Job:
    """Create the upscaled render version + its job. Raises UpscaleError for anything the caller should show."""
    standalone = is_media_video(source)
    if source.kind != "render" and not standalone:
        raise UpscaleError("Only stitched or uploaded videos can be upscaled")
    if source.status not in ("ready", "approved") or not source.file_path:
        raise UpscaleError("This video isn't finished yet")
    path = generation_file(source)
    if not path or not path.is_file():
        raise UpscaleError("This video's file is missing")
    eid = engine_id(engine)
    var = seedvr2_variant(variant) if eid == "best" else None
    why = known_unavailable(eid)
    if why:
        raise UpscaleError(f"{ENGINES[eid].label} isn't available on the GPU server: {why}")
    w, h = source_size(source)
    sp = size_plan(ENGINES[eid], w, h, target)
    running = active_job(db, source.id, eid, target, var)
    if running is not None:
        return running

    sp_ = source.params or {}
    if standalone:
        from app.models import MediaItem

        item = db.get(MediaItem, source.target_id)
        base_title = (item.title if item else "") or "Video"
        # an upscale of an upscale shouldn't read "clip · 1080p · 4k"
        title, prompt = f"{base_title} · {target}", base_title
        kind = "video"
    else:
        title = f"{sp_.get('title') or rl.FULL_FILM} · {target}"
        project = db.get(Project, source.project_id) if source.project_id else None
        prompt = f"{project.title if project else ''} · {title}".strip(" ·")
        kind = "render"
    g = Generation(
        id=new_id(), workspace_id=source.workspace_id, project_id=source.project_id, target_type=source.target_type,
        target_id=source.target_id, kind=kind, version=next_version(db, source.target_type, source.target_id, kind),
        status="queued", prompt=prompt, seed=new_seed(),
        parent_id=source.id,
        params={
            "title": title, "title_auto": False, "scene_ids": list(sp_.get("scene_ids") or []),
            "scene_range": sp_.get("scene_range") or "", "full": bool(sp_.get("full", True)),
            "clips": sp_.get("clips"), "duration_s": sp_.get("duration_s"), "quality": "upscaled",
            "chapters": sp_.get("chapters"),
            "upscale": {"engine": eid, "variant": var, "template": ENGINES[eid].template, "target": target,
                        "width": sp.width, "height": sp.height, "engine_width": sp.engine_width,
                        "engine_height": sp.engine_height, "engine_scale": sp.scale, "source_id": source.id,
                        "source_size": [w, h]},
            "segments": [],
            "created_by": {"user_id": user_id, "flow": flow},
        },
    )
    db.add(g)
    db.flush()
    job = Job(workspace_id=source.workspace_id, type=JOB_TYPE, project_id=source.project_id, generation_id=g.id,
              message="Waiting for a worker",
              payload={"generation_id": g.id, "source_id": source.id, "engine": eid, "target": target, "variant": var})
    db.add(job)
    db.flush()
    g.job_id = job.id
    return job


# ---------------------------------------------------------------- the job

def needs_normalise(g: Generation) -> bool:
    # our renders are CFR H.264/AAC mp4 already; uploads can be anything ffmpeg reads. The final
    # mux copies audio into mp4, which Vorbis (webm) can't go into, and VFR phone footage would make
    # the frame-indexed segment maths drift.
    # TODO: flag variable-frame-rate mp4s at upload time (params.vfr); today only the container decides
    p = g.params or {}
    return g.media_type != "video/mp4" or bool(p.get("vfr"))


def normalise_upload(src: Path, dest: Path, tick=None) -> Path:
    if dest.is_file() and dest.stat().st_size > 0:
        return dest  # resumed job: done on an earlier attempt
    fps = probe_source(src).fps_str
    tmp = dest.with_name(dest.stem + ".tmp.mp4")
    ff(["-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", "-vf", f"fps={fps}", "-c:v", "libx264", "-preset", "fast",
        "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(tmp)],
       tick=tick)
    tmp.replace(dest)
    return dest


def seg_dir(gen: Generation) -> tuple[Path, str]:
    rel = Path("workspaces") / gen.workspace_id / "projects" / (gen.project_id or "_unassigned") / "upscales" / gen.id
    return get_settings().data_dir / rel, rel.as_posix()


def _seg_ok(seg: dict) -> bool:
    return seg.get("status") == "done" and bool(seg.get("file")) and (get_settings().data_dir / seg["file"]).is_file()


def _publish(db: Session, gen: Generation, **changes) -> None:
    gen.params = {**(gen.params or {}), **changes}
    db.commit()


def handle_upscale(ctx) -> dict:
    db, job = ctx.db, ctx.job
    gen = db.get(Generation, job.generation_id) if job.generation_id else None
    if gen is None:
        raise RuntimeError("The upscale's render record no longer exists")
    params = dict(gen.params or {})
    up = params.get("upscale") or {}
    source = db.get(Generation, up.get("source_id") or gen.parent_id or "")
    src_path = generation_file(source) if source else None
    if not src_path or not src_path.is_file():
        raise UpscaleError("The source video is gone; nothing to upscale")
    engine = ENGINES[up["engine"]]
    driver = ctx.driver_factory()
    job.gpu = job.gpu or getattr(driver, "name", None)
    gen.status = "generating"
    db.commit()

    folder, rel_folder = seg_dir(gen)
    folder.mkdir(parents=True, exist_ok=True)
    ctx.progress(0.01, "Reading the source video")
    if source.kind == "upload" and needs_normalise(source):
        src_path = normalise_upload(src_path, folder / "source.mp4", lambda: ctx.progress(0.01))
    src = probe_source(src_path)
    segments = [dict(s) for s in params.get("segments") or []]
    if not segments or sum(s["frames"] for s in segments) - overlap_frames(segments) * (len(segments) - 1) != src.frames:
        segments = plan_segments(src.frames, src.fps)
    _publish(db, gen, segments=segments)

    n = len(segments)
    todo = sum(s["frames"] for s in segments if not _seg_ok(s)) or 1
    done_frames = 0
    gpu_run = 0.0
    t_run = time.monotonic()
    tick = lambda: ctx.progress(job.progress)  # noqa: E731  (raises on cancel)

    for seg in segments:
        k = seg["idx"]
        if _seg_ok(seg):
            continue
        base = done_frames

        def cb(frac: float, msg: str = "", _seg=seg, _base=base) -> None:
            overall = (_base + max(0.0, min(1.0, frac)) * _seg["frames"]) / todo
            ctx.progress(0.02 + 0.88 * overall, f"Segment {_seg['idx'] + 1} of {n}")

        cb(0.0)
        # unique name: it lands in ComfyUI's shared input folder
        clip = cut_segment(src, seg, folder / f"{gen.id[:8]}_in_{k}.mp4", tick=tick)
        out = folder / f"seg_{k}.mp4"
        cparams = {
            "kind": "upscale_segment", "template": engine.template, "video_path": str(clip), "segment_idx": k,
            "source_id": source.id, "generation_id": f"{gen.id}_s{k}", "fps": src.fps,
            "width": up["engine_width"], "height": up["engine_height"],
            "out_width": up["engine_width"], "out_height": up["engine_height"],
        }
        if engine.fixed_scales:
            cparams["scale"] = int(up["engine_scale"])
        if engine.id == "best":
            from app.workflows import load

            cparams["model"] = load(engine.template).manifest["variants"][up.get("variant") or "3b"]
        seg.update(status="generating")
        seg.pop("error", None)
        _publish(db, gen, segments=segments)
        t0 = time.monotonic()
        try:
            result = driver.generate_video("", cparams, gen.seed, out, cb)
        except Exception as e:
            db.rollback()
            if type(e).__name__ in ("JobCancelled", "WorkerStopping"):
                seg["status"] = "pending"
            else:
                seg.update(status="failed", error=str(e)[:300])
            gen.params = {**(gen.params or {}), "segments": segments}
            db.commit()
            raise
        finally:
            clip.unlink(missing_ok=True)
        gpu = float((result.meta or {}).get("gpu_seconds") or round(time.monotonic() - t0, 3))
        frames_out = lt.count_frames(out)
        if frames_out != seg["frames"]:
            # the join pads (clone) or trims by frame index, so a short or long segment can't shift the film
            log.warning("segment %d of %s came back with %d frames, sent %d", k, gen.id, frames_out, seg["frames"])
        gpu_run += gpu
        seg.update(status="done", file=f"{rel_folder}/seg_{k}.mp4", gpu_seconds=round(gpu, 3), frames_out=frames_out)
        if result.params_update.get("comfy"):
            seg["prompt_id"] = result.params_update["comfy"].get("prompt_id")
        done_frames += seg["frames"]
        _publish(db, gen, segments=segments)

    ctx.progress(0.9, f"Joining {n} segment{'s' if n > 1 else ''}")
    if gen.target_type == "media":
        final_rel = Path("workspaces") / gen.workspace_id / "media" / f"{gen.id}.mp4"
    else:
        final_rel = (Path("workspaces") / gen.workspace_id / "projects" / (gen.project_id or "_unassigned")
                     / "generations" / f"{gen.id}.mp4")
    final = get_settings().data_dir / final_rel
    final.parent.mkdir(parents=True, exist_ok=True)
    files = [get_settings().data_dir / s["file"] for s in segments]
    work = folder / "join"
    shutil.rmtree(work, ignore_errors=True)
    t_join = time.monotonic()

    def join_progress(frac):
        if frac is None:
            ctx.progress(job.progress)
        else:
            ctx.progress(0.9 + 0.09 * frac, f"Joining {n} segment{'s' if n > 1 else ''}")

    try:
        info = join(files, segments, (up["width"], up["height"]), src, work, final, join_progress)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    info["join_seconds"] = round(time.monotonic() - t_join, 1)

    out_s = src.frames / src.fps
    total_gpu = sum(float(s.get("gpu_seconds") or 0) for s in segments)
    mp = up["engine_width"] * up["engine_height"] / 1e6
    stats = {"segments": n, "gpu_seconds": round(total_gpu, 1),
             "gpu_per_output_s": round(total_gpu / out_s, 2) if out_s else None,
             "rate_mp": round(total_gpu / out_s / mp, 3) if out_s and mp else None,
             "wall_seconds_last_run": round(time.monotonic() - t_run, 1), **info}
    # the checkpoints have done their job; at 4K they're the bulk of the disk use
    # TODO: keep them when a per-segment re-roll lands, like long-take chunks
    for s in segments:
        s.pop("file", None)
    shutil.rmtree(folder, ignore_errors=True)
    db.refresh(gen)
    gen.params = {**(gen.params or {}), "segments": segments, "upscale_stats": stats,
                  "size": [up["width"], up["height"]], "duration_s": round(out_s, 3)}
    gen.file_path = final_rel.as_posix()
    gen.media_type = "video/mp4"
    gen.status = "ready"
    return {"file_path": gen.file_path, "media_type": "video/mp4", "duration_s": round(out_s, 3), "segments": n,
            "width": up["width"], "height": up["height"], "gpu_seconds": round(gpu_run, 3) or None}
