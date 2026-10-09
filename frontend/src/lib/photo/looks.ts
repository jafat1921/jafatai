import { rangeText } from '@/lib/estimate'
import { FALLBACK_RANGES, mergeParams, rangeFor, scaleParams } from './params'
import type { DevelopParams, Look } from './types'

const FIXED = new Set(['version', 'x', 'y', 'falloff', 'hue', 'sat', 'val'])

// sliders stop at their ends however hard a look is pushed (the server refuses anything past them)
function clampSliders(p: DevelopParams): DevelopParams {
  const walk = (v: unknown, key: string, path: string): unknown => {
    if (typeof v === 'number') {
      if (FIXED.has(key) || key.startsWith('ref') || key.startsWith('center') || /^grading\.\w+\.h$/.test(path)) return v
      const lim = rangeFor(FALLBACK_RANGES, path.replace(/^(lightPoints|palette)\.\d+\./, '$1.').replace(/^pointColor\.\d+\./, 'pointColor.'))
      return Math.max(lim.min, Math.min(lim.max, v))
    }
    if (Array.isArray(v)) return key === 'points' || path.startsWith('points.') ? v : v.map((x, i) => walk(x, '', `${path}.${i}`))
    if (v && typeof v === 'object' && key !== 'crop' && key !== 'lut' && key !== 'profile') {
      return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk, path ? `${path}.${kk}` : kk)]))
    }
    return v
  }
  return walk(p, '', '') as DevelopParams
}

/**
 * A look put over the params it was applied to (contract-v9 §4), at an Amount of 0..200 like
 * Lightroom's presets. A look with a .cube also sets `lut`; a LUT can't go past fully on.
 */
export function applyLook(before: DevelopParams, look: Look, intensity = 100): DevelopParams {
  const k = Math.max(0, Math.min(200, intensity)) / 100
  const next = mergeParams(before, k === 1 ? look.params : clampSliders(scaleParams(look.params, k)))
  return look.has_cube ? { ...next, lut: { look_id: look.id, amount: Math.round(Math.min(1, k) * 100) } } : next
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
