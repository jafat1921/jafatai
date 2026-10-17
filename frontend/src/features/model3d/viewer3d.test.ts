import { describe, expect, it } from 'vitest'
import { FRONT_Z, homePosition, lightPosition } from './viewer3d'

// createViewer needs WebGL, which jsdom hasn't got; where it puts the camera and lights is plain maths
describe('viewer framing', () => {
  it('opens on the front: Pixal3D and TRELLIS.2 models face -Z', () => {
    expect(FRONT_Z).toBe(-1)
    const [x, y, z] = homePosition(4)
    expect(z).toBeLessThan(0)
    expect(z).toBe(-4)
    expect(y).toBeGreaterThan(0)
    expect(Math.abs(x)).toBeCloseTo(1.4)
  })

  it('keeps the key light on the camera’s side', () => {
    const [, , camZ] = homePosition(3)
    const [, ky, kz] = lightPosition([3, 4, 5])
    expect(Math.sign(kz)).toBe(Math.sign(camZ))
    expect(ky).toBe(4)
  })
})
