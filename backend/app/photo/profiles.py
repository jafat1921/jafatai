"""Built-in profiles (Lightroom's Profile browser): a base rendering under every other slider.

Each is a set of develop params baked once into a 33-point LUT, so a profile costs one table lookup in
both the render and the WebGL preview, and its Amount (0-200) can push it past how it was made.
"""
import numpy as np

from app.photo import lut as lt

PROFILES: dict[str, dict] = {
    "color": {"label": "Color", "group": "Basic", "params": {}},
    "standard": {"label": "Standard", "group": "Basic", "params": {"contrast": 6, "vibrance": 4}},
    "neutral": {"label": "Neutral", "group": "Basic",
                "params": {"contrast": -25, "highlights": 10, "shadows": 10, "vibrance": -10, "saturation": -5}},
    "landscape": {"label": "Landscape", "group": "Basic",
                  "params": {"contrast": 10, "vibrance": 20, "hsl": {"green": {"s": 10}, "aqua": {"s": 10},
                                                                      "blue": {"s": 15, "l": -5}, "orange": {"s": -5}}}},
    "portrait": {"label": "Portrait", "group": "Basic",
                 "params": {"contrast": -8, "highlights": -5, "vibrance": 5, "temperature": 3,
                            "hsl": {"orange": {"s": -8, "l": 6}, "red": {"s": -5}}}},
    "vivid": {"label": "Vivid", "group": "Basic", "params": {"contrast": 18, "vibrance": 30, "saturation": 10, "blacks": -5}},
    "monochrome": {"label": "Monochrome", "group": "Basic", "params": {"saturation": -100, "contrast": 10}},
    # creative profiles (Lightroom's Artistic / Vintage / Modern sets, our own recipes)
    "artistic-warm": {"label": "Artistic · Warm", "group": "Creative",
                      "params": {"temperature": 12, "contrast": 12, "grading": {"highlights": {"h": 40, "s": 18},
                                                                                 "shadows": {"h": 20, "s": 10}}}},
    "vintage-fade": {"label": "Vintage · Fade", "group": "Creative",
                     "params": {"contrast": -15, "blacks": 25, "saturation": -20,
                                "grading": {"shadows": {"h": 210, "s": 12}, "highlights": {"h": 45, "s": 12}}}},
    "modern-teal": {"label": "Modern · Teal & orange", "group": "Creative",
                    "params": {"contrast": 15, "grading": {"shadows": {"h": 190, "s": 30}, "highlights": {"h": 35, "s": 25}}}},
    "bw-high": {"label": "B&W · High contrast", "group": "Creative", "params": {"saturation": -100, "contrast": 45, "blacks": -15}},
    "bw-soft": {"label": "B&W · Soft", "group": "Creative", "params": {"saturation": -100, "contrast": -15, "shadows": 15}},
}
SIZE = 33
_cache: dict[str, np.ndarray] = {}


def listing() -> list[dict]:
    return [{"id": k, "label": v["label"], "group": v["group"]} for k, v in PROFILES.items()]


def table(profile_id: str) -> np.ndarray | None:
    """size^3 x 3 sRGB table, or None for the neutral Color profile and unknown ids."""
    if profile_id not in PROFILES or not PROFILES[profile_id]["params"]:
        return None
    if profile_id not in _cache:
        _cache[profile_id] = lt.bake({"version": 2, **PROFILES[profile_id]["params"]}, SIZE)
    return _cache[profile_id]
