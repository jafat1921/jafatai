import { humanize } from '@/lib/utils'
import { FALLBACK_RANGES, changedKeys, getValue } from './params'
import type { DevelopParams, HistoryVersion } from './types'

export function editLabel(v: HistoryVersion): string {
  switch (v.edit) {
    case 'develop':
      return 'Developed'
    case 'effect':
      return v.effect ? `Effect · ${humanize(v.effect.name)}` : 'Effect'
    case 'look':
      return v.look ? `Look · ${v.look.name}` : 'Look'
    case 'upscale':
      return 'Upscaled'
    default:
      return v.generation.kind === 'upload' ? 'Original upload' : 'Original'
  }
}

const NAMES: Record<string, string> = { crop: 'Crop', rotate: 'Rotate', flipH: 'Flip', flipV: 'Flip', lightPoints: 'Local light', palette: 'Selective colour', lut: 'LUT' }

/** "Exposure +38 · Contrast +12 · 3 more" for a version card. */
export function summarise(p: DevelopParams | null | undefined, max = 3): string {
  if (!p) return ''
  const keys = changedKeys(p)
  if (!keys.length) return 'No adjustments'
  const parts = keys.slice(0, max).map((k) => {
    if (NAMES[k]) return NAMES[k]
    const hsl = /^hsl\.(\w+)\.([hsl])$/.exec(k)
    const label = hsl ? `${humanize(hsl[1])} ${{ h: 'hue', s: 'sat', l: 'lum' }[hsl[2]]}` : k.startsWith('curve.') ? `Curve ${k.slice(6)}` : (FALLBACK_RANGES[k]?.label ?? k)
    const v = getValue(p, k)
    return `${label} ${v > 0 ? '+' : ''}${Math.round(v)}`
  })
  if (keys.length > max) parts.push(`${keys.length - max} more`)
  return parts.join(' · ')
}

/** Where a version's settings live for non-destructive editing (contract-v9 §3). */
export function editBase(v: HistoryVersion): { baseId: string; params: DevelopParams } {
  if (v.edit === 'develop' && v.develop?.base) return { baseId: v.develop.base, params: v.develop.params ?? {} }
  return { baseId: v.generation.id, params: {} }
}
