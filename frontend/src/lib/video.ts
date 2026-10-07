import type { MentionOptions } from '@/components/mentions/MentionTextarea'
import { cameraPayload, type CameraSetting } from './camera'
import { CHUNK_MAX_S, isLongTakeDuration, LONGTAKE_MAX_S } from './duration'
import { has } from './models'
import type { Job, MediaBatch, MediaItem, ModelInfo, VideoAspect, VideoGenerateRequest } from './types'

export const VIDEO_ASPECTS: VideoAspect[] = ['16:9', '9:16', '1:1']

// TODO: let a mention compose the start frame on the edit model first, so faces match without a picture
export const VIDEO_MENTIONS: MentionOptions = {
  refBudget: 0,
  namesOnlyNote: 'Video models take no reference pictures, so each mention adds its name and a short description. For a face that must match, start from a picture of them.',
}

const PRESETS = [
  { value: 5, label: '5 s' },
  { value: 10, label: '10 s' },
  { value: 20, label: '20 s' },
  { value: 30, label: '30 s' },
  { value: 60, label: '1 min' },
]

export interface VideoForm {
  prompt: string
  model?: string
  durationS: number
  aspect: VideoAspect
  imageId: string | null
  // needs a start image and a first+last frame model
  endImageId?: string | null
  smooth: boolean
  seed: string
  camera?: CameraSetting
}

export const DEFAULT_VIDEO_FORM: VideoForm = { prompt: '', durationS: 5, aspect: '16:9', imageId: null, endImageId: null, smooth: false, seed: '', camera: {} }

// whole seconds; the server reports caps like 10.67 (256 frames at 24 fps)
export const maxDuration = (m: ModelInfo | undefined) => Math.max(1, Math.floor(m?.max_duration_s ?? LONGTAKE_MAX_S))

/** Presets that fit the model; when the cap isn't a preset, it's offered as the last one. */
export function durationPresets(m: ModelInfo | undefined) {
  const max = maxDuration(m)
  const fit = PRESETS.filter((p) => p.value <= max)
  return fit.some((p) => p.value === max) || max > PRESETS[PRESETS.length - 1].value ? fit : [...fit, { value: max, label: `${max} s` }]
}

export const clampDuration = (s: number, m: ModelInfo | undefined) => Math.min(maxDuration(m), Math.max(1, Math.round(s)))

/** Smooth motion runs on single-pass clips only; null when it can be used. */
export function smoothBlockedReason(m: ModelInfo | undefined, durationS: number): string | null {
  if (!m?.smooth_motion) return 'Not offered for this model.'
  if (!m.smooth_motion.available) return m.smooth_motion.reason || 'Not available on this server yet.'
  if (isLongTakeDuration(durationS)) return `Works on clips up to ${CHUNK_MAX_S} s. Shorten the clip to use it.`
  return null
}

/** Why this model can't make the clip as set up, in words a person can act on; null when it can. */
export function videoBlockedReason(m: ModelInfo, hasImage: boolean, hasEnd = false): string | null {
  if (hasImage && !has(m, 'i2v')) return `${m.label} works from text only. Remove the start image to use it.`
  if (hasEnd && !has(m, 'flf')) return `${m.label} can't land on an end image. Remove the end image to use it.`
  return null
}

/** Image to Video: the start picture is required, so text-only models are out; an end picture needs first+last frame. */
export function i2vBlockedReason(m: ModelInfo, hasEnd: boolean): string | null {
  if (!has(m, 'i2v')) return `${m.label} works from text only, so it can't animate a picture. Use Create Video for text clips.`
  if (hasEnd && !has(m, 'flf')) return `${m.label} can't land on an end image. Remove the end image to use it.`
  return null
}

export interface I2vForm {
  startId: string | null
  endId: string | null
  prompt: string
  model?: string
  durationS: number
  smooth: boolean
  seed: string
  camera?: CameraSetting
}

export const DEFAULT_I2V_FORM: I2vForm = { startId: null, endId: null, prompt: '', durationS: 5, smooth: false, seed: '', camera: {} }

export function i2vPayload(f: I2vForm & { startId: string }, m: ModelInfo, brandKitId?: string): VideoGenerateRequest {
  // no aspect: the clip takes the start picture's shape
  // TODO: add an aspect picker if the server ends up cropping image-to-video to its 16:9 default
  const body: VideoGenerateRequest = { prompt: f.prompt.trim(), model: m.id, duration_s: clampDuration(f.durationS, m), image_id: f.startId }
  if (f.endId && has(m, 'flf')) body.end_image_id = f.endId
  const seed = Number.parseInt(f.seed, 10)
  if (Number.isFinite(seed) && seed >= 0) body.seed = seed
  if (f.smooth && !smoothBlockedReason(m, body.duration_s)) body.smooth_motion = true
  if (brandKitId) body.brand_kit_id = brandKitId
  const camera = cameraPayload(f.camera)
  if (camera) body.camera = camera
  return body
}

export function videoPayload(f: VideoForm, m: ModelInfo): VideoGenerateRequest {
  const body: VideoGenerateRequest = {
    prompt: f.prompt.trim(),
    model: m.id,
    duration_s: clampDuration(f.durationS, m),
    aspect: f.aspect,
  }
  if (f.imageId && has(m, 'i2v')) body.image_id = f.imageId
  if (body.image_id && f.endImageId && has(m, 'flf')) body.end_image_id = f.endImageId
  const seed = Number.parseInt(f.seed, 10)
  if (Number.isFinite(seed) && seed >= 0) body.seed = seed
  if (f.smooth && !smoothBlockedReason(m, body.duration_s)) body.smooth_motion = true
  const camera = cameraPayload(f.camera)
  if (camera) body.camera = camera
  return body
}

/** The generate endpoint answers one MediaItem (+ job), or a batch on some servers. */
export function videoResult(res: (MediaItem & { job?: Job | null }) | MediaBatch) {
  const batch = res as Partial<MediaBatch>
  const single = res as MediaItem & { job?: Job | null }
  const items = Array.isArray(batch.items) ? batch.items : single?.id ? [single] : []
  return { items, jobs: [...(batch.jobs ?? []), ...(single?.job ? [single.job] : [])] }
}
