import { describe, expect, it } from 'vitest'
import type { Generation } from './types'
import {
  comparePartner,
  detailLabel,
  imageResolutionBadge,
  imageTargetSize,
  previewText,
  upscaledFromText,
  type SizeRule,
} from './imageUpscale'

const redraw: SizeRule = { maxLong: 4096, multiple: 16, maxMp: 8.4 }
const quick: SizeRule = { maxLong: 8192, multiple: 2, maxMp: null }

const gen = (id: string, version: number, params: Record<string, unknown> = {}, parent_id?: string): Generation =>
  ({
    id,
    target_type: 'character',
    target_id: 'c1',
    kind: 'portrait',
    version,
    status: 'ready',
    prompt: 'p',
    params,
    seed: 1,
    media_url: `/m/${id}.png`,
    created_at: '',
    parent_id,
  }) as Generation

describe('imageTargetSize', () => {
  it.each([
    [{ w: 768, h: 1024 }, '2x', redraw, { w: 1536, h: 2048 }],
    [{ w: 1280, h: 720 }, '2k', redraw, { w: 2048, h: 1152 }],
    [{ w: 1280, h: 720 }, '4k', redraw, { w: 3840, h: 2160 }],
    [{ w: 720, h: 1280 }, '4k', quick, { w: 2160, h: 3840 }],
    [{ w: 768, h: 1024 }, '4x', quick, { w: 3072, h: 4096 }],
  ] as const)('%o at %s', (src, target, rule, want) => {
    const plan = imageTargetSize(src, target, rule)
    expect(plan.ok && plan.size).toEqual(want)
  })

  it('keeps the aspect, even sides and the caps', () => {
    const plan = imageTargetSize({ w: 768, h: 1024 }, '4x', redraw)
    if (!plan.ok) throw new Error(plan.reason)
    expect(plan.capped).toBe(true)
    expect(plan.size.w % 16).toBe(0)
    expect(plan.size.w * plan.size.h).toBeLessThanOrEqual(8.4e6)
    expect(Math.abs(plan.size.w / plan.size.h - 0.75)).toBeLessThan(0.02)
  })

  it('refuses a target the image is already at', () => {
    const plan = imageTargetSize({ w: 2048, h: 1152 }, '2k', quick)
    expect(plan.ok).toBe(false)
  })

  it('formats the preview', () => {
    expect(previewText({ w: 768, h: 1024 }, { w: 1536, h: 2048 })).toBe('768×1024 → 1536×2048')
  })
})

describe('detail strength labels', () => {
  it.each([
    [0.15, 'Subtle'],
    [0.24, 'Subtle'],
    [0.33, 'Balanced'],
    [0.39, 'Balanced'],
    [0.4, 'Strong'],
    [0.5, 'Strong'],
  ])('%s is %s', (v, label) => expect(detailLabel(v)).toBe(label))
})

describe('upscaled versions', () => {
  const src = gen('a', 2)
  const up2k = gen('b', 3, { upscale: { engine: 'redraw', target: '2x', width: 1536, height: 2048, source_id: 'a' } }, 'a')
  const up4k = gen('c', 4, { upscale: { engine: 'quick', target: '4k', width: 3840, height: 2160, source_id: 'a', source_version: 2 } })

  it('badges by the long side', () => {
    expect(imageResolutionBadge(up2k)).toBe('2K')
    expect(imageResolutionBadge(up4k)).toBe('4K')
    expect(imageResolutionBadge(src)).toBeNull()
  })

  it('says where it came from', () => {
    expect(upscaledFromText(up2k, [up2k, src])).toBe('Upscaled from v2')
    expect(upscaledFromText(up4k, [up4k])).toBe('Upscaled from v2') // source hidden (rejected) but recorded
    expect(upscaledFromText(src, [src])).toBeNull()
  })

  it('pairs an upscale with its source and back', () => {
    expect(comparePartner(up2k, [up4k, up2k, src])?.id).toBe('a')
    expect(comparePartner(src, [up4k, up2k, src])?.id).toBe('c') // newest finished upscale first
    expect(comparePartner(src, [src])).toBeUndefined()
  })
})
