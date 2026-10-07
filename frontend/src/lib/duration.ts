import type { Shot, ShotEstimate } from './types'
import { formatEstimate, MODEL_LOAD_S, SECONDS_PER_TAKE_SECOND } from './shots'
import { plural } from './utils'

// contract-v2 defaults; the server may run with other .env values
export const LONGTAKE_MAX_S = 300
export const CHUNK_MAX_S = 10
const CHUNK_S = 8
const CHUNK_OVERLAP_S = 1

export const DURATION_PRESETS: { value: number; label: string }[] = [
  { value: 10, label: '10 s' },
  { value: 20, label: '20 s' },
  { value: 30, label: '30 s' },
  { value: 60, label: '60 s' },
  { value: 90, label: '90 s' },
  { value: 120, label: '2 min' },
]

const NUM = String.raw`(\d+(?:\.\d+)?)`
const MIN_SEC = new RegExp(String.raw`^(?:${NUM}\s*m(?:in(?:ute)?s?)?)?\s*(?:${NUM}\s*(?:s(?:ec(?:ond)?s?)?)?)?$`)

/**
 * Reads what people actually type into a duration box: "75", "75s", "1:15", "2m", "2 min", "1m 30s".
 * Returns whole seconds, or null when it can't make sense of it. Range checks are separate.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase()
  if (!s) return null
  const colon = s.match(/^(\d+):([0-5]?\d)$/)
  if (colon) return Number(colon[1]) * 60 + Number(colon[2])
  const m = s.match(MIN_SEC)
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  const total = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)
  return Number.isFinite(total) ? Math.round(total) : null
}

export function durationError(seconds: number | null, max = LONGTAKE_MAX_S, min = 1, per = ' per take'): string | null {
  if (seconds === null) return 'Use seconds (75), minutes (2m) or m:ss (1:15).'
  if (seconds < min) return min === 1 ? 'At least 1 second.' : `At least ${formatDuration(min)}.`
  if (seconds > max) return `Up to ${formatDuration(max)}${per}.`
  return null
}

export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s ? `${m} min ${s} s` : `${m} min`
}

/** mm:ss, or h:mm:ss past the hour — the reel header and clip lengths. */
export function formatTimecode(seconds: number) {
  const t = Math.max(0, Math.round(seconds))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`
}

export const isLongTakeDuration = (seconds: number) => seconds > CHUNK_MAX_S
export const isLongTake = (shot: Pick<Shot, 'duration_s' | 'shot_type'>, seconds = shot.duration_s) =>
  shot.shot_type === 'long_take' || isLongTakeDuration(seconds)

// Mirrors the server's chunking well enough to show something while /estimate loads (or on an older server).
export function localEstimate(seconds: number): ShotEstimate {
  const chunks = seconds <= CHUNK_MAX_S ? 1 : Math.ceil((seconds - CHUNK_OVERLAP_S) / (CHUNK_S - CHUNK_OVERLAP_S))
  const gpu = seconds * SECONDS_PER_TAKE_SECOND
  return { chunks, frames_total: seconds * 24 + 1, est_gpu_s: gpu, est_wall_s: gpu + MODEL_LOAD_S[0] }
}

export function estimateText(est: Pick<ShotEstimate, 'chunks' | 'est_gpu_s'>, count = 1) {
  const time = `about ${formatEstimate(est.est_gpu_s * count)} on the GPU`
  if (count > 1) return `${count} takes × ${plural(est.chunks, 'chunk')} · ${time}`
  return `${plural(est.chunks, 'chunk')} · ${time}`
}
