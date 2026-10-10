"""Time estimates for the Generate button (UI polish P1): honest ranges, not single numbers.

Measured: median (low) and p80 (high) GPU seconds per unit from this workspace's finished
generations, per model and size bucket; a unit is one image, or one output second of video or audio.
Rough: the catalog's warm guess widened both ways. Either way a model load is added when the
model isn't the one the GPU ran last.
"""
import math
import statistics

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models_catalog as mc
from app.models import Generation, Job

MIN_SAMPLES = 3
WINDOW = 300
ROUGH_LOW, ROUGH_HIGH = 0.75, 1.6
# first-use load on the GPU box; provisional like the catalog's est_seconds
# TODO: measure loads from cold-vs-warm pairs in the comfy history instead of guessing
LOAD_S = {"zimage_turbo": 15, "flux2_klein": 12, "qwen_image_2512": 35, "qwen_image_edit_2511": 35,
          "flux2_klein_edit": 15, "ltx23_distilled": 45, "ltx23_hq": 60, "wan22_t2v": 60,
          # audio: guesses until the GPU box has run some (warm rates are the catalog's est_seconds / 30)
          "ace15_turbo": 8, "sa3_small_music": 5, "sa3_small_sfx": 5, "sa3_medium": 10, "minimax_music3": 20}
AUDIO_DEFAULT_S = 30.0
UPSCALE_TEMPLATES = {
    "video": {"seedvr2": "upscale_seedvr2", "best": "upscale_seedvr2", "flashvsr": "upscale_flashvsr",
              "fast": "upscale_flashvsr", "esrgan": "upscale_esrgan", "quick": "upscale_esrgan"},
    "image": {"zimage_redraw": "image_upscale_zimage", "redraw": "image_upscale_zimage",
              "esrgan": "image_upscale_esrgan", "quick": "image_upscale_esrgan",
              "seedvr2": "image_upscale_seedvr2", "best": "image_upscale_seedvr2"},
}


def _template_models() -> dict[str, str]:
    out = {}
    for m in mc.MODELS.values():
        if m.type == "upscale":
            continue
        out[m.template] = m.id
        for tpl in m.extra.values():
            out[tpl] = m.id
    return out


TEMPLATE_MODEL = _template_models()


def bucket(width: int, height: int) -> float:
    return round(width * height / 1e6 / 0.25) * 0.25


def model_key(model_id: str, speed: str | None = None) -> str:
    m = mc.MODELS[model_id]
    if not m.speeds:
        return model_id
    return f"{model_id}:{speed or m.default_speed}"


def _size(p: dict) -> tuple[int, int] | None:
    if p.get("width") and p.get("height"):
        return int(p["width"]), int(p["height"])
    size = p.get("size")
    if isinstance(size, list) and len(size) == 2 and all(size):
        return int(size[0]), int(size[1])
    inputs = (p.get("comfy") or {}).get("inputs") or {}
    if inputs.get("width") and inputs.get("height"):
        return int(inputs["width"]), int(inputs["height"])
    return None


def sample(params: dict | None, job_gpu: float | None) -> tuple[str, float, float] | None:
    """(key, megapixels, GPU seconds per unit) for one finished generation, or None."""
    p = params or {}
    up = p.get("upscale") or {}
    if up.get("template"):
        size = (up.get("width"), up.get("height"))
        if not all(size):
            return None
        mp = size[0] * size[1] / 1e6
        stats = p.get("upscale_stats") or {}
        if stats:
            dur = p.get("duration_s")
            gpu = stats.get("gpu_seconds") or job_gpu
            return (f"upscale:{up['template']}", mp, float(gpu) / float(dur)) if gpu and dur else None
        gpu = (p.get("comfy") or {}).get("gpu_seconds") or job_gpu
        return (f"upscale:{up['template']}", mp, float(gpu)) if gpu else None

    if p.get("longtake"):
        tpl, gpu = "ltx23_extend", (p.get("longtake_stats") or {}).get("gpu_seconds") or job_gpu
    else:
        comfy = p.get("comfy") or {}
        tpl, gpu = comfy.get("template"), comfy.get("gpu_seconds") or job_gpu
    model_id = TEMPLATE_MODEL.get(tpl or "")
    if model_id and mc.MODELS[model_id].type == "audio":
        dur = p.get("duration_s")
        return (model_key(model_id), 0.0, float(gpu) / float(dur)) if gpu and dur else None
    size = _size(p)
    if not model_id or not gpu or size is None:
        return None
    mp = size[0] * size[1] / 1e6
    if mc.MODELS[model_id].type == "video":
        dur = p.get("duration_s")
        return (model_key(model_id), mp, float(gpu) / float(dur)) if dur else None
    return model_key(model_id, p.get("speed")), mp, float(gpu)


def _rows(db: Session, workspace_id: str | None, limit: int = WINDOW):
    q = (select(Generation.params, Job.gpu_seconds).outerjoin(Job, Job.id == Generation.job_id)
         .where(Generation.status.in_(("ready", "approved")))
         .order_by(Generation.updated_at.desc()).limit(limit))
    if workspace_id:
        q = q.where(Generation.workspace_id == workspace_id)
    return db.execute(q).all()


def history(db: Session, workspace_id: str) -> dict[str, list[tuple[float, float]]]:
    acc: dict[str, list[tuple[float, float]]] = {}
    for params, job_gpu in _rows(db, workspace_id):
        s = sample(params, job_gpu)
        if s:
            acc.setdefault(s[0], []).append((s[1], s[2]))
    return acc


def last_model(db: Session) -> str | None:
    """Whatever the GPU ran last (any workspace: it's one box). Model id or upscale template."""
    for params, job_gpu in _rows(db, None, 20):
        s = sample(params, job_gpu or 1.0)
        if s:
            return s[0].split(":")[0] if not s[0].startswith("upscale:") else s[0]
    return None


def _p80(vals: list[float]) -> float:
    vals = sorted(vals)
    return vals[max(0, math.ceil(0.8 * len(vals)) - 1)]


# ---------------------------------------------------------------- the estimate

def _plan(kind: str, model: str | None, speed: str | None, duration_s: float | None,
          width: int | None, height: int | None) -> dict:
    """What we're estimating: key, load key, unit size, warm rough seconds per unit, load seconds."""
    from app.drivers.comfy import HQ_SIZES, VIDEO_SIZES, WAN_SIZES

    if kind == "upscale":
        from app import upscale, upscale_image

        family = "video" if duration_s else "image"
        tpl = UPSCALE_TEMPLATES[family].get((model or "seedvr2").lower())
        if tpl is None:
            raise HTTPException(422, f"'{model}' isn't a {family} upscale engine")
        if family == "video":
            w, h = width or 1920, height or 1080
            eng = next(e for e in upscale.ENGINES.values() if e.template == tpl)
            rough, load = eng.rate_mp * w * h / 1e6, upscale.MODEL_LOAD_S
        else:
            w, h = width or 2048, height or 2048
            eng = next(e for e in upscale_image.ENGINES.values() if e.template == tpl)
            rough, load = eng.rate_mp * w * h / 1e6, eng.load_s
        key = f"upscale:{tpl}"
        return {"key": key, "load_key": key, "model": tpl, "w": w, "h": h, "rough": rough, "load": load,
                "video": family == "video"}

    if kind == "audio":
        m = mc.MODELS.get(model or "") if model and model != mc.AUTO else mc.audio_default("song")
        if m is None or m.type != "audio":
            raise HTTPException(422, f"'{model}' isn't an audio model")
        # no picture size: w/h 0 puts every take of a model in one bucket
        return {"key": model_key(m.id), "load_key": m.id, "model": m.id, "w": 0, "h": 0,
                "rough": (m.est_seconds or 6) / 30.0, "load": LOAD_S.get(m.id, 10), "video": True}

    if kind in ("video", "take"):
        m = mc.get(model, "video")
        table = {"wan22_t2v": WAN_SIZES, "ltx23_hq": HQ_SIZES}.get(m.id, VIDEO_SIZES)
        ref_w, ref_h = table["16:9"]
        w, h = width or ref_w, height or ref_h
        # est_seconds is a typical 5 s clip at the model's 16:9 size
        rough = (m.est_seconds or 60) / 5.0 * (w * h) / (ref_w * ref_h)
        return {"key": model_key(m.id), "load_key": m.id, "model": m.id, "w": w, "h": h, "rough": rough,
                "load": LOAD_S.get(m.id, 30), "video": True}

    m = mc.MODELS.get(model or "") if model and model != mc.AUTO else mc.default_for("image")
    if m is None or m.type not in ("image", "edit"):
        raise HTTPException(422, f"'{model}' isn't an image or edit model")
    sp = mc.speed_of(m, speed)
    w, h = width or 1024, height or 1024
    rough = (m.est_seconds or 20) * (w * h) / (1024 * 1024)
    if sp is not None:
        base = next(s for s in m.speeds if s.id == m.default_speed)
        # a fixed overhead (text encoder, VAE) plus the part that scales with steps
        rough *= 0.4 + 0.6 * sp.steps / base.steps
    return {"key": model_key(m.id, sp.id if sp else None), "load_key": m.id, "model": m.id, "w": w, "h": h,
            "rough": rough, "load": LOAD_S.get(m.id, 20), "video": False}


def estimate(db: Session, workspace_id: str, *, kind: str, model: str | None = None, speed: str | None = None,
             count: int = 1, duration_s: float | None = None, width: int | None = None,
             height: int | None = None) -> dict:
    if kind in ("video", "take") and not duration_s:
        duration_s = 5.0
    if kind == "audio" and not duration_s:
        duration_s = AUDIO_DEFAULT_S
    plan = _plan(kind, model, speed, duration_s, width, height)
    units = max(1, count) * (float(duration_s) if plan["video"] else 1.0)
    mp = plan["w"] * plan["h"] / 1e6

    samples = history(db, workspace_id).get(plan["key"], [])
    same = [v for s_mp, v in samples if bucket(plan["w"], plan["h"]) == round(s_mp / 0.25) * 0.25]
    if len(same) >= MIN_SAMPLES:
        vals = same
    elif len(samples) >= MIN_SAMPLES:
        # other sizes of the same model: scale by pixel count, close enough for a range
        vals = [v * mp / s_mp for s_mp, v in samples if s_mp]
    else:
        vals = []

    if vals:
        low, high, basis = statistics.median(vals) * units, _p80(vals) * units, "measured"
        high = max(high, low * 1.15)
    else:
        low, high, basis = plan["rough"] * units * ROUGH_LOW, plan["rough"] * units * ROUGH_HIGH, "rough"

    load = 0.0
    if last_model(db) != plan["load_key"]:
        load = float(plan["load"])
    return {"low_s": int(math.floor(low + load)), "high_s": int(math.ceil(high + load)), "basis": basis,
            "samples": len(vals), "model": plan["model"], "load_s": round(load), "units": round(units, 2)}
