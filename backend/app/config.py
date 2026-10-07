"""Settings loaded from the repo-root .env (same file on Windows dev and the Linux box)."""
import shutil
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from typing import Annotated

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: str = "dev"
    app_secret: str = "change-me"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173"]

    admin_email: str = "admin@mixai.local"
    admin_password: str = "change-me"
    dev_login_prefill: bool = True
    admin_name: str = "Admin"

    database_url: str = "sqlite:///./data/mixai.db"
    data_dir: Path = Path("./data")

    gen_driver: str = "mock"

    comfy_urls: Annotated[list[str], NoDecode] = []
    comfy_auth_token: str = ""
    comfy_verify_tls: bool = False
    comfy_lora_dir: str = ""
    comfy_output_dir: str = ""

    llm_base_url: str = "http://127.0.0.1:11434/v1"
    llm_api_key: str = "ollama"
    llm_model_reasoning: str = ""
    llm_model_creative: str = ""
    llm_model_vision: str = ""
    llm_reasoning_format: str = "deepseek"
    # auto: use Ollama's native /api/chat when the server answers /api/version
    # (it honours num_ctx and think=false), else plain OpenAI-compatible calls
    llm_api: str = "auto"
    llm_num_ctx: int = 8192
    llm_timeout_s: float = 600.0

    ffmpeg_bin: str = ""

    # long takes (contract v2)
    longtake_max_s: float = 300.0
    chunk_s: float = 8.0
    chunk_overlap_s: float = 1.0
    chunk_context_frames: int = 9
    longtake_method: str = "extend"  # extend | i2v

    # Quick Create autopilot (contract v4)
    auto_approve_score: float = 6.0
    auto_retries: int = 2
    vision_timeout_s: float = 180.0

    # upscaling (contract v4)
    upscale_segment_s: float = 4.0
    upscale_overlap_s: float = 0.5
    upscale_default_engine: str = "best"  # best | fast | quick
    upscale_seedvr2_model: str = "3b"  # 3b | 7b
    image_upscale_max_mp: float = 8.4  # redraw / faithful image outputs; 3840x2160 is 8.3

    @field_validator("cors_origins", "comfy_urls", mode="before")
    @classmethod
    def _split_csv(cls, v):
        if isinstance(v, str):
            return [p.strip().rstrip("/") for p in v.split(",") if p.strip()]
        return v

    @field_validator("data_dir", mode="after")
    @classmethod
    def _abs_data_dir(cls, v: Path) -> Path:
        return v if v.is_absolute() else (REPO_ROOT / v).resolve()

    @field_validator("database_url", mode="after")
    @classmethod
    def _abs_sqlite(cls, v: str) -> str:
        # sqlite:///./x.db is relative to whatever cwd uvicorn was started from;
        # pin it to the repo root so api, worker and alembic share one file.
        prefix = "sqlite:///"
        if v.startswith(prefix) and not v.startswith("sqlite:////"):
            raw = v[len(prefix):]
            if raw and raw != ":memory:" and not Path(raw).is_absolute():
                return prefix + (REPO_ROOT / raw).resolve().as_posix()
        return v

    @property
    def is_prod(self) -> bool:
        return self.app_env.lower() == "prod"

    def ffmpeg_path(self) -> str:
        if self.ffmpeg_bin:
            return self.ffmpeg_bin
        found = shutil.which("ffmpeg")
        if found:
            return found
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()


@lru_cache
def get_settings() -> Settings:
    return Settings()
