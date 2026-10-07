"""Model catalog (contract v6): every model the app can drive, with the template behind it.

Single source of truth for the pickers (GET /api/models), for request validation and for the
comfy driver's routing. Availability comes from check_template against a cached /object_info.
"""
import re
import statistics
import time
from dataclasses import dataclass, field

from fastapi import HTTPException

from app.workflows import check_template, frames_for


@dataclass(frozen=True)
class Speed:
    id: str
    label: str
    steps: int
    note: str
    cfg: float = 1.0
    shift: float | None = None
    lora: str | None = None


@dataclass(frozen=True)
class Model:
    id: str
    type: str  # image | edit | video | upscale
    label: str
    badge: str | None
    description: str
    capabilities: tuple[str, ...]
    template: str
    # other templates the model needs for some capability (cap -> template)
    extra: dict = field(default_factory=dict)
    speeds: tuple[Speed, ...] = ()
    default_speed: str | None = None
    max_refs: int | None = None
    max_duration_s: float | None = None
    est_seconds: float | None = None
    default: bool = False
    smooth_motion: bool = False  # the template carries the optional temporal x2 nodes


QWEN_LIGHTNING = "Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors"
QWEN_TURBO = "Wuli-Qwen-Image-2512-Turbo-LoRA-2steps-V1.0-bf16.safetensors"
SINGLE_PASS_S = 256 / 24  # 257 frames, one LTX pass
WAN_FPS = 16.0
WAN_FRAMES = 81

MODELS: dict[str, Model] = {m.id: m for m in (
    Model("zimage_turbo", "image", "Z-Image Turbo", "FAST",
          "Photoreal pictures in a few seconds.", ("t2i", "i2i"), "zimage_t2i", extra={"i2i": "zimage_i2i"},
          est_seconds=7, default=True),
    Model("qwen_image_2512", "image", "Qwen-Image 2512", "TEXT",
          "Best for writing inside the picture: signs, posters, titles, including Urdu.",
          ("t2i", "i2i", "text_render"), "qwen_image_t2i", extra={"i2i": "qwen_image_i2i"},
          speeds=(
              # full: the server template says 50 steps; 30 keeps most of the quality at 60% of the time
              Speed("full", "Full quality", 30, "Slowest, most detail", cfg=4.0, shift=3.1),
              Speed("lightning", "Lightning (4 steps)", 4, "Fast, nearly full quality", shift=3.1, lora=QWEN_LIGHTNING),
              Speed("turbo", "Turbo (2 steps)", 2, "Fastest draft", shift=3.0, lora=QWEN_TURBO),
          ),
          default_speed="lightning", est_seconds=25),
    Model("flux2_klein", "image", "FLUX.2 klein 4B", "FAST",
          "Very fast general-purpose images.", ("t2i", "i2i"), "flux2_klein_t2i", extra={"i2i": "flux2_klein_i2i"},
          est_seconds=5),

    Model("qwen_image_edit_2511", "edit", "Qwen-Image-Edit 2511", "BEST",
          "Change a picture or combine up to 3 references; keeps faces and clothes.",
          ("edit", "refs", "multi_angle"), "qwen_edit", max_refs=3, est_seconds=20, default=True),
    Model("flux2_klein_edit", "edit", "FLUX.2 klein 4B (base)", None,
          "Reference-guided edits, quick and loose.", ("edit", "refs"), "flux2_klein_edit",
          max_refs=3, est_seconds=25),

    Model("ltx23_distilled", "video", "LTX-2.3", None,
          "Video with sound from text, a start image, or start and end frames; long takes.",
          ("t2v", "i2v", "flf", "audio", "longtake"), "ltx23_i2v", extra={"longtake": "ltx23_extend"},
          max_duration_s=None, est_seconds=40, default=True, smooth_motion=True),
    Model("ltx23_hq", "video", "LTX-2.3 High quality", "HQ",
          "Sharper, higher-resolution video with sound; slower, one shot up to about 10 s.",
          ("t2v", "i2v", "flf", "audio"), "ltx23_two_stage", max_duration_s=SINGLE_PASS_S,
          est_seconds=150, smooth_motion=True),
    Model("wan22_t2v", "video", "Wan 2.2 14B", "NEW",
          "Text to video, no sound, about 5 seconds. Strong motion.", ("t2v",), "wan22_t2v",
          max_duration_s=5.0, est_seconds=120),

    Model("seedvr2", "upscale", "SeedVR2", "BEST", "Best video upscale: restores detail.", (), "upscale_seedvr2",
          default=True),
    Model("flashvsr", "upscale", "FlashVSR", "FAST", "Fast video upscale.", (), "upscale_flashvsr"),
    Model("esrgan", "upscale", "ESRGAN", "QUICK", "Quickest upscale, sharpening only.", (), "upscale_esrgan"),
    Model("zimage_redraw", "upscale", "Z-Image redraw", "UPSCALE",
          "Image upscale that redraws fine detail.", (), "image_upscale_zimage"),
)}

TYPES = ("image", "edit", "video", "upscale")
QUALITIES = {"standard": "ltx23_distilled", "hq": "ltx23_hq"}


def default_for(type_: str) -> Model:
    return next(m for m in MODELS.values() if m.type == type_ and m.default)


def get(model_id: str | None, type_: str) -> Model:
    """The model, or the type's default when none was asked for. 422 on unknown / wrong type /
    known-unavailable. "auto" with nothing to go on is the default too (see resolve_auto)."""
    if not model_id or model_id == AUTO:
        return default_for(type_)
    m = MODELS.get(model_id)
    if m is None or m.type != type_:
        names = ", ".join(x.id for x in MODELS.values() if x.type == type_)
        what = "an image" if type_ == "image" else ("an edit" if type_ == "edit" else f"a {type_}")
        raise HTTPException(422, f"'{model_id}' isn't {what} model (choose one of: {names})")
    reason = known_unavailable(m)
    if reason:
        raise HTTPException(422, f"{m.label} isn't available right now: {reason}")
    return m


# ---------------------------------------------------------------- auto

AUTO = "auto"
AUTO_TYPES = ("image", "edit", "video")
AUTO_DESCRIPTION = "Picks the best model for your prompt"
_NON_LATIN = re.compile(r"[֐-ࣿऀ-෿฀-࿿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯"
                        r"Ѐ-ӿͰ-Ͽﭐ-﷿ﹰ-﻿]")
_TEXT_WORDS = re.compile(r"\b(posters?|signs?|signage|signboard|logos?|text|caption|headline|lettering|typography|"
                         r"banner|billboard)\b", re.I)


def wants_text(prompt: str) -> bool:
    from app.prompt_enhance import quoted

    return bool(quoted(prompt) or _NON_LATIN.search(prompt or "") or _TEXT_WORDS.search(prompt or ""))


def _usable(model_id: str) -> bool:
    return known_unavailable(MODELS[model_id]) is None


def resolve_auto(type_: str, prompt: str = "", *, count: int = 1, refs: int = 0,
                 quality: str | None = None) -> tuple[Model, str]:
    """(model, why) for the catalog's "auto" entry. Skips a pick the last /object_info says is broken."""
    if type_ == "image":
        if wants_text(prompt):
            picks = [("qwen_image_2512", "text in the prompt")]
        elif count >= 4:
            picks = [("flux2_klein", f"{count} images, fastest model")]
        else:
            picks = []
        picks.append(("zimage_turbo", "general picture"))
    elif type_ == "edit":
        picks = [(m.id, "keeps faces and clothes" if m.id == "qwen_image_edit_2511" else f"{refs} references")
                 for m in MODELS.values() if m.type == "edit" and (m.max_refs is None or refs <= m.max_refs)]
        picks.sort(key=lambda p: p[0] != "qwen_image_edit_2511")
        picks.append(("qwen_image_edit_2511", "default"))
    elif type_ == "video":
        picks = [("ltx23_hq", "high quality asked for")] if quality == "hq" else []
        picks.append(("ltx23_distilled", "video with sound"))
    else:
        raise HTTPException(422, f"There's no auto choice for {type_} models")
    for mid, why in picks:
        if _usable(mid):
            return MODELS[mid], why
    # nothing known-good: hand back the last resort and let get()/the job say why
    mid, why = picks[-1]
    return get(mid, type_), why


def choose(model_id: str | None, type_: str, prompt: str = "", **kw) -> tuple[Model, dict]:
    """Route helper: the model plus what goes into params (model_resolved, and the reason when auto)."""
    if model_id == AUTO:
        m, why = resolve_auto(type_, prompt, **kw)
        return m, {"model_requested": AUTO, "model_resolved": m.id, "model_auto_reason": why}
    m = get(model_id, type_)
    return m, {"model_resolved": m.id}


def auto_out(type_: str) -> dict:
    return {"id": AUTO, "type": type_, "label": "Auto", "badge": None, "description": AUTO_DESCRIPTION,
            "capabilities": [], "available": True, "reason": None, "default": False, "auto": True,
            "est_seconds": None, "estimate_source": "rough"}


def speed_of(m: Model, speed_id: str | None) -> Speed | None:
    if not m.speeds:
        if speed_id:
            raise HTTPException(422, f"{m.label} has no speed options")
        return None
    sid = speed_id or m.default_speed
    sp = next((s for s in m.speeds if s.id == sid), None)
    if sp is None:
        raise HTTPException(422, f"Unknown speed '{speed_id}' for {m.label} "
                                 f"(choose one of: {', '.join(s.id for s in m.speeds)})")
    return sp


def check_refs(m: Model, n: int) -> None:
    if m.max_refs is not None and n > m.max_refs:
        raise HTTPException(422, f"{m.label} takes at most {m.max_refs} reference images; you sent {n}")


def check_video(m: Model, *, has_image: bool, duration_s: float, smooth_motion: bool) -> None:
    if has_image and "i2v" not in m.capabilities:
        raise HTTPException(422, f"{m.label} makes video from text only; remove the start image or pick LTX-2.3")
    if m.max_duration_s is not None and duration_s > m.max_duration_s + 1e-6:
        raise HTTPException(422, f"{m.label} makes clips up to {m.max_duration_s:.1f} s; asked for {duration_s:g} s")
    if smooth_motion:
        if not m.smooth_motion:
            raise HTTPException(422, f"Smooth motion isn't offered for {m.label}")
        reason = smooth_unavailable(m)
        if reason:
            raise HTTPException(422, f"Smooth motion isn't available right now: {reason}")


# ---------------------------------------------------------------- availability

def _problems(res: dict) -> list[str]:
    return ([f"missing nodes: {', '.join(res['missing_nodes'])}"] if res["missing_nodes"] else []) + \
           ([f"missing models: {', '.join(res['missing_models'])}"] if res["missing_models"] else []) + \
           res["invalid"][:3]


def _lora_options(info: dict) -> set:
    spec = info.get("LoraLoaderModelOnly", {}).get("input", {}).get("required", {}).get("lora_name") or [[]]
    head = spec[0]
    if head == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        return set(spec[1].get("options") or [])
    return set(head) if isinstance(head, list) else set()


def availability(m: Model, info: dict | None, *, driver: str = "comfy", error: str | None = None) -> dict:
    """{available, reason, speeds: {id: reason|None}, smooth: reason|None, dropped: [capabilities]}"""
    out = {"available": True, "reason": None, "speeds": {s.id: None for s in m.speeds}, "smooth": None, "dropped": []}
    if driver == "mock":
        return out
    if info is None:
        reason = f"ComfyUI isn't reachable ({error or 'no answer'})"
        out.update(available=False, reason=reason, smooth=reason)
        return out
    res = check_template(m.template, info)
    if not res["ok"]:
        out.update(available=False, reason="; ".join(_problems(res)))
    for cap, tpl in m.extra.items():
        extra = check_template(tpl, info)
        if not extra["ok"]:
            out["dropped"].append(cap)
    if m.speeds:
        loras = _lora_options(info)
        for s in m.speeds:
            if s.lora and s.lora not in loras:
                out["speeds"][s.id] = f"missing LoRA {s.lora}"
    if m.smooth_motion:
        feat = (res.get("features") or {}).get("smooth_motion")
        if feat and not feat["ok"]:
            out["smooth"] = "; ".join(feat["problems"][:3])
    return out


def _cached_info() -> dict | None:
    from app import upscale  # its object_info cache is shared by every picker

    info = upscale._INFO_CACHE["info"]
    if info is None or time.monotonic() - upscale._INFO_CACHE["at"] > upscale.INFO_TTL_S:
        return None
    return info


def known_unavailable(m: Model) -> str | None:
    """Reason from a recent /object_info, None when fine or not known (we don't block on a guess)."""
    from app.config import get_settings

    if get_settings().gen_driver == "mock":
        return None
    info = _cached_info()
    return None if info is None else availability(m, info)["reason"]


def capability_unavailable(m: Model, cap: str) -> str | None:
    """Why `cap` can't be used right now: not offered at all, or its extra template failed the last
    /object_info check. None when fine or not known."""
    from app.config import get_settings

    if cap not in m.capabilities:
        return f"{m.label} doesn't offer this"
    if get_settings().gen_driver == "mock" or cap not in m.extra:
        return None
    info = _cached_info()
    if info is None:
        return None
    res = check_template(m.extra[cap], info)
    return None if res["ok"] else "; ".join(_problems(res))


def smooth_unavailable(m: Model) -> str | None:
    from app.config import get_settings

    if get_settings().gen_driver == "mock":
        return None
    info = _cached_info()
    return None if info is None else availability(m, info)["smooth"]


def measured_seconds(rows: list[dict]) -> dict[str, float]:
    """Median GPU seconds per output (images) or per output second (videos), keyed by catalog key.
    rows are generation params dicts with a 'comfy' record."""
    acc: dict[str, list[float]] = {}
    for p in rows:
        rec = (p or {}).get("comfy") or {}
        gpu = rec.get("gpu_seconds")
        tpl = rec.get("template")
        if not gpu or not tpl:
            continue
        key = tpl + (f":{p['speed']}" if p.get("speed") else "")
        dur = p.get("duration_s") if tpl in ("ltx23_i2v", "ltx23_two_stage", "wan22_t2v") else None
        acc.setdefault(key, []).append(float(gpu) / float(dur) if dur else float(gpu))
    return {k: statistics.median(v[:15]) for k, v in acc.items()}


def model_out(m: Model, av: dict, measured: dict[str, float] | None = None) -> dict:
    measured = measured or {}
    caps = [c for c in m.capabilities if c not in av["dropped"]]
    est, source = m.est_seconds, "rough"
    key = m.template + (f":{m.default_speed}" if m.default_speed else "")
    if key in measured:
        per = measured[key]
        est = per * (5.0 if m.type == "video" else 1.0)  # videos: a typical 5 s clip
        source = "measured"
    out = {
        "id": m.id, "type": m.type, "label": m.label, "badge": m.badge, "description": m.description,
        "capabilities": caps, "available": av["available"], "reason": av["reason"], "default": m.default,
        "est_seconds": round(est) if est is not None else None, "estimate_source": source,
    }
    if m.speeds:
        out["speeds"] = [{"id": s.id, "label": s.label, "steps": s.steps, "note": s.note,
                          "available": av["speeds"][s.id] is None, "reason": av["speeds"][s.id]} for s in m.speeds]
        out["default_speed"] = m.default_speed
    if m.max_refs is not None:
        out["max_refs"] = m.max_refs
    if m.type == "video":
        if m.max_duration_s is not None:
            out["max_duration_s"] = round(m.max_duration_s, 2)
        else:
            from app.config import get_settings

            out["max_duration_s"] = get_settings().longtake_max_s
        out["audio"] = "audio" in caps
        if m.smooth_motion:
            out["smooth_motion"] = {"available": av["smooth"] is None and av["available"], "reason": av["smooth"]}
    return out


def catalog(type_: str | None, info: dict | None, *, driver: str, error: str | None = None,
            measured: dict | None = None) -> list[dict]:
    out = []
    for t in TYPES:
        if type_ not in (None, t):
            continue
        rows = [model_out(m, availability(m, info, driver=driver, error=error), measured)
                for m in MODELS.values() if m.type == t]
        if t in AUTO_TYPES:
            auto = auto_out(t)
            if not any(r["available"] for r in rows):
                auto.update(available=False, reason=rows[0]["reason"])
            out.append(auto)
        out += rows
    return out


# ---------------------------------------------------------------- studio params

IMAGE_STUDIO_KINDS = ("portrait", "establishing", "keyframe_start", "keyframe_end", "keyframe_mid")


def clean_project_settings(current: dict, patch: dict) -> dict:
    """Merge a settings patch, validating the keys this module owns; other keys (brand kits…) pass through."""
    out = dict(current)
    for key, val in patch.items():
        if key in ("brand_closing_shot", "shots_review"):
            continue  # owned by brand_moments / the storyboard review gate, not settable from outside
        if val is None:
            out.pop(key, None)
            continue
        if key in ("image_model", "edit_model") and val == AUTO:
            # TODO: resolve per prompt in the studio too; for now auto there means the type's default
            out.pop(key, None)
            continue
        if key == "image_model":
            val = get(str(val), "image").id
        elif key == "image_speed":
            speed_of(get(str(patch.get("image_model") or out.get("image_model") or ""), "image"), str(val))
        elif key == "edit_model":
            val = get(str(val), "edit").id
        elif key == "video_quality":
            if val not in QUALITIES:
                raise HTTPException(422, f"video_quality must be one of: {', '.join(QUALITIES)}")
        elif key == "smooth_motion":
            val = bool(val)
        elif key == "brand_closing":
            if val not in ("auto", "ai_packshot", "logo_reveal", "none"):
                raise HTTPException(422, "brand_closing must be one of: auto, ai_packshot, logo_reveal, none")
        out[key] = val
    return out


def apply_image_choice(params: dict, settings: dict | None) -> dict:
    """Studio stills: params.model (an image model) / params.edit_model, else the project's defaults.
    Validates; leaves the params without a model when everything is the default."""
    settings = settings or {}
    image_id = params.get("model") or settings.get("image_model")
    if image_id:
        params["model"] = get(image_id, "image").id
        sp = speed_of(MODELS[params["model"]], params.get("speed") or (
            settings.get("image_speed") if params["model"] == settings.get("image_model") else None))
        if sp:
            params["speed"] = sp.id
    edit_id = params.get("edit_model") or settings.get("edit_model")
    if edit_id:
        em = get(edit_id, "edit")
        params["edit_model"] = em.id
        check_refs(em, len(params.get("reference_ids") or []))
    return params


def apply_take_quality(params: dict, settings: dict | None, *, long_take: bool) -> dict:
    """Render quality for a take. HQ and smooth motion are single-pass only: asked for explicitly on a
    long take that's a 422, inherited from the project default it falls back with a note."""
    settings = settings or {}
    explicit_q = params.get("quality") is not None
    quality = params.get("quality") or settings.get("video_quality") or "standard"
    if quality not in QUALITIES:
        raise HTTPException(422, f"quality must be one of: {', '.join(QUALITIES)}")
    explicit_s = params.get("smooth_motion") is not None
    smooth = bool(params["smooth_motion"] if explicit_s else settings.get("smooth_motion"))
    notes = []
    if long_take and quality == "hq":
        if explicit_q:
            raise HTTPException(422, f"High quality renders one pass of up to {SINGLE_PASS_S:.1f} s; this take is "
                                     f"{float(params.get('duration_s') or 0):g} s. Use Standard, or shorten the shot.")
        quality = "standard"
        notes.append("long take rendered in Standard quality (High quality is single-pass only)")
    if long_take and smooth:
        if explicit_s:
            raise HTTPException(422, "Smooth motion works on single-pass takes only (up to "
                                     f"{SINGLE_PASS_S:.1f} s); turn it off for this long take")
        smooth = False
        notes.append("smooth motion skipped on a long take")
    m = get(QUALITIES[quality], "video")
    if smooth:
        check_video(m, has_image=True, duration_s=0, smooth_motion=True)
    params.update(quality=quality, smooth_motion=smooth)
    if notes:
        params["quality_note"] = "; ".join(notes)
    else:
        params.pop("quality_note", None)
    return params


def wan_frames(duration_s: float) -> int:
    # Wan latents step 4 frames; 81 (5 s at 16 fps) is what both experts were trained on
    n = int(round(duration_s * WAN_FPS / 4)) * 4 + 1
    return max(17, min(WAN_FRAMES, n))


def video_frames(m: Model, duration_s: float, fps: float = 24.0) -> int:
    return wan_frames(duration_s) if m.id == "wan22_t2v" else frames_for(duration_s, fps)
