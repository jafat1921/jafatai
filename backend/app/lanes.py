"""Job lanes: which GPU (ComfyUI instance) a job belongs on.

image   -> stills, image edits and image upscales (COMFY_IMAGE_URLS)
video   -> takes, long takes, renders, video upscales (COMFY_VIDEO_URLS)
general -> LLM work, ffmpeg assembly / branding, exports, autopilot orchestration

Kept free of app imports on purpose: migration 0009 backfills with the same classifier.
"""
import re

LANES = ("image", "video", "general")

IMAGE_KINDS = frozenset({"portrait", "sheet_view", "keyframe_start", "keyframe_end", "keyframe_mid",
                         "establishing", "image"})
VIDEO_KINDS = frozenset({"take", "tile", "render", "video"})
# TODO: let an idle lane borrow the other GPU (a night of image batches leaves the video GPU unused)
# job types that always run on the video GPU whatever their generation says (SeedVR2 / FlashVSR segments)
VIDEO_JOB_TYPES = frozenset({"upscale"})


def lane_for(job_type: str, gen_kind: str | None = None) -> str:
    if job_type in VIDEO_JOB_TYPES:
        return "video"
    if job_type == "generate":
        if gen_kind in IMAGE_KINDS:
            return "image"
        if gen_kind in VIDEO_KINDS:
            return "video"
    # scene_text generations, ai_*, reel_assemble, brand_*, media_zip, autopilot...
    return "general"


def parse_lanes(value: str | None) -> tuple[str, ...]:
    """'image,video' -> ('image', 'video'); empty or 'all' means every lane.

    Also takes '-', '_' and ':' as separators because systemd instance names can't hold commas
    (mixai-worker@image-video.service)."""
    raw = [p for p in re.split(r"[\s,+:_-]+", (value or "").lower()) if p]
    if not raw or raw == ["all"]:
        return LANES
    bad = [p for p in raw if p not in LANES]
    if bad:
        raise ValueError(f"unknown lane(s) {', '.join(bad)} (expected {', '.join(LANES)} or all)")
    return tuple(dict.fromkeys(raw))
