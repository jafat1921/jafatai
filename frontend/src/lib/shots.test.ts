import { describe, expect, it } from 'vitest'
import { nextCurrent } from '@/hooks/useShots'
import { frame, scene, shot } from '@/test/storyboard-fixtures'
import { buildUnits, canRender, estimateRenderSeconds, groupShots, startFrameOf } from './shots'

describe('shots helpers', () => {
  const scenes = [scene('b', 1), scene('a', 0)]
  const a1 = shot('a1', 'a', 0, { end_frame: frame('ea1', 'keyframe_end', 'a1', 'approved') })
  const a2 = shot('a2', 'a', 1, { seam_in: 'continue' })
  const b1 = shot('b1', 'b', 0)

  it('groups shots by scene order and builds rows for both views', () => {
    const groups = groupShots(scenes, [b1, a2, a1])
    expect(groups.map((g) => g.shots.map((s) => s.id))).toEqual([['a1', 'a2'], ['b1']])
    const sceneRows = buildUnits('scenes', groups)
    expect(sceneRows.map((u) => [u.startShot.id, u.endShot.id])).toEqual([
      ['a1', 'a2'],
      ['b1', 'b1'],
    ])
    expect(sceneRows[1].prevShot?.id).toBe('a2')
    expect(buildUnits('shots', groups, 'a').map((u) => u.key)).toEqual(['a1', 'a2'])
  })

  it('links a Continue START to the previous END and gates rendering on it', () => {
    expect(startFrameOf(a2, a1)).toMatchObject({ linked: true, frame: { id: 'ea1' } })
    expect(canRender(a2, a1)).toBe(true)
    expect(canRender(b1, a2)).toBe(false)
  })

  it('estimates ≈30 s of GPU per 5 s take', () => {
    expect(estimateRenderSeconds([shot('x', 'a', 0, { duration_s: 5 })], 3)).toBe(90)
  })

  it('keeps an approved frame current while a new version renders', () => {
    const approved = frame('g1', 'keyframe_start', 'a1', 'approved')
    const queued = { ...frame('g2', 'keyframe_start', 'a1', 'queued'), version: 2 }
    expect(nextCurrent(approved, queued)).toBe(approved)
    expect(nextCurrent(null, queued)).toBe(queued)
    expect(nextCurrent(approved, { ...approved, status: 'rejected' })).toBeUndefined()
  })
})
