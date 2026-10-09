import { humanize } from '@/lib/utils'
import { PARAMS_VERSION, upgradeParams } from './maths'
import { HSL_BANDS, type DevelopParams, type RangeSpec } from './types'

// Flat slider keys use dotted paths the schema also uses: "exposure", "curve.mids", "hsl.red.s".

export const SPATIAL_KEYS = ['clarity', 'sharpness', 'noiseReduction', 'lightPoints'] as const

const r = (min: number, max: number, label: string, extra: Partial<RangeSpec> = {}): RangeSpec => ({ min, max, step: 1, default: 0, label, ...extra })

// Used until GET /photo/schema answers, and by tests. Mirrors develop.ranges() on the server.
export const FALLBACK_RANGES: Record<string, RangeSpec> = {
  temperature: r(-100, 100, 'Temperature'),
  tint: r(-100, 100, 'Tint'),
  exposure: r(-5, 5, 'Exposure', { step: 0.01 }),
  contrast: r(-100, 100, 'Contrast'),
  highlights: r(-100, 100, 'Highlights'),
  shadows: r(-100, 100, 'Shadows'),
  whites: r(-100, 100, 'Whites'),
  blacks: r(-100, 100, 'Blacks'),
  vibrance: r(-100, 100, 'Vibrance'),
  saturation: r(-100, 100, 'Saturation'),
  clarity: r(-100, 100, 'Clarity', { spatial: true }),
  sharpness: r(0, 100, 'Sharpening', { spatial: true }),
  noiseReduction: r(0, 100, 'Noise reduction', { spatial: true }),
  vignette: r(-100, 100, 'Vignette'),
  vignetteMidpoint: r(0, 100, 'Midpoint', { default: 50 }),
  vignetteRoundness: r(-100, 100, 'Roundness'),
  vignetteFeather: r(0, 100, 'Feather', { default: 50 }),
  vignetteHighlights: r(0, 100, 'Highlights'),
  grainAmount: r(0, 100, 'Grain'),
  grainSize: r(0, 100, 'Size', { default: 25 }),
  grainRoughness: r(0, 100, 'Roughness', { default: 50 }),
  refineSat: r(0, 100, 'Refine saturation', { default: 100 }),
  'curve.blacks': r(-100, 100, 'Blacks'),
  'curve.shadows': r(-100, 100, 'Shadows'),
  'curve.mids': r(-100, 100, 'Midtones'),
  'curve.highlights': r(-100, 100, 'Highlights'),
  'curve.whites': r(-100, 100, 'Whites'),
  'pcurve.highlights': r(-100, 100, 'Highlights'),
  'pcurve.lights': r(-100, 100, 'Lights'),
  'pcurve.darks': r(-100, 100, 'Darks'),
  'pcurve.shadows': r(-100, 100, 'Shadows'),
  'pcurve.s1': r(5, 95, 'Split', { default: 25 }),
  'pcurve.s2': r(5, 95, 'Split', { default: 50 }),
  'pcurve.s3': r(5, 95, 'Split', { default: 75 }),
  'hsl.h': r(-100, 100, 'Hue'),
  'hsl.s': r(-100, 100, 'Saturation'),
  'hsl.l': r(-100, 100, 'Luminance'),
  bw: r(-100, 100, 'B&W mix'),
  'grading.h': r(0, 360, 'Hue'),
  'grading.s': r(0, 100, 'Saturation'),
  'grading.l': r(-100, 100, 'Luminance'),
  'grading.blending': r(0, 100, 'Blending', { default: 50 }),
  'grading.balance': r(-100, 100, 'Balance'),
  'calibration.shadowsTint': r(-100, 100, 'Shadows tint'),
  'calibration.redHue': r(-100, 100, 'Red hue'),
  'calibration.redSat': r(-100, 100, 'Red saturation'),
  'calibration.greenHue': r(-100, 100, 'Green hue'),
  'calibration.greenSat': r(-100, 100, 'Green saturation'),
  'calibration.blueHue': r(-100, 100, 'Blue hue'),
  'calibration.blueSat': r(-100, 100, 'Blue saturation'),
  'profile.amount': r(0, 200, 'Amount', { default: 100 }),
  'pointColor.dh': r(-100, 100, 'Hue'),
  'pointColor.ds': r(-100, 100, 'Saturation'),
  'pointColor.dl': r(-100, 100, 'Luminance'),
  'pointColor.hueRange': r(0, 100, 'Hue range', { default: 50 }),
  'pointColor.satRange': r(0, 100, 'Saturation range', { default: 50 }),
  'pointColor.lumRange': r(0, 100, 'Luminance range', { default: 50 }),
  rotate: r(-180, 180, 'Rotate', { step: 0.1 }),
  'lightPoints.exposure': r(-100, 100, 'Exposure'),
  'lut.amount': r(0, 100, 'Amount', { default: 100 }),
}

export const FALLBACK_GROUPS = [
  { id: 'basic', label: 'Basic', keys: ['profile', 'treatment', 'temperature', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'] },
  { id: 'curve', label: 'Tone curve', keys: ['curve.blacks', 'curve.shadows', 'curve.mids', 'curve.highlights', 'curve.whites', 'pcurve.highlights', 'pcurve.lights', 'pcurve.darks', 'pcurve.shadows', 'points', 'refineSat'] },
  { id: 'hsl', label: 'Colour mixer', keys: ['hsl', 'pointColor', 'bw'] },
  { id: 'grading', label: 'Colour grading', keys: ['grading'] },
  { id: 'detail', label: 'Detail', keys: ['clarity', 'sharpness', 'noiseReduction'] },
  { id: 'effects', label: 'Effects', keys: ['vignette', 'vignetteMidpoint', 'vignetteRoundness', 'vignetteFeather', 'vignetteHighlights', 'vignetteStyle', 'grainAmount', 'grainSize', 'grainRoughness'] },
  { id: 'calibration', label: 'Calibration', keys: ['calibration'] },
  { id: 'local', label: 'Local light · Selective colour', keys: ['lightPoints', 'palette'] },
]

/** A range for any key, including per-band / per-zone ones ("hsl.red.s" uses "hsl.s"). */
export function rangeFor(ranges: Record<string, RangeSpec>, key: string): RangeSpec {
  const m = /^(hsl|grading)\.\w+\.([hsl])$/.exec(key) ?? /^(bw)\.\w+()$/.exec(key)
  const k = m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]) : key
  return ranges[k] ?? FALLBACK_RANGES[k] ?? r(-100, 100, key)
}

// Neutral positions that aren't 0. A missing key reads as its neutral value, and compact() drops it again.
const NEUTRAL: Record<string, number> = {
  vignetteMidpoint: 50, vignetteFeather: 50, grainSize: 25, grainRoughness: 50, refineSat: 100,
  'pcurve.s1': 25, 'pcurve.s2': 50, 'pcurve.s3': 75, 'grading.blending': 50,
}
const NEUTRAL_TEXT: Record<string, string> = { treatment: 'color', vignetteStyle: 'highlight' }
export const neutralOf = (key: string) => NEUTRAL[key] ?? 0

export function getValue(p: DevelopParams, key: string): number {
  const parts = key.split('.')
  let cur: unknown = p
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return neutralOf(key)
    cur = (cur as Record<string, unknown>)[k]
  }
  return typeof cur === 'number' ? cur : neutralOf(key)
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

const ZONES = ['shadows', 'midtones', 'highlights', 'global'] as const
const SLIDER_KEYS = [
  ...Object.keys(FALLBACK_RANGES).filter((k) => !k.includes('.') && k !== 'rotate' && k !== 'bw'),
  'curve.blacks', 'curve.shadows', 'curve.mids', 'curve.highlights', 'curve.whites',
  'pcurve.highlights', 'pcurve.lights', 'pcurve.darks', 'pcurve.shadows', 'pcurve.s1', 'pcurve.s2', 'pcurve.s3',
  ...HSL_BANDS.flatMap((b) => [`hsl.${b}.h`, `hsl.${b}.s`, `hsl.${b}.l`]),
  ...HSL_BANDS.map((b) => `bw.${b}`),
  // a zone's hue does nothing on its own, so it never counts as a change
  ...ZONES.flatMap((z) => [`grading.${z}.s`, `grading.${z}.l`]), 'grading.blending', 'grading.balance',
  ...Object.keys(FALLBACK_RANGES).filter((k) => k.startsWith('calibration.')),
]

const straight = (pts: [number, number][] | undefined) => !pts || pts.every(([x, y]) => Math.abs(x - y) < 0.5)

/** Keys away from their neutral value: drives "n changed" counts and "is this an edit at all". */
export function changedKeys(p: DevelopParams): string[] {
  const out = SLIDER_KEYS.filter((k) => Math.abs(getValue(p, k) - neutralOf(k)) > 0.001)
  if (p.profile?.id && p.profile.id !== 'color') out.push('profile')
  if (p.treatment === 'bw') out.push('treatment')
  if (p.points && Object.values(p.points).some((pts) => !straight(pts))) out.push('points')
  if (p.pointColor?.length) out.push('pointColor')
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
  return changedKeys(p).some((k) => (SPATIAL_KEYS as readonly string[]).includes(k) || k === 'palette')
}

// whole values: their insides mean nothing apart (a crop box, a LUT or profile reference)
const ATOMIC = ['crop', 'lut', 'profile']

function strip(p: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    const path = prefix + k
    if (typeof v === 'number') {
      if (Math.abs(v - neutralOf(path)) > 1e-9) out[k] = v
    } else if (typeof v === 'string') {
      if (NEUTRAL_TEXT[path] !== v) out[k] = v
    } else if (isObj(v) && !ATOMIC.includes(path)) {
      const inner = strip(v, `${path}.`)
      if (Object.keys(inner).length) out[k] = inner
    } else if (Array.isArray(v)) {
      if (v.length) out[k] = v
    } else if (v != null && v !== false) {
      out[k] = v
    }
  }
  return out
}

/** Drop neutral values and empty groups so payloads stay readable; always says which params version it is. */
export function compact(p: DevelopParams): DevelopParams {
  const rest = strip(upgradeParams(p) as Record<string, unknown>, '')
  return { ...rest, version: PARAMS_VERSION } as DevelopParams
}

// numbers a look's Amount must not touch: positions, hues and split points
const FIXED = new Set(['version', 'h', 's1', 's2', 's3', 'hue', 'sat', 'val', 'hueRange', 'satRange', 'lumRange'])

/** Scale a look's numbers by its intensity (0..1) around their neutral values before putting it over the current params. */
export function scaleParams(p: DevelopParams, k: number): DevelopParams {
  const walk = (v: unknown, key: string, path: string): unknown => {
    if (typeof v === 'number') {
      if (FIXED.has(key)) return v
      const n = neutralOf(path)
      const digits = path === 'exposure' ? 100 : 10
      return Math.round((n + (v - n) * k) * digits) / digits
    }
    if (isObj(v) && !ATOMIC.includes(path)) return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk, path ? `${path}.${kk}` : kk)]))
    return v
  }
  return walk(p, '', '') as DevelopParams
}

const WHOLE: Record<string, string> = { profile: 'Profile', treatment: 'Black & white', points: 'Point curve', pointColor: 'Point colour' }

/** "Red hue", "Curve lights", "Shadows grade sat": a human name for a dotted slider key. */
export function keyLabel(k: string): string {
  if (WHOLE[k]) return WHOLE[k]
  const band = /^hsl\.(\w+)\.([hsl])$/.exec(k)
  if (band) return `${humanize(band[1])} ${{ h: 'hue', s: 'sat', l: 'lum' }[band[2]]}`
  const zone = /^grading\.(\w+)\.([hsl])$/.exec(k)
  if (zone) return `${humanize(zone[1])} grade ${{ h: 'hue', s: 'sat', l: 'lum' }[zone[2]]}`
  if (k.startsWith('bw.')) return `B&W ${k.slice(3)}`
  if (k.startsWith('curve.') || /^pcurve\.[a-z]+$/.test(k)) return `Curve ${k.split('.')[1]}`
  if (k.startsWith('pcurve.')) return 'Curve split'
  if (k.startsWith('grading.')) return `Grading ${k.slice(8)}`
  return FALLBACK_RANGES[k]?.label ?? k
}

/** "+0.75 EV" for exposure, "+38" for the rest. */
export function formatValue(k: string, v: number): string {
  const sign = v > 0 ? '+' : ''
  return k === 'exposure' ? `${sign}${v.toFixed(2)} EV` : `${sign}${Math.round(v)}`
}

export const paramsKey = (p: DevelopParams) => JSON.stringify(compact(p))
