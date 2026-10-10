"""Dialogue & narration request/response shapes (contract v17). Kept out of app.schemas, which B4 is
also growing, so the two phases don't edit the same block."""
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas import JobOut, LangCode, Utc

LineStatus = Literal["empty", "stale", "rendering", "ready", "failed"]


class CastMember(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=80)
    voice_id: str | None = None
    color: str | None = Field(None, max_length=9)


class LineIn(BaseModel):
    id: str | None = Field(None, max_length=40)
    speaker_id: str = Field("narrator", max_length=40)
    text: str = Field("", max_length=5000)
    voice_id: str | None = None
    speed: float | None = Field(None, ge=0.5, le=2.0)
    emotion: str | None = Field(None, max_length=120)
    pause_after_s: float | None = Field(None, ge=0, le=10)
    # ends a paragraph: the gap after it is settings.paragraph_gap_s unless pause_after_s says otherwise
    para: bool = False


class LineOut(BaseModel):
    id: str
    speaker_id: str
    text: str
    voice_id: str | None = None
    speed: float | None = None
    emotion: str | None = None
    pause_after_s: float | None = None
    para: bool = False
    take_id: str | None = None
    take_media_id: str | None = None
    take_url: str | None = None
    duration_s: float | None = None
    fingerprint: str | None = None
    status: LineStatus = "empty"
    error: str | None = None


class ScriptSettings(BaseModel):
    gap_s: float = Field(0.35, ge=0, le=10)
    paragraph_gap_s: float = Field(0.8, ge=0, le=10)
    loudness: Literal["web", "podcast", "broadcast", "acx", "none"] = "podcast"
    aerab: bool = True


class MixOut(BaseModel):
    media_id: str
    generation_id: str
    url: str | None = None
    duration_s: float | None = None
    built_at: str | None = None
    stale: bool = False


class Counts(BaseModel):
    lines: int = 0
    ready: int = 0
    stale: int = 0
    empty: int = 0
    rendering: int = 0
    failed: int = 0


class ScriptOut(BaseModel):
    id: str
    title: str
    language: str
    engine: str
    project_id: str | None = None
    cast: list[CastMember]
    lines: list[LineOut]
    settings: ScriptSettings
    mix: MixOut | None = None
    mix_job: JobOut | None = None
    stems_job: JobOut | None = None
    counts: Counts
    created_at: Utc
    updated_at: Utc


class ScriptSummary(BaseModel):
    id: str
    title: str
    language: str
    project_id: str | None = None
    counts: Counts
    has_mix: bool = False
    created_at: Utc
    updated_at: Utc


class ScriptIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    language: LangCode = "en"
    engine: str = Field("auto", max_length=20)
    project_id: str | None = None


class ScriptPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    language: LangCode | None = None
    engine: str | None = Field(None, max_length=20)
    cast: list[CastMember] | None = Field(None, max_length=60)
    lines: list[LineIn] | None = Field(None, max_length=3000)
    settings: ScriptSettings | None = None


class SplitIn(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    mode: Literal["sentences", "paragraphs", "lines"] = "sentences"
    speaker_id: str | None = Field(None, max_length=40)


class ImportIn(BaseModel):
    project_id: str
    scene_ids: list[str] | None = None
    include_action: bool = False


class RenderIn(BaseModel):
    line_ids: list[str] | None = None


class RenderOut(BaseModel):
    jobs: list[JobOut]
    queued: int
    failed: int = 0
