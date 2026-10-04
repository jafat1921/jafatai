// Mirrors docs/api/contract-v0.md. Keep snake_case so payloads pass through untouched.

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

export type AuthoringMode = 'ai_director' | 'scene_by_scene' | 'import'
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
  created_at: string
  updated_at: string
}

export type ScenePatch = Partial<
  Pick<
    Scene,
    'heading' | 'logline' | 'script_text' | 'summary' | 'time_of_day' | 'mood' | 'lighting' | 'locked' | 'location_id'
  >
>

export type TargetType = 'character' | 'scene' | 'shot' | 'location' | 'project'
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
  | 'scene_text'
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
  created_at: string
  updated_at: string
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
  >
>

export interface StoryboardRequest {
  mode: 'scene' | 'shots'
  scene_ids?: string[]
  generate_frames: boolean
  overwrite: boolean
  continuity?: 'chain'
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
