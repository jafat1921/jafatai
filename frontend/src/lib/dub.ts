import type { Job, MediaDetail } from './types'

// contract-v18: Dub a video, and Transcribe

export const DUB_STAGES = ['extract', 'separate', 'transcribe', 'speakers', 'translate', 'cast', 'render', 'fit', 'verify', 'mix'] as const
export type DubStageName = (typeof DUB_STAGES)[number]
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'review'
export type FitMode = 'smart' | 'stretch' | 'strict'
export type DubQuality = 'fast' | 'careful'
export type TargetStatus = 'pending' | 'translated' | 'rendered' | 'fitted' | 'verified' | 'stale' | 'failed' | 'skipped'

export interface DubStage {
  status: StageStatus
  progress: number
  error?: string
  seconds?: number
  model?: string
}

export interface DubSpeaker {
  id: string
  label: string
  voice_id?: string | null
  voice_name?: string | null
  sample_media_id?: string | null
  sample_url?: string | null
  sample_duration_s?: number | null
}

export interface DubVerify {
  wer: number
  overrun_s: number
  flags: ('wer' | 'overrun')[]
  heard?: string
}

export interface DubTarget {
  text?: string
  take_id?: string | null
  take_url?: string | null
  fit?: FitMode
  status?: TargetStatus
  verify?: DubVerify | null
  voice_id?: string | null
  natural_s?: number
  fitted_s?: number
  tempo?: number
  shortened?: boolean
  text_before?: string
  error?: string | null
}

export interface DubWord {
  start: number
  end: number
  w: string
}

export interface DubSegment {
  id: string
  start: number
  end: number
  speaker_id: string | null
  source_text: string
  words?: DubWord[]
  target: Record<string, DubTarget>
}

export interface GlossaryRow {
  source: string
  target: Record<string, string>
  note?: string | null
}

export interface DubSettings {
  quality: DubQuality
  fit: FitMode
  keep_background: boolean
  background_db: number
  voice_match: 'per_speaker'
  speakers: 'auto' | number
}

export interface DubTrack {
  media_id: string
  generation_id: string
  built_at: string
  url?: string | null
}

export interface DubSummary {
  id: string
  video_id: string
  video_generation_id: string
  title: string
  source_language: string | null
  targets: string[]
  stage: DubStageName
  stages: Record<DubStageName, DubStage>
  settings: DubSettings
  tracks: Record<string, DubTrack>
  duration_s: number | null
  video_url: string | null
  job: Job | null
  segment_count: number
  speaker_count: number
  created_at: string
  updated_at: string
}

export interface Dub extends DubSummary {
  speakers: DubSpeaker[]
  segments: DubSegment[]
  glossary: GlossaryRow[]
  stems: { vocals: string | null; instrumental: string | null }
  regen?: { lang: string; segment_ids: string[]; from: string }
}

export interface DubCreate {
  video_id: string
  targets: string[]
  source_language?: string
  speakers?: 'auto' | number
  settings?: Partial<Omit<DubSettings, 'speakers'>>
  title?: string
}

export interface SegmentEdit {
  id: string
  source_text?: string
  speaker_id?: string
  start?: number
  end?: number
  target?: Record<string, { text?: string; fit?: FitMode; voice_id?: string | null }>
}

export interface DubPatch {
  title?: string
  segments?: SegmentEdit[]
  speakers?: { id: string; label?: string; voice_id?: string | null }[]
  glossary?: GlossaryRow[]
  settings?: Partial<Omit<DubSettings, 'speakers'>>
  targets?: string[]
}

export type SubtitleMode = 'none' | 'srt' | 'burn'

export interface DubExportBody {
  langs: string[]
  default_lang: string
  subtitles: SubtitleMode
  include_original: boolean
  stems: boolean
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  clean?: string
  words?: DubWord[]
}

export type TranscriptStatus = 'queued' | 'running' | 'done' | 'failed' | 'cleaning'

export interface Transcript {
  id: string
  media_id: string
  generation_id: string | null
  title: string
  language: string | null
  text: string
  segments: TranscriptSegment[]
  cleanup_text: string | null
  status: TranscriptStatus
  error: string | null
  job_id: string | null
  duration_s: number | null
  words: boolean
  created_at: string
  updated_at: string
  job?: Job | null
  media?: MediaDetail | null
}

export type TranscriptSummary = Omit<Transcript, 'segments' | 'job' | 'media'>

// ---------------------------------------------------------------- the pipeline

export const STAGE_LABEL: Record<DubStageName, string> = {
  extract: 'Extract',
  separate: 'Separate',
  transcribe: 'Transcribe',
  speakers: 'Speakers',
  translate: 'Translate',
  cast: 'Cast',
  render: 'Voice',
  fit: 'Fit',
  verify: 'Verify',
  mix: 'Mix',
}

export const FIT_LABEL: Record<FitMode, string> = { smart: 'Smart fit', stretch: 'Stretch', strict: 'Strict slot' }

// Urdu first: the studio's own films are dubbed into it most
export const SUGGESTED_TARGETS = ['ur', 'en', 'hi', 'pa', 'ar', 'es', 'fr']

const jobBusy = (j: Job | null | undefined) => j?.status === 'queued' || j?.status === 'running'

export const dubBusy = (d: Pick<DubSummary, 'job' | 'stages' | 'stage'> | undefined) =>
  !!d && (jobBusy(d.job) || d.stages?.[d.stage]?.status === 'running')

export function checkpoint(d: Pick<DubSummary, 'stage' | 'stages'>): string | null {
  const st = d.stages?.[d.stage]
  if (st?.status !== 'review') return null
  if (d.stage === 'speakers') return 'Transcript ready — fix any mistakes and speaker labels, then continue.'
  if (d.stage === 'translate') return 'Translation ready — check the lines and the glossary terms, then continue to voicing.'
  return 'Ready for review — continue when it looks right.'
}

export const allDone = (d: Pick<DubSummary, 'stages'>) => DUB_STAGES.every((s) => d.stages?.[s]?.status === 'done')

/** The stage the stepper should point at: the running / failed / review one, or the first not done. */
export function currentStage(d: Pick<DubSummary, 'stage' | 'stages'>): DubStageName {
  const st = d.stages?.[d.stage]?.status
  if (st && st !== 'done') return d.stage
  return DUB_STAGES.find((s) => d.stages?.[s]?.status !== 'done') ?? 'mix'
}

export function failure(d: Pick<DubSummary, 'stages'>): { stage: DubStageName; error: string } | null {
  const s = DUB_STAGES.find((x) => d.stages?.[x]?.status === 'failed')
  return s ? { stage: s, error: d.stages[s].error ?? 'This step failed' } : null
}

// a line whose take doesn't match what it says now: what "Regen N changed" redoes
export const NEEDS_REGEN: TargetStatus[] = ['stale', 'pending', 'failed']

export function changedIds(segments: DubSegment[], lang: string): string[] {
  return segments.filter((s) => NEEDS_REGEN.includes(s.target?.[lang]?.status ?? 'pending')).map((s) => s.id)
}

export function flagged(t: DubTarget | undefined): string[] {
  const out: string[] = []
  for (const f of t?.verify?.flags ?? []) {
    if (f === 'wer') out.push(`Heard differently (WER ${Math.round((t?.verify?.wer ?? 0) * 100)}%)`)
    else out.push(`Runs ${(t?.verify?.overrun_s ?? 0).toFixed(1)} s over`)
  }
  return out
}

export function fitPill(t: DubTarget | undefined): { label: string; tone: 'ok' | 'warn' | 'muted' } {
  const fit = t?.fit ?? 'smart'
  if (t?.tempo && Math.abs(t.tempo - 1) > 0.01) return { label: `${FIT_LABEL[fit]} · ${t.tempo.toFixed(2)}×`, tone: t.tempo > 1.2 ? 'warn' : 'ok' }
  if (t?.verify?.flags?.includes('overrun')) return { label: `${FIT_LABEL[fit]} · over`, tone: 'warn' }
  return { label: FIT_LABEL[fit], tone: 'muted' }
}

export const STATUS_LABEL: Record<TargetStatus, string> = {
  pending: 'To translate',
  translated: 'Translated',
  rendered: 'Voiced',
  fitted: 'Fitted',
  verified: 'Done',
  stale: 'Changed',
  failed: 'Failed',
  skipped: 'Silent',
}

export const segmentAt = <T extends { start: number; end: number }>(rows: T[], t: number) => rows.findIndex((s) => t >= s.start && t < s.end)

export function stamp(t: number) {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`
}

/** Which rows of a fixed-height list are on screen (plus some either side). */
export function windowRange(scrollTop: number, viewport: number, rowH: number, count: number, overscan = 8): [number, number] {
  // jsdom and a hidden panel measure 0; show a screenful anyway
  const visible = viewport > 0 ? Math.ceil(viewport / rowH) : 30
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  return [first, Math.min(count, first + visible + overscan * 2)]
}

// ---------------------------------------------------------------- transcripts

export const transcriptBusy = (t: Pick<Transcript, 'status'> | undefined) => !!t && ['queued', 'running', 'cleaning'].includes(t.status)

export function searchSegments(rows: TranscriptSegment[], q: string, clean = false): number[] {
  const needle = q.trim().toLocaleLowerCase()
  if (!needle) return rows.map((_, i) => i)
  return rows.flatMap((r, i) => (((clean && r.clean) || r.text).toLocaleLowerCase().includes(needle) ? [i] : []))
}

export const subtitlesUrl = (id: string, format: 'srt' | 'vtt', clean = false) => `/api/transcripts/${id}/subtitles?format=${format}${clean ? '&clean=true' : ''}`
