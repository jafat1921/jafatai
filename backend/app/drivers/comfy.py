"""Real generation driver: maps a Generation onto one of our ComfyUI templates."""
import asyncio
import logging
import math
import random
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.config import Settings, get_settings
from app.drivers.base import DriverResult, ProgressCallback
from app.drivers.comfy_client import ComfyClient, ComfyError, ComfyOutput, parse_outputs, pick_client
from app import models_catalog as mc
from app.workflows import build, frames_for, load, snap_multiple

log = logging.getLogger("mixai.comfy")

# keyframes: ~0.6-0.9 MP, multiples of 16 for Z-Image / Qwen latents
IMAGE_SIZES = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (1024, 1024), "4:3": (1152, 864), "2.39:1": (1536, 640)}
# LTX draft sizes, multiples of 32. Final-res passes go through the x2 upscaler later.
VIDEO_SIZES = {"16:9": (832, 480), "9:16": (480, 832), "1:1": (640, 640), "4:3": (736, 544), "2.39:1": (960, 416)}
# High quality LTX: final size (multiples of 64, so stage 1 at half size stays on the 32 grid)
HQ_SIZES = {"16:9": (1280, 704), "9:16": (704, 1280), "1:1": (960, 960), "4:3": (1088, 832), "2.39:1": (1536, 640)}
WAN_SIZES = {"16:9": (832, 480), "9:16": (480, 832), "1:1": (624, 624), "4:3": (704, 544), "2.39:1": (960, 400)}
PORTRAIT_SIZE = (768, 1024)
MAX_FRAMES = 257  # ~10.7 s at 24 fps; longer shots belong to the long-take templates

VIEW_PROMPTS = {
    "front": "front view, facing the camera directly, full body, arms relaxed",
    "three_quarter": "three-quarter view, body turned 45 degrees from the camera, full body",
    "side": "side profile view, body turned 90 degrees, full body",
    "back": "back view, seen from directly behind, full body",
}
VIEW_ALIASES = {"3/4": "three_quarter", "3-4": "three_quarter", "34": "three_quarter", "profile": "side"}
ANGLES_LORA = "qwen-image-edit-2511-multiple-angles-lora.safetensors"

TIMEOUTS = {"zimage_t2i": 900.0, "qwen_edit": 900.0, "ltx23_i2v": 3600.0, "ltx23_extend": 3600.0,
            "upscale_seedvr2": 3600.0, "upscale_flashvsr": 3600.0, "upscale_esrgan": 1800.0,
            "image_upscale_zimage": 900.0, "image_upscale_seedvr2": 900.0, "image_upscale_esrgan": 300.0,
            "qwen_image_t2i": 1200.0, "flux2_klein_t2i": 600.0, "flux2_klein_edit": 900.0,
            "ltx23_two_stage": 3600.0, "wan22_t2v": 2400.0,
            "zimage_i2i": 900.0, "flux2_klein_i2i": 600.0, "qwen_image_i2i": 1200.0}
# templates whose LoRA insertion point takes the user's LoRAs (Z-Image / Qwen-Edit / LTX families)
LORA_FAMILIES = {"zimage_t2i", "zimage_i2i", "qwen_edit", "ltx23_i2v", "ltx23_extend"}
IMAGE_UPSCALE_TEMPLATES = {"image_upscale_zimage", "image_upscale_seedvr2", "image_upscale_esrgan"}
UPSCALE_TEMPLATES = {"upscale_seedvr2", "upscale_flashvsr", "upscale_esrgan"}


@dataclass
class Plan:
    template: str
    inputs: dict[str, Any]
    images: dict[str, Path | list[Path]] = field(default_factory=dict)
    loras: list[tuple[str, float]] = field(default_factory=list)
    media: str = "image"
    sources: dict[str, Any] = field(default_factory=dict)  # generation ids behind the images, for the record


class DbLookup:
    """Reads the few things the driver needs from the app DB (own short-lived session)."""

    def _session(self):
        from app.db import SessionLocal

        return SessionLocal()

    def generation_file(self, gen_id: str) -> Path:
        from app.models import Generation
        from app.services import generation_file

        with self._session() as db:
            g = db.get(Generation, gen_id)
            if g is None:
                raise ComfyError(f"referenced generation {gen_id} doesn't exist")
            if g.status not in ("ready", "approved") or not g.file_path:
                raise ComfyError(f"referenced generation {gen_id} has no finished image (status {g.status})")
            path = generation_file(g)
        if not path or not path.is_file():
            raise ComfyError(f"file for generation {gen_id} is missing on disk")
        return path

    def character_portrait(self, character_id: str) -> str | None:
        from sqlalchemy import select

        from app.models import Generation

        with self._session() as db:
            base = select(Generation.id).where(
                Generation.target_type == "character", Generation.target_id == character_id,
                Generation.kind == "portrait", Generation.file_path.is_not(None),
            )
            approved = db.scalars(base.where(Generation.status == "approved")).first()
            if approved:
                return approved
            # no approved portrait yet: newest finished one is better than refusing outright
            return db.scalars(base.where(Generation.status == "ready").order_by(Generation.created_at.desc())).first()

    def project_aspect(self, project_id: str | None) -> str | None:
        if not project_id:
            return None
        from app.models import Project

        with self._session() as db:
            p = db.get(Project, project_id)
            return p.aspect_ratio if p else None


def _ids(value) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value if v]


def _size(params: dict, default: tuple[int, int], multiple: int) -> tuple[int, int]:
    w = params.get("width") or default[0]
    h = params.get("height") or default[1]
    return snap_multiple(w, multiple), snap_multiple(h, multiple)


def _loras(params: dict) -> list[tuple[str, float]]:
    # TODO: check names (and model family) against the lora table / object_info before queueing,
    # so a typo fails here instead of as a ComfyUI validation error
    out = []
    for item in params.get("loras") or []:
        if isinstance(item, str):
            out.append((item, 1.0))
        elif isinstance(item, dict) and item.get("name"):
            out.append((item["name"], float(item.get("strength", 1.0))))
    return out


def _ref_preamble(labels, n: int) -> str:
    # the Qwen edit encoder names its inputs "Picture 1..3"; say which is which so it composes
    # rather than copying picture 1 back out
    labels = list(labels or [])[:n]
    if not labels:
        return ""
    parts = [f"Picture {i} shows {name}" for i, name in enumerate(labels, 1)]
    return ("; ".join(parts) + ". Compose a new film frame with them: keep each character's face, hair and "
            "clothing exactly, and match the location. ")


def plan_generation(kind: str, prompt: str, params: dict, seed: int, lookup) -> Plan:
    params = params or {}
    negative = params.get("negative") or params.get("negative_prompt") or ""
    ref_ids = _ids(params.get("reference_ids"))[:3]
    loras = _loras(params)

    if params.get("upscale") and kind in ("portrait", "sheet_view", "establishing", "keyframe_start", "keyframe_end",
                                          "keyframe_mid", "image"):
        return image_upscale_plan(params["upscale"], negative, seed, lookup)

    def edit_plan(ids: list[str], text: str, size: tuple[int, int], model: str | None = None) -> Plan:
        m = mc.MODELS.get(model or edit_model_id(params)) or mc.default_for("edit")
        ids = ids[: m.max_refs or 3]
        files = [lookup.generation_file(i) for i in ids]
        w, h = _size(params, size, 16)
        inputs = {"prompt": text, "negative": negative, "width": w, "height": h, "seed": seed}
        if params.get("steps"):
            inputs["steps"] = params["steps"]
        return Plan(m.template, inputs, {"images": files}, _family(m.template, loras), "image",
                    {"reference_ids": ids, "model": m.id})

    def t2i_plan(size: tuple[int, int]) -> Plan:
        m = mc.MODELS.get(params.get("model") or "")
        if m is None or m.type != "image":
            m = mc.default_for("image")
        w, h = _size(params, size, 16)
        inputs = {"prompt": prompt, "negative": negative, "width": w, "height": h, "seed": seed}
        sources = {"model": m.id}
        sp = next((x for x in m.speeds if x.id == params.get("speed")), None) or \
            next((x for x in m.speeds if x.id == m.default_speed), None)
        if sp:
            inputs.update(steps=sp.steps, cfg=sp.cfg, speed_lora=sp.lora)
            if sp.shift is not None:
                inputs["shift"] = sp.shift
            sources["speed"] = sp.id
        if params.get("steps"):
            inputs["steps"] = params["steps"]
        return Plan(m.template, inputs, {}, _family(m.template, loras), "image", sources)

    def i2i_plan(size: tuple[int, int]) -> Plan:
        # the t2i recipe (model, speed, size) on the model's image-to-image graph
        plan = t2i_plan(size)
        m = mc.MODELS[plan.sources["model"]]
        tpl = m.extra.get("i2i")
        if not tpl:
            raise ComfyError(f"{m.label} can't redraw an existing picture")
        src = params["img2img_of"]
        strength = min(0.9, max(0.1, float(src.get("strength") or 0.45)))
        plan.template = tpl
        plan.inputs["denoise"] = strength
        if tpl == "flux2_klein_i2i":
            # SplitSigmasDenoise keeps round(steps * strength) steps; stretch so ~4 real steps run
            plan.inputs["steps"] = max(4, math.ceil(int(plan.inputs.get("steps") or 4) / strength))
        plan.images = {"image": lookup.generation_file(src["generation_id"])}
        plan.loras = _family(tpl, loras)
        plan.sources.update(img2img_of=src["generation_id"], strength=strength)
        return plan

    if kind == "image":
        # Image studio (contract v5): sources make it an edit, otherwise plain text to image.
        # The API already picked a ~1 MP size for the aspect.
        size = (params.get("width") or 1024, params.get("height") or 1024)
        if params.get("img2img_of"):
            return i2i_plan(size)
        return edit_plan(ref_ids, prompt, size) if ref_ids else t2i_plan(size)

    if kind == "video":
        return clip_plan(prompt, params, seed, lookup, negative, loras)

    if kind == "portrait":
        return edit_plan(ref_ids, prompt, PORTRAIT_SIZE) if ref_ids else t2i_plan(PORTRAIT_SIZE)

    if kind == "sheet_view":
        ids = ref_ids
        if not ids:
            portrait = lookup.character_portrait(params["target_id"]) if params.get("target_id") else None
            if not portrait:
                raise ComfyError("This character has no portrait yet. Generate (and ideally approve) one first.")
            ids = [portrait]
        view = str(params.get("view") or "front").lower().replace(" ", "_")
        view = VIEW_ALIASES.get(view, view)
        angle = VIEW_PROMPTS.get(view, view.replace("_", " "))
        text = (
            f"Show the same character from a new camera angle: {angle}. "
            "Keep the face, hairstyle, body shape, clothing and colours exactly the same. "
            "Plain light grey studio background, soft even lighting, character sheet style."
        )
        if prompt.strip():
            text += f" {prompt.strip()}"
        plan = edit_plan(ids, text, PORTRAIT_SIZE, model="qwen_image_edit_2511")  # the angles LoRA is Qwen-only
        if params.get("angles_lora"):
            strength = params["angles_lora"] if isinstance(params["angles_lora"], (int, float)) else 1.0
            plan.loras = [(ANGLES_LORA, float(strength))] + plan.loras
        plan.inputs["view"] = view  # recorded only; build() ignores unknown keys
        return plan

    if kind in ("keyframe_start", "keyframe_end", "keyframe_mid", "establishing"):
        aspect = params.get("aspect_ratio") or lookup.project_aspect(params.get("project_id")) or "16:9"
        size = IMAGE_SIZES.get(aspect, IMAGE_SIZES["16:9"])
        if not ref_ids:
            return t2i_plan(size)
        # the preamble talks Qwen's "Picture N" language; FLUX.2 just gets the prompt
        qwen = edit_model_id(params) == "qwen_image_edit_2511"
        pre = _ref_preamble(params.get("reference_labels"), len(ref_ids)) if qwen else ""
        return edit_plan(ref_ids, pre + prompt, size)

    if kind == "take":
        first = params.get("first_frame_id")
        if not first:
            raise ComfyError("A take needs params.first_frame_id (the START keyframe generation)")
        last = params.get("last_frame_id")
        aspect = params.get("aspect_ratio") or lookup.project_aspect(params.get("project_id")) or "16:9"
        w, h = _size(params, VIDEO_SIZES.get(aspect, VIDEO_SIZES["16:9"]), 32)
        fps = float(params.get("fps") or 24)
        frames = int(params["num_frames"]) if params.get("num_frames") else frames_for(float(params.get("duration_s") or 5), fps)
        frames = min(frames, MAX_FRAMES)
        images: dict[str, Path | list[Path]] = {"first_image": lookup.generation_file(first)}
        if last:
            images["last_image"] = lookup.generation_file(last)
        inputs = {"prompt": prompt, "width": w, "height": h, "num_frames": frames, "fps": fps, "seed": seed}
        if negative:
            inputs["negative"] = negative
        sources = {"first_frame_id": first, "last_frame_id": last}
        if params.get("quality") == "hq":
            return hq_plan(inputs, images, aspect, params, loras, sources)
        if params.get("smooth_motion"):
            inputs["smooth_fps"] = fps * 2
            sources["smooth_motion"] = True
        return Plan("ltx23_i2v", inputs, images, loras, "video", sources)

    if kind == "take_chunk":
        return chunk_plan(prompt, params, seed, lookup, negative, loras)

    if kind == "upscale_segment":
        return upscale_plan(params, seed)

    raise ComfyError(f"The ComfyUI driver doesn't handle '{kind}' generations")


def edit_model_id(params: dict) -> str:
    m = mc.MODELS.get(params.get("edit_model") or "") or mc.MODELS.get(params.get("model") or "")
    return m.id if m is not None and m.type == "edit" else mc.default_for("edit").id


def _family(template: str, loras):
    # a Z-Image or LTX LoRA would break a Qwen-Image / FLUX.2 / Wan graph
    return list(loras) if template in LORA_FAMILIES else []


def hq_plan(inputs: dict, images: dict, aspect: str, params: dict, loras, sources: dict) -> Plan:
    """LTX two-stage: same inputs as a standard take, at HQ size (stage 1 runs at half of it)."""
    w, h = HQ_SIZES.get(aspect, HQ_SIZES["16:9"])
    inputs = {**inputs, "width": w, "height": h, "half_width": w // 2, "half_height": h // 2}
    sources = {**sources, "quality": "hq"}
    if params.get("smooth_motion"):
        inputs["smooth_fps"] = float(inputs["fps"]) * 2
        sources["smooth_motion"] = True
    return Plan("ltx23_two_stage", inputs, images, _family("ltx23_i2v", loras), "video", sources)


def clip_plan(prompt: str, params: dict, seed: int, lookup, negative: str, loras) -> Plan:
    """Create Video (contract v6): one prompt, optional start image, any video model."""
    m = mc.MODELS.get(params.get("model") or "") or mc.default_for("video")
    aspect = params.get("aspect_ratio") or "16:9"
    first = params.get("first_frame_id")
    images: dict[str, Path | list[Path]] = {}
    if first:
        if "i2v" not in m.capabilities:
            raise ComfyError(f"{m.label} can't start from an image")
        images["first_image"] = lookup.generation_file(first)
    last = params.get("last_frame_id")
    if last:
        if "flf" not in m.capabilities:
            raise ComfyError(f"{m.label} can't end on a given image")
        images["last_image"] = lookup.generation_file(last)
    duration = float(params.get("duration_s") or 5)
    sources = {"model": m.id, "first_frame_id": first, "last_frame_id": last}
    if m.id == "wan22_t2v":
        w, h = WAN_SIZES.get(aspect, WAN_SIZES["16:9"])
        inputs = {"prompt": prompt, "width": w, "height": h, "num_frames": mc.wan_frames(duration),
                  "fps": mc.WAN_FPS, "seed": seed}
        if negative:
            inputs["negative"] = negative
        return Plan(m.template, inputs, images, [], "video", sources)
    fps = 24.0
    frames = min(frames_for(duration, fps), MAX_FRAMES)
    w, h = VIDEO_SIZES.get(aspect, VIDEO_SIZES["16:9"])
    inputs = {"prompt": prompt, "width": w, "height": h, "num_frames": frames, "fps": fps, "seed": seed}
    if negative:
        inputs["negative"] = negative
    if m.id == "ltx23_hq":
        return hq_plan(inputs, images, aspect, params, loras, sources)
    if params.get("smooth_motion"):
        inputs["smooth_fps"] = fps * 2
        sources["smooth_motion"] = True
    return Plan("ltx23_i2v", inputs, images, loras, "video", sources)


def chunk_plan(prompt: str, params: dict, seed: int, lookup, negative: str, loras) -> Plan:
    """One chunk of a long take (app.longtake). Chunk 0 is plain I2V from START; later chunks
    continue from the previous chunk's tail clip (extend) or restart from its last frame (i2v)."""
    w, h = _size(params, VIDEO_SIZES["16:9"], 32)
    fps = float(params.get("fps") or 24)
    frames = min(int(params["num_frames"]), MAX_FRAMES)
    inputs: dict[str, Any] = {"prompt": prompt, "width": w, "height": h, "num_frames": frames, "fps": fps, "seed": seed}
    if negative:
        inputs["negative"] = negative
    images: dict[str, Path | list[Path]] = {}
    last = params.get("last_frame_id")
    if last:
        images["last_image"] = lookup.generation_file(last)
    sources = {"chunk": params.get("chunk_idx"), "last_frame_id": last}

    if params.get("context_video"):
        ctx_frames = int(params.get("context_frames") or 9)
        images["context_video"] = Path(params["context_video"])
        # the audio mask works in seconds over this chunk only, not the whole take
        inputs.update(duration_s=frames / fps, context_s=ctx_frames / fps)
        return Plan("ltx23_extend", inputs, images, loras, "video", sources)

    if params.get("first_image_path"):
        images["first_image"] = Path(params["first_image_path"])
    elif params.get("first_frame_id"):
        images["first_image"] = lookup.generation_file(params["first_frame_id"])
        sources["first_frame_id"] = params["first_frame_id"]
    elif not params.get("text_start"):
        raise ComfyError("A take chunk needs the START frame, a context clip or a first image")
    # text_start: chunk 0 of a long Create Video clip without a start image is plain text to video
    return Plan("ltx23_i2v", inputs, images, loras, "video", sources)


def upscale_plan(params: dict, seed: int) -> Plan:
    """One segment of an upscale job (app.upscale): a short video-only clip in, frames out."""
    template = params.get("template")
    if template not in UPSCALE_TEMPLATES:
        raise ComfyError(f"unknown upscale template {template!r}")
    inputs = {k: params[k] for k in ("width", "height", "fps", "scale", "model", "model_version", "color_correction")
              if params.get(k) is not None}
    inputs["seed"] = seed
    return Plan(template, inputs, {"video": Path(params["video_path"])}, [], "video",
                {"segment": params.get("segment_idx"), "source_id": params.get("source_id")})


def image_upscale_plan(up: dict, negative: str, seed: int, lookup) -> Plan:
    """A new version of an image, made from an older one (app.upscale_image)."""
    template = up.get("template")
    if template not in IMAGE_UPSCALE_TEMPLATES:
        raise ComfyError(f"unknown image upscale template {template!r}")
    inputs: dict[str, Any] = {"width": up["width"], "height": up["height"], "seed": seed}
    if template == "image_upscale_zimage":
        # TODO: carry the source's Z-Image LoRAs over once LoRAs record which model family they're for
        inputs.update(prompt=up.get("prompt") or "", negative=negative, denoise=up.get("denoise") or 0.33,
                      pre_enlarge=True if up.get("pre_enlarge", True) else None)
    elif template == "image_upscale_seedvr2" and up.get("model"):
        inputs["model"] = up["model"]
    src = lookup.generation_file(up["source_id"])
    return Plan(template, inputs, {"image": src}, [], "image", {"source_id": up["source_id"]})


def exec_seconds(entry: dict) -> float | None:
    """GPU time from the history timestamps, so time spent queued behind other jobs isn't billed."""
    start = end = None
    for msg in (entry.get("status") or {}).get("messages") or []:
        if not (isinstance(msg, list) and len(msg) == 2 and isinstance(msg[1], dict)):
            continue
        ts = msg[1].get("timestamp")
        if msg[0] == "execution_start":
            start = ts
        elif msg[0] in ("execution_success", "execution_error", "execution_interrupted"):
            end = ts
    if start and end and end >= start:
        return round((end - start) / 1000.0, 3)
    return None


class ComfyDriver:
    name = "comfy"

    def __init__(
        self,
        settings: Settings | None = None,
        client_factory: Callable[[], Awaitable[ComfyClient]] | None = None,
        lookup=None,
        lane: str | None = None,
    ):
        self.settings = settings or get_settings()
        s = self.settings
        self.lane = lane
        # image jobs on the image GPU, video jobs on the video GPU (COMFY_IMAGE_URLS / COMFY_VIDEO_URLS)
        self.urls = s.comfy_urls_for(lane)
        self._client_factory = client_factory or (
            lambda: pick_client(self.urls, s.comfy_auth_token, s.comfy_verify_tls)
        )
        self.lookup = lookup or DbLookup()

    def generate_image(self, prompt, params, seed, out_path: Path, progress_cb: ProgressCallback) -> DriverResult:
        return self._generate(prompt, params, seed, out_path, progress_cb)

    def generate_video(self, prompt, params, seed, out_path: Path, progress_cb: ProgressCallback) -> DriverResult:
        return self._generate(prompt, params, seed, out_path, progress_cb)

    def generate_text(self, prompt, params, seed, out_path: Path, progress_cb: ProgressCallback) -> DriverResult:
        raise ComfyError("Text generations go to the LLM lane, not ComfyUI")

    def _generate(self, prompt, params, seed, out_path, progress_cb) -> DriverResult:
        seed = int(seed) if seed is not None else random.randint(0, 2**31 - 1)
        plan = plan_generation(params.get("kind", ""), prompt, params, seed, self.lookup)
        # the worker is sync; each job gets its own short event loop
        return asyncio.run(self._execute(plan, out_path, progress_cb, params))

    async def _execute(self, plan: Plan, out_path: Path, progress_cb: ProgressCallback, params: dict) -> DriverResult:
        progress_cb(0.0, "Connecting to ComfyUI")
        client = await self._client_factory()
        try:
            inputs = dict(plan.inputs)
            for key, value in plan.images.items():
                if isinstance(value, list):
                    inputs[key] = [await client.upload_image(p) for p in value]
                else:
                    inputs[key] = await client.upload_image(value)
            gen_id = params.get("generation_id") or out_path.stem
            inputs["filename_prefix"] = f"mixai/{gen_id}"

            graph, resolved = build(plan.template, inputs, plan.loras)
            tpl = load(plan.template)
            weights = {tpl.node_id(t): w for t, w in tpl.manifest.get("progress_weights", {}).items()
                       if any(n.get("_meta", {}).get("title") == t for n in graph.values())}

            t0 = time.monotonic()
            prompt_id, entry = await client.run(
                graph, progress_cb, timeout=TIMEOUTS.get(plan.template, 1800.0), weights=weights
            )
            wall = round(time.monotonic() - t0, 3)

            outs = [o for o in parse_outputs(entry) if o.kind == plan.media]
            if not outs:
                raise ComfyError(f"{plan.template} finished but produced no {plan.media} output")
            progress_cb(0.99, "Downloading result")
            await client.download(self._pick(outs, graph, tpl.manifest), out_path)
            server = client.base_url
        finally:
            await client.close()

        gpu_seconds = exec_seconds(entry) or wall
        record = {
            "template": plan.template,
            "seed": resolved.get("seed"),
            "inputs": {k: v for k, v in resolved.items() if k != "filename_prefix"},
            "sources": plan.sources,
            "prompt_id": prompt_id,
            "server": server,
            "gpu_seconds": gpu_seconds,
            "wall_seconds": wall,
        }
        if "view" in plan.inputs:
            record["view"] = plan.inputs["view"]
        meta: dict[str, Any] = {"template": plan.template, "gpu_seconds": gpu_seconds}
        if plan.media == "video" and "num_frames" in resolved:
            fps = float(resolved.get("fps") or 24)
            meta.update(duration_s=round(resolved["num_frames"] / fps, 3), width=resolved["width"], height=resolved["height"])
        elif plan.media == "video":
            meta.update(width=resolved.get("width"), height=resolved.get("height"))
        else:
            meta.update(width=resolved.get("width"), height=resolved.get("height"))
        progress_cb(1.0, "Done")
        return DriverResult(out_path, "video/mp4" if plan.media == "video" else "image/png", meta,
                            params_update={"comfy": record})

    @staticmethod
    def _pick(outs: list[ComfyOutput], graph: dict, manifest: dict) -> ComfyOutput:
        wanted = {spec["node"] for spec in manifest.get("outputs", {}).values()}
        ids = {nid for nid, n in graph.items() if n.get("_meta", {}).get("title") in wanted}
        for o in outs:
            if o.node_id in ids:
                return o
        return outs[0]
