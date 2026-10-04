import { describe, expect, it } from 'vitest'
import { clip, reelOf } from '@/test/reel-fixtures'
import { filterRenders, rangeLabel, renderInfo, resolveSelection, restitchPayload, stitchPayload, stitchScenes } from './stitch'
import type { Render } from './types'

// four scenes, the third without an approved take
const reel = reelOf([[clip('a')], [clip('b')], [], [clip('d', { duration_s: 4 })]])
const scenes = stitchScenes(reel)

describe('stitch selection', () => {
  it('labels ranges and sets like the server', () => {
    expect(rangeLabel([3])).toBe('Scene 3')
    expect(rangeLabel([5, 2, 3, 4])).toBe('Scenes 2–5')
    expect(rangeLabel([1, 3, 6])).toBe('Scenes 1, 3, 6')
  })

  it('treats every scene with takes as the full film and sends no scene_ids', () => {
    const sel = resolveSelection(scenes, { mode: 'range', from: 1, to: 4, picked: [] })
    expect(sel.full).toBe(true)
    expect(sel.autoTitle).toBe('Full film')
    expect(sel.skipped.map((s) => s.number)).toEqual([3])
    expect(sel.durationS).toBe(20)
    expect(stitchPayload(sel, 'Full film')).toEqual({ quality: 'draft' })
  })

  it('a range skips scenes without takes and labels what is really in it', () => {
    const sel = resolveSelection(scenes, { mode: 'range', from: 2, to: 4, picked: [] })
    expect(sel.label).toBe('Scenes 2, 4')
    expect(stitchPayload(sel, '')).toEqual({ quality: 'draft', scene_ids: ['b', 'd'] })
    expect(stitchPayload(sel, '  Act 2 ')).toEqual({ quality: 'draft', scene_ids: ['b', 'd'], title: 'Act 2' })
  })

  it('a hand-picked set keeps film order', () => {
    const sel = resolveSelection(scenes, { mode: 'pick', from: 1, to: 1, picked: ['d', 'a', 'c'] })
    expect(sel.included.map((s) => s.number)).toEqual([1, 4])
    expect(sel.autoTitle).toBe('Scenes 1, 4')
    expect(stitchPayload(sel, sel.autoTitle).scene_ids).toEqual(['a', 'd'])
  })
})

const T = '2026-10-04T00:00:00Z'
const render = (id: string, params: Record<string, unknown>, status: Render['status'] = 'ready'): Render => ({
  id,
  target_type: 'project',
  target_id: 'p1',
  kind: 'render',
  version: 1,
  status,
  prompt: '',
  params,
  seed: 1,
  media_url: `/api/media/${id}.mp4`,
  created_at: T,
})

describe('renders', () => {
  const old = render('old', { duration_s: 30 })
  const part = render('part', { title: 'Act 2', title_auto: false, full: false, scene_ids: ['b'], scene_range: 'Scene 2' })
  const gone = render('gone', { full: false }, 'rejected')

  it('reads pre-range renders as the full film', () => {
    expect(renderInfo(old)).toMatchObject({ title: 'Full film', full: true, durationS: 30 })
  })

  it('filters full / partial and hides rejected unless asked', () => {
    const list = [old, part, gone]
    expect(filterRenders(list, 'all', false).map((r) => r.id)).toEqual(['old', 'part'])
    expect(filterRenders(list, 'full', false).map((r) => r.id)).toEqual(['old'])
    expect(filterRenders(list, 'partial', true).map((r) => r.id)).toEqual(['part', 'gone'])
  })

  it('re-stitches the same scenes under a typed name', () => {
    expect(restitchPayload(part)).toEqual({ quality: 'draft', scene_ids: ['b'], title: 'Act 2' })
    expect(restitchPayload(old)).toEqual({ quality: 'draft' })
  })
})
