"""Upscaling a single image (portraits, sheet views, establishing frames, keyframes).

Unlike the video upscale this is one ComfyUI prompt, so it rides the normal "generate" job: the result
is a new version of the same target + kind with parent_id pointing at the source, and the review loop
(Versions, approve) works on it unchanged. The driver spots params.upscale and swaps the template.
"""
import math
from dataclasses import dataclass

from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Generation, Job
from app.services import enqueue_generation, generation_file
from app.upscale import UpscaleError, seedvr2_variant

IMAGE_KINDS = ("portrait", "sheet_view", "establishing", "keyframe_start", "keyframe_end", "keyframe_mid", "image")
TARGETS = {"2x": 2.0, "4x": 4.0, "2k": 2048, "4k": 3840}
TARGET_LABELS = {"2x": "2×", "4x": "4×", "2k": "2K", "4k": "4K"}
ANIME_MODEL = "RealESRGAN_x4plus_anime_6B.pth"
ALIASES = {"cartoon": "anime", "zimage": "redraw", "z-image": "redraw", "esrgan": "quick", "realesrgan": "quick",
           "seedvr2": "best", "seedvr": "best", "faithful": "best"}
GENERIC_REDRAW_PROMPT = "a sharp, detailed, high quality image with clean natural texture"
DENOISE = (0.15, 0.5, 0.33)  # min, max, default: the product owner's workflow runs at 0.33
DEFAULT_ENGINE = "redraw"
# keys of the source's params that describe how *it* was made, not what the upscale should carry
DROP_KEYS = ("comfy", "upscale", "size", "approved_by", "auto_check", "auto_check_reason", "auto_issues",
             "autopilot", "compile_first", "created_by", "original_name", "bytes")


@dataclass(frozen=True)
class ImageEngine:
    id: str
    label: str
    template: str
    max_long: int
    multiple: int = 2
    mp_capped: bool = True  # diffusion engines are held under IMAGE_UPSCALE_MAX_MP for VRAM
    load_s: float = 20.0  # provisional GPU-second guesses until real numbers come in
    rate_mp: float = 4.0
    blurb: str = ""


ENGINES = {
    "redraw": ImageEngine("redraw", "Redraw · Z-Image", "image_upscale_zimage", 4096, 16, load_s=20.0, rate_mp=5.0,
                          blurb="Sharpest. Re-draws fine detail with the image's own prompt."),
    "quick": ImageEngine("quick", "Quick · Real-ESRGAN", "image_upscale_esrgan", 8192, mp_capped=False,
                         load_s=3.0, rate_mp=0.6, blurb="A few seconds. Cleaner edges, no new detail."),
    "anime": ImageEngine("anime", "Anime · Real-ESRGAN", "image_upscale_esrgan", 8192, mp_capped=False,
                         load_s=3.0, rate_mp=0.4, blurb="For anime, cartoons and line art: crisp lines, flat colour."),
    "best": ImageEngine("best", "Faithful · SeedVR2", "image_upscale_seedvr2", 4096, load_s=30.0, rate_mp=6.0,
                        blurb="Restores detail while staying true to the original."),
}
SEEDVR2_7B_FACTOR = 2.0


def engine_id(value: str | None) -> str:
    v = (value or DEFAULT_ENGINE).strip().lower()
    v = ALIASES.get(v, v)
    if v not in ENGINES:
        raise UpscaleError(f"'{value}' isn't an image upscale engine (expected redraw, quick, anime or best)")
    return v


def is_image(g: Generation) -> bool:
    # uploads (contract v5) can be either; the sniffed media type decides
    return g.kind in IMAGE_KINDS or (g.kind == "upload" and (g.media_type or "").startswith("image/"))


# ---------------------------------------------------------------- sizes

def _snap(x: float, m: int) -> int:
    # floor, so a capped size never pokes past the cap
    return max(m, int(x) // m * m)


@dataclass
class ImageSize:
    width: int
    height: int
    scale: float
    capped: bool  # the cap, not the target, set the size


def image_size(engine: ImageEngine, src_w: int, src_h: int, target: str, max_mp: float | None = None) -> ImageSize:
    if target not in TARGETS:
        raise UpscaleError(f"Unknown target '{target}' (expected {', '.join(TARGETS)})")
    t = TARGETS[target]
    long = max(src_w, src_h)
    want = t if isinstance(t, float) else t / long
    s = min(want, engine.max_long / long)
    if engine.mp_capped:
        cap = (max_mp or get_settings().image_upscale_max_mp) * 1e6
        s = min(s, math.sqrt(cap / (src_w * src_h)))
    if s <= 1.01:
        raise UpscaleError(f"This image is already {src_w}×{src_h}; {TARGET_LABELS[target]} wouldn't make it bigger"
                           if want <= 1.01 else f"{engine.label} can't go past {src_w}×{src_h} for this image")
    w, h = _snap(src_w * s, engine.multiple), _snap(src_h * s, engine.multiple)
    return ImageSize(w, h, round(s, 3), s < want - 1e-6)


def source_size(g: Generation) -> tuple[int, int]:
    path = generation_file(g)
    if not path or not path.is_file():
        raise UpscaleError("This image's file is missing")
    try:
        with Image.open(path) as im:
            return im.size
    except OSError:
        raise UpscaleError("Couldn't read this image") from None


def estimate(engine: ImageEngine, size: ImageSize, variant: str | None = None) -> int:
    rate = engine.rate_mp * (SEEDVR2_7B_FACTOR if engine.id == "best" and variant == "7b" else 1.0)
    return round(engine.load_s + rate * size.width * size.height / 1e6)


def source_prompt(g: Generation) -> str:
    # the user's prompt describes the picture; what the driver sent to Qwen-edit adds "Picture 1 shows..."
    # instructions that mean nothing to Z-Image, so that's only the fallback (sheet views often have no prompt)
    comfy = (g.params or {}).get("comfy") or {}
    return (g.prompt or (comfy.get("inputs") or {}).get("prompt") or "").strip()


# ---------------------------------------------------------------- options

def engine_options(object_info: dict | None, *, driver: str, error: str | None = None) -> list[dict]:
    from app.upscale import _model_options
    from app.workflows import check_template, load

    out = []
    for e in ENGINES.values():
        item = {"id": e.id, "label": e.label, "description": e.blurb, "template": e.template, "available": True,
                "reason": None, "max_long_side": e.max_long, "multiple": e.multiple,
                "max_mp": get_settings().image_upscale_max_mp if e.mp_capped else None}
        if e.id == "redraw":
            item["denoise"] = {"min": DENOISE[0], "max": DENOISE[1], "default": DENOISE[2]}
        if e.id == "best":
            item["variants"] = ["3b", "7b"]
            item["default_variant"] = seedvr2_variant(None)
        if driver != "mock":
            if object_info is None:
                item.update(available=False, reason=f"ComfyUI isn't reachable ({error or 'no answer'})")
            else:
                res = check_template(e.template, object_info)
                problems = ([f"missing nodes: {', '.join(res['missing_nodes'])}"] if res["missing_nodes"] else []) + \
                           ([f"missing models: {', '.join(res['missing_models'])}"] if res["missing_models"] else []) + \
                           res["invalid"][:3]
                if e.id == "anime" and ANIME_MODEL not in _model_options(object_info, "UpscaleModelLoader",
                                                                         "model_name"):
                    problems.append(f"missing models: {ANIME_MODEL}")
                if e.id == "best":
                    have = set(_model_options(object_info, "UNETLoader", "unet_name"))
                    variants = load(e.template).manifest["variants"]
                    item["variants"] = [v for v, f in variants.items() if f in have]
                    if not item["variants"]:
                        problems.append("missing models: " + ", ".join(variants.values()))
                    elif item["default_variant"] not in item["variants"]:
                        item["default_variant"] = item["variants"][0]
                if problems:
                    item.update(available=False, reason="; ".join(problems))
        out.append(item)
    return out


def options_for(g: Generation, object_info: dict | None, *, driver: str, error: str | None = None) -> dict:
    engines = engine_options(object_info, driver=driver, error=error)
    default = DEFAULT_ENGINE if next(e for e in engines if e["id"] == DEFAULT_ENGINE)["available"] else \
        next((e["id"] for e in engines if e["available"]), DEFAULT_ENGINE)
    w, h = source_size(g)
    estimates = {}
    for e in ENGINES.values():
        per = {}
        for t in TARGETS:
            try:
                sz = image_size(e, w, h, t)
            except UpscaleError as err:
                per[t] = {"allowed": False, "reason": str(err)}
                continue
            per[t] = {"allowed": True, "width": sz.width, "height": sz.height, "capped": sz.capped,
                      "est_gpu_s": estimate(e, sz, seedvr2_variant(None)), "estimate_source": "provisional"}
        estimates[e.id] = per
    return {"media": "image", "engines": engines, "default_engine": default,
            "targets": [{"id": k, "label": v} for k, v in TARGET_LABELS.items()],
            "source": {"width": w, "height": h, "prompt": source_prompt(g)}, "estimates": estimates}


# ---------------------------------------------------------------- queueing

def _same(p: dict, want: dict) -> bool:
    return all(p.get(k) == want[k] for k in ("engine", "target", "variant", "denoise"))


def queue_image_upscale(db: Session, source: Generation, engine: str | None, target: str | None,
                        variant: str | None = None, denoise: float | None = None, prompt: str | None = None,
                        user_id: str | None = None) -> Job:
    if not is_image(source):
        raise UpscaleError("Only images can be upscaled this way")
    if source.status not in ("ready", "approved") or not source.file_path:
        raise UpscaleError("This image isn't finished yet")
    eid = engine_id(engine)
    e = ENGINES[eid]
    target = target or "2x"
    var = seedvr2_variant(variant) if eid == "best" else None
    if denoise is not None and not DENOISE[0] <= denoise <= DENOISE[1]:
        raise UpscaleError(f"Detail strength must be between {DENOISE[0]} and {DENOISE[1]}")
    dn = round(float(denoise if denoise is not None else DENOISE[2]), 3) if eid == "redraw" else None
    w, h = source_size(source)
    sz = image_size(e, w, h, target)

    up = {"engine": eid, "target": target, "variant": var, "denoise": dn}
    running = db.scalars(select(Generation).where(
        Generation.parent_id == source.id, Generation.status.in_(("queued", "generating")))).all()
    for g in running:
        if _same((g.params or {}).get("upscale") or {}, up) and g.job_id:
            return db.get(Job, g.job_id)

    from app.workflows import load

    up.update(template=e.template, width=sz.width, height=sz.height, scale=sz.scale, capped=sz.capped,
              source_id=source.id, source_file=source.file_path, source_version=source.version,
              source_size=[w, h])
    if eid == "redraw":
        # an upload has no prompt of its own; Z-Image still needs something to steer the redraw
        up["prompt"] = (prompt or "").strip() or source_prompt(source) or GENERIC_REDRAW_PROMPT
        # ESRGAN x4 then down to x1.4 is wasted work; lanczos alone is fine for small steps
        up["pre_enlarge"] = sz.scale >= 1.5
    if eid == "best":
        up["model"] = load(e.template).manifest["variants"][var]
    if eid == "anime":
        up["model"] = ANIME_MODEL
    params = {k: v for k, v in (source.params or {}).items() if k not in DROP_KEYS}
    params.update(upscale=up, size=[sz.width, sz.height], created_by={"user_id": user_id, "flow": "upscale"})
    # an upscaled upload is a made image, so it joins the item's line as kind "image"
    kind = "image" if source.kind == "upload" else source.kind
    g = enqueue_generation(
        db, workspace_id=source.workspace_id, project_id=source.project_id, target_type=source.target_type,
        target_id=source.target_id, kind=kind, prompt=source.prompt, params=params, parent_id=source.id,
    )
    job = db.get(Job, g.job_id)
    job.message = f"Waiting for a worker · {e.label.split(' · ')[0]} {TARGET_LABELS[target]}"
    return job
