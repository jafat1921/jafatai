import type { Beat, ChunkStatus, Generation, TakeChunk } from './types'
import { SECONDS_PER_TAKE_SECOND } from './shots'

const CHUNK_STATUSES: ChunkStatus[] = ['queued', 'generating', 'done', 'failed']

/** params.chunks comes from the worker as loose JSON; keep only rows we can draw. */
export function chunksOf(take: Pick<Generation, 'params'> | null | undefined): TakeChunk[] {
  const raw = take?.params?.chunks
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is TakeChunk => !!c && typeof c.idx === 'number' && typeof c.t_start === 'number' && typeof c.t_end === 'number')
    .map((c) => ({ ...c, status: CHUNK_STATUSES.includes(c.status) ? c.status : 'queued' }))
    .sort((a, b) => a.idx - b.idx)
}

// Chunk k feeds chunk k+1 its tail frames, so re-rolling k redoes everything after it too.
export const rerollCount = (chunks: TakeChunk[], idx: number) => chunks.filter((c) => c.idx >= idx).length

export const rerollSeconds = (chunks: TakeChunk[], idx: number) =>
  chunks.filter((c) => c.idx >= idx).reduce((t, c) => t + (c.t_end - c.t_start), 0) * SECONDS_PER_TAKE_SECOND

export function chunkSummary(chunks: TakeChunk[]) {
  const n = (s: ChunkStatus) => chunks.filter((c) => c.status === s).length
  const parts = [`${n('done')} of ${chunks.length} done`]
  if (n('generating')) parts.push(`${n('generating')} generating`)
  if (n('failed')) parts.push(`${n('failed')} failed`)
  return parts.join(' · ')
}

/** A user edit always locks the beat, so "Write beats with AI" won't overwrite it (contract v2). */
export function editBeat(beats: Beat[], index: number, prompt: string): Beat[] {
  return beats.map((b, i) => (i === index ? { ...b, prompt, source: 'user', locked: true } : b))
}

export const setBeatLock = (beats: Beat[], index: number, locked: boolean): Beat[] =>
  beats.map((b, i) => (i === index ? { ...b, locked } : b))

// Beats are written for one duration; after a length change the server marks them stale and rewrites
// unlocked ones on the next render. We only need to tell the user.
export function beatsOutOfDate(beats: Beat[], durationS: number) {
  if (!beats.length) return false
  return Math.abs(beats[beats.length - 1].t_end - durationS) > 0.5
}

export const fmtT = (t: number) => `${Number.isInteger(t) ? t : t.toFixed(1)} s`
