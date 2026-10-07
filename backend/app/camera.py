"""Camera rack (polish P2): film vocabulary for shot size, angle and move, written into the motion prompt.

The phrases are what LTX-2.3 and Wan 2.2 follow best in our tests: short, plain cinematography terms
("slow push-in", "static locked-off shot") rather than long descriptions of the rig.
Storyboard shots (P3) call to_prompt() too, so keep the wording stable.
"""
from typing import Literal

from pydantic import BaseModel

# id -> (chip label, short label for the summary, one-line description, prompt phrase)
SHOT_SIZES: dict[str, tuple[str, str, str, str]] = {
    "ecu": ("Extreme close-up", "ECU", "Eyes, lips or a detail fill the frame.", "extreme close-up"),
    "cu": ("Close-up", "CU", "The face fills the frame.", "close-up"),
    "mcu": ("Medium close-up", "MCU", "Head and shoulders.", "medium close-up"),
    "ms": ("Medium shot", "MS", "From the waist up.", "medium shot"),
    "mls": ("Medium long shot", "MLS", "From the knees up.", "medium long shot"),
    "ls": ("Wide", "Wide", "The whole body with room around it.", "wide shot"),
    "ews": ("Extreme wide", "EWS", "A tiny figure in a big landscape.", "extreme wide shot"),
}

ANGLES: dict[str, tuple[str, str, str, str]] = {
    "eye": ("Eye level", "Eye", "Level with the subject's eyes; neutral.", "eye-level angle"),
    "low": ("Low angle", "Low", "Looking up; the subject feels powerful.", "low-angle shot looking up"),
    "high": ("High angle", "High", "Looking down; the subject feels small.", "high-angle shot looking down"),
    "overhead": ("Overhead", "Overhead", "Straight down from above, bird's-eye view.", "overhead bird's-eye view"),
    "dutch": ("Dutch", "Dutch", "A tilted horizon; unease.", "dutch angle with a tilted horizon"),
    "pov": ("Point of view", "POV", "Through the character's eyes.", "point-of-view shot"),
    "ots": ("Over the shoulder", "OTS", "Past one person's shoulder at another.", "over-the-shoulder shot"),
}

# moves that take a speed word are written "{speed} {phrase}"
MOTIONS: dict[str, tuple[str, str, str, str]] = {
    "static": ("Static", "Static", "The camera doesn't move.", "static locked-off shot"),
    "push_in": ("Push in", "Push-in", "Moves closer to the subject.", "push-in"),
    "pull_out": ("Pull out", "Pull-out", "Moves away and reveals more.", "pull-out"),
    "pan_left": ("Pan left", "Pan L", "Turns to the left on the spot.", "pan to the left"),
    "pan_right": ("Pan right", "Pan R", "Turns to the right on the spot.", "pan to the right"),
    "tilt_up": ("Tilt up", "Tilt up", "Tips upward on the spot.", "tilt up"),
    "tilt_down": ("Tilt down", "Tilt down", "Tips downward on the spot.", "tilt down"),
    "orbit_left": ("Orbit left", "Orbit L", "Circles the subject to the left.", "orbit around the subject to the left"),
    "orbit_right": ("Orbit right", "Orbit R", "Circles the subject to the right.", "orbit around the subject to the right"),
    "handheld": ("Handheld", "Handheld", "Follows by hand with a little shake.", "handheld"),
    "crane_up": ("Crane up", "Crane up", "Rises up and over the scene.", "crane up"),
    "crane_down": ("Crane down", "Crane down", "Descends into the scene.", "crane down"),
    "dolly_left": ("Track left", "Track L", "Slides sideways to the left.", "dolly tracking left"),
    "dolly_right": ("Track right", "Track R", "Slides sideways to the right.", "dolly tracking right"),
    "zoom_in": ("Zoom in", "Zoom in", "The lens zooms; the camera stays put.", "zoom in"),
    "zoom_out": ("Zoom out", "Zoom out", "The lens zooms out; the camera stays put.", "zoom out"),
}

SPEEDS: dict[str, tuple[str, str, str, str]] = {
    "slow": ("Slow", "slow", "Calm, barely noticeable.", "slow"),
    "medium": ("Medium", "medium", "A steady, natural pace.", "steady"),
    "fast": ("Fast", "fast", "Energetic and quick.", "fast"),
}

# handheld reads better as a shake strength than "slow handheld"
HANDHELD = {"slow": "handheld, subtle shake", "medium": "handheld, natural shake", "fast": "handheld, energetic shake"}

# loose spellings from shot.camera text or older clients
ALIASES = {
    "wide": "ls", "long": "ls", "ws": "ls", "extreme_wide": "ews", "close_up": "cu", "closeup": "cu",
    "medium": "ms", "eye_level": "eye", "birds_eye": "overhead", "bird's-eye": "overhead", "top_down": "overhead",
    "over_the_shoulder": "ots", "push": "push_in", "dolly_in": "push_in", "dolly_out": "pull_out",
    "track_left": "dolly_left", "track_right": "dolly_right",
}

ShotSize = Literal["ecu", "cu", "mcu", "ms", "mls", "ls", "ews"]
Angle = Literal["eye", "low", "high", "overhead", "dutch", "pov", "ots"]
Motion = Literal["static", "push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "orbit_left",
                 "orbit_right", "handheld", "crane_up", "crane_down", "dolly_left", "dolly_right", "zoom_in", "zoom_out"]
Speed = Literal["slow", "medium", "fast"]


class Camera(BaseModel):
    size: ShotSize | None = None
    angle: Angle | None = None
    motion: Motion | None = None
    speed: Speed | None = None

    def is_empty(self) -> bool:
        return not (self.size or self.angle or self.motion)


def _key(v: str | None, aliases: bool = True) -> str | None:
    if not v:
        return None
    k = str(v).strip().lower().replace("-", "_").replace(" ", "_")
    return ALIASES.get(k, k) if aliases else k


def motion_phrase(motion: str | None, speed: str | None = None) -> str:
    m = _key(motion)
    if m not in MOTIONS:
        return ""
    sp = _key(speed, False)
    sp = sp if sp in SPEEDS else "slow"
    if m == "static":
        return MOTIONS[m][3]
    if m == "handheld":
        return HANDHELD[sp]
    return f"{SPEEDS[sp][3]} {MOTIONS[m][3]}"


def to_prompt(camera: "Camera | dict | None") -> str:
    """{"size": "ms", "angle": "low", "motion": "push_in", "speed": "slow"} ->
    "Medium shot, low-angle shot looking up, slow push-in." Unknown ids are skipped; nothing set -> "".
    No speed means slow: calm moves survive both models far better than fast ones."""
    if camera is None:
        return ""
    c = camera.model_dump() if isinstance(camera, BaseModel) else dict(camera)
    parts = []
    size, angle = _key(c.get("size")), _key(c.get("angle"))
    if size in SHOT_SIZES:
        parts.append(SHOT_SIZES[size][3])
    # eye level is the default framing; saying it only adds noise
    if angle in ANGLES and angle != "eye":
        parts.append(ANGLES[angle][3])
    move = motion_phrase(c.get("motion"), c.get("speed"))
    if move:
        parts.append(move)
    if not parts:
        return ""
    text = ", ".join(parts)
    return text[0].upper() + text[1:] + "."


def compose(prompt: str, camera: "Camera | dict | None") -> str:
    """The motion prompt with the camera sentence after it (brand text goes after this)."""
    cam = to_prompt(camera)
    if not cam:
        return prompt
    return f"{prompt.strip().rstrip('.')}. {cam}"


def summary(camera: "Camera | dict | None") -> str:
    """'MS · Low · Push-in slow', the chip text."""
    if camera is None:
        return ""
    c = camera.model_dump() if isinstance(camera, BaseModel) else dict(camera)
    bits = [SHOT_SIZES[k][1] for k in [_key(c.get("size"))] if k in SHOT_SIZES]
    bits += [ANGLES[k][1] for k in [_key(c.get("angle"))] if k in ANGLES]
    m = _key(c.get("motion"))
    if m in MOTIONS:
        sp = _key(c.get("speed"), False)
        bits.append(MOTIONS[m][1] + (f" {SPEEDS[sp][1]}" if sp in SPEEDS and m != "static" else ""))
    return " · ".join(bits)


def presets() -> dict:
    def rows(table):
        return [{"id": k, "label": v[0], "short": v[1], "description": v[2], "phrase": v[3]} for k, v in table.items()]

    return {"shot_size": rows(SHOT_SIZES), "angle": rows(ANGLES), "motion": rows(MOTIONS), "speed": rows(SPEEDS),
            "default_speed": "slow"}
