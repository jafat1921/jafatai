import { LONGTAKE_MAX_S } from '@/lib/duration'
import { rangeText } from '@/lib/estimate'
import { etaSeconds } from '@/lib/jobs'
import type { StatusView } from '@/lib/status'
import type { GenerationKind, Job, Shot, ShotActivity } from '@/lib/types'

// Shot-list review helpers (UI polish P3). The split/merge previews mirror backend storyboard.py so the
// table can show what will happen before the request goes out.

/** True when the ids are neighbours in the scene's order (merge needs that). */
export function isContiguous(ids: string[], sceneShots: Shot[]) {
  if (ids.length < 2) return false
  const idx = ids.map((id) => sceneShots.findIndex((s) => s.id === id)).sort((a, b) => a - b)
  if (idx[0] < 0) return false
  return idx.every((v, i) => i === 0 || v === idx[i - 1] + 1)
}

export function mergedDuration(shots: Pick<Shot, 'duration_s'>[]) {
  return Math.min(LONGTAKE_MAX_S, shots.reduce((t, s) => t + s.duration_s, 0))
}

export function splitDurations(duration: number, ratio: number): [number, number] {
  const first = Math.max(1, Math.min(duration - 1, Math.round(duration * ratio * 2) / 2))
  return [first, Math.round((duration - first) * 2) / 2]
}

export function splitText(text: string, ratio: number): [string, string] {
  const t = text.trim()
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean)
  const parts = sentences.length > 1 ? sentences : t.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return [t, t]
  const cut = Math.min(parts.length - 1, Math.max(1, Math.round(parts.length * ratio)))
  return [parts.slice(0, cut).join(' '), parts.slice(cut).join(' ')]
}

export const canSplit = (shot: Pick<Shot, 'duration_s'>) => shot.duration_s >= 2

export function moveId(ids: string[], id: string, to: number) {
  const from = ids.indexOf(id)
  if (from < 0 || to < 0 || to >= ids.length || to === from) return ids
  const next = ids.slice()
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

type Activity = Pick<ShotActivity, 'status' | 'job_id'>

/**
 * One pill for what a card's generations are doing right now: queued · 42% · ETA · failed.
 * Null when nothing is in flight or failed, so the card falls back to its normal shot status.
 */
export function shotActivity(items: Activity[], jobs: Job[] | undefined, now = Date.now()): StatusView | null {
  const pending = items.filter((a) => a.status !== 'failed')
  if (pending.length) {
    const running = pending
      .map((a) => jobs?.find((j) => j.id === a.job_id))
      .filter((j): j is Job => !!j && j.status === 'running')
    if (running.length) {
      const p = running.reduce((t, j) => t + j.progress, 0) / running.length
      const etas = running.map((j) => etaSeconds(j, now)).filter((x): x is number => x != null)
      const eta = etas.length ? ` · ${rangeText(Math.max(...etas) * 0.85, Math.max(...etas) * 1.25)}` : ''
      const more = pending.length > running.length ? ` · ${pending.length - running.length} queued` : ''
      return { label: `Rendering ${Math.round(p * 100)}%${eta}${more}`, tone: 'accent', icon: 'spinner' }
    }
    return { label: pending.length > 1 ? `Queued · ${pending.length}` : 'Queued', tone: 'neutral', icon: 'clock' }
  }
  if (items.some((a) => a.status === 'failed')) return { label: 'Failed', tone: 'danger', icon: 'alert' }
  return null
}

export const isFrameKind = (k: GenerationKind) => k === 'keyframe_start' || k === 'keyframe_end'
