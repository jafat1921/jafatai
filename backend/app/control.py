"""Depth / Sketch / Pose / Edge to image (contract v31): Z-Image Turbo steered by the Fun ControlNet Union.

alibaba-pai's Z-Image-Turbo-Fun-Controlnet-Union-2.1 (Apache-2.0) is a ComfyUI "model patch": ModelPatchLoader
reads it from models/model_patches and QwenImageDiffsynthControlnet applies it to the Z-Image model. The control
picture is either a photo we turn into a map first (round-2 preprocessors from comfyui_controlnet_aux, plus
DWPose for pose) or a map/sketch the user already has ("use as is"). When the patch isn't installed the request
falls back to Qwen-Image-Edit with the picture as a reference, which follows it more loosely.
"""
from dataclasses import dataclass

from PIL import Image, ImageOps, ImageStat

from app.config import get_settings
from app.models import Generation, new_id

MODEL_PATCH = "Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors"
RAW_TEMPLATE = "zimage_controlnet"
LICENCE = "Apache-2.0 (Z-Image-Turbo-Fun-Controlnet-Union-2.1 lite, alibaba-pai)"
ANNOTATORS = "Unverified: ControlNetHED.pth from lllyasviel/Annotators (licence 'other'); treated as non-commercial"

STRENGTH_MIN, STRENGTH_MAX, STRENGTH_DEFAULT = 0.65, 1.0, 0.8


@dataclass(frozen=True)
class ControlType:
    id: str
    label: str  # what the UI calls the map
    detector: str  # what makes it from a photo
    licence: str
    follows: str  # "Render ... following the {follows} of image 1" for the Qwen fallback
    noncommercial: bool = False
    # a hand drawing is usually dark lines on white; the ControlNet wants light lines on black
    lines: bool = False

    @property
    def template(self) -> str:
        return f"{RAW_TEMPLATE}_{self.id}"


TYPES: dict[str, ControlType] = {c.id: c for c in (
    ControlType("depth", "Depth", "Depth Anything V2 Small", "Apache-2.0 (Depth Anything V2 Small)",
                "depth and layout"),
    ControlType("canny", "Edges", "Canny edges", "No model weights (OpenCV Canny)", "outlines and composition",
                lines=True),
    ControlType("pose", "Pose", "DWPose", "Apache-2.0 (DWPose and YOLOX TorchScript weights, per their model cards)",
                "pose, body position and framing"),
    ControlType("hed", "Soft edges", "HED soft edges", ANNOTATORS, "soft outlines and composition",
                noncommercial=True, lines=True),
    ControlType("scribble", "Sketch", "XDoG scribble lines", "No model weights (OpenCV XDoG)",
                "sketch lines and composition", lines=True),
)}
TEMPLATES = frozenset({RAW_TEMPLATE} | {c.template for c in TYPES.values()})


class ControlError(ValueError):
    pass


def allowed(c: ControlType) -> bool:
    return not c.noncommercial or get_settings().image_allow_noncommercial


def _problems(template: str, info: dict) -> str | None:
    from app import models_catalog as mc
    from app.workflows import check_template

    res = check_template(template, info)
    return None if res["ok"] else "; ".join(mc._problems(res))


def unavailable(c: ControlType, as_is: bool) -> str | None:
    """Why the ControlNet can't run this request. None when fine or not known (no fresh /object_info)."""
    if not allowed(c):
        return f"{c.detector} is switched off on this server (non-commercial licence; IMAGE_ALLOW_NONCOMMERCIAL)"
    if get_settings().gen_driver == "mock":
        return None
    from app.models_catalog import _cached_info

    info = _cached_info()
    return None if info is None else _problems(RAW_TEMPLATE if as_is else c.template, info)


def status(info: dict | None, *, driver: str, error: str | None = None) -> dict:
    """The "control" block of GET /images/tools."""
    def reason(template: str) -> str | None:
        if driver == "mock":
            return None
        if info is None:
            return f"ComfyUI isn't reachable ({error or 'no answer'})"
        return _problems(template, info)

    base = reason(RAW_TEMPLATE)
    types = []
    for c in TYPES.values():
        if not allowed(c):
            continue
        why = base or reason(c.template)
        types.append({"id": c.id, "label": c.label, "detector": c.detector, "licence": c.licence,
                      "noncommercial": c.noncommercial, "available": why is None, "reason": why})
    return {"engine": "Z-Image Turbo + Fun ControlNet Union 2.1", "licence": LICENCE, "available": base is None,
            "reason": base, "fallback": "Qwen-Image-Edit, using the picture as a reference (looser)",
            "strength": {"min": STRENGTH_MIN, "max": STRENGTH_MAX, "default": STRENGTH_DEFAULT}, "types": types}


def detect_resolution(w: int, h: int) -> int:
    return min(1024, max(512, min(w, h) // 64 * 64))


def light_background(path) -> bool:
    with Image.open(path) as im:
        return ImageStat.Stat(ImageOps.grayscale(im)).mean[0] > 127


def store_inverted(src: Generation, workspace_id: str) -> str:
    """A dark-on-light drawing turned light-on-dark, kept beside the masks (never shown in the Library)."""
    path = get_settings().data_dir / (src.file_path or "")
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        out = ImageOps.invert(ImageOps.grayscale(im))
    rel = f"workspaces/{workspace_id}/media/masks/{new_id()}.png"
    dest = get_settings().data_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.convert("RGB").save(dest, "PNG", compress_level=3)
    return rel


def build_record(c: ControlType, src: Generation, workspace_id: str, *, as_is: bool, strength: float,
                 size: tuple[int, int]) -> dict:
    """params["control"] for the driver."""
    if not STRENGTH_MIN <= strength <= STRENGTH_MAX:
        raise ControlError(f"Strength must be between {STRENGTH_MIN} and {STRENGTH_MAX}")
    w, h = size
    rec: dict = {"type": c.id, "as_is": as_is, "template": RAW_TEMPLATE if as_is else c.template,
                 "source_id": src.id, "inputs": {"width": w, "height": h, "strength": round(strength, 3)}}
    if not as_is:
        rec["inputs"]["resolution"] = detect_resolution(w, h)
    elif c.lines:
        try:
            if light_background(get_settings().data_dir / (src.file_path or "")):
                rec["control_file"] = store_inverted(src, workspace_id)
                rec["inverted"] = True
        except OSError:
            raise ControlError("The control picture isn't readable") from None
    return rec


def fallback_instruction(c: ControlType, prompt: str, style_text: str | None) -> str:
    what = prompt.strip().rstrip(".") or "a new picture"
    styled = f"{what}, {style_text}" if style_text else what
    return (f"Render {styled}, following the {c.follows} of image 1. Use image 1 only as a guide for shape and "
            "placement; do not copy its colours, textures or surface details.")
