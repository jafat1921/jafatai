"""Request/response shapes. Kept in one file while the surface is small."""
import re
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, PlainSerializer


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


Utc = Annotated[datetime, PlainSerializer(_iso, return_type=str)]

AuthoringMode = Literal["ai_director", "scene_by_scene", "import"]
Quality = Literal["draft", "final"]
ProjectStatus = Literal["draft", "in_progress", "rendering", "done"]
TimeOfDay = Literal["dawn", "morning", "day", "golden_hour", "dusk", "night", "interior"]
TargetType = Literal["character", "scene", "shot", "location", "project"]
GenKind = Literal[
    "portrait", "sheet_view", "keyframe_start", "keyframe_end", "keyframe_mid",
    "take", "tile", "render", "scene_text",
]


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# auth
class LoginIn(BaseModel):
    email: str
    password: str


class UserOut(Out):
    id: str
    email: str
    display_name: str
    workspace_id: str
    role: str


# projects
class Counts(BaseModel):
    scenes: int = 0
    shots: int = 0
    characters: int = 0


class ProjectOut(Out):
    id: str
    title: str
    logline: str
    authoring_mode: str
    aspect_ratio: str
    target_runtime_s: int
    quality: str
    takes_per_shot: int
    overnight: bool
    status: str
    created_at: Utc
    updated_at: Utc
    thumbnail_url: str | None = None
    counts: Counts = Counts()


class ProjectCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    authoring_mode: AuthoringMode
    logline: str = ""
    aspect_ratio: str = "16:9"
    target_runtime_s: int = Field(120, ge=1)
    quality: Quality = "draft"
    takes_per_shot: int = Field(3, ge=1, le=16)
    overnight: bool = False
    brief: str | None = None


class ProjectPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    authoring_mode: AuthoringMode | None = None
    logline: str | None = None
    aspect_ratio: str | None = None
    target_runtime_s: int | None = Field(None, ge=1)
    quality: Quality | None = None
    takes_per_shot: int | None = Field(None, ge=1, le=16)
    overnight: bool | None = None
    status: ProjectStatus | None = None
    brief: str | None = None


# scenes
class SceneOut(Out):
    id: str
    project_id: str
    order: int
    heading: str
    logline: str
    script_text: str
    summary: str
    time_of_day: str | None
    mood: str
    lighting: str
    source: str
    locked: bool
    version: int
    stale: bool
    created_at: Utc
    updated_at: Utc


def flush_left(text: str) -> str:
    # Scripts are stored flush-left; pasted screenplays come with centred cues/indented dialogue.
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(re.sub(r"^\s+|\s+$", "", line) for line in lines)


ScriptText = Annotated[str, AfterValidator(flush_left)]


class SceneCreate(BaseModel):
    heading: str = ""
    logline: str = ""
    script_text: ScriptText = ""
    after_scene_id: str | None = None


class ScenePatch(BaseModel):
    heading: str | None = None
    logline: str | None = None
    script_text: ScriptText | None = None
    summary: str | None = None
    time_of_day: TimeOfDay | None = None
    mood: str | None = None
    lighting: str | None = None
    locked: bool | None = None
    stale: bool | None = None


class ReorderIn(BaseModel):
    scene_ids: list[str]


# generations
class GenerationOut(Out):
    id: str
    target_type: str
    target_id: str
    kind: str
    version: int
    status: str
    prompt: str
    params: dict[str, Any]
    seed: int
    media_url: str | None = None
    media_type: str | None = None
    score: dict[str, Any] | None = None
    note: str | None = None
    created_at: Utc
    approved_at: Utc | None = None
    parent_id: str | None = None
    job_id: str | None = None


class GenerationCreate(BaseModel):
    target_type: TargetType
    target_id: str
    kind: GenKind
    prompt: str = Field(min_length=1)
    params: dict[str, Any] = {}


class RegenerateIn(BaseModel):
    mode: Literal["same", "note", "edit"] = "same"
    note: str | None = None
    prompt: str | None = None
    params: dict[str, Any] | None = None


class RejectIn(BaseModel):
    reason: str | None = None


# characters
class CharacterOut(Out):
    id: str
    project_id: str
    name: str
    description: str
    source: str
    locked: bool
    approved_portrait: GenerationOut | None = None


class CharacterCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


class CharacterPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = None
    locked: bool | None = None


# jobs
class JobOut(Out):
    id: str
    type: str
    status: str
    progress: float
    message: str
    project_id: str | None = None
    generation_id: str | None = None
    gpu: str | None = None
    attempts: int
    error: str | None = None
    created_at: Utc
    started_at: Utc | None = None
    finished_at: Utc | None = None
    gpu_seconds: float | None = None
    # AI jobs put their output here (thinking, prompts, touched ids); generate jobs their file info
    result: dict[str, Any] | None = None


# AI
AssistAction = Literal["draft_from_idea", "expand", "tighten", "rewrite_tone", "write_dialogue", "suggest_logline"]


class AssistIn(BaseModel):
    action: AssistAction
    idea: str | None = Field(None, max_length=2000)
    tone: str | None = Field(None, max_length=100)


class WriteMissingIn(BaseModel):
    scene_ids: list[str] | None = None
    # with no empty scenes to fill, insert this many new ones after `after_scene_id`
    after_scene_id: str | None = None
    count: int = Field(1, ge=1, le=10)


class ContinueIn(BaseModel):
    count: int = Field(1, ge=1, le=10)


class SuggestionOut(Out):
    id: str
    project_id: str
    target_type: str
    target_id: str
    field: str
    current_text: str
    proposed_text: str
    action: str
    status: str
    job_id: str | None = None
    created_at: Utc
    resolved_at: Utc | None = None


class SuggestionResult(BaseModel):
    suggestion: SuggestionOut
    scene: SceneOut | None = None
    character: CharacterOut | None = None
