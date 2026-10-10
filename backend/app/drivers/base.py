from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

# progress_cb(fraction 0..1, message). It may raise to abort (cancel / shutdown),
# so drivers should call it between steps and not swallow what it throws.
ProgressCallback = Callable[[float, str], None]


@dataclass
class DriverResult:
    path: Path
    media_type: str
    meta: dict[str, Any] = field(default_factory=dict)
    # merged into generation.params by the worker (template, resolved inputs, ...)
    params_update: dict[str, Any] = field(default_factory=dict)


class GenerationDriver(Protocol):
    name: str

    def generate_image(
        self, prompt: str, params: dict, seed: int, out_path: Path, progress_cb: ProgressCallback
    ) -> DriverResult: ...

    def generate_video(
        self, prompt: str, params: dict, seed: int, out_path: Path, progress_cb: ProgressCallback
    ) -> DriverResult: ...

    def generate_audio(
        self, prompt: str, params: dict, seed: int, out_path: Path, progress_cb: ProgressCallback
    ) -> DriverResult: ...

    def generate_text(
        self, prompt: str, params: dict, seed: int, out_path: Path, progress_cb: ProgressCallback
    ) -> DriverResult: ...
