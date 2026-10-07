"""Automatic review for the autopilot: the vision model scores images, ffmpeg checks takes."""
import base64
import io
import logging
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image
from pydantic import BaseModel, Field, field_validator

from app.config import get_settings
from app.llm import LLMError, chat_sync

log = logging.getLogger("mixai.vision")

MAX_SIDE = 1024
DURATION_TOLERANCE = 0.10
MAX_BLACK_RATIO = 0.5


class VisionUnavailable(RuntimeError):
    pass


class VisionScore(BaseModel):
    score: float = Field(ge=0, le=10)
    issues: list[str] = []

    @field_validator("score", mode="before")
    @classmethod
    def _clamp(cls, v):
        # small models answer 10.5 or "7/10" now and then
        if isinstance(v, str):
            m = re.search(r"\d+(\.\d+)?", v)
            v = float(m.group()) if m else 0
        return max(0.0, min(10.0, float(v)))


def image_b64(path: Path, max_side: int = MAX_SIDE) -> str:
    """JPEG, downscaled: frames are ~1 MP PNGs and the vision model doesn't need more."""
    with Image.open(path) as im:
        im = im.convert("RGB")
        im.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode("ascii")


SYSTEM = (
    "You are a strict script supervisor checking AI-generated film frames before they are used. "
    "Answer only with JSON."
)


def score_messages(image: Path, description: str, reference: Path | None = None) -> list[dict]:
    text = (
        f"Intended content of the image:\n{description.strip()[:2500]}\n\n"
        "Score from 0 to 10 how well the FIRST image matches that description: the right subject, people, "
        "setting, framing and mood, and no glaring generation faults (extra limbs, melted faces, garbled text, "
        "duplicated people). 8-10 = usable as is, 6-7 = minor deviations, below 6 = wrong or broken."
    )
    images = [image_b64(image)]
    if reference is not None and reference.exists():
        images.append(image_b64(reference))
        text += ("\nThe SECOND image is the approved reference portrait of the character in this shot: take points off "
                 "if the person in the first image clearly isn't the same person (face, hair, wardrobe).")
    text += '\n\nReply as JSON {"score": <0-10>, "issues": ["short phrase", ...]} with an empty list when nothing is wrong.'
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text, "images": images}]


def score_image(image: Path, description: str, reference: Path | None = None, *, tick=None) -> tuple[VisionScore, dict]:
    """Returns the score and the call info. Raises VisionUnavailable when the model can't be used;
    whatever `tick` raises (cancel, shutdown) passes straight through."""
    try:
        msgs = score_messages(image, description, reference)
    except OSError as e:
        raise VisionUnavailable(f"couldn't read the image: {e}") from e
    try:
        res = chat_sync("vision", msgs, schema=VisionScore, temperature=0.1, max_tokens=400,
                        timeout=get_settings().vision_timeout_s, tick=tick)
    except LLMError as e:
        raise VisionUnavailable(str(e)) from e
    return res.data, res.call_info("vision")


# ---------------------------------------------------------------- takes

@dataclass
class TakeCheck:
    ok: bool
    issues: list[str] = field(default_factory=list)
    duration_s: float = 0.0
    black_ratio: float = 0.0
    has_audio: bool = False

    def as_score(self) -> dict:
        return {"check": "passed" if self.ok else "failed", "issues": self.issues, "duration_s": self.duration_s,
                "black_ratio": round(self.black_ratio, 3), "has_audio": self.has_audio}


_BLACK = re.compile(r"black_duration:\s*(\d+(?:\.\d+)?)")


def black_seconds(path: Path) -> float:
    ff = get_settings().ffmpeg_path()
    r = subprocess.run([ff, "-hide_banner", "-nostdin", "-i", str(path), "-an", "-vf",
                        "blackdetect=d=0.1:pix_th=0.10", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    return sum(float(x) for x in _BLACK.findall(r.stderr))


def check_take(path: Path, expected_s: float) -> TakeCheck:
    from app.reel import probe  # reel pulls in the storyboard stack

    if not path.exists():
        return TakeCheck(False, ["the video file is missing"])
    p = probe(path)
    issues = []
    if not p.has_video or p.duration <= 0:
        return TakeCheck(False, ["no readable video stream"])
    if expected_s > 0 and abs(p.duration - expected_s) > expected_s * DURATION_TOLERANCE:
        issues.append(f"runs {p.duration:.1f} s instead of {expected_s:.1f} s")
    black = black_seconds(path) / p.duration
    if black > MAX_BLACK_RATIO:
        issues.append(f"mostly black ({black:.0%} of the take)")
    if not p.has_audio:
        issues.append("no audio stream")
    return TakeCheck(not issues, issues, round(p.duration, 3), black, p.has_audio)
