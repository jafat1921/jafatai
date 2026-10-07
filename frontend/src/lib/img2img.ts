import { has } from './models'
import type { Img2ImgAspect, Img2ImgRequest, ModelInfo } from './types'
import { MAX_COUNT } from './images'

export const STRENGTH_MIN = 0.1
export const STRENGTH_MAX = 0.9
export const STRENGTH_DEFAULT = 0.45

// the three words under the slider; the slider stays continuous between them
export const STRENGTH_MARKS = [
  { value: 0.2, label: 'Subtle' },
  { value: 0.45, label: 'Balanced' },
  { value: 0.8, label: 'Reimagine' },
] as const

export function strengthLabel(v: number) {
  if (v < 0.33) return 'Subtle'
  if (v < 0.63) return 'Balanced'
  return 'Reimagine'
}

export const strengthHint = (v: number) =>
  v < 0.33 ? 'Keeps the picture, changes small details and colour.' : v < 0.63 ? 'Keeps the layout, restyles the look.' : 'Keeps a loose layout, redraws almost everything.'

export const clampStrength = (v: number) => Math.round(Math.min(STRENGTH_MAX, Math.max(STRENGTH_MIN, v)) * 100) / 100

/** Image models that can start from a picture; an older catalog without "i2i" falls back to all of them. */
export function i2iModels(models: ModelInfo[]) {
  const able = models.filter((m) => has(m, 'i2i'))
  return able.length ? able : models
}

export interface Img2ImgForm {
  sourceId: string | null
  prompt: string
  strength: number
  count: number
  aspect: Img2ImgAspect
  seed: string
}

export const DEFAULT_I2I_FORM: Img2ImgForm = { sourceId: null, prompt: '', strength: STRENGTH_DEFAULT, count: 2, aspect: 'source', seed: '' }

export function img2imgPayload(f: Img2ImgForm & { sourceId: string }, model?: ModelInfo, speed?: string, brandKitId?: string): Img2ImgRequest {
  const body: Img2ImgRequest = {
    source_id: f.sourceId,
    prompt: f.prompt.trim(),
    strength: clampStrength(f.strength),
    count: Math.min(MAX_COUNT, Math.max(1, Math.round(f.count) || 1)),
    aspect: f.aspect,
  }
  if (model) body.model = model.id
  if (model && speed) body.speed = speed
  const seed = Number.parseInt(f.seed, 10)
  if (Number.isFinite(seed) && seed >= 0) body.seed = seed
  if (brandKitId) body.brand_kit_id = brandKitId
  return body
}
