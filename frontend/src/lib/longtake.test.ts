import { describe, expect, it } from 'vitest'
import { beatsOutOfDate, chunkSummary, chunksOf, editBeat, rerollCount } from './longtake'
import type { Beat, TakeChunk } from './types'

const beats: Beat[] = [
  { t_start: 0, t_end: 8, prompt: 'descends', source: 'ai', locked: false },
  { t_start: 7, t_end: 15, prompt: 'turns', source: 'ai', locked: false },
]
const chunk = (idx: number, status: TakeChunk['status']): TakeChunk => ({ idx, t_start: idx * 7, t_end: idx * 7 + 8, frames: 193, status })

describe('beats', () => {
  it('locks a beat when the user edits it and leaves the others alone', () => {
    const next = editBeat(beats, 1, 'turns toward the light')
    expect(next[1]).toEqual({ t_start: 7, t_end: 15, prompt: 'turns toward the light', source: 'user', locked: true })
    expect(next[0]).toBe(beats[0])
  })

  it('notices beats written for another length', () => {
    expect(beatsOutOfDate(beats, 15)).toBe(false)
    expect(beatsOutOfDate(beats, 30)).toBe(true)
    expect(beatsOutOfDate([], 30)).toBe(false)
  })
})

describe('chunks', () => {
  it('reads params.chunks defensively and in order', () => {
    const take = { params: { chunks: [chunk(1, 'done'), { junk: true }, { ...chunk(0, 'done'), status: 'weird' }] } }
    expect(chunksOf(take).map((c) => [c.idx, c.status])).toEqual([
      [0, 'queued'],
      [1, 'done'],
    ])
    expect(chunksOf({ params: {} })).toEqual([])
  })

  it('counts the chunk and everything after it for a re-roll', () => {
    const list = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => chunk(i, 'done'))
    expect(rerollCount(list, 0)).toBe(8)
    expect(rerollCount(list, 5)).toBe(3)
    expect(rerollCount(list, 7)).toBe(1)
  })

  it('summarises progress', () => {
    expect(chunkSummary([chunk(0, 'done'), chunk(1, 'generating'), chunk(2, 'failed'), chunk(3, 'queued')])).toBe(
      '1 of 4 done · 1 generating · 1 failed',
    )
  })
})
