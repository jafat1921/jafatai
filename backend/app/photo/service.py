"""Photo Studio glue: source images, the preview cache, history, and the render/effect job (contract v9).

The engine modules (develop, analysis, effects, lut, xmp) know nothing about the database; this one does.
"""
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Generation, Job, Look, MediaItem, new_id
from app.photo import analysis, develop as dv, effects as fx
from app.photo import lut as lt
from app.services import approve, gen_out, generation_file, new_seed, next_version

log = logging.getLogger("mixai.photo")

RENDER_JOB = "photo_render"
PROXY_SIDE = 2560
FINISHED = ("ready", "approved")
# keys of the source's params that describe how *it* was made, not the new version
DROP_KEYS = ("comfy", "upscale", "upscale_stats", "segments", "size", "approved_by", "auto_check",
             "auto_check_reason", "auto_issues", "autopilot", "compile_first", "created_by", "original_name",
             "bytes", "develop", "effect", "look", "magic_prompt", "restore", "cutout", "chain", "chain_skipped")


class PhotoError(RuntimeError):
    pass


# ---------------------------------------------------------------- sources

def is_image(g: Generation) -> bool:
    return (g.media_type or "").startswith("image/")


def check_image(g: Generation) -> Path:
    if not is_image(g):
        raise HTTPException(422, "Photo Studio works on images; this one is "
                                 f"{(g.media_type or g.kind or 'unknown')}")
    if g.status not in FINISHED:
        raise HTTPException(409, f"This image isn't finished yet ({g.status})")
    path = generation_file(g)
    if not path or not path.is_file():
        raise HTTPException(422, "This image's file is missing")
    return path


@dataclass
class Source:
    proxy: Image.Image
    size: tuple[int, int]  # full resolution, upright


_cache: OrderedDict = OrderedDict()
_cache_lock = threading.Lock()
CACHE_ITEMS = 6


def load_source(g: Generation) -> Source:
    """A <= 2560 px proxy of the generation's file, decoded once per process (sliders hit it repeatedly)."""
    path = check_image(g)
    key = (g.id, path.stat().st_mtime_ns)
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
            return hit
    try:
        im, size = dv.open_image(path, PROXY_SIDE)
    except (OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(422, "Couldn't read this image") from None
    src = Source(im, size)
    with _cache_lock:
        _cache[key] = src
        while len(_cache) > CACHE_ITEMS:
            _cache.popitem(last=False)
    return src


# ---------------------------------------------------------------- looks used as LUTs

_cube_cache: dict = {}


def look_table(look: Look) -> np.ndarray | None:
    if not look.cube_path:
        return None
    path = get_settings().data_dir / look.cube_path
    if not path.is_file():
        raise PhotoError(f"The look '{look.name}' has lost its .cube file")
    key = (str(path), path.stat().st_mtime_ns)
    if key not in _cube_cache:
        cube = lt.parse_cube(path.read_text(encoding="utf-8", errors="replace"))
        if len(_cube_cache) > 32:
            _cube_cache.clear()
        _cube_cache[key] = lt.standard_table(cube)
    return _cube_cache[key]


def visible_look(db: Session, workspace_id: str, look_id: str) -> Look | None:
    look = db.get(Look, look_id)
    if look is None or (look.workspace_id is not None and look.workspace_id != workspace_id):
        return None
    return look


def resolve_lut(db: Session, workspace_id: str, p: dict):
    ref = p.get("lut")
    if not ref:
        return None
    look = visible_look(db, workspace_id, ref["look_id"])
    if look is None:
        raise HTTPException(422, "params.lut points at a look that doesn't exist")
    try:
        table = look_table(look)
    except (PhotoError, lt.CubeError) as e:
        raise HTTPException(422, str(e)) from None
    if table is None:
        return None  # a params-only look: the client merged its params already
    return table, ref["amount"] / 100


# ---------------------------------------------------------------- sync work (preview, histogram, ...)

def _fit(im: Image.Image, max_side: int) -> Image.Image:
    if max(im.size) <= max_side:
        return im
    f = max_side / max(im.size)
    return im.resize((max(1, round(im.width * f)), max(1, round(im.height * f))), Image.Resampling.LANCZOS)


def render_small(db: Session, g: Generation, params: dict, max_side: int):
    """-> (float sRGB array, alpha, info). The same pipeline as the full render, on the proxy."""
    src = load_source(g)
    p = dv.normalise(params)
    lut = resolve_lut(db, g.workspace_id, p)
    im = _fit(dv.apply_geometry(src.proxy, p, src.size), max_side)
    rgb, alpha = dv.split(im)
    frame = dv.frame_size(*src.size, p)
    out = dv.develop(rgb, p, scale=rgb.shape[1] / frame[0], frame=frame, lut=lut)
    return out, alpha, {"source": src.size, "output": (rgb.shape[1], rgb.shape[0])}


def preview(db: Session, g: Generation, params: dict, max_side: int) -> tuple[bytes, dict]:
    t0 = time.perf_counter()
    out, _, info = render_small(db, g, params, max_side)
    data = dv.encode(out, None, "jpeg", 90)
    info["ms"] = round((time.perf_counter() - t0) * 1000)
    return data, info


def histogram(db: Session, g: Generation, params: dict) -> dict:
    out, _, _ = render_small(db, g, params, 512)
    return analysis.histogram(out)


def source_rgb(g: Generation, side: int = 1024) -> np.ndarray:
    src = load_source(g)
    rgb, _ = dv.split(_fit(src.proxy, side))
    return rgb


def analyse(g: Generation) -> dict:
    return analysis.analyse(source_rgb(g), load_source(g).size)


def auto(g: Generation) -> dict:
    a = analyse(g)
    params, notes = analysis.suggest(a, source_rgb(g))
    return {"params": {"version": dv.PARAMS_VERSION, **params}, "analysis": a, "notes": notes}


def palette(g: Generation, k: int) -> list[dict]:
    return analysis.palette(source_rgb(g, 256), k)


# ---------------------------------------------------------------- history

def item_for(db: Session, g: Generation) -> MediaItem | None:
    return db.get(MediaItem, g.target_id) if g.target_type == "media" else None


def version_line(db: Session, g: Generation) -> list[Generation]:
    q = select(Generation).where(Generation.target_type == g.target_type, Generation.target_id == g.target_id)
    if g.target_type != "media":
        q = q.where(Generation.kind == g.kind)
    return list(db.scalars(q.order_by(Generation.version.desc(), Generation.created_at.desc())))


def edit_kind(g: Generation) -> str | None:
    p = g.params or {}
    for k in ("develop", "effect", "look", "upscale", "cutout", "restore"):
        if p.get(k):
            return k
    return None


def history(db: Session, g: Generation) -> dict:
    line = version_line(db, g)
    item = item_for(db, g)
    if item is not None:
        current = item.generation_id
    else:
        current = next((x.id for x in line if x.status == "approved"), None)
    out = []
    for x in line:
        p = x.params or {}
        out.append({"generation": gen_out(x).model_dump(mode="json"), "current": x.id == current,
                    "edit": edit_kind(x), "develop": p.get("develop"), "effect": p.get("effect"),
                    "look": p.get("look"), "restore": _restore_summary(p), "cutout": _cutout_summary(p),
                    "chain": _chain_summary(p)})
    return {"target_type": g.target_type, "target_id": g.target_id, "current_id": current, "versions": out}


def _restore_summary(p: dict) -> dict | None:
    r = p.get("restore")
    if not r:
        return None
    return {k: r.get(k) for k in ("tool", "variant", "strength", "user_prompt", "changed")}


def _cutout_summary(p: dict) -> dict | None:
    c = p.get("cutout")
    if not c or not c.get("mask_file"):
        return None
    bg = c.get("background") or {}
    return {"has_mask": True, "coverage": c.get("coverage"), "edge": c.get("edge"),
            "background": {k: bg.get(k) for k in ("type", "colour", "radius", "prompt", "generation_id")}}


def _chain_summary(p: dict) -> dict | None:
    ch = p.get("chain")
    if not ch:
        return None
    return {"id": ch.get("id"), "index": ch.get("index"), "steps": ch.get("steps"),
            "skipped": p.get("chain_skipped")}


def revert(db: Session, g: Generation) -> dict:
    if g.status == "rejected":
        raise HTTPException(409, "This version was rejected; restore it first")
    if g.status not in FINISHED or not g.file_path:
        raise HTTPException(409, f"Only a finished version can be made current (this one is {g.status})")
    item = item_for(db, g)
    if item is not None:
        from app.library import _dims_of, touch

        item.generation_id = g.id
        try:
            item.width, item.height, dur = _dims_of(g)
            if dur is not None or item.kind == "image":
                item.duration_s = dur
        except Exception:
            log.exception("couldn't read the size of %s", g.id)
        touch(item)
    else:
        approve(db, g)
    db.flush()
    return history(db, g)


# ---------------------------------------------------------------- queueing

def _new_version(db: Session, source: Generation, params: dict, *, job_type: str, payload: dict,
                 message: str, note: str | None = None, kind: str | None = None) -> Job:
    kind = kind or ("image" if source.kind == "upload" else source.kind)
    keep = {k: v for k, v in (source.params or {}).items() if k not in DROP_KEYS}
    g = Generation(
        id=new_id(), workspace_id=source.workspace_id, project_id=source.project_id,
        target_type=source.target_type, target_id=source.target_id, kind=kind,
        version=next_version(db, source.target_type, source.target_id, kind), status="queued",
        prompt=source.prompt, seed=new_seed(), parent_id=source.id, note=note, params={**keep, **params},
    )
    db.add(g)
    db.flush()
    job = Job(workspace_id=source.workspace_id, type=job_type, project_id=source.project_id, generation_id=g.id,
              message=message, payload={"generation_id": g.id, "source_id": source.id, **payload})
    db.add(job)
    db.flush()
    g.job_id = job.id
    return job


def _running_twin(db: Session, source: Generation, key: str, want: dict) -> Job | None:
    for g in db.scalars(select(Generation).where(Generation.parent_id == source.id,
                                                 Generation.status.in_(("queued", "generating")))):
        if (g.params or {}).get(key) == want and g.job_id:
            job = db.get(Job, g.job_id)
            if job is not None and job.status in ("queued", "running"):
                return job
    return None


def queue_render(db: Session, source: Generation, params: dict, fmt: str, quality: int, note: str | None,
                 user_id: str | None) -> Job:
    check_image(source)
    p = dv.normalise(params)
    resolve_lut(db, source.workspace_id, p)  # a bad look is a 422 now, not a failed job later
    base = ((source.params or {}).get("develop") or {}).get("base") or source.id
    develop = {"params": p, "parent": source.id, "base": base, "format": fmt, "quality": quality}
    twin = _running_twin(db, source, "develop", develop)
    if twin is not None:
        return twin
    return _new_version(db, source, {"develop": develop, "created_by": {"user_id": user_id, "flow": "photo"}},
                        job_type=RENDER_JOB, payload={"mode": "develop"}, note=note,
                        message=f"Waiting for a worker · Develop ({dv.FORMATS[fmt]['label']})")


def queue_effect(db: Session, source: Generation, name: str, strength: float, fmt: str, quality: int,
                 note: str | None, user_id: str | None) -> Job:
    check_image(source)
    effect = {"name": name, "strength": round(float(strength), 3), "parent": source.id, "format": fmt,
              "quality": quality}
    twin = _running_twin(db, source, "effect", effect)
    if twin is not None:
        return twin
    label = next((e["label"] for e in fx.EFFECTS if e["id"] == name), name)
    return _new_version(db, source, {"effect": effect, "created_by": {"user_id": user_id, "flow": "photo"}},
                        job_type=RENDER_JOB, payload={"mode": "effect"}, note=note,
                        message=f"Waiting for a worker · {label}")


# ---------------------------------------------------------------- the job

def out_path(gen: Generation, ext: str) -> tuple[Path, str]:
    # same layout as the worker's generate jobs
    if gen.target_type == "media":
        rel = Path("workspaces") / gen.workspace_id / "media" / f"{gen.id}{ext}"
    else:
        rel = (Path("workspaces") / gen.workspace_id / "projects" / (gen.project_id or "_unassigned")
               / "generations" / f"{gen.id}{ext}")
    return get_settings().data_dir / rel, rel.as_posix()


def handle_render(ctx) -> dict:
    db, job = ctx.db, ctx.job
    gen = db.get(Generation, job.generation_id) if job.generation_id else None
    if gen is None:
        raise PhotoError("The new version's record no longer exists")
    params = gen.params or {}
    if (job.payload or {}).get("mode") == "cutout":
        from app.photo.restore import render_cutout

        return render_cutout(ctx, gen)
    spec = params.get("develop") or params.get("effect")
    if not spec:
        raise PhotoError("Nothing to render (no develop or effect settings)")
    source = db.get(Generation, spec.get("parent") or gen.parent_id or "")
    src_path = generation_file(source) if source else None
    if not src_path or not src_path.is_file():
        raise PhotoError("The source image is gone")
    gen.status = "generating"
    db.commit()
    t0 = time.monotonic()
    ctx.progress(0.05, "Reading the image")
    im, size = dv.open_image(src_path)
    exif = im.info.get("exif")
    fmt = spec.get("format") or "jpeg"
    if params.get("develop"):
        p = dv.normalise(spec["params"])
        lut = None
        if p.get("lut"):
            look = db.get(Look, p["lut"]["look_id"])
            if look is None:
                raise PhotoError("The look used by this edit was deleted")
            table = look_table(look)
            lut = (table, p["lut"]["amount"] / 100) if table is not None else None
        im = dv.apply_geometry(im, p, size)
        rgb, alpha = dv.split(im)
        ctx.progress(0.2, "Developing")
        frame = (rgb.shape[1], rgb.shape[0])
        out = dv.develop(rgb, p, scale=1.0, frame=frame, lut=lut)
    else:
        rgb, alpha = dv.split(im)
        ctx.progress(0.2, f"Applying {spec['name']}")
        out = fx.apply(rgb, spec["name"], spec.get("strength", 1.0))
    del rgb
    ctx.progress(0.8, "Saving")
    if fmt == "jpeg":
        alpha = None
    data = dv.encode(out, alpha, fmt, int(spec.get("quality") or 95), exif=exif)
    abs_path, rel = out_path(gen, dv.FORMATS[fmt]["ext"])
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = abs_path.with_name(abs_path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(abs_path)
    db.refresh(gen)
    h, w = out.shape[:2]
    gen.params = {**(gen.params or {}), "size": [w, h]}
    gen.file_path = rel
    gen.media_type = dv.FORMATS[fmt]["media_type"]
    gen.status = "ready"
    return {"file_path": rel, "media_type": gen.media_type, "width": w, "height": h, "bytes": len(data),
            "seconds": round(time.monotonic() - t0, 3)}
