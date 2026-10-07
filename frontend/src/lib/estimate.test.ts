import { describe, expect, it } from 'vitest'
import { CATALOG } from '@/test/model-fixtures'
import { basisHint, estimateLabel, localEstimate, rangeText, spread } from './estimate'
import { etaSeconds, etaText, jobOpenPath } from './jobs'
import { job } from '@/test/media-fixtures'

const [zimage, qwen] = CATALOG.image
const ltx = CATALOG.video[0]

describe('estimate ranges', () => {
  it('prints seconds, minutes and mixed ranges, collapsing equal ends', () => {
    expect(rangeText(20, 35)).toBe('~20–35 s')
    expect(rangeText(4.2, 6.6)).toBe('~4–7 s')
    expect(rangeText(29, 31)).toBe('~30 s')
    expect(rangeText(240, 370)).toBe('~4–6 min')
    expect(rangeText(45, 130)).toBe('~45 s–2 min')
    expect(rangeText(5400, 9000)).toBe('~1.5–2.5 h')
    // ends given the wrong way round still read low → high
    expect(rangeText(35, 20)).toBe('~20–35 s')
  })

  it('builds the button label from what is known', () => {
    expect(estimateLabel('Generate', '4 images', { low_s: 20, high_s: 35, basis: 'measured' })).toBe('Generate · 4 images · ~20–35 s')
    expect(estimateLabel('Render', '3 takes', { low_s: 300, high_s: 420, basis: 'rough' })).toBe('Render · 3 takes · ~5–7 min')
    expect(estimateLabel('Edit', '1 result', null)).toBe('Edit · 1 result')
  })

  it('guesses locally from the catalog: per output × count, speeds scale, video per 5 s', () => {
    // 7 s × 2, rough: 0.7–1.6
    expect(localEstimate(zimage, { count: 2 })).toEqual({ low_s: 7 * 2 * 0.7, high_s: 7 * 2 * 1.6, basis: 'rough' })
    // Qwen at 4 of 24 steps is about a sixth of 30 s
    expect(localEstimate(qwen, { count: 1, speed: 'lightning4' })?.low_s).toBeCloseTo(5 * 0.7)
    expect(localEstimate({ ...zimage, estimate_source: 'measured' }, { count: 1 })?.basis).toBe('measured')
    expect(localEstimate({ ...ltx, est_seconds: 60 }, { durationS: 10 })).toEqual(spread(120, 'rough'))
    expect(localEstimate({ ...zimage, est_seconds: undefined })).toBeNull()
  })

  it('explains measured vs rough in the tooltip', () => {
    expect(basisHint({ low_s: 1, high_s: 2, basis: 'measured', samples: 14 })).toMatch(/Measured from the last 14 runs/)
    expect(basisHint({ low_s: 1, high_s: 2, basis: 'rough' })).toMatch(/rough guess/)
  })
})

describe('job ETA and Open', () => {
  const now = Date.parse('2026-10-07T10:01:00Z')

  it('uses the server eta when sent, else extrapolates from progress', () => {
    expect(etaSeconds(job('a', { status: 'running', result: { eta_s: 90 } as never }), now)).toBe(90)
    // 60 s for 25 % → 180 s to go
    expect(etaSeconds(job('b', { status: 'running', progress: 0.25, started_at: '2026-10-07T10:00:00Z' }), now)).toBe(180)
    expect(etaSeconds(job('c', { status: 'running', progress: 0.01, started_at: '2026-10-07T10:00:00Z' }), now)).toBeNull()
    expect(etaText(job('d', { status: 'queued' }), now)).toBe('Waiting')
    expect(etaText(job('e', { status: 'running', progress: 0.25, started_at: '2026-10-07T10:00:00Z' }), now)).toBe('~3–4 min left')
  })

  it('opens the right place for a job', () => {
    expect(jobOpenPath(job('q', { type: 'autopilot', project_id: 'p1' }))).toBe('/quick/p1')
    expect(jobOpenPath(job('t', { type: 'take', project_id: 'p1' }))).toBe('/projects/p1/render')
    expect(jobOpenPath(job('i', { type: 'image_generate' }))).toBe('/image/library')
    expect(jobOpenPath(job('v', { type: 'video_generate' }))).toBe('/video/library')
  })
})
