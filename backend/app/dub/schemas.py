"""Request bodies for Dub a video and Transcribe (contract v18). Responses are plain dicts built by
app.dub.project.dub_out / app.transcripts.transcript_out: segments are free-form JSON rows."""
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas import JobOut, LangCode

Fit = Literal["smart", "stretch", "strict"]


class DubSettingsIn(BaseModel):
    quality: Literal["fast", "careful"] | None = None
    fit: Fit | None = None
    keep_background: bool | None = None
    background_db: float | None = Field(None, ge=-30, le=12)
    voice_match: Literal["per_speaker"] | None = None


class DubIn(BaseModel):
    video_id: str
    targets: list[LangCode] = Field(min_length=1, max_length=8)
    source_language: str | None = Field(None, max_length=12)
    speakers: Literal["auto"] | int = "auto"
    settings: DubSettingsIn | None = None
    title: str | None = Field(None, max_length=200)

    @field_validator("speakers")
    @classmethod
    def _speakers(cls, v):
        if isinstance(v, int) and not 1 <= v <= 12:
            raise ValueError("speakers is 'auto' or 1 to 12")
        return v


class TargetEdit(BaseModel):
    text: str | None = Field(None, max_length=2000)
    fit: Fit | None = None
    voice_id: str | None = None


class SegmentEdit(BaseModel):
    id: str
    source_text: str | None = Field(None, max_length=2000)
    speaker_id: str | None = None
    start: float | None = Field(None, ge=0)
    end: float | None = Field(None, ge=0)
    target: dict[str, TargetEdit] | None = None


class SpeakerEdit(BaseModel):
    id: str
    label: str | None = Field(None, max_length=80)
    voice_id: str | None = None


class GlossaryRow(BaseModel):
    source: str = Field(min_length=1, max_length=200)
    target: dict[str, str] = {}
    note: str | None = Field(None, max_length=300)


class DubPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    segments: list[SegmentEdit] | None = Field(None, max_length=5000)
    speakers: list[SpeakerEdit] | None = None
    glossary: list[GlossaryRow] | None = Field(None, max_length=500)
    settings: DubSettingsIn | None = None
    targets: list[LangCode] | None = Field(None, min_length=1, max_length=8)


class RegenIn(BaseModel):
    lang: LangCode
    segment_ids: list[str] | None = Field(None, max_length=5000)


class SplitIn(BaseModel):
    segment_id: str
    at: float = Field(ge=0)


class MergeIn(BaseModel):
    segment_ids: list[str] = Field(min_length=2, max_length=50)


class DubExportIn(BaseModel):
    langs: list[LangCode] = Field(min_length=1, max_length=8)
    default_lang: LangCode
    subtitles: Literal["none", "srt", "burn"] = "none"
    include_original: bool = True
    stems: bool = False
    note: str | None = Field(None, max_length=300)


class TranscribeIn(BaseModel):
    media_id: str = Field(description="A Library audio or video item", examples=["3f2a9c1e-0000-4000-8000-000000000000"])
    language: str | None = Field(None, max_length=12, examples=["en"],
                                 description="ISO 639-1 code of the speech; null detects it")
    words: bool = Field(True, description="Keep word-level timings (karaoke subtitles, precise cuts)")
    cleanup: bool = Field(False, description="Queue an LLM pass afterwards that fixes punctuation and fillers")


class TranscribeQueued(BaseModel):
    transcript_id: str = Field(description="GET /api/transcripts/{transcript_id} once the job is done")
    job: JobOut


class DubOut(BaseModel):
    """The main fields of a dub project; the review data (speakers, segments, tracks) rides along as is."""
    model_config = ConfigDict(extra="allow")

    id: str
    title: str
    video_id: str
    source_language: str | None = None
    targets: list[str]
    stage: str = Field(description="The pipeline stage it's at: extract, separate, transcribe, speakers, translate, "
                                   "cast, render, fit, verify, mix")
    stages: dict[str, Any]
    job: JobOut | None = Field(None, description="The job working on the current stage")


class TranscriptVideoIn(BaseModel):
    mode: Literal["soft", "burn"] = "soft"
    clean: bool = False
