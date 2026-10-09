"""Looks (contract v9): built-ins, user looks, .xmp/.lrtemplate/.cube import, .cube export, thumbnails and
"Apply look to video" (a baked 33-point cube through ffmpeg lut3d, segment by segment like video upscales).
"""
import json
import logging
import shutil
import subprocess
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import longtake as ltk
from app import reel as rl
from app import upscale as up
from app.config import get_settings
from app.models import Generation, Job, Look, MediaItem, new_id, utcnow
from app.photo import develop as dv
from app.photo import lut as lt
from app.photo import service as svc
from app.photo import xmp
from app.services import generation_file

log = logging.getLogger("mixai.looks")

VIDEO_JOB = "look_video"
VIDEO_CUBE_SIZE = 33
SEGMENT_S = 60.0
MAX_IMPORT_BYTES = 16 * 1024 * 1024
MAX_IMPORT_FILES = 20
VIDEO_KINDS = ("render", "take", "video", "upload")
BUILTIN_FILE = Path(__file__).with_name("builtin_looks.json")


# ---------------------------------------------------------------- built-ins

def builtin_data() -> list[dict]:
    return json.loads(BUILTIN_FILE.read_text(encoding="utf-8"))


_ORDER = {d["id"]: i for i, d in enumerate(builtin_data())}


def ensure_builtins(db: Session) -> None:
    """Insert or refresh the shipped looks (fixed ids, no workspace). Cheap enough to run on every start."""
    changed = False
    for d in builtin_data():
        params = dv.sparse(d["params"])
        row = db.get(Look, d["id"])
        if row is None:
            db.add(Look(id=d["id"], workspace_id=None, name=d["name"], description=d.get("description", ""),
                        category=d.get("category", ""), params=params, source="builtin"))
            changed = True
        elif (row.name, row.description, row.category, row.params) != (d["name"], d.get("description", ""),
                                                                        d.get("category", ""), params):
            row.name, row.description, row.category, row.params = (d["name"], d.get("description", ""),
                                                                   d.get("category", ""), params)
            changed = True
    if changed:
        db.commit()


# ---------------------------------------------------------------- reading

def get_visible(db: Session, workspace_id: str, look_id: str) -> Look:
    look = svc.visible_look(db, workspace_id, look_id)
    if look is None:
        raise HTTPException(404, "Look not found")
    return look


def get_editable(db: Session, workspace_id: str, look_id: str) -> Look:
    look = get_visible(db, workspace_id, look_id)
    if look.source == "builtin" or look.workspace_id is None:
        raise HTTPException(403, "Built-in looks are read-only; save a copy to change it")
    return look


def list_looks(db: Session, workspace_id: str) -> list[Look]:
    built = sorted(db.scalars(select(Look).where(Look.workspace_id.is_(None))), key=lambda x: _ORDER.get(x.id, 99))
    mine = db.scalars(select(Look).where(Look.workspace_id == workspace_id)
                      .order_by(Look.created_at.desc())).all()
    return [*built, *mine]


def look_out(look: Look) -> dict:
    stamp = int((look.updated_at or look.created_at or utcnow()).timestamp())
    return {
        "id": look.id, "name": look.name, "description": look.description or "", "category": look.category or "",
        "source": look.source, "params": look.params or {}, "has_cube": bool(look.cube_path),
        "cube_size": look.cube_size, "editable": look.workspace_id is not None,
        "spatial": dv.spatial_used(look.params or {}), "thumb_url": f"/api/looks/{look.id}/thumb?v={stamp}",
        "created_at": look.created_at, "updated_at": look.updated_at,
    }


def develop_params(look: Look, amount: float = 100.0) -> dict:
    """The look as one params object for the pipeline (its own params plus its cube as params.lut)."""
    p = dict(look.params or {})
    if look.cube_path:
        p["lut"] = {"look_id": look.id, "amount": amount}
    return p


def _lut_for(look: Look):
    table = svc.look_table(look)
    return (table, 1.0) if table is not None else None


# ---------------------------------------------------------------- writing

def looks_dir(workspace_id: str) -> tuple[Path, str]:
    rel = Path("workspaces") / workspace_id / "looks"
    return get_settings().data_dir / rel, rel.as_posix()


def create(db: Session, workspace_id: str, *, name: str, params: dict, description: str = "", category: str = "",
           source: str = "user", look_id: str | None = None) -> Look:
    look = Look(id=look_id or new_id(), workspace_id=workspace_id, name=name.strip()[:200],
                description=description or "", category=category or "", params=dv.sparse(params), source=source)
    db.add(look)
    db.flush()
    return look


def save_thumb(db: Session, look: Look, g: Generation) -> None:
    """A 256 px picture of the look on the image it was made from (best effort: a look without one still works)."""
    try:
        out, _, _ = svc.render_small(db, g, develop_params(look), 256)
    except Exception:
        log.warning("couldn't make a thumbnail for look %s", look.id, exc_info=True)
        return
    folder, rel = looks_dir(look.workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{look.id}.thumb.jpg").write_bytes(dv.encode(out, None, "jpeg", 85))
    look.thumb_path = f"{rel}/{look.id}.thumb.jpg"


def delete(db: Session, look: Look) -> None:
    root = get_settings().data_dir
    files = [x for x in (look.cube_path, look.thumb_path) if x]
    db.delete(look)
    db.flush()
    for rel in files:
        try:
            (root / rel).unlink(missing_ok=True)
        except OSError:
            log.warning("couldn't delete %s", rel)


def import_files(db: Session, workspace_id: str, files: list[tuple[str, bytes]]) -> tuple[list[Look], list[dict]]:
    looks, reports = [], []
    folder, rel = looks_dir(workspace_id)
    for name, data in files[:MAX_IMPORT_FILES]:
        ext = Path(name).suffix.lower()
        rep = {"file": name, "ok": False}
        try:
            if ext == ".cube":
                cube = lt.parse_cube(data.decode("utf-8-sig", errors="replace"))
                table = lt.standard_table(cube)
                look = create(db, workspace_id, name=cube["title"] or Path(name).stem, params={},
                              category="Imported", source="imported")
                folder.mkdir(parents=True, exist_ok=True)
                (folder / f"{look.id}.cube").write_text(
                    lt.write_cube(table, cube["title"] or Path(name).stem, [f"Imported from {name}"]), encoding="utf-8")
                look.cube_path, look.cube_size = f"{rel}/{look.id}.cube", cube["size"]
                notes = [] if np.allclose(cube["domain_max"], 1) and np.allclose(cube["domain_min"], 0) else \
                    ["Input domain rescaled to 0..1"]
                rep.update(ok=True, kind="cube", look_id=look.id, name=look.name, cube_size=cube["size"], notes=notes)
            elif ext in (".xmp", ".lrtemplate"):
                parsed = xmp.parse(name, data)
                look = create(db, workspace_id, name=parsed["name"], params=parsed["params"], category="Imported",
                              source="imported")
                rep.update(ok=True, kind=parsed["kind"], look_id=look.id, name=look.name, mapped=parsed["mapped"],
                           unmapped=parsed["unmapped"])
            else:
                rep["error"] = "Only .xmp, .lrtemplate and .cube files can be imported"
                reports.append(rep)
                continue
        except (lt.CubeError, xmp.PresetError) as e:
            rep["error"] = str(e)
            reports.append(rep)
            continue
        looks.append(look)
        reports.append(rep)
    if len(files) > MAX_IMPORT_FILES:
        reports.append({"file": f"{len(files) - MAX_IMPORT_FILES} more", "ok": False,
                        "error": f"Up to {MAX_IMPORT_FILES} files per import"})
    db.flush()
    return looks, reports


# ---------------------------------------------------------------- .cube and thumbnails

def bake(look: Look, size: int = 33) -> np.ndarray:
    try:
        return lt.bake(look.params or {}, size, lut=_lut_for(look))
    except svc.PhotoError as e:
        raise HTTPException(422, str(e)) from None


def cube_text(table: np.ndarray, title: str, params: dict) -> str:
    notes = ["Made by Mix AI Cinema Studio (develop pipeline baked on an identity lattice)",
             "Input and output: sRGB / Rec.709, full range 0..1"]
    skipped = dv.spatial_used(params)
    if skipped:
        notes.append("Not included (depends on neighbouring pixels or position): " + ", ".join(skipped))
    return lt.write_cube(table, title, notes)


_REF: np.ndarray | None = None


def reference_image() -> np.ndarray:
    """A small made-up scene (sky, warm light, skin, foliage, shadows, neutrals) so built-in looks have a tile."""
    global _REF
    if _REF is None:
        h, w = 170, 256
        y = np.linspace(0, 1, h)[:, None, None]
        x = np.linspace(0, 1, w)[None, :, None]
        sky = np.array([0.35, 0.55, 0.85]) * (1 - y) + np.array([0.95, 0.80, 0.62]) * y
        img = np.broadcast_to(sky, (h, w, 3)).copy()
        ground = (y > 0.62)[..., 0] & np.ones((h, w), bool)
        img[ground] = (np.array([0.20, 0.38, 0.16]) * (1.2 - y) + np.array([0.08, 0.1, 0.05]) * x)[ground]
        cy, cx = np.ogrid[:h, :w]
        face = (cy - 78) ** 2 / 34 ** 2 + (cx - 168) ** 2 / 26 ** 2 < 1
        img[face] = np.array([0.86, 0.64, 0.52])
        img[face & (cx > 172)] *= 0.8  # a shadow side, so contrast and shadow sliders show on skin
        for i, c in enumerate(np.linspace(0.05, 0.95, 6)):
            img[148:166, 8 + i * 20:24 + i * 20] = c
        _REF = (np.clip(img, 0, 1) * 255).astype(np.uint8)
    return _REF


_thumbs: OrderedDict = OrderedDict()
_thumbs_lock = threading.Lock()


def thumb(db: Session, look: Look, workspace_id: str, generation_id: str | None = None) -> bytes:
    stamp = (look.updated_at or look.created_at).isoformat()
    key = (look.id, stamp, generation_id)
    with _thumbs_lock:
        if key in _thumbs:
            _thumbs.move_to_end(key)
            return _thumbs[key]
    if generation_id:
        from app.services import owned_source

        g = owned_source(db, workspace_id, generation_id)
        out, _, _ = svc.render_small(db, g, develop_params(look), 256)
        data = dv.encode(out, None, "jpeg", 85)
    elif look.thumb_path and (get_settings().data_dir / look.thumb_path).is_file():
        data = (get_settings().data_dir / look.thumb_path).read_bytes()
    else:
        try:
            lut = _lut_for(look)
        except svc.PhotoError:
            lut = None
        out = dv.develop(reference_image(), look.params or {}, scale=256 / 4000, lut=lut)
        data = dv.encode(out, None, "jpeg", 85)
    with _thumbs_lock:
        _thumbs[key] = data
        while len(_thumbs) > 200:
            _thumbs.popitem(last=False)
    return data


# ---------------------------------------------------------------- apply to video

def is_video(g: Generation) -> bool:
    return (g.media_type or "").startswith("video/") and g.kind in VIDEO_KINDS


def unsharp_filter(params: dict, intensity: float) -> str:
    """Clarity and sharpening as ffmpeg unsharp (luma only): a wide mask for clarity, a tight one for detail."""
    p = dv.normalise(params)
    parts = []
    c = p["clarity"] / 100 * intensity
    if abs(c) > 0.005:
        parts.append(f"unsharp=13:13:{0.6 * c:.3f}:3:3:0")  # 13x13 is the widest ffmpeg allows
    s = p["sharpness"] / 100 * intensity
    if s > 0.005:
        parts.append(f"unsharp=5:5:{(0.5 + 1.5 * s) * 0.5:.3f}:3:3:0")
    return ",".join(parts)


def grade_dir(gen: Generation) -> tuple[Path, str]:
    rel = (Path("workspaces") / gen.workspace_id / "projects" / (gen.project_id or "_unassigned") / "graded"
           / gen.id)
    return get_settings().data_dir / rel, rel.as_posix()


def queue_apply_video(db: Session, look: Look, source: Generation, intensity: float, user_id: str | None) -> Job:
    if not is_video(source):
        raise HTTPException(422, "Looks can be applied to stitched films, takes and Library videos")
    if source.status not in svc.FINISHED or not source.file_path:
        raise HTTPException(409, f"This video isn't finished yet ({source.status})")
    path = generation_file(source)
    if not path or not path.is_file():
        raise HTTPException(422, "This video's file is missing")
    intensity = round(float(intensity), 3)
    want = {"id": look.id, "intensity": intensity, "source_id": source.id}
    for g in db.scalars(select(Generation).where(Generation.parent_id == source.id,
                                                 Generation.status.in_(("queued", "generating")))):
        lk = (g.params or {}).get("look") or {}
        if {k: lk.get(k) for k in want} == want and g.job_id:
            job = db.get(Job, g.job_id)
            if job is not None and job.status in ("queued", "running"):
                return job

    table = lt.mix(bake(look, VIDEO_CUBE_SIZE), intensity)
    skipped = [k for k in dv.spatial_used(look.params or {}) if k not in ("clarity", "sharpness")]
    spec = {**want, "name": look.name, "unsharp": unsharp_filter(look.params or {}, intensity),
            "spatial_skipped": skipped}
    extra = {"look": spec, "segments": [], "created_by": {"user_id": user_id, "flow": "look_video"}}
    if source.kind == "render":
        extra["title"] = f"{(source.params or {}).get('title') or rl.FULL_FILM} · {look.name}"
        extra["title_auto"] = False
    kind = "video" if source.kind == "upload" else source.kind
    job = svc._new_version(db, source, extra, job_type=VIDEO_JOB, payload={"look_id": look.id}, kind=kind,
                           message=f"Waiting for a worker · {look.name}")
    gen = db.get(Generation, job.generation_id)
    if source.kind == "upload":
        item = db.get(MediaItem, source.target_id)
        gen.prompt = (item.title if item else "") or source.prompt
    folder, rel = grade_dir(gen)
    folder.mkdir(parents=True, exist_ok=True)
    # baked now: editing or deleting the look later doesn't change a job that's already queued
    (folder / "look.cube").write_text(cube_text(table, look.name, look.params or {}), encoding="utf-8")
    gen.params = {**gen.params, "look": {**spec, "cube_file": f"{rel}/look.cube"}}
    return job


def _ff(args: list[str], cwd: Path, tick=None, timeout: float = 6 * 3600) -> None:
    # cwd so lut3d can name the cube without filtergraph escaping of a Windows path
    cmd = [get_settings().ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-nostdin", *args]
    proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                _, err = proc.communicate(timeout=5)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() > deadline:
                    raise svc.PhotoError("ffmpeg timed out") from None
                if tick:
                    tick()
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    if proc.returncode != 0:
        raise svc.PhotoError(f"ffmpeg failed: {err.decode(errors='replace')[-600:]}")


def plan_segments(frames: int, fps: float, seg_s: float | None = None) -> list[dict]:
    per = max(1, int(round((seg_s or SEGMENT_S) * fps)))
    return [{"idx": i, "start_frame": s, "frames": min(per, frames - s), "status": "pending"}
            for i, s in enumerate(range(0, max(frames, 1), per))]


def handle_apply_video(ctx) -> dict:
    db, job = ctx.db, ctx.job
    gen = db.get(Generation, job.generation_id) if job.generation_id else None
    if gen is None:
        raise svc.PhotoError("The graded version's record no longer exists")
    spec = (gen.params or {}).get("look") or {}
    source = db.get(Generation, spec.get("source_id") or gen.parent_id or "")
    src_path = generation_file(source) if source else None
    if not src_path or not src_path.is_file():
        raise svc.PhotoError("The source video is gone")
    folder, rel_folder = grade_dir(gen)
    cube = get_settings().data_dir / (spec.get("cube_file") or "")
    if not spec.get("cube_file") or not cube.is_file():
        raise svc.PhotoError("The baked look for this job is missing; apply the look again")
    gen.status = "generating"
    db.commit()
    tick = lambda: ctx.progress(job.progress)  # noqa: E731  (raises on cancel)
    ctx.progress(0.01, "Reading the video")
    audio_from = src_path
    if source.kind == "upload" and up.needs_normalise(source):
        src_path = up.normalise_upload(src_path, folder / "source.mp4", tick)
        audio_from = src_path
    src = up.probe_source(src_path)

    segments = [dict(s) for s in (gen.params or {}).get("segments") or []]
    if not segments or sum(s["frames"] for s in segments) != src.frames:
        segments = plan_segments(src.frames, src.fps)
    # TODO: tag the output bt709 and convert with explicit matrices; today swscale's defaults are used both
    # ways, which round-trips our untagged renders but can shift a tagged phone clip slightly
    vf = "lut3d=file=look.cube:interp=tetrahedral"
    if spec.get("unsharp"):
        vf += "," + spec["unsharp"]
    vf += ",format=yuv420p"
    n = len(segments)
    for seg in segments:
        k = seg["idx"]
        out = folder / f"seg_{k}.mp4"
        if seg.get("status") == "done" and out.is_file():
            continue
        ctx.progress(0.02 + 0.85 * k / n, f"Grading part {k + 1} of {n}")
        args = []
        if seg["start_frame"]:
            args += ["-ss", f"{max(0.0, (seg['start_frame'] - 0.5) / src.fps):.5f}"]
        args += ["-i", str(src_path), "-map", "0:v:0", "-an", "-frames:v", str(seg["frames"]), "-vf", vf,
                 "-r", src.fps_str, *up.ENC, out.name]
        _ff(args, folder, tick)
        seg.update(status="done", frames_out=ltk.count_frames(out))
        gen.params = {**(gen.params or {}), "segments": segments}
        db.commit()

    ctx.progress(0.9, "Joining")
    lst = rl.write_concat_list(folder, [rl.Entry(folder / f"seg_{s['idx']}.mp4") for s in segments],
                               name="graded.ffconcat")
    _ff(["-f", "concat", "-safe", "0", "-i", lst.name, "-map", "0:v", "-c", "copy", "video.mp4"], folder, tick)
    if ltk.count_frames(folder / "video.mp4") != src.frames:
        log.warning("graded concat of %s lost frames; re-encoding the join", gen.id)
        _ff(["-f", "concat", "-safe", "0", "-i", lst.name, "-map", "0:v", *up.ENC, "-r", src.fps_str,
             "-frames:v", str(src.frames), "video.mp4"], folder, tick)
    final, final_rel = svc.out_path(gen, ".mp4")
    final.parent.mkdir(parents=True, exist_ok=True)
    tmp = final.with_name(final.stem + ".mux.mp4")
    _ff(up.mux_cmd(folder / "video.mp4", audio_from, tmp), folder, tick)
    tmp.replace(final)
    shutil.rmtree(folder, ignore_errors=True)

    dur = round(src.frames / src.fps, 3) if src.fps else None
    db.refresh(gen)
    for s in segments:
        s.pop("frames_out", None)
    gen.params = {**(gen.params or {}), "segments": segments, "size": [src.width, src.height], "duration_s": dur}
    gen.file_path = final_rel
    gen.media_type = "video/mp4"
    gen.status = "ready"
    return {"file_path": final_rel, "media_type": "video/mp4", "width": src.width, "height": src.height,
            "duration_s": dur, "segments": n}
