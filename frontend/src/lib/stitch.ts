import type { Generation, Reel, ReelScene, Render, StitchRequest } from './types'

export type StitchMode = 'range' | 'pick'

export interface StitchScene {
  scene: ReelScene
  number: number // 1-based position in the film, matches "Sc N" on the strips
  ready: boolean // has at least one enabled clip with an approved take
}

export const stitchScenes = (reel: Reel): StitchScene[] =>
  [...reel.scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene, i) => ({ scene, number: i + 1, ready: scene.clips.some((c) => c.enabled) }))

/** Same wording as the server: "Scene 3", "Scenes 2–5", "Scenes 1, 3, 6". */
export function rangeLabel(numbers: number[]): string {
  const nums = [...new Set(numbers)].sort((a, b) => a - b)
  if (!nums.length) return ''
  if (nums.length === 1) return `Scene ${nums[0]}`
  if (nums[nums.length - 1] - nums[0] === nums.length - 1) return `Scenes ${nums[0]}–${nums[nums.length - 1]}`
  return `Scenes ${nums.join(', ')}`
}

export interface StitchState {
  mode: StitchMode
  from: number
  to: number
  picked: string[]
}

export interface Selection {
  included: StitchScene[]
  skipped: StitchScene[] // inside the range but without an approved take
  full: boolean
  label: string
  autoTitle: string
  durationS: number
  cached: number
}

export function resolveSelection(scenes: StitchScene[], s: StitchState): Selection {
  const lo = Math.min(s.from, s.to)
  const hi = Math.max(s.from, s.to)
  const chosen =
    s.mode === 'range'
      ? scenes.filter((x) => x.number >= lo && x.number <= hi)
      : scenes.filter((x) => s.picked.includes(x.scene.scene_id))
  const included = chosen.filter((x) => x.ready)
  const ready = scenes.filter((x) => x.ready)
  const full = included.length > 0 && included.length === ready.length
  const label = rangeLabel(included.map((x) => x.number))
  return {
    included,
    skipped: chosen.filter((x) => !x.ready),
    full,
    label,
    autoTitle: full ? 'Full film' : label,
    // scene seams can shave a dissolve off; close enough for a summary line
    durationS: included.reduce((t, x) => t + x.scene.duration_s, 0),
    cached: included.filter((x) => x.scene.mezzanine.status === 'fresh').length,
  }
}

/** The whole film goes out without scene_ids; a name is only sent when the user typed one. */
export function stitchPayload(sel: Selection, title: string): StitchRequest {
  const body: StitchRequest = { quality: 'draft' }
  if (!sel.full) body.scene_ids = sel.included.map((x) => x.scene.scene_id)
  const t = title.trim()
  if (t && t !== sel.autoTitle) body.title = t
  return body
}

export interface RenderInfo {
  title: string
  range: string
  full: boolean
  durationS: number | null
  sceneIds: string[]
}

export function renderInfo(r: Render | Generation): RenderInfo {
  const p = (r.params ?? {}) as Record<string, unknown>
  const x = r as Render
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  // renders from before range stitching were always the whole film
  const full = typeof p.full === 'boolean' ? p.full : (x.full ?? true)
  return {
    title: (typeof p.title === 'string' && p.title) || x.title || 'Full film',
    range: (typeof p.scene_range === 'string' && p.scene_range) || x.scene_range || (full ? 'All scenes' : ''),
    full,
    durationS: num(p.duration_s) ?? num(x.duration_s),
    sceneIds: (Array.isArray(p.scene_ids) ? (p.scene_ids as string[]) : x.scene_ids) ?? [],
  }
}

export type OutputFilter = 'all' | 'full' | 'partial'

export function filterRenders<T extends Render>(list: T[], filter: OutputFilter, showRejected: boolean): T[] {
  return list.filter((r) => {
    if (!showRejected && r.status === 'rejected') return false
    if (filter === 'all') return true
    return renderInfo(r).full === (filter === 'full')
  })
}

/** Re-stitch the same scenes under the same name (the review bar's "Regenerate" on a render). */
export function restitchPayload(r: Render | Generation): StitchRequest {
  const info = renderInfo(r)
  const body: StitchRequest = { quality: 'draft' }
  if (!info.full && info.sceneIds.length) body.scene_ids = info.sceneIds
  const p = (r.params ?? {}) as Record<string, unknown>
  if (p.title_auto === false) body.title = info.title
  return body
}

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
