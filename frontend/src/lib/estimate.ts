import { estimateSeconds } from './models'
import type { EstimateResult, ModelInfo } from './types'

// How wide the local guess is. A measured median still varies with load and warm/cold models;
// a rough catalog number can be off by half either way, so its range is wider on purpose.
const SPREAD = { measured: [0.85, 1.3], rough: [0.7, 1.6] } as const

export function spread(totalS: number, basis: EstimateResult['basis']): EstimateResult {
  const [lo, hi] = SPREAD[basis]
  return { low_s: totalS * lo, high_s: totalS * hi, basis }
}

/** From the catalog alone: per-output time × count; video est_seconds is per 5 s clip. */
export function localEstimate(model: ModelInfo | undefined, opts: { count?: number; durationS?: number; speed?: string } = {}): EstimateResult | null {
  const each = estimateSeconds(model, opts.speed)
  if (!each) return null
  const count = Math.max(1, opts.count ?? 1)
  const scale = model?.type === 'video' && opts.durationS ? opts.durationS / 5 : 1
  return spread(each * count * scale, model?.estimate_source === 'measured' ? 'measured' : 'rough')
}

function roundS(s: number) {
  if (s < 10) return Math.max(1, Math.round(s))
  return Math.round(s / 5) * 5
}

function part(s: number): { n: string; unit: 's' | 'min' | 'h' } {
  if (s < 60) return { n: String(roundS(s)), unit: 's' }
  if (s < 3600) return { n: String(Math.max(1, Math.round(s / 60))), unit: 'min' }
  return { n: (Math.round((s / 3600) * 10) / 10).toString(), unit: 'h' }
}

/** "~20–35 s", "~4–6 min", "~45 s–2 min", or "~30 s" when both ends round the same. */
export function rangeText(lowS: number, highS: number) {
  const a = part(Math.min(lowS, highS))
  const b = part(Math.max(lowS, highS))
  if (a.unit === b.unit) return a.n === b.n ? `~${a.n} ${a.unit}` : `~${a.n}–${b.n} ${a.unit}`
  return `~${a.n} ${a.unit}–${b.n} ${b.unit}`
}

/** "Generate · 4 images · ~20–35 s"; parts that aren't known yet are left out. */
export function estimateLabel(verb: string, what: string | null, est: EstimateResult | null) {
  return [verb, what, est ? rangeText(est.low_s, est.high_s) : null].filter(Boolean).join(' · ')
}

export function basisHint(est: EstimateResult | null) {
  if (!est) return 'No timing data for this model yet.'
  if (est.basis === 'measured') {
    return `Measured from ${est.samples ? `the last ${est.samples} runs` : 'recent runs'} on this server. A cold model or a busy queue adds time.`
  }
  return 'A rough guess from the model card; it gets sharper after a few runs on this server.'
}
