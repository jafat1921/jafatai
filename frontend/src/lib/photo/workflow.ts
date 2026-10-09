import { FALLBACK_RANGES, changedKeys, getValue } from './params'
import type { DevelopParams } from './types'

/** Develop workflow (M10 / D1): panel switches, Copy / Paste / Sync groups, history labels. */

// top-level param keys per group; mirrors develop.GROUPS on the server
export const GROUP_KEYS: Record<string, (keyof DevelopParams)[]> = {
  basic: ['temperature', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'],
  curve: ['curve'],
  hsl: ['hsl'],
  detail: ['clarity', 'sharpness', 'noiseReduction'],
  effects: ['vignette'],
  local: ['lightPoints', 'palette'],
  geometry: ['crop', 'rotate', 'flipH', 'flipV'],
  look: ['lut'],
}
export const GROUP_LABELS: Record<string, string> = {
  basic: 'Basic (white balance, tone, presence)',
  curve: 'Tone curve',
  hsl: 'Colour mixer',
  detail: 'Detail (clarity, sharpening, noise)',
  effects: 'Effects (vignette)',
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

export const readClipboard = () => read<Clipboard>(CLIP)
export const writeClipboard = (c: Clipboard) => write(CLIP, c)
/** Lightroom's "Previous": the settings of the last picture edited, whatever it was. */
export const readPrevious = () => read<{ params: DevelopParams; from: string }>(PREV)
export const writePrevious = (params: DevelopParams, from: string) => write(PREV, { params, from })

// ---------------------------------------------------------------- history labels

const NAMES: Record<string, string> = {
  crop: 'Crop', rotate: 'Straighten', flipH: 'Flip horizontal', flipV: 'Flip vertical', lightPoints: 'Local light',
  palette: 'Selective colour', lut: 'Look', off: 'Panel switch',
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
  if (k === 'curve' || k === 'hsl') {
    const inner = Object.keys({ ...(a[k] ?? {}), ...(b[k] ?? {}) }).find((x) => !sameJSON((a[k] as Record<string, unknown> | undefined)?.[x], (b[k] as Record<string, unknown> | undefined)?.[x]))
    return k === 'curve' ? `Tone curve ${inner ?? ''}`.trim() : `Colour mixer ${inner ?? ''}`.trim()
  }
  const v = getValue(b, k)
  const label = FALLBACK_RANGES[k]?.label ?? k
  return changed.length > 1 ? `${label} and ${changed.length - 1} more` : `${label} ${v > 0 ? '+' : ''}${Math.round(v)}`
}
