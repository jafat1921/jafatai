import { describe, expect, it } from 'vitest'
import { moveClip, outPoint, playlist, renderIsFresh, transitionLabel, trimError, trimPatch } from './reel'
import { clip, reelOf } from '@/test/reel-fixtures'

describe('trim', () => {
  it('requires 0 ≤ in < out ≤ source', () => {
    expect(trimError(0, 8, 8)).toBeNull()
    expect(trimError(1.5, 6, 8)).toBeNull()
    expect(trimError(-1, 6, 8)).toMatch(/before 0/)
    expect(trimError(6, 6, 8)).toMatch(/before the out point/)
    expect(trimError(7, 3, 8)).toMatch(/before the out point/)
    expect(trimError(0, 8.5, 8)).toMatch(/past the end of the clip \(8 s\)/)
    expect(trimError(Number.NaN, 3, 8)).toMatch(/seconds/)
    expect(trimError(2, 2.1, 8)).toMatch(/at least 0.25 s/)
  })

  it('stores the out point as seconds cut from the end', () => {
    expect(trimPatch(1.25, 8, 8)).toEqual({ trim_in_s: 1.3, trim_out_s: 0 })
    expect(trimPatch(0, 6.04, 8)).toEqual({ trim_in_s: 0, trim_out_s: 2 })
    expect(outPoint({ trim_out_s: 0, source_duration_s: 8 })).toBe(8)
    expect(outPoint({ trim_out_s: 3, source_duration_s: 8 })).toBe(5)
  })
})

describe('reel helpers', () => {
  it('labels transitions', () => {
    expect(transitionLabel({ transition_in: 'cut', transition_s: 0.5 })).toBe('Cut')
    expect(transitionLabel({ transition_in: 'dissolve', transition_s: 1 })).toBe('Dissolve 1 s')
    expect(transitionLabel({ transition_in: 'fade_black', transition_s: 0.75 })).toBe('Fade 0.8 s')
  })

  it('moves clips only inside their scene and returns the full order', () => {
    const reel = reelOf([[clip('a'), clip('b')], [clip('c')]])
    expect(moveClip(reel, 'b', -1)?.ids).toEqual(['b', 'a', 'c'])
    expect(moveClip(reel, 'a', -1)).toBeNull()
    expect(moveClip(reel, 'c', 1)).toBeNull()
  })

  it('plays enabled clips with their trims, and the render only while every scene is fresh', () => {
    const reel = reelOf([[clip('a', { trim_in_s: 1, trim_out_s: 4 }), clip('b', { enabled: false })]])
    expect(playlist(reel).map((p) => [p.clip.id, p.in, p.out])).toEqual([['a', 1, 4]])
    expect(renderIsFresh(reel)).toBe(false)
    const render = { id: 'r1', status: 'ready', media_url: '/f.mp4' } as never
    expect(renderIsFresh({ ...reel, last_render: render })).toBe(true)
    const stale = reelOf([[clip('a')]], 'stale')
    expect(renderIsFresh({ ...stale, last_render: render })).toBe(false)
  })
})
