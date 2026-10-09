import { HSL_BANDS, type DevelopParams, type RangeSpec } from './types'

// Flat slider keys use dotted paths the schema also uses: "exposure", "curve.mids", "hsl.red.s".

export const SPATIAL_KEYS = ['clarity', 'sharpness', 'noiseReduction', 'lightPoints'] as const

// Used until GET /photo/schema answers, and by tests. Mirrors the contract's table.
export const FALLBACK_RANGES: Record<string, RangeSpec> = {
  temperature: { min: -100, max: 100, step: 1, default: 0, label: 'Temperature' },
  tint: { min: -100, max: 100, step: 1, default: 0, label: 'Tint' },
  exposure: { min: -100, max: 100, step: 1, default: 0, label: 'Exposure' },
  contrast: { min: -100, max: 100, step: 1, default: 0, label: 'Contrast' },
  highlights: { min: -100, max: 100, step: 1, default: 0, label: 'Highlights' },
  shadows: { min: -100, max: 100, step: 1, default: 0, label: 'Shadows' },
  whites: { min: -100, max: 100, step: 1, default: 0, label: 'Whites' },
  blacks: { min: -100, max: 100, step: 1, default: 0, label: 'Blacks' },
  vibrance: { min: -100, max: 100, step: 1, default: 0, label: 'Vibrance' },
  saturation: { min: -100, max: 100, step: 1, default: 0, label: 'Saturation' },
  clarity: { min: -100, max: 100, step: 1, default: 0, label: 'Clarity', spatial: true },
  sharpness: { min: 0, max: 100, step: 1, default: 0, label: 'Sharpening', spatial: true },
  noiseReduction: { min: 0, max: 100, step: 1, default: 0, label: 'Noise reduction', spatial: true },
  vignette: { min: -100, max: 100, step: 1, default: 0, label: 'Vignette' },
  'curve.blacks': { min: -100, max: 100, step: 1, default: 0, label: 'Blacks' },
  'curve.shadows': { min: -100, max: 100, step: 1, default: 0, label: 'Shadows' },
  'curve.mids': { min: -100, max: 100, step: 1, default: 0, label: 'Midtones' },
  'curve.highlights': { min: -100, max: 100, step: 1, default: 0, label: 'Highlights' },
  'curve.whites': { min: -100, max: 100, step: 1, default: 0, label: 'Whites' },
  'hsl.h': { min: -100, max: 100, step: 1, default: 0, label: 'Hue' },
  'hsl.s': { min: -100, max: 100, step: 1, default: 0, label: 'Saturation' },
  'hsl.l': { min: -100, max: 100, step: 1, default: 0, label: 'Luminance' },
  rotate: { min: -180, max: 180, step: 0.1, default: 0, label: 'Rotate' },
  'lightPoints.exposure': { min: -100, max: 100, step: 1, default: 0, label: 'Exposure' },
  'lut.amount': { min: 0, max: 100, step: 1, default: 100, label: 'Amount' },
}

export const FALLBACK_GROUPS = [
  { id: 'basic', label: 'Basic', keys: ['temperature', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'] },
  { id: 'curve', label: 'Tone curve', keys: ['curve.blacks', 'curve.shadows', 'curve.mids', 'curve.highlights', 'curve.whites'] },
  { id: 'hsl', label: 'Colour mixer', keys: ['hsl'] },
  { id: 'detail', label: 'Detail', keys: ['clarity', 'sharpness', 'noiseReduction'] },
  { id: 'effects', label: 'Effects', keys: ['vignette'] },
  { id: 'local', label: 'Local light · Selective colour', keys: ['lightPoints', 'palette'] },
]

/** A range for any key, including per-band HSL ("hsl.red.s" uses "hsl.s"). */
export function rangeFor(ranges: Record<string, RangeSpec>, key: string): RangeSpec {
  const hsl = /^hsl\.\w+\.([hsl])$/.exec(key)
  return ranges[hsl ? `hsl.${hsl[1]}` : key] ?? FALLBACK_RANGES[hsl ? `hsl.${hsl[1]}` : key] ?? { min: -100, max: 100, step: 1, default: 0, label: key }
}

export function getValue(p: DevelopParams, key: string): number {
  const parts = key.split('.')
  let cur: unknown = p
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return 0
    cur = (cur as Record<string, unknown>)[k]
  }
  return typeof cur === 'number' ? cur : 0
}

/** Immutable set by dotted path; a value equal to 0 is kept (the server treats it as "leave alone"). */
export function setValue(p: DevelopParams, key: string, value: number): DevelopParams {
  const parts = key.split('.')
  const write = (obj: Record<string, unknown> | undefined, i: number): Record<string, unknown> => {
    const base = { ...(obj ?? {}) }
    base[parts[i]] = i === parts.length - 1 ? value : write(base[parts[i]] as Record<string, unknown> | undefined, i + 1)
    return base
  }
  return write(p as Record<string, unknown>, 0) as DevelopParams
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Deep merge for plain objects; arrays and null replace. Used for Auto and looks ("put over"). */
export function mergeParams(base: DevelopParams, over: DevelopParams): DevelopParams {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? mergeParams(out[k] as DevelopParams, v as DevelopParams) : v
  }
  return out as DevelopParams
}

const SLIDER_KEYS = [
  ...Object.keys(FALLBACK_RANGES).filter((k) => !k.includes('.') && k !== 'rotate'),
  'curve.blacks', 'curve.shadows', 'curve.mids', 'curve.highlights', 'curve.whites',
  ...HSL_BANDS.flatMap((b) => [`hsl.${b}.h`, `hsl.${b}.s`, `hsl.${b}.l`]),
]

/** Keys with a non-zero value: drives "n changed" counts and "is this an edit at all". */
export function changedKeys(p: DevelopParams): string[] {
  const out = SLIDER_KEYS.filter((k) => Math.abs(getValue(p, k)) > 0.001)
  if (p.crop) out.push('crop')
  if (p.rotate) out.push('rotate')
  if (p.flipH) out.push('flipH')
  if (p.flipV) out.push('flipV')
  if (p.lightPoints?.some((l) => l.exposure)) out.push('lightPoints')
  if (p.palette?.some((c) => !c.enabled || c.h || c.s || c.l)) out.push('palette')
  if (p.lut && p.lut.amount > 0) out.push('lut')
  return out
}

export const isIdentity = (p: DevelopParams) => changedKeys(p).length === 0

/** Spatial edits the instant preview can't show exactly: wait for the server's render. */
export function needsServer(p: DevelopParams): boolean {
  return changedKeys(p).some((k) => (SPATIAL_KEYS as readonly string[]).includes(k) || k === 'palette' || k === 'lut')
}

/** Drop zeros and empty groups so payloads stay readable; the server fills `version`. */
export function compact(p: DevelopParams): DevelopParams {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (k === 'version') continue
    if (typeof v === 'number') {
      if (v !== 0) out[k] = v
    } else if (k === 'curve' || k === 'hsl') {
      const inner = compact(v as DevelopParams) as Record<string, unknown>
      if (Object.keys(inner).length) out[k] = inner
    } else if (isObj(v) && !['crop', 'lut'].includes(k)) {
      const inner = compact(v as DevelopParams) as Record<string, unknown>
      if (Object.keys(inner).length) out[k] = inner
    } else if (Array.isArray(v)) {
      if (v.length) out[k] = v
    } else if (v != null && v !== false) {
      out[k] = v
    }
  }
  return out as DevelopParams
}

/** Scale a look's numbers by its intensity (0..1) before putting it over the current params. */
export function scaleParams(p: DevelopParams, k: number): DevelopParams {
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'number') return key === 'version' ? v : Math.round(v * k * 10) / 10
    if (isObj(v) && key !== 'crop' && key !== 'lut') return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk)]))
    return v
  }
  return walk(p, '') as DevelopParams
}

export const paramsKey = (p: DevelopParams) => JSON.stringify(compact(p))
