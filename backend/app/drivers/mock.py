"""Placeholder driver so the whole review loop works on a laptop with no GPU."""
import random
import subprocess
import textwrap
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app.config import get_settings
from app.drivers.base import DriverResult, ProgressCallback

ASPECTS = {"16:9": (1024, 576), "9:16": (576, 1024), "1:1": (768, 768), "4:3": (1024, 768), "2.39:1": (1224, 512)}


def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # very old Pillow without scalable default font
        return ImageFont.load_default()


def _size(params: dict) -> tuple[int, int]:
    if params.get("width") and params.get("height"):
        return max(64, int(params["width"])), max(64, int(params["height"]))
    # character art is portrait-shaped regardless of the film's aspect ratio
    if params.get("kind") in ("portrait", "sheet_view"):
        return 768, 1024
    return ASPECTS.get(params.get("aspect_ratio", "16:9"), ASPECTS["16:9"])


def render_placeholder(prompt: str, params: dict, seed: int, out_path: Path) -> Path:
    w, h = _size(params)
    rng = random.Random(seed)
    # seed picks the hue so different versions are visibly different at a glance
    # warm sepia range to sit with the parchment UI
    r = rng.randint(60, 110)
    top = (r, int(r * rng.uniform(0.6, 0.75)), int(r * rng.uniform(0.3, 0.45)))
    bottom = (rng.randint(14, 24), rng.randint(9, 16), rng.randint(5, 10))

    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        draw.line([(0, y), (w, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))

    pad = max(16, w // 24)
    body_px = max(12, w // 44)
    small_px = max(10, w // 60)
    title = _font(max(14, w // 28))
    body = _font(body_px)
    small = _font(small_px)

    draw.text((pad, pad), "MOCK · " + str(params.get("kind", "image")).upper(), font=title, fill=(235, 200, 120))
    chars_per_line = max(20, int((w - 2 * pad) / (body_px * 0.55)))
    lines = textwrap.wrap(prompt.strip() or "(empty prompt)", width=chars_per_line)[:10]
    draw.multiline_text((pad, pad * 3), "\n".join(lines), font=body, fill=(240, 230, 214), spacing=6)
    footer = f"v{params.get('version', 1)}  ·  seed {seed}  ·  {w}x{h}"
    draw.text((pad, h - pad - small_px), footer, font=small, fill=(196, 174, 140))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG")
    return out_path


class MockDriver:
    name = "mock"

    def __init__(self, step_seconds: float | None = None, steps: int = 6):
        # None = realistic 0.5–1.0 s per step (3–6 s total); tests pass 0
        self.step_seconds = step_seconds
        self.steps = steps

    def _tick(self, progress_cb: ProgressCallback, label: str, upto: float = 0.9) -> None:
        for i in range(self.steps):
            delay = self.step_seconds if self.step_seconds is not None else random.uniform(0.5, 1.0)
            if delay:
                time.sleep(delay)
            progress_cb(upto * (i + 1) / self.steps, f"{label} {i + 1}/{self.steps}")

    def generate_image(self, prompt, params, seed, out_path: Path, progress_cb) -> DriverResult:
        self._tick(progress_cb, "Sampling")
        render_placeholder(prompt, params, seed, out_path)
        progress_cb(1.0, "Done")
        return DriverResult(out_path, "image/png", {"width": _size(params)[0], "height": _size(params)[1]})

    def generate_video(self, prompt, params, seed, out_path: Path, progress_cb) -> DriverResult:
        self._tick(progress_cb, "Rendering", upto=0.8)
        frame = out_path.with_suffix(".frame.png")
        render_placeholder(prompt, params, seed, frame)
        seconds = float(params.get("duration_s", 2))
        cmd = [get_settings().ffmpeg_path(), "-y", "-loglevel", "error", "-loop", "1", "-i", str(frame)]
        if params.get("kind") == "take_chunk":
            # long-take chunks: exact 8n+1 frame count plus a tone, so the joiner has audio to crossfade
            frames = int(params["num_frames"])
            seconds = frames / 24
            cmd += ["-f", "lavfi", "-t", f"{seconds:.4f}", "-i", f"sine=frequency={220 + seed % 400}:sample_rate=48000",
                    "-frames:v", str(frames), "-c:a", "aac"]
        else:
            cmd += ["-t", f"{seconds:.2f}"]
        cmd += ["-r", "24", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "ultrafast",
                "-pix_fmt", "yuv420p", str(out_path)]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"ffmpeg failed: {e.stderr.decode(errors='replace')[-400:]}") from e
        finally:
            frame.unlink(missing_ok=True)
        progress_cb(1.0, "Done")
        return DriverResult(out_path, "video/mp4", {"duration_s": seconds})

    def generate_text(self, prompt, params, seed, out_path: Path, progress_cb) -> DriverResult:
        self._tick(progress_cb, "Writing")
        text = (
            f"[mock draft · seed {seed}]\n\n"
            f"{prompt.strip()}\n\n"
            "The camera lingers a moment longer than it should. Nobody speaks.\n"
        )
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        progress_cb(1.0, "Done")
        return DriverResult(out_path, "text/plain", {"chars": len(text)})
