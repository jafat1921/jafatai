import type { SessionRequest } from '@/stores/sessions'
import type { MediaItem } from './types'

export interface SessionRow<S = unknown> {
  key: string
  prompt: string
  summary: string
  at: string
  items: MediaItem[]
  // set for requests made in this tab; history rows only know what the items say
  request?: SessionRequest<S>
}

// a batch is created in one request, so its items land within seconds of each other
const SAME_BATCH_MS = 2 * 60_000

const promptOf = (m: MediaItem) => (m.prompt || m.title || '').trim()
const ms = (iso: string) => new Date(iso).getTime() || 0

function sizeSummary(items: MediaItem[]) {
  const sizes = [...new Set(items.map((m) => (m.width && m.height ? `${m.width}×${m.height}` : null)).filter(Boolean))]
  return sizes.length === 1 ? sizes[0]! : null
}

/**
 * Groups results into one row per generation request, newest first. Requests made in this tab
 * claim their own items; everything else is grouped by matching prompt within a couple of minutes.
 */
export function sessionRows<S>(items: MediaItem[], requests: SessionRequest<S>[]): SessionRow<S>[] {
  const claimed = new Set<string>()
  const rows: SessionRow<S>[] = []

  for (const r of requests) {
    const mine = r.itemIds.map((id) => items.find((m) => m.id === id)).filter((m): m is MediaItem => !!m)
    mine.forEach((m) => claimed.add(m.id))
    if (mine.length) rows.push({ key: r.id, prompt: r.prompt, summary: r.summary, at: r.at, items: mine, request: r })
  }

  let current: SessionRow<S> | null = null
  for (const m of items) {
    if (claimed.has(m.id)) continue
    const p = promptOf(m)
    const last = current?.items[current.items.length - 1]
    if (current && last && p && promptOf(last) === p && Math.abs(ms(last.created_at) - ms(m.created_at)) <= SAME_BATCH_MS) {
      current.items.push(m)
      continue
    }
    current = { key: `h-${m.id}`, prompt: p, summary: '', at: m.created_at, items: [m] }
    rows.push(current)
  }

  for (const r of rows) {
    if (r.request) continue
    const n = r.items.length
    r.summary = [n > 1 ? `${n} ${r.items[0].kind === 'video' ? 'clips' : 'images'}` : null, sizeSummary(r.items)].filter(Boolean).join(' · ')
  }
  return rows.sort((a, b) => ms(b.at) - ms(a.at))
}
