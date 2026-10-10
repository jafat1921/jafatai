// Mirrors docs/api/contract-v0.md. Keep snake_case so payloads pass through untouched.
import type { BrandPlacement } from './brand'
import type { CameraSetting } from './camera'

export type Role = 'owner' | 'editor' | 'viewer'

export interface User {
  id: string
  email: string
  display_name: string
  workspace_id: string
  role: Role
}

export interface SystemStatus {
  comfy: {
    ok: boolean
    url: string
    version?: string
    devices?: { name: string; vram_total: number; vram_free: number }[]
    error?: string
  }
  llm: { ok: boolean; url: string; models?: string[]; error?: string }
  driver: 'mock' | 'comfy'
  worker: { alive: boolean; last_heartbeat?: string }
}

export type AuthoringMode = 'ai_director' | 'scene_by_scene' | 'import' | 'quick'
export type Quality = 'draft' | 'final'
export type ProjectStatus = 'draft' | 'in_progress' | 'rendering' | 'done'
export type AspectRatio = '16:9' | '9:16' | '1:1' | '2.39:1'

export interface Project {
  id: string
  title: string
  logline: string
  authoring_mode: AuthoringMode
  aspect_ratio: string
  target_runtime_s: number
  quality: Quality
  takes_per_shot: number
  overnight: boolean
  status: ProjectStatus
  created_at: string
  updated_at: string
  thumbnail_url?: string | null
  counts: { scenes: number; shots: number; characters: number }
  // contract-v6; older servers don't send it
  settings?: ProjectSettings
}

// PATCH merges these into project.settings; null removes a key
export interface ProjectSettings {
  image_model?: string | null
  image_speed?: string | null
  edit_model?: string | null
  video_quality?: 'standard' | 'hq' | null
  smooth_motion?: boolean | null
  [key: string]: unknown
}

export interface ProjectCreate {
  title: string
  authoring_mode: AuthoringMode
  logline?: string
  aspect_ratio?: string
  target_runtime_s?: number
  quality?: Quality
  takes_per_shot?: number
  overnight?: boolean
  brief?: string
}

export type Source = 'user' | 'ai' | 'ai_edited'
export type TimeOfDay = 'dawn' | 'morning' | 'day' | 'golden_hour' | 'dusk' | 'night' | 'interior'

export interface Scene {
  id: string
  project_id: string
  order: number
  heading: string
  logline: string
  script_text: string
  summary: string
  time_of_day: TimeOfDay | null
  mood: string | null
  lighting: string | null
  source: Source
  locked: boolean
  version: number
  stale: boolean
  location_id?: string | null
  // P3 review gate: 'pending' while the planned shot list waits for approval; older servers omit it
  shots_review?: 'pending' | null
  created_at: string
  updated_at: string
}

export type ScenePatch = Partial<
  Pick<
    Scene,
    'heading' | 'logline' | 'script_text' | 'summary' | 'time_of_day' | 'mood' | 'lighting' | 'locked' | 'location_id'
  >
>

export type TargetType = 'character' | 'scene' | 'shot' | 'location' | 'project' | 'media'
export type GenerationKind =
  | 'portrait'
  | 'sheet_view'
  | 'establishing'
  | 'keyframe_start'
  | 'keyframe_end'
  | 'keyframe_mid'
  | 'take'
  | 'tile'
  | 'render'
  | 'mezzanine'
  | 'scene_text'
  // contract-v5: standalone media (Image studio results, uploads)
  | 'image'
  | 'video'
  | 'upload'
  // contract-v14: Audio Studio
  | 'song'
  | 'music'
  | 'sfx'
export type GenerationStatus = 'queued' | 'generating' | 'ready' | 'approved' | 'rejected' | 'failed'

export interface Generation {
  id: string
  target_type: TargetType
  target_id: string
  kind: GenerationKind
  version: number
  status: GenerationStatus
  prompt: string
  params: Record<string, unknown>
  seed: number | null
  media_url?: string | null
  media_type?: string | null
  score?: number | Record<string, number> | null
  note?: string | null
  created_at: string
  approved_at?: string | null
  parent_id?: string | null
  job_id?: string | null
  // small webp preview for grids (P5); older servers leave it out
  thumb_url?: string | null
}

export interface Character {
  id: string
  project_id: string
  name: string
  description: string
  source: Source
  locked: boolean
  approved_portrait?: Generation | null
}

// contract-v1-storyboard.md
export interface Location {
  id: string
  project_id: string
  name: string
  description: string
  source: Source
  locked: boolean
  time_of_day_variants: string[]
  approved_establishing?: Generation | null
  created_at: string
  updated_at: string
}

export type ShotType =
  | 'wide'
  | 'medium'
  | 'close_up'
  | 'extreme_close_up'
  | 'over_shoulder'
  | 'pov'
  | 'insert'
  | 'establishing'
  | 'long_take'
export type SeamMode = 'cut' | 'continue'
export type PromptMode = 'auto' | 'manual'
export type ShotStatus = 'draft' | 'frames_ready' | 'rendering' | 'take_ready' | 'approved'

export interface Shot {
  id: string
  scene_id: string
  project_id: string
  order: number
  shot_type: ShotType
  duration_s: number
  description: string
  camera: string
  prompt: string
  prompt_mode: PromptMode
  start_prompt?: string | null
  end_prompt?: string | null
  motion_prompt?: string | null
  character_ids: string[]
  location_id?: string | null
  seam_in: SeamMode
  handoff_text: string
  status: ShotStatus
  stale: boolean
  source: Source
  locked: boolean
  start_frame?: Generation | null
  end_frame?: Generation | null
  start_linked?: boolean
  approved_take?: Generation | null
  takes_count: number
  // contract-v2: per-chunk action prompts for long takes; older servers omit it
  beats?: Beat[]
  // contract-v7: where the brand kit's logo/products appear; older servers omit them
  brand_placements?: BrandPlacement[]
  brand_placements_locked?: boolean
  closing?: string | null
  brand_closing?: string | null
  // P3: generations in flight, and kinds whose newest try failed; older servers omit it
  activity?: ShotActivity[]
  // P2 camera rack on a shot (migration 0007); `camera` holds the same in plain words
  camera_rack?: CameraSetting

  created_at: string
  updated_at: string
}

export interface ShotActivity {
  id: string
  kind: GenerationKind
  status: 'queued' | 'generating' | 'failed'
  job_id?: string | null
  version: number
}

export type ShotPatch = Partial<
  Pick<
    Shot,
    | 'shot_type'
    | 'duration_s'
    | 'description'
    | 'camera'
    | 'prompt'
    | 'prompt_mode'
    | 'start_prompt'
    | 'end_prompt'
    | 'motion_prompt'
    | 'character_ids'
    | 'location_id'
    | 'seam_in'
    | 'handoff_text'
    | 'beats'
    | 'brand_placements'
    | 'camera_rack'
  >
>

export interface StoryboardRequest {
  mode: 'scene' | 'shots'
  scene_ids?: string[]
  generate_frames: boolean
  overwrite: boolean
  continuity?: 'chain'
  // P3: plan the shot list, hold the frames until it's approved
  review_first?: boolean
}

// UI polish P3 (contract-v8-polish.md)
export interface ShotExtendResult {
  shot: Shot
  job: Job
}

export interface ShotRerenderResult {
  jobs: Job[]
  linked_next_shot_id?: string | null
}

export interface ShotsApproveResult {
  scene: Scene
  jobs: Job[]
}

export interface QuickStageThumb {
  id: string
  kind: GenerationKind
  url: string | null
  video: boolean
}

export interface QuickStageMedia {
  outline?: { text?: string }
  cast?: QuickStageThumb[]
  storyboard?: QuickStageThumb[]
  render?: QuickStageThumb[]
  stitch?: QuickStageThumb[]
}

export type RegenerateMode = 'same' | 'note' | 'edit'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  type: string
  status: JobStatus
  progress: number
  message: string
  project_id?: string | null
  generation_id?: string | null
  gpu?: string | null
  // which GPU worker runs it when the server splits image and video work
  lane?: 'image' | 'video' | 'audio' | 'general'
  attempts: number
  error?: string | null
  created_at: string
  started_at?: string | null
  finished_at?: string | null
  gpu_seconds?: number | null
  result?: (AiJobResult & Record<string, unknown>) | null
}

// AI writing (contract-v0 "AI" section)
export type AssistAction = 'draft_from_idea' | 'expand' | 'tighten' | 'rewrite_tone' | 'write_dialogue' | 'suggest_logline'
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected'

export interface Suggestion {
  id: string
  project_id: string
  target_type: 'scene' | 'character'
  target_id: string
  field: string
  current_text: string
  proposed_text: string
  action: string
  status: SuggestionStatus
  job_id?: string | null
  created_at: string
  resolved_at?: string | null
}

export interface SuggestionResult {
  suggestion: Suggestion
  scene?: Scene | null
  character?: Character | null
}

export interface AiJobResult {
  thinking?: string
  prompt?: string
  outcome?: 'written' | 'suggested' | 'unchanged'
  scene_ids?: string[]
  drafted_ids?: string[]
  character_ids?: string[]
  suggestion_ids?: string[]
  calls?: { role: string; model: string; seconds: number; step?: string }[]
}

// contract-v2-longtake.md
export interface Beat {
  t_start: number
  t_end: number
  prompt: string
  source: Source
  locked: boolean
  // the server sets this when the duration changed under an unlocked beat
  stale?: boolean
}

export interface ShotEstimate {
  chunks: number
  frames_total: number
  est_gpu_s: number
  est_wall_s: number
  // not in the contract yet; read it when the server sends it
  max_s?: number
}

export type ChunkStatus = 'queued' | 'generating' | 'done' | 'failed'

export interface TakeChunk {
  idx: number
  t_start: number
  t_end: number
  frames: number
  status: ChunkStatus
  file?: string | null
  seed?: number | null
  gpu_seconds?: number | null
  progress?: number | null
}

// contract-v3-reel.md
export type TransitionKind = 'cut' | 'dissolve' | 'fade_black'
export type MezzanineStatus = 'fresh' | 'stale' | 'missing' | 'building'

export interface ReelClip {
  id: string
  shot_id: string
  scene_id: string
  order: number
  generation_id: string
  media_url: string
  thumb_url?: string | null
  source_duration_s: number
  trim_in_s: number
  trim_out_s: number
  duration_s: number
  transition_in: TransitionKind
  transition_s: number
  enabled: boolean
  changed: boolean
}

export type ReelClipPatch = Partial<Pick<ReelClip, 'trim_in_s' | 'trim_out_s' | 'transition_in' | 'transition_s' | 'enabled'>>

export interface ReelScene {
  scene_id: string
  heading: string
  order: number
  duration_s: number
  mezzanine: { status: MezzanineStatus; generation_id?: string | null }
  clips: ReelClip[]
}

export interface Reel {
  id: string
  project_id: string
  duration_s: number
  scenes: ReelScene[]
  missing: { shot_id: string; scene_id: string; reason: string }[]
  last_render?: Generation | null
}

export interface ReelEstimate {
  clips: number
  duration_s: number
  stale_scenes: number
  est_seconds: number
}

// Range stitching (contract-v3 "Range stitching & Output"). SSE generation events omit the
// top-level extras, so read them through renderInfo() which falls back to params.
export interface Render extends Generation {
  title?: string
  scene_range?: string
  scene_ids?: string[]
  full?: boolean
  duration_s?: number | null
  clips?: number | null
  approved?: boolean
}

export interface StitchRequest {
  quality: 'draft'
  scene_ids?: string[]
  title?: string
}

// contract-v4-upscale-quick.md
export type UpscaleEngineId = 'best' | 'fast' | 'quick'
export type UpscaleTarget = '1080p' | '1440p' | '4k'

export interface UpscaleEngine {
  id: UpscaleEngineId
  label: string
  available: boolean
  reason?: string | null
  scales: number[]
  est_gpu_s_per_output_s: number
}

export interface UpscaleOptions {
  engines: UpscaleEngine[]
  default_engine: UpscaleEngineId
  // the server sends {id, label, width, height}; older builds sent bare ids
  targets: (UpscaleTarget | { id: UpscaleTarget; label?: string })[]
}

export interface UpscaleRequest {
  engine: UpscaleEngineId
  target: UpscaleTarget
}

// image upscaling (contract v4, "Image upscaling")
export type ImageUpscaleEngineId = 'redraw' | 'quick' | 'anime' | 'best'
export type ImageUpscaleTarget = '2x' | '4x' | '2k' | '4k'

export interface ImageUpscaleEngine {
  id: ImageUpscaleEngineId
  label: string
  description?: string
  available: boolean
  reason?: string | null
  max_long_side: number
  multiple?: number
  max_mp?: number | null
  denoise?: { min: number; max: number; default: number }
  variants?: ('3b' | '7b')[]
  default_variant?: '3b' | '7b'
}

export type ImageUpscaleEstimate =
  | { allowed: true; width: number; height: number; capped?: boolean; est_gpu_s: number }
  | { allowed: false; reason: string }

export interface ImageUpscaleOptions {
  media: 'image'
  engines: ImageUpscaleEngine[]
  default_engine: ImageUpscaleEngineId
  targets: { id: ImageUpscaleTarget; label: string }[]
  source: { width: number; height: number; prompt?: string }
  estimates: Partial<Record<ImageUpscaleEngineId, Partial<Record<ImageUpscaleTarget, ImageUpscaleEstimate>>>>
}

export interface ImageUpscaleRequest {
  engine: ImageUpscaleEngineId
  target: ImageUpscaleTarget
  variant?: '3b' | '7b'
  denoise?: number
}

export type SegmentStatus = 'queued' | 'generating' | 'done' | 'failed'

export interface UpscaleSegment {
  idx: number
  t_start: number
  t_end: number
  status: SegmentStatus
  file?: string | null
}

export type QuickStyle = 'cinematic' | 'documentary' | 'animated' | 'commercial'
export type QuickAspect = '16:9' | '9:16' | '1:1'

export interface QuickRequest extends MagicFields {
  prompt: string
  duration_s: number
  aspect_ratio: QuickAspect
  style: QuickStyle
  dialogue: boolean
  upscale: UpscaleRequest | null
  // contract-v6, omitted for the server default
  image_model?: string
  video_quality?: 'standard' | 'hq'
  brand_kit_id?: string
}

export type QuickStageKey = 'outline' | 'cast' | 'storyboard' | 'render' | 'stitch' | 'upscale'
export type QuickStageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface QuickStage {
  key: QuickStageKey
  label: string
  status: QuickStageStatus
  started_at?: string | null
  finished_at?: string | null
  detail?: string | null
}

export interface QuickJobResult {
  stages?: QuickStage[]
  preview_ids?: string[]
  final_render_id?: string | null
  eta_s?: number | null
  // P3: [low, high] seconds left, and per-stage thumbnail strips; older servers omit both
  eta_range_s?: [number, number] | null
  stage_media?: QuickStageMedia
}

export interface QuickRecent {
  project: Project
  job: Job
  final_render?: Generation | null
}

// contract-v5-nav-image.md
export type MediaKind = 'image' | 'video' | 'audio'
// what has pixels: upscaling, compare, looks
export type VisualKind = Exclude<MediaKind, 'audio'>
export type MediaOrigin = 'generated' | 'upload' | 'project'

export interface MediaItem {
  id: string
  workspace_id: string
  kind: MediaKind
  origin: MediaOrigin
  title: string
  tags: string[]
  project_id?: string | null
  generation_id: string
  width?: number | null
  height?: number | null
  duration_s?: number | null
  media_url?: string | null
  thumb_url?: string | null
  created_at: string
  updated_at: string
  versions_count: number
  // not in the contract; read when the server sends it, otherwise derived from the generation
  status?: GenerationStatus
  prompt?: string
  seed?: number | null
  // newer servers echo the generation params (model, model_resolved, brand_kit_id…) on the item
  params?: Record<string, unknown> | null
  model?: string | null
  // contract v8 P4; older servers leave them out
  folder_id?: string | null
  favourite?: boolean
  // P5: the current version is an upscale ("4K", "2×"…), and the version it all started from
  upscale?: { target: string; label: string; engine?: string | null } | null
  original_generation_id?: string | null
  // photo catalogue (contract v11); older servers leave them out
  rating?: number
  flag?: '' | 'pick' | 'reject'
  label?: '' | 'red' | 'yellow' | 'green' | 'blue' | 'purple'
  caption?: string
  captured_at?: string | null
  camera?: string | null
  lens?: string | null
  focal_mm?: number | null
  aperture?: number | null
  shutter_s?: number | null
  iso?: number | null
  original_name?: string | null
  bytes?: number | null
  source_type?: string | null
  edited?: boolean
  album_ids?: string[]
  duplicate?: boolean
}

export interface MediaDetail extends MediaItem {
  versions: Generation[]
}

export interface MediaPage {
  items: MediaItem[]
  next_cursor?: string | null
}

export interface MediaQuery {
  kind?: MediaKind
  origin?: MediaOrigin
  q?: string
  tag?: string
  project_id?: string
  include?: 'project'
  folder_id?: string
  favourite?: 1
  limit?: number
  cursor?: string
}

// contract v8 P4: library organisation
export type FolderKind = 'any' | MediaKind

export interface Folder {
  id: string
  name: string
  parent_id: string | null
  kind: FolderKind
  sort: number
  item_count: number
  created_at: string
  updated_at: string
}

export interface SavedFilter {
  id: string
  name: string
  query: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type BatchAction = 'delete' | 'download' | 'upscale' | 'move' | 'tag'

export interface BatchResult {
  action: BatchAction
  done: string[]
  skipped: { ref: string; reason: string }[]
  jobs: Job[]
}

export type ImageAspect = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '2:3' | '3:2'

// magic prompt (contract-v8 draft): omitted means "auto"
export type MagicMode = 'auto' | 'on' | 'off'

export interface MagicFields {
  magic_prompt?: MagicMode
  // the prompt is an enhancement the user already reviewed; don't enhance it again
  prompt_enhanced?: boolean
}

export interface PromptEnhanceRequest {
  prompt: string
  kind: 'image' | 'video' | 'quick'
  model?: string
  style?: string
  brand_kit_id?: string
  mode: MagicMode
}

export interface PromptEnhanceResult {
  enhanced: string
  changed: boolean
  notes?: string | null
}

export interface EstimateQuery {
  kind: 'image' | 'video' | 'take' | 'upscale' | 'audio'
  model?: string
  speed?: string
  count?: number
  duration_s?: number
  width?: number
  height?: number
}

export interface EstimateResult {
  low_s: number
  high_s: number
  basis: 'measured' | 'rough'
  samples?: number
  // a model load, already included in both ends
  load_s?: number
}

export interface ImageGenerateRequest extends MagicFields {
  // P4 "Generate into…"
  folder_id?: string
  prompt: string
  negative?: string
  aspect: ImageAspect
  count: number
  style?: string
  seed?: number
  steps?: number
  template_id?: string
  model?: string
  speed?: string
  brand_kit_id?: string
}

export interface ImageEditRequest extends MagicFields {
  // P4 "Generate into…"
  folder_id?: string
  source_ids: string[]
  instruction: string
  aspect?: ImageAspect
  count?: number
  seed?: number
  model?: string
  brand_kit_id?: string
}

export type Img2ImgAspect = 'source' | ImageAspect

export interface Img2ImgRequest extends MagicFields {
  // P4 "Generate into…"
  folder_id?: string
  source_id: string
  prompt: string
  strength: number
  count: number
  aspect: Img2ImgAspect
  model?: string
  speed?: string
  seed?: number
  brand_kit_id?: string
}

export interface MediaBatch {
  items: MediaItem[]
  jobs: Job[]
  // contract v14: what "auto" turned into
  model_resolved?: string | null
}

export type TemplateType = 'video' | 'image' | 'audio'

export interface Template {
  id: string
  type: TemplateType
  title: string
  description: string
  thumb?: string | null
  defaults: Record<string, unknown>
  // prompt templates (v2 catalogue); older servers leave these out
  category?: string | null
  tags?: string[]
  examples?: Record<string, string>
  preview_url?: string | null
  requires_brand?: boolean
}

export interface TemplateStart {
  target: 'quick' | 'studio' | 'image' | 'audio'
  prefill: Record<string, unknown>
}

export interface Dashboard {
  recent_projects: Project[]
  recent_videos: MediaItem[]
  recent_images: MediaItem[]
  running_jobs: Job[]
  quick_recent: QuickRecent[]
}

export interface TemplateCheck {
  ok: boolean
  missing_nodes: string[]
  missing_models: string[]
  invalid: string[]
  warnings: string[]
}

export interface ComfyCheck {
  ok: boolean
  url: string
  error?: string
  templates: Record<string, TemplateCheck>
}

export interface LlmRole {
  model: string | null
  present: boolean
  latency_ms?: number
  error?: string
}

export interface LlmCheck {
  ok: boolean
  url: string
  reasoning_format?: string
  roles: Partial<Record<'reasoning' | 'creative' | 'vision', LlmRole>>
  error?: string
}

// contract-v6-models.md
export type ModelType = 'image' | 'edit' | 'video' | 'upscale' | 'audio'
export type ModelBadgeId = 'FAST' | 'BEST' | 'TEXT' | 'NEW' | 'HQ' | 'QUICK' | 'UPSCALE'
export type ModelCapability =
  | 't2i' | 'edit' | 'refs' | 't2v' | 'i2v' | 'flf' | 'audio' | 'longtake' | 'text_render' | 'multi_angle' | 'i2i'
  // contract v14 (audio models)
  | 'song' | 'music' | 'sfx' | 'lyrics' | 'vocals' | 'instrumental' | 'timbre_ref' | 'long'

export interface ModelSpeed {
  id: string
  label: string
  steps: number
  note?: string | null
  available?: boolean
  reason?: string | null
}

export interface ModelInfo {
  id: string
  type: ModelType
  label: string
  badge: ModelBadgeId | null
  description: string
  capabilities: ModelCapability[]
  speeds?: ModelSpeed[]
  default_speed?: string
  max_refs?: number
  max_duration_s?: number
  est_seconds?: number
  estimate_source?: 'measured' | 'rough'
  available: boolean
  reason?: string | null
  default: boolean
  // LTX only: the temporal x2 upscaler, single-pass clips only
  smooth_motion?: { available: boolean; reason?: string | null }
  // audio models: the licence line, and MiniMax's non-commercial flag
  extra?: { licence?: string; noncommercial?: boolean } & Record<string, unknown>
}

export type VideoAspect = '16:9' | '9:16' | '1:1'

export interface VideoGenerateRequest extends MagicFields {
  // P4 "Generate into…"
  folder_id?: string
  prompt: string
  model: string
  duration_s: number
  // Image to Video leaves it out so the clip keeps the picture's shape
  aspect?: VideoAspect
  image_id?: string
  end_image_id?: string
  seed?: number
  smooth_motion?: boolean
  brand_kit_id?: string
  // contract v8 P2: ids from lib/camera.ts
  camera?: { size?: string; angle?: string; motion?: string; speed?: string }
}

// contract-v14: Audio Studio
export type AudioKind = 'song' | 'music' | 'sfx'
export type AudioVocal = 'male' | 'female' | 'duet' | 'none'
export type AudioCategory = 'music' | 'instrument' | 'loop' | 'sfx' | 'oneshot'

export interface AudioGenerateRequest {
  folder_id?: string
  kind: AudioKind
  prompt: string
  lyrics?: string
  language?: string
  vocal?: AudioVocal
  bpm?: number
  category?: AudioCategory
  duration_s: number
  model?: string
  count?: number
  seed?: number
  steps?: number
  timbre_ref_id?: string
  title?: string
}

export interface LyricsRequest {
  topic: string
  language: string
  mood?: string
  style?: string
  sections?: string[]
}

export interface LyricsResponse {
  lyrics: string
  tags?: string | string[] | null
}

// quality and smooth motion come from project.settings; the server drops them for long takes
export interface TakesRequest {
  count?: number
  duration_s?: number
}

/** GET /api/upscales (P5): one upscale result with the version it was made from. */
export interface UpscaleRow {
  result: Generation
  source?: Generation | null
  title: string
  kind: VisualKind
  media_id?: string | null
  project_id?: string | null
  engine?: string | null
  target?: string | null
  label?: string | null
  width?: number | null
  height?: number | null
  status: GenerationStatus
  job?: Job | null
  error?: string | null
}

export interface UpscalePage {
  items: UpscaleRow[]
  next_cursor?: string | null
}
