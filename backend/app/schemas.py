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
    "take", "tile", "render", "scene_text", "establishing",
]
ShotType = Literal[
    "wide", "medium", "close_up", "extreme_close_up", "over_shoulder", "pov", "insert", "establishing", "long_take",
]
Seam = Literal["cut", "continue"]
PromptMode = Literal["auto", "manual"]


def _take_length(v: float | None) -> float | None:
    from app.config import get_settings

    top = get_settings().longtake_max_s
    if v is not None and not 1 <= v <= top:
        raise ValueError(f"must be between 1 and {top:g} seconds")
    return v


# 1..LONGTAKE_MAX_S (a setting, so it can't be a static Field bound)
TakeSeconds = Annotated[float, AfterValidator(_take_length)]


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
    style_bible: str = ""
    settings: dict[str, Any] = {}
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
    style_bible: str = ""
    settings: dict[str, Any] | None = None


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
    style_bible: str | None = None
    # merged into project.settings; a key set to null is removed
    settings: dict[str, Any] | None = None


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
    location_id: str | None = None
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
    location_id: str | None = None


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
    # shots fill an empty prompt from start/end/motion prompts; other targets still need one
    prompt: str = ""
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


# locations
class LocationOut(Out):
    id: str
    project_id: str
    name: str
    description: str
    source: str
    locked: bool
    time_of_day_variants: list[str] = []
    approved_establishing: GenerationOut | None = None
    created_at: Utc
    updated_at: Utc


class LocationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    time_of_day_variants: list[str] = []


class LocationPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = None
    time_of_day_variants: list[str] | None = None
    locked: bool | None = None


# shots
class ShotOut(Out):
    id: str
    scene_id: str
    project_id: str
    order: int
    shot_type: str
    duration_s: float
    description: str
    camera: str
    prompt: str
    prompt_mode: str
    start_prompt: str
    end_prompt: str
    motion_prompt: str
    character_ids: list[str] = []
    location_id: str | None = None
    seam_in: str
    handoff_text: str
    status: str = "draft"
    stale: bool
    source: str
    locked: bool
    start_frame: GenerationOut | None = None
    start_linked: bool = False
    end_frame: GenerationOut | None = None
    approved_take: GenerationOut | None = None
    takes_count: int = 0
    beats: list[dict[str, Any]] = []
    brand_placements: list[dict[str, Any]] = []
    # set on the advert's closing shot: "ai_packshot" or "logo_reveal" (exact clip, no keyframes);
    # `closing` is the same value under the name the UI reads
    brand_closing: str | None = None
    closing: str | None = None
    brand_placements_locked: bool = False
    created_at: Utc
    updated_at: Utc


class Beat(BaseModel):
    t_start: float = Field(ge=0)
    t_end: float = Field(ge=0)
    prompt: str = Field(max_length=4000)
    source: Literal["ai", "user", "ai_edited"] = "user"
    locked: bool = False


class ShotCreate(BaseModel):
    shot_type: ShotType | None = None
    duration_s: TakeSeconds = 4.0
    description: str = ""
    camera: str = ""
    character_ids: list[str] | None = None
    location_id: str | None = None
    seam_in: Seam = "cut"
    after_shot_id: str | None = None


class ShotPatch(BaseModel):
    shot_type: ShotType | None = None
    duration_s: TakeSeconds | None = None
    beats: list[Beat] | None = None
    description: str | None = None
    camera: str | None = Field(None, max_length=300)
    prompt: str | None = None
    prompt_mode: PromptMode | None = None
    start_prompt: ScriptText | None = None
    end_prompt: ScriptText | None = None
    motion_prompt: ScriptText | None = None
    character_ids: list[str] | None = None
    location_id: str | None = None
    seam_in: Seam | None = None
    handoff_text: str | None = None
    locked: bool | None = None
    stale: bool | None = None
    # contract v7: where the brand kit's logo/products appear in this shot
    brand_placements: list["BrandPlacement"] | None = Field(None, max_length=12)


class BrandPlacement(BaseModel):
    # extra keys the UI sends along are kept as they are
    model_config = ConfigDict(extra="allow")

    asset_id: str
    asset_type: Literal["logo", "product"]
    surface: str = Field("", max_length=200)
    prominence: Literal["hero", "background"] = "background"
    # "user" placements are locked: AI re-plans only suggest changes to them
    source: Literal["ai", "user"] = "user"


ShotPatch.model_rebuild()


class ShotReorderIn(BaseModel):
    shot_ids: list[str]


class TakesIn(BaseModel):
    count: int | None = Field(None, ge=1, le=16)
    duration_s: TakeSeconds | None = None
    # contract v6; unset = the project's settings (Standard, no smoothing)
    quality: Literal["standard", "hq"] | None = None
    smooth_motion: bool | None = None


class ChunkRegenerateIn(BaseModel):
    prompt: str | None = Field(None, max_length=4000)
    seed: int | None = Field(None, ge=0)


class TakeEstimate(BaseModel):
    chunks: int
    frames_total: int
    duration_s: float
    long_take: bool
    method: str
    est_gpu_s: int
    est_wall_s: int
    rate_gpu_s_per_output_s: float


class SuggestShotsIn(BaseModel):
    max_shots: int = Field(6, ge=1, le=20)


class StoryboardIn(BaseModel):
    mode: Literal["scene", "shots"] = "scene"
    scene_ids: list[str] | None = None
    generate_frames: bool = True
    overwrite: bool = False
    continuity: bool | Literal["chain", "none"] = False
    max_shots: int = Field(6, ge=1, le=20)


class SuggestionResult(BaseModel):
    suggestion: SuggestionOut
    scene: SceneOut | None = None
    character: CharacterOut | None = None
    location: LocationOut | None = None
    shot: ShotOut | None = None


# reel (contract v3)
Transition = Literal["cut", "dissolve", "fade_black"]


class ReelClipOut(BaseModel):
    id: str
    shot_id: str
    scene_id: str
    order: int
    generation_id: str | None
    media_url: str | None = None
    thumb_url: str | None = None
    source_duration_s: float
    trim_in_s: float
    trim_out_s: float
    duration_s: float
    transition_in: str
    transition_s: float
    enabled: bool
    changed: bool


class MezzanineOut(BaseModel):
    status: Literal["fresh", "stale", "missing", "building"]
    generation_id: str | None = None


class ReelSceneOut(BaseModel):
    scene_id: str
    heading: str
    order: int
    duration_s: float
    mezzanine: MezzanineOut
    clips: list[ReelClipOut] = []


class ReelMissingOut(BaseModel):
    shot_id: str
    scene_id: str
    reason: str


class ReelOut(BaseModel):
    id: str
    project_id: str
    duration_s: float
    scenes: list[ReelSceneOut] = []
    missing: list[ReelMissingOut] = []
    last_render: GenerationOut | None = None


class ReelClipPatch(BaseModel):
    trim_in_s: float | None = Field(None, ge=0)
    trim_out_s: float | None = Field(None, ge=0)
    transition_in: Transition | None = None
    transition_s: float | None = Field(None, ge=0, le=10)
    enabled: bool | None = None


class ReelReorderIn(BaseModel):
    clip_ids: list[str]


class AssembleIn(BaseModel):
    quality: Literal["draft"] = "draft"
    # stitch only these scenes (always in film order); empty/None = the whole film
    scene_ids: list[str] | None = None
    title: str | None = Field(None, max_length=200)


class RenderOut(GenerationOut):
    title: str = "Full film"
    scene_range: str = ""
    scene_ids: list[str] = []
    full: bool = True
    duration_s: float | None = None
    clips: int | None = None
    approved: bool = False


class GenerationPatch(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class ReelEstimateOut(BaseModel):
    clips: int
    duration_s: float
    stale_scenes: int
    est_seconds: float


# Upscale (contract v4)
class UpscaleIn(BaseModel):
    # videos: best|fast|quick (None = UPSCALE_DEFAULT_ENGINE); images: redraw|quick|best (None = redraw).
    # Engine names (seedvr2, flashvsr, esrgan, zimage) are accepted as aliases.
    engine: Literal["best", "fast", "quick", "redraw", "faithful", "seedvr2", "flashvsr", "esrgan", "zimage"] | None = None
    # videos take 1080p|1440p|4k (default 1080p), images 2x|4x|2k|4k (default 2x)
    target: Literal["1080p", "1440p", "4k", "2x", "4x", "2k"] | None = None
    # SeedVR2 size, engine "best" only; None = UPSCALE_SEEDVR2_MODEL
    variant: Literal["3b", "7b"] | None = None
    # image "redraw" only: how much Z-Image may repaint (detail strength)
    denoise: float | None = Field(None, ge=0.15, le=0.5)
    # image "redraw" only: overrides the source's own prompt
    prompt: str | None = Field(None, max_length=4000)


# Media library, Image studio, Templates, Dashboard (contract v5)
ImageAspect = Literal["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"]


class MediaItemOut(BaseModel):
    id: str
    workspace_id: str
    kind: str
    origin: str
    title: str
    tags: list[str] = []
    project_id: str | None = None
    project_title: str | None = None
    generation_id: str | None = None
    # the current version's status: queued/generating while a fresh item is still being made
    status: str | None = None
    media_type: str | None = None
    width: int | None = None
    height: int | None = None
    duration_s: float | None = None
    media_url: str | None = None
    thumb_url: str | None = None
    created_at: Utc
    updated_at: Utc
    versions_count: int = 1


class MediaDetailOut(MediaItemOut):
    versions: list[GenerationOut] = []


class MediaPage(BaseModel):
    items: list[MediaItemOut]
    next_cursor: str | None = None


class MediaPatch(BaseModel):
    title: str | None = Field(None, max_length=300)
    tags: list[str] | None = Field(None, max_length=30)


MagicMode = Literal["auto", "on", "off"]


class ImageGenerateIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    negative: str | None = Field(None, max_length=2000)
    aspect: ImageAspect = "1:1"
    count: int = Field(1, ge=1, le=4)
    style: str | None = None
    seed: int | None = Field(None, ge=0, le=2**31 - 1)
    steps: int | None = Field(None, ge=1, le=60)
    template_id: str | None = None
    title: str | None = Field(None, max_length=300)
    model: str | None = Field(None, max_length=60)  # catalog id (contract v6); default Z-Image Turbo
    speed: str | None = Field(None, max_length=30)
    brand_kit_id: str | None = None  # contract v7: palette/look in the prompt, brand pass on the result
    magic_prompt: MagicMode | None = None  # None: settings.magic_prompt_default
    prompt_enhanced: bool = False  # the dock already ran /prompts/enhance; don't do it again


class ImageEditIn(BaseModel):
    # the catalog's max_refs is checked in the route, so the message names the model
    source_ids: list[str] = Field(min_length=1, max_length=8)
    instruction: str = Field(min_length=1, max_length=4000)
    aspect: ImageAspect | None = None
    count: int = Field(1, ge=1, le=4)
    seed: int | None = Field(None, ge=0, le=2**31 - 1)
    title: str | None = Field(None, max_length=300)
    model: str | None = Field(None, max_length=60)
    brand_kit_id: str | None = None  # contract v7: also adds product refs while there's room


VideoAspect = Literal["16:9", "9:16", "1:1", "4:3", "2.39:1"]


class VideoGenerateIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    model: str | None = Field(None, max_length=60)
    duration_s: float = Field(5.0, ge=1)
    aspect: VideoAspect | None = None  # None: the start image's shape (nearest supported), else 16:9
    image_id: str | None = None
    end_image_id: str | None = None  # first+last frame (LTX "flf"); needs image_id
    seed: int | None = Field(None, ge=0, le=2**31 - 1)
    smooth_motion: bool = False
    negative: str | None = Field(None, max_length=2000)
    title: str | None = Field(None, max_length=300)
    brand_kit_id: str | None = None  # contract v7
    magic_prompt: MagicMode | None = None
    prompt_enhanced: bool = False
    quality: Literal["standard", "hq"] | None = None  # only read with model "auto"


class Img2ImgIn(BaseModel):
    source_id: str  # a Library item (uploads too) or a finished image generation id
    prompt: str = Field(min_length=1, max_length=4000)
    strength: float = Field(0.45, ge=0.1, le=0.9)
    model: str | None = Field(None, max_length=60)
    speed: str | None = Field(None, max_length=30)
    count: int = Field(1, ge=1, le=4)
    aspect: Literal["source", "1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"] = "source"
    seed: int | None = Field(None, ge=0, le=2**31 - 1)
    negative: str | None = Field(None, max_length=2000)
    title: str | None = Field(None, max_length=300)
    brand_kit_id: str | None = None
    magic_prompt: MagicMode | None = None
    prompt_enhanced: bool = False


class VideoGenerateOut(MediaItemOut):
    job: JobOut | None = None
    model_resolved: str | None = None
    magic_prompt: dict | None = None


class ImageBatchOut(BaseModel):
    items: list[MediaItemOut]
    jobs: list[JobOut]
    model_resolved: str | None = None  # what "auto" (or the default) turned into
    magic_prompt: dict | None = None


class TemplateOut(BaseModel):
    id: str
    type: Literal["video", "image"]
    title: str
    description: str
    thumb: str | None = None
    defaults: dict[str, Any]
    requires_brand: bool = False  # advert templates: the UI asks for a brand kit


class TemplateStartOut(BaseModel):
    target: Literal["quick", "studio", "image"]
    prefill: dict[str, Any]


class DashboardOut(BaseModel):
    recent_projects: list[ProjectOut]
    recent_videos: list[MediaItemOut]
    recent_images: list[MediaItemOut]
    running_jobs: list[JobOut]
    quick_recent: list[dict[str, Any]]
