import { humanize } from '@/lib/utils'
import { upgradeParams } from './maths'
import { changedKeys, formatValue, getValue, keyLabel } from './params'
import type { DevelopParams } from './types'

/** Develop workflow (M10 / D1): panel switches, Copy / Paste / Sync groups, history labels. */

// top-level param keys per group; mirrors develop.GROUPS on the server
export const GROUP_KEYS: Record<string, (keyof DevelopParams)[]> = {
  basic: ['profile', 'treatment', 'temperature', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'],
  curve: ['curve', 'pcurve', 'points', 'refineSat'],
  hsl: ['hsl', 'pointColor', 'bw'],
  grading: ['grading'],
  detail: ['clarity', 'sharpness', 'noiseReduction'],
  effects: ['vignette', 'vignetteMidpoint', 'vignetteRoundness', 'vignetteFeather', 'vignetteHighlights', 'vignetteStyle', 'grainAmount', 'grainSize', 'grainRoughness'],
  calibration: ['calibration'],
  local: ['lightPoints', 'palette'],
  geometry: ['crop', 'rotate', 'flipH', 'flipV'],
  look: ['lut'],
}
export const GROUP_LABELS: Record<string, string> = {
  basic: 'Basic (profile, white balance, tone, presence)',
  curve: 'Tone curve',
  hsl: 'Colour mixer, point colour & B&W mix',
  grading: 'Colour grading',
  detail: 'Detail (clarity, sharpening, noise)',
  effects: 'Effects (vignette, grain)',
  calibration: 'Calibration',
  local: 'Local light & selective colour',
  geometry: 'Crop, straighten & flip',
  look: 'Look',
}
export const SWITCHABLE = Object.keys(GROUP_KEYS).filter((g) => g !== 'geometry')
// Lightroom leaves crop and spot-type edits out of Copy by default: they rarely fit another frame
export const DEFAULT_COPY = Object.keys(GROUP_KEYS).filter((g) => g !== 'geometry' && g !== 'local')

const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/** What the preview should draw: switched-off groups as if untouched. The saved params keep them. */
export function bypass(p: DevelopParams): DevelopParams {
  if (!p.off?.length) return p
  const out: Record<string, unknown> = { ...p }
  for (const g of p.off) for (const k of GROUP_KEYS[g] ?? []) delete out[k]
  return out as DevelopParams
}

export function toggleGroup(p: DevelopParams, group: string): DevelopParams {
  const off = new Set(p.off ?? [])
  if (off.has(group)) off.delete(group)
  else off.add(group)
  const next = SWITCHABLE.filter((g) => off.has(g))
  const out = { ...p } as DevelopParams
  if (next.length) out.off = next
  else delete out.off
  return out
}

/** The ticked groups of `src` (and their on/off state), nothing else. */
export function pickGroups(src: DevelopParams, groups: string[]): DevelopParams {
  const out: Record<string, unknown> = {}
  for (const g of groups) for (const k of GROUP_KEYS[g] ?? []) if (src[k] !== undefined) out[k] = clone(src[k])
  const off = (src.off ?? []).filter((g) => groups.includes(g))
  if (off.length) out.off = off
  return out as DevelopParams
}

/** Paste: the ticked groups replace mine (a group missing from the copy goes back to default). */
export function pasteGroups(mine: DevelopParams, copied: DevelopParams, groups: string[]): DevelopParams {
  const out: Record<string, unknown> = { ...mine }
  for (const g of groups) for (const k of GROUP_KEYS[g] ?? []) {
    if (copied[k] !== undefined) out[k] = clone(copied[k])
    else delete out[k]
  }
  const off = new Set((mine.off ?? []).filter((g) => !groups.includes(g)))
  for (const g of copied.off ?? []) if (groups.includes(g)) off.add(g)
  const list = SWITCHABLE.filter((g) => off.has(g))
  if (list.length) out.off = list
  else delete out.off
  return out as DevelopParams
}

/** Groups that hold something in these params ("Copy modified"). */
export function modifiedGroups(p: DevelopParams): string[] {
  const changed = new Set(changedKeys(p).map((k) => k.split('.')[0]))
  return Object.keys(GROUP_KEYS).filter((g) => GROUP_KEYS[g].some((k) => changed.has(k as string)))
}

// ---------------------------------------------------------------- settings clipboard

export interface Clipboard {
  params: DevelopParams
  groups: string[]
  from: string
  at: number
}
const CLIP = 'mixai.develop.clipboard'
const PREV = 'mixai.develop.previous'

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode: copy just won't survive a reload */
  }
}

// anything saved before params v2 holds exposure on the old ±100 scale
export function readClipboard() {
  const c = read<Clipboard>(CLIP)
  return c && { ...c, params: upgradeParams(c.params) }
}
export const writeClipboard = (c: Clipboard) => write(CLIP, c)
/** Lightroom's "Previous": the settings of the last picture edited, whatever it was. */
export function readPrevious() {
  const p = read<{ params: DevelopParams; from: string }>(PREV)
  return p && { ...p, params: upgradeParams(p.params) }
}
export const writePrevious = (params: DevelopParams, from: string) => write(PREV, { params, from })

// ---------------------------------------------------------------- history labels

const NAMES: Record<string, string> = {
  crop: 'Crop', rotate: 'Straighten', flipH: 'Flip horizontal', flipV: 'Flip vertical', lightPoints: 'Local light',
  palette: 'Selective colour', lut: 'Look', off: 'Panel switch',
}

const NESTED: Record<string, string> = {
  curve: 'Tone curve', pcurve: 'Tone curve', points: 'Point curve', hsl: 'Colour mixer', bw: 'B&W mix',
  grading: 'Colour grading', calibration: 'Calibration',
}

const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** "Exposure +38" for the step from a to b (the first thing that changed, like Lightroom's History). */
export function stepLabel(a: DevelopParams, b: DevelopParams): string {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const changed: string[] = []
  for (const k of keys) if (!sameJSON(a[k as keyof DevelopParams], b[k as keyof DevelopParams])) changed.push(k)
  if (!changed.length) return 'No change'
  const k = changed[0]
  if (NAMES[k]) return changed.length > 1 ? `${NAMES[k]} and ${changed.length - 1} more` : NAMES[k]
  if (k in NESTED) {
    const pa = (a as Record<string, Record<string, unknown> | undefined>)[k] ?? {}
    const pb = (b as Record<string, Record<string, unknown> | undefined>)[k] ?? {}
    const inner = Object.keys({ ...pa, ...pb }).find((x) => !sameJSON(pa[x], pb[x]))
    return `${NESTED[k]} ${inner ? humanize(inner).toLowerCase() : ''}`.trim()
  }
  if (typeof b[k as keyof DevelopParams] !== 'number' && typeof a[k as keyof DevelopParams] !== 'number') return keyLabel(k)
  const label = keyLabel(k)
  return changed.length > 1 ? `${label} and ${changed.length - 1} more` : `${label} ${formatValue(k, getValue(b, k))}`
}
