"""3D Studio (contract v40): a picture to a textured GLB with Pixal3D or TRELLIS.2.

A result is a MediaItem of kind "model" whose generations are kind "model3d" (target_type "media"), so
versions, deletes, favourites and downloads work like any other Library item. The graph is
app/workflows/trellis2_image_to_3d; the engine and quality only change its inputs.
"""
from pathlib import Path

from PIL import Image

GEN_KIND = "model3d"
MEDIA_KIND = "model"
MEDIA_TYPE = "model/gltf-binary"
TEMPLATE = "trellis2_image_to_3d"
ENGINES = ("pixal3d", "trellis2")
DEFAULT_ENGINE = "pixal3d"

# Final is the official workflow's own settings; Draft trades detail for roughly half the time and VRAM
QUALITY = {
    "draft": {"upsample_resolution": 1024, "texture_size": 2048, "face_count": 200_000,
              "ao_resolution": 1024, "normal_resolution": 1024},
    "final": {"upsample_resolution": 1536, "texture_size": 4096, "face_count": 700_000,
              "ao_resolution": 1024, "normal_resolution": 2048},
}
QUALITY_LABELS = {"draft": "Draft", "final": "Final"}
# share of a Final run's time, for the estimate until the server has timings of its own
QUALITY_FACTOR = {"draft": 0.45, "final": 1.0}
# Pixal3D wants the subject padded a little (pad_factor 1.1), TRELLIS.2 cropped tight (1.0): the nodes' own advice
PAD = {"pixal3d": 1.1, "trellis2": 1.0}


def has_transparency(path: Path) -> bool:
    try:
        with Image.open(path) as im:
            if "A" not in im.getbands() and "transparency" not in im.info:
                return False
            alpha = im.convert("RGBA").getchannel("A")
            return alpha.getextrema()[0] < 250
    except (OSError, ValueError):
        return False


def inputs_for(rec: dict, seed: int) -> dict:
    """Template inputs for a params["model3d"] record (the comfy driver's half of the job)."""
    engine = rec.get("engine") if rec.get("engine") in ENGINES else DEFAULT_ENGINE
    quality = rec.get("quality") if rec.get("quality") in QUALITY else "final"
    return {**QUALITY[quality], "trellis2": engine == "trellis2", "pad_factor": PAD[engine],
            "remove_background": bool(rec.get("remove_background", True)), "seed": seed}
