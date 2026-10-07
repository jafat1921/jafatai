import { describe, expect, it } from 'vitest'
import { shot } from '@/test/storyboard-fixtures'
import type { Job } from '@/lib/types'
import { isContiguous, mergedDuration, moveId, shotActivity, splitDurations, splitText } from './shotList'

const shots = [shot('a', 'sc', 1), shot('b', 'sc', 2), shot('c', 'sc', 3)]

describe('shot list helpers', () => {
  it('only neighbours can merge, in any click order', () => {
    expect(isContiguous(['b', 'a'], shots)).toBe(true)
    expect(isContiguous(['a', 'b', 'c'], shots)).toBe(true)
    expect(isContiguous(['a', 'c'], shots)).toBe(false)
    expect(isContiguous(['a'], shots)).toBe(false)
    expect(isContiguous(['a', 'zz'], shots)).toBe(false)
  })

  it('merged length is the sum, capped at the longest take', () => {
    expect(mergedDuration([{ duration_s: 4 }, { duration_s: 6 }])).toBe(10)
    expect(mergedDuration([{ duration_s: 200 }, { duration_s: 200 }])).toBe(300)
  })

  it('splits text on sentences, then words, like the server', () => {
    expect(splitText('One. Two. Three. Four.', 0.5)).toEqual(['One. Two.', 'Three. Four.'])
    expect(splitText('just some words here', 0.25)).toEqual(['just', 'some words here'])
    expect(splitText('single', 0.5)).toEqual(['single', 'single'])
    expect(splitDurations(6, 0.66)).toEqual([4, 2])
    expect(splitDurations(2, 0.9)).toEqual([1, 1])
  })

  it('moves an id to a new position', () => {
    expect(moveId(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
    expect(moveId(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    const same = ['a', 'b']
    expect(moveId(same, 'a', 5)).toBe(same)
  })

  it('summarises what is in flight: queued, %, ETA, failed', () => {
    const now = Date.parse('2026-10-07T10:01:00Z')
    const running = { id: 'j1', status: 'running', progress: 0.5, started_at: '2026-10-07T10:00:00Z' } as Job
    expect(shotActivity([], [], now)).toBeNull()
    expect(shotActivity([{ status: 'queued', job_id: 'j9' }], [], now)?.label).toBe('Queued')
    const v = shotActivity([{ status: 'generating', job_id: 'j1' }, { status: 'queued', job_id: 'j2' }], [running], now)
    expect(v?.label).toMatch(/^Rendering 50% · ~.+ · 1 queued$/)
    expect(shotActivity([{ status: 'failed', job_id: 'j3' }], [], now)).toMatchObject({ label: 'Failed', tone: 'danger' })
  })
})
