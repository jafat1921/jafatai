import { rangeText } from '@/lib/estimate'
import { mergeParams, scaleParams } from './params'
import type { DevelopParams, Look } from './types'

/**
 * A look put over the params it was applied to (contract-v9 §4), at an intensity of 0..100.
 * A look with a .cube also sets `lut`, its amount following the intensity.
 */
export function applyLook(before: DevelopParams, look: Look, intensity = 100): DevelopParams {
  const k = Math.max(0, Math.min(100, intensity)) / 100
  const next = mergeParams(before, k === 1 ? look.params : scaleParams(look.params, k))
  return look.has_cube ? { ...next, lut: { look_id: look.id, amount: Math.round(k * 100) } } : next
}

// ffmpeg lut3d on the CPU lane runs roughly a third to near real time at 1080p
// TODO: switch to a server-side estimate once /estimate learns kind=look_video
export function gradeEstimate(durationS: number | null | undefined, w?: number | null, h?: number | null): string | null {
  if (!durationS) return null
  const px = (w && h ? w * h : 1920 * 1080) / (1920 * 1080)
  return rangeText(5 + durationS * 0.3 * px, 10 + durationS * 0.9 * px)
}

/** Steps a video grade can't carry, from the look or its params. */
export function skippedOnVideo(look: Look): string[] {
  const names: Record<string, string> = { vignette: 'vignette', noiseReduction: 'noise reduction', lightPoints: 'light points' }
  const keys = look.spatial ?? []
  return keys.filter((k) => k in names).map((k) => names[k])
}
