import { LONGTAKE_MAX_S } from './duration'
import { formatEstimate, MODEL_LOAD_S, SECONDS_PER_TAKE_SECOND } from './shots'
import type { StatusView } from './status'
import type {
  Job,
  QuickAspect,
  QuickJobResult,
  QuickRequest,
  QuickStage,
  QuickStageKey,
  QuickStyle,
  UpscaleEngine,
  UpscaleEngineId,
} from './types'

export const QUICK_MIN_S = 5
// contract-v4: up to LONGTAKE_MAX_S × 4 (20 min with the default .env)
export const QUICK_MAX_S = LONGTAKE_MAX_S * 4

export const QUICK_PRESETS = [
  { value: 10, label: '10 s' },
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
]

export const QUICK_ASPECTS: QuickAspect[] = ['16:9', '9:16', '1:1']

export const QUICK_STYLES: { value: QuickStyle; label: string }[] = [
  { value: 'cinematic', label: 'Cinematic' },
  { value: 'documentary', label: 'Documentary' },
  { value: 'animated', label: 'Animated' },
  { value: 'commercial', label: 'Commercial' },
]

export interface QuickForm {
  prompt: string
  durationS: number
  aspect: QuickAspect
  style: QuickStyle
  dialogue: boolean
  upscale: boolean
}

export const DEFAULT_QUICK_FORM: QuickForm = {
  prompt: '',
  durationS: 30,
  aspect: '16:9',
  style: 'cinematic',
  dialogue: true,
  upscale: false,
}

export function quickPayload(f: QuickForm, engine: UpscaleEngineId | undefined): QuickRequest {
  return {
    prompt: f.prompt.trim(),
    duration_s: Math.round(Math.min(QUICK_MAX_S, Math.max(QUICK_MIN_S, f.durationS))),
    aspect_ratio: f.aspect,
    style: f.style,
    dialogue: f.dialogue,
    upscale: f.upscale && engine ? { engine, target: '1080p' } : null,
  }
}

/**
 * Rough whole-pipeline GPU time: the takes dominate, frames and portraits add about a third
 * (retries included), plus model loads and the optional upscale. The progress screen shows the
 * server's own ETA once it has one.
 */
export function quickEstimateS(durationS: number, upscale?: UpscaleEngine) {
  const takes = durationS * SECONDS_PER_TAKE_SECOND
  const images = takes * 0.35
  const up = upscale ? durationS * upscale.est_gpu_s_per_output_s : 0
  return takes + images + MODEL_LOAD_S[1] + up
}

export const quickEstimateText = (durationS: number, upscale?: UpscaleEngine) =>
  `Roughly ${formatEstimate(quickEstimateS(durationS, upscale))} of GPU time`

export const STAGE_DEFS: { key: QuickStageKey; label: string }[] = [
  { key: 'outline', label: 'Writing' },
  { key: 'cast', label: 'Cast' },
  { key: 'storyboard', label: 'Storyboard' },
  { key: 'render', label: 'Rendering' },
  { key: 'stitch', label: 'Stitching' },
  { key: 'upscale', label: 'Upscaling' },
]

export const quickResult = (job: Job | undefined | null): QuickJobResult => (job?.result ?? {}) as QuickJobResult

/** The server's stage list, or a placeholder timeline until the first job event fills it in. */
export function readStages(job: Job | undefined | null): QuickStage[] {
  const stages = quickResult(job).stages
  if (Array.isArray(stages) && stages.length) return stages
  const running = job?.status === 'running'
  return STAGE_DEFS.map((d, i) => ({ ...d, status: running && i === 0 ? 'running' : 'pending' }))
}

export function currentStage(stages: QuickStage[]) {
  return stages.find((s) => s.status === 'running') ?? stages.find((s) => s.status === 'failed') ?? stages.find((s) => s.status === 'pending')
}

export function etaText(etaS: number | null | undefined) {
  if (etaS == null || !Number.isFinite(etaS)) return 'Working out how long this will take…'
  if (etaS < 60) return 'Almost there'
  return `About ${formatEstimate(etaS)} left`
}

const QUICK_TYPE = /autopilot|quick/

export const isQuickJob = (j: Job) => QUICK_TYPE.test(j.type) || Array.isArray(quickResult(j).stages)

/** Newest autopilot job for a project, from whatever job list we have. */
export function quickJobFor(jobs: Job[] | undefined, projectId: string) {
  return (jobs ?? [])
    .filter((j) => j.project_id === projectId && isQuickJob(j))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
}

// The autopilot hands itself back to the queue while its renders run, so "queued"
// after the first stage started still means work is happening.
export const hasStarted = (job: Job | undefined | null) => readStages(job).some((s) => s.status !== 'pending')

export function quickStatus(job: Job | undefined | null): StatusView {
  if (!job) return { label: 'Starting', tone: 'neutral', icon: 'clock' }
  switch (job.status) {
    case 'queued':
      if (hasStarted(job)) return { label: currentStage(readStages(job))?.label ?? 'Working', tone: 'accent', icon: 'spinner' }
      return { label: 'Waiting to start', tone: 'neutral', icon: 'clock' }
    case 'running':
      return { label: currentStage(readStages(job))?.label ?? 'Working', tone: 'accent', icon: 'spinner' }
    case 'done':
      return { label: 'Ready', tone: 'success', icon: 'check' }
    case 'failed':
      return { label: 'Failed', tone: 'danger', icon: 'alert' }
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', icon: 'ban' }
  }
}
