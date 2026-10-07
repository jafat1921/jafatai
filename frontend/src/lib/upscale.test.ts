import { describe, expect, it } from 'vitest'
import { planText, planUpscale, readSegments, resolutionLabel, segmentLine, targetBox, upscaleEstimate } from './upscale'

describe('planUpscale', () => {
  it('picks the smallest engine pass that reaches the box, then fits inside it with even sizes', () => {
    const src = { w: 768, h: 448 }
    const plan = planUpscale(src, '1080p', [2, 4])
    expect(plan.ok).toBe(true)
    expect(plan.scale).toBe(4) // ×2 only reaches 1536×896
    expect(plan.upscaled).toEqual({ w: 3072, h: 1792 })
    expect(plan.final).toEqual({ w: 1850, h: 1080 })
    expect(planText(src, plan)).toBe('768×448 → 3072×1792 (×4) → 1850×1080, fit to the 1920×1080 box')
  })

  it('skips the fit step when the pass lands exactly on the box', () => {
    const plan = planUpscale({ w: 960, h: 540 }, '1080p', [2, 4])
    expect(plan.scale).toBe(2)
    expect(planText({ w: 960, h: 540 }, plan)).toBe('960×540 → 1920×1080 (×2)')
  })

  it('refuses targets beyond the engine scale, or not bigger than the source', () => {
    const fourK = planUpscale({ w: 768, h: 448 }, '4k', [2, 4])
    expect(fourK.ok).toBe(false)
    expect(fourK.reason).toMatch(/Needs ×4\.8 from 768×448; this engine goes up to ×4/)
    const same = planUpscale({ w: 1920, h: 1080 }, '1080p', [2])
    expect(same.ok).toBe(false)
    expect(same.reason).toMatch(/already 1920×1080/)
  })

  it('turns the box for portrait video', () => {
    expect(targetBox('1080p', { w: 720, h: 1280 })).toEqual({ w: 1080, h: 1920 })
    expect(planUpscale({ w: 720, h: 1280 }, '1080p', [2]).final).toEqual({ w: 1080, h: 1920 })
  })
})

describe('upscale metadata', () => {
  it('labels resolution from the upscale params, or the plain size', () => {
    expect(resolutionLabel({ params: { upscale: { target: '4k' } } })).toBe('4K')
    expect(resolutionLabel({ params: { width: 1920, height: 1080 } })).toBe('1080p')
    expect(resolutionLabel({ params: {} })).toBeNull()
  })

  it('describes segment progress, preferring the job message', () => {
    const segs = readSegments({
      params: {
        segments: [
          { idx: 1, t_start: 3.5, t_end: 7.5, status: 'generating' },
          { idx: 0, t_start: 0, t_end: 4, status: 'done' },
          { idx: 2, t_start: 7, t_end: 10, status: 'queued' },
        ],
      },
    })
    expect(segs.map((s) => s.idx)).toEqual([0, 1, 2])
    expect(segmentLine(segs)).toBe('Segment 2 of 3')
    expect(segmentLine(segs, 'Segment 14 of 120')).toBe('Segment 14 of 120')
    expect(segmentLine(segs.map((s) => ({ ...s, status: 'done' as const })))).toBe('All 3 segments done, joining')
  })

  it('estimates GPU time from the per-second rate', () => {
    const e = { id: 'fast', label: 'FlashVSR', available: true, scales: [2], est_gpu_s_per_output_s: 8 } as const
    expect(upscaleEstimate({ ...e, scales: [2] }, 60)).toBe('About 8 min on the GPU')
    expect(upscaleEstimate({ ...e, scales: [2] }, null)).toBeNull()
  })
})
