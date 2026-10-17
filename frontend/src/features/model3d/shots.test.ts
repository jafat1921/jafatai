import { describe, expect, it } from 'vitest'
import { adBriefHref, productsFromQuery } from '@/lib/ads'
import { fitDistance, SHOT_ANGLES, shotPosition, shotFile } from './shots'
import { FRONT_Z } from './viewer3d'

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6))

describe('product shot framing', () => {
  it('puts every angle at the same distance, the front on the model’s facing side', () => {
    const d = fitDistance(1, 35)
    expect(d).toBeCloseTo((1 / Math.sin((35 * Math.PI) / 360)) * 1.18, 6)
    for (const a of SHOT_ANGLES) expect(Math.hypot(...shotPosition(a, d, FRONT_Z))).toBeCloseTo(d, 6)
    close(shotPosition({ azimuth: 0, elevation: 0 }, 2, -1), [0, 0, -2])
    close(shotPosition({ azimuth: 180, elevation: 0 }, 2, -1), [0, 0, 2])
    // seen from -Z the viewer's left is +X
    expect(shotPosition({ azimuth: 40, elevation: 0 }, 2, -1)[0]).toBeGreaterThan(0)
    expect(shotPosition({ azimuth: -40, elevation: 0 }, 2, -1)[0]).toBeLessThan(0)
    expect(shotPosition(SHOT_ANGLES.find((a) => a.id === 'top')!, 2, -1)[1]).toBeGreaterThan(1.4)
  })

  it('offers six angles, five kept by default, named for the route', () => {
    expect(SHOT_ANGLES.map((a) => a.id)).toEqual(['front', 'left', 'right', 'side', 'top', 'back'])
    expect(SHOT_ANGLES.filter((a) => a.keep)).toHaveLength(5)
    expect(shotFile('top')).toBe('top.png')
  })

  it('carries ids to the brief and back, three at most', () => {
    expect(adBriefHref(['a', 'b', 'c', 'd'])).toBe('/image/ads?products=a,b,c')
    expect(productsFromQuery(new URLSearchParams('products=a, b,b,<x>,c,d'))).toEqual(['a', 'b', 'c'])
    expect(productsFromQuery(new URLSearchParams(''))).toEqual([])
  })
})
