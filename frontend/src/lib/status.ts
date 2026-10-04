import type { GenerationKind, GenerationStatus, JobStatus, ProjectStatus } from './types'
import { humanize } from './utils'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type StatusIcon = 'clock' | 'spinner' | 'eye' | 'check' | 'x' | 'alert' | 'pencil' | 'film' | 'ban' | 'stale'

export interface StatusView {
  label: string
  tone: Tone
  icon: StatusIcon
}

const pct = (p?: number) => (typeof p === 'number' ? ` ${Math.round(Math.min(1, Math.max(0, p)) * 100)}%` : '')

// Plain language only — raw codes like "frame_generated" never reach the screen (design-system §4).
export function generationStatus(status: GenerationStatus, progress?: number): StatusView {
  switch (status) {
    case 'queued':
      return { label: 'Waiting in queue', tone: 'neutral', icon: 'clock' }
    case 'generating':
      return { label: `Generating${pct(progress)}`, tone: 'accent', icon: 'spinner' }
    case 'ready':
      return { label: 'Ready for review', tone: 'success', icon: 'check' }
    case 'approved':
      return { label: 'Approved', tone: 'success', icon: 'check' }
    case 'rejected':
      return { label: 'Rejected', tone: 'neutral', icon: 'x' }
    case 'failed':
      return { label: 'Failed', tone: 'danger', icon: 'alert' }
  }
}

export function jobStatus(status: JobStatus, progress?: number): StatusView {
  switch (status) {
    case 'queued':
      return { label: 'Waiting', tone: 'neutral', icon: 'clock' }
    case 'running':
      return { label: `Running${pct(progress)}`, tone: 'accent', icon: 'spinner' }
    case 'done':
      return { label: 'Done', tone: 'success', icon: 'check' }
    case 'failed':
      return { label: 'Failed', tone: 'danger', icon: 'alert' }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', icon: 'ban' }
  }
}

export function projectStatus(status: ProjectStatus): StatusView {
  switch (status) {
    case 'draft':
      return { label: 'Draft', tone: 'neutral', icon: 'pencil' }
    case 'in_progress':
      return { label: 'In progress', tone: 'accent', icon: 'clock' }
    case 'rendering':
      return { label: 'Rendering', tone: 'warning', icon: 'film' }
    case 'done':
      return { label: 'Finished', tone: 'success', icon: 'check' }
  }
}

export const staleStatus: StatusView = { label: 'Stale', tone: 'warning', icon: 'stale' }

const KIND_LABELS: Record<GenerationKind, string> = {
  portrait: 'Portrait',
  sheet_view: 'Character sheet view',
  keyframe_start: 'Start frame',
  keyframe_end: 'End frame',
  keyframe_mid: 'Mid frame',
  take: 'Video take',
  tile: 'Long-take tile',
  render: 'Film render',
  scene_text: 'Scene draft',
}

export const kindLabel = (kind: GenerationKind) => KIND_LABELS[kind] ?? humanize(kind)

// Job types are backend-defined strings; known ones get a friendly name, the rest are humanised.
const JOB_LABELS: Record<string, string> = {
  generation: 'Generation',
  generate: 'Generation',
  portrait: 'Portrait',
  generate_portrait: 'Portrait',
  render: 'Render',
  ai_outline: 'AI Director outline',
  ai_write_scene: 'AI scene draft',
  ai_write_missing: 'Write missing scenes',
  ai_continue: 'Continue story',
  ai_assist: 'AI Assist',
  ai_extract_characters: 'Extract characters',
  ai_portrait_prompt: 'Portrait prompt',
  ai_summarize: 'Scene summary',
}

export const jobLabel = (type: string) => JOB_LABELS[type] ?? humanize(type)

export const isActiveJob = (s: JobStatus) => s === 'queued' || s === 'running'
export const isPendingGeneration = (s: GenerationStatus) => s === 'queued' || s === 'generating'
