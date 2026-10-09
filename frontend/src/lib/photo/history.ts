import { humanize } from '@/lib/utils'
import { upgradeParams } from './maths'
import { changedKeys, formatValue, getValue, keyLabel } from './params'
import type { DevelopParams, HistoryVersion } from './types'

const RESTORE_NAMES: Record<string, string> = {
  repair: 'Repair', scratches: 'Scratches', heavy: 'Heavy restore', jpeg: 'JPEG clean-up', denoise: 'Denoise', deblur: 'Deblur',
  faces: 'Faces', colourise: 'Colourise', fix: 'Prompted fix', stylise: 'Stylise', cutout: 'Cut-out', select: 'Selection', background: 'Painted background',
}

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
    case 'restore':
      return v.restore ? `Restore · ${RESTORE_NAMES[v.restore.tool] ?? humanize(v.restore.tool)}` : 'Restored'
    case 'cutout':
      return v.cutout?.background?.type && v.cutout.background.type !== 'transparent' ? 'Cut-out · new background' : 'Cut-out'
    default:
      return v.generation.kind === 'upload' ? 'Original upload' : 'Original'
  }
}

const NAMES: Record<string, string> = { crop: 'Crop', rotate: 'Rotate', flipH: 'Flip', flipV: 'Flip', lightPoints: 'Local light', palette: 'Selective colour', lut: 'LUT' }

/** "Exposure +38 · Contrast +12 · 3 more" for a version card. */
export function summarise(p: DevelopParams | null | undefined, max = 3): string {
  if (!p) return ''
  p = upgradeParams(p)
  const keys = changedKeys(p)
  if (!keys.length) return 'No adjustments'
  const parts = keys.slice(0, max).map((k) => {
    if (NAMES[k]) return NAMES[k]
    if (['profile', 'treatment', 'points', 'pointColor'].includes(k)) return keyLabel(k)
    return `${keyLabel(k)} ${formatValue(k, getValue(p, k))}`
  })
  if (keys.length > max) parts.push(`${keys.length - max} more`)
  return parts.join(' · ')
}

/** Where a version's settings live for non-destructive editing (contract-v9 §3). */
export function editBase(v: HistoryVersion): { baseId: string; params: DevelopParams } {
  if (v.edit === 'develop' && v.develop?.base) return { baseId: v.develop.base, params: upgradeParams(v.develop.params ?? {}) }
  return { baseId: v.generation.id, params: {} }
}
