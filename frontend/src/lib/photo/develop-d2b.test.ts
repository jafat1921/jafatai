import { describe, expect, it } from 'vitest'
import parity from '@/test/develop-parity.json'
import { nextOverlay, overlayLines, spiralPoints } from './cropOverlays'
import { apply, aspectRatio, frameAffine, geometryFor, inv, manualTransform, mapUv, mul, reshapeCrop, roundEven, straightenAngle, warpFor, warpUv } from './geometry'
import { fringeBand, legacySharpen, upgradeParams } from './maths'
import { changedKeys, compact, keyLabel, needsServer } from './params'
import type { DevelopParams } from './types'
import { pasteGroups, remeasure } from './workflow'

// the server's Warp, mapped at a grid of output points (backend tests/test_develop_parity.py)
describe('geometry matches the server warp', () => {
  for (const [name, g] of Object.entries(parity.geometry)) {
    it(name, () => {
      const w = warpFor(g.w, g.h, g.params as DevelopParams)
      expect(w.zoom).toBeCloseTo(g.zoom, 5)
      const fa = frameAffine(g.w, g.h, g.params as DevelopParams)
      // the server floors to whole pixels; ours stays fractional
      expect(Math.abs(fa.width - g.frame[0])).toBeLessThan(1.01)
      expect(Math.abs(fa.height - g.frame[1])).toBeLessThan(1.01)
      let worst = 0
      for (const [u, v, su, sv] of g.points) {
        const [x, y] = warpUv(w, u, v)
        worst = Math.max(worst, Math.abs(x - su), Math.abs(y - sv))
      }
      expect(worst).toBeLessThan(1e-4)
      // and the shader's column-major copy lands on the same points
      const geo = geometryFor(g.w, g.h, g.params as DevelopParams)
      const [u, v, su, sv] = g.points[7]
      const [x, y] = mapUv(geo, u, v)
      expect(Math.abs(x - su) + Math.abs(y - sv)).toBeLessThan(2e-4)
    })
  }
})

describe('homography maths', () => {
  it('inverts and round-trips', () => {
    const m = manualTransform({ vertical: 30, horizontal: -15, rotate: 2, aspect: 10, scale: 90, offsetX: 5 }, 400, 300)!
    const id = mul(m, inv(m))
    id.forEach((x, i) => expect(x).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i], 9))
    const [x, y] = apply(m, 0.2, 0.7)
    const back = apply(inv(m), x, y)
    expect(back[0]).toBeCloseTo(0.2, 9)
    expect(back[1]).toBeCloseTo(0.7, 9)
    expect(manualTransform({}, 400, 300)).toBeNull()
    // negative Vertical widens the top, the centre stays put
    const top = manualTransform({ vertical: -50 }, 400, 300)!
    expect(apply(top, 1, 0)[0] - apply(top, 0, 0)[0]).toBeGreaterThan(apply(top, 1, 1)[0] - apply(top, 0, 1)[0])
    expect(apply(top, 0.5, 0.5)[0]).toBeCloseTo(0.5, 9)
  })

  it('rounds quarter turns like Python', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5].map(roundEven)).toEqual([0, 2, 2, -0, -2])
  })

  it('straighten tool levels the line it was given', () => {
    expect(straightenAngle(0, 0, 100, 5)).toBeCloseTo(-2.9, 1) // falls to the right: turn back
    expect(straightenAngle(0, 0, 4, 100)).toBeCloseTo(2.3, 1) // nearly plumb works too
    expect(straightenAngle(0, 0, 3, 2)).toBeNull()
  })
})

describe('crop tool', () => {
  it('aspect presets turn with X and keep the crop area', () => {
    expect(aspectRatio('5:4', null, false, [1, 1])).toBeCloseTo(1.25)
    expect(aspectRatio('5:4', null, true, [1, 1])).toBeCloseTo(0.8)
    expect(aspectRatio('custom', null, false, [7, 3])).toBeCloseTo(7 / 3)
    expect(aspectRatio('original', { w: 300, h: 200 }, true, [1, 1])).toBeCloseTo(2 / 3)
    expect(aspectRatio('free', null, true, [1, 1])).toBeNull()
    const c = reshapeCrop({ x: 100, y: 100, width: 300, height: 200 }, 2 / 3, 1000, 800)
    expect(c.width / c.height).toBeCloseTo(2 / 3, 1)
    expect(c.x + c.width / 2).toBeCloseTo(250, -1)
  })

  it('overlays: O cycles, the triangle meets the diagonal at right angles, the spiral stays inside', () => {
    expect(nextOverlay('thirds')).toBe('grid')
    expect(nextOverlay('none')).toBe('thirds')
    const aspect = 1.5
    const { lines } = overlayLines('triangle', aspect)
    const [, , fx, fy] = lines[1]
    // in pixels: (corner -> foot) . diagonal == 0
    expect((fx - 1) * aspect * aspect + (fy - 0)).toBeCloseTo(0, 9)
    const pts = spiralPoints()
    expect(pts.every(([x, y]) => x >= -1e-9 && x <= 1 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9)).toBe(true)
    expect(overlayLines('thirds', 1).lines).toHaveLength(4)
  })
})

describe('params helpers', () => {
  it('moves the old one-slider sharpening and noise into the Lightroom groups', () => {
    const up = upgradeParams<DevelopParams>({ version: 2, sharpness: 40, noiseReduction: 20, exposure: 0.5 })
    expect(up.sharpen).toEqual(legacySharpen(40))
    expect(up.nr).toEqual({ luminance: 20, color: 20 })
    expect(up.sharpness).toBeUndefined()
    expect(upgradeParams({ version: 2, sharpness: 40, sharpen: { amount: 10 } }).sharpen).toEqual({ amount: 10 })
    expect(compact({ sharpness: 40 })).toEqual({ version: 2, sharpen: { amount: 82.5, radius: 1.1, detail: 100 } })
  })

  it('drops the non-zero neutrals and knows what needs the server', () => {
    const p: DevelopParams = { sharpen: { radius: 1, detail: 25 }, nr: { detail: 50 }, lens: { vignetteMidpoint: 50, caAuto: false }, transform: { scale: 100, upright: 'off' } }
    expect(compact(p)).toEqual({ version: 2 })
    expect(changedKeys(p)).toEqual([])
    expect(needsServer({ lens: { distortion: 20, vignette: 30 }, transform: { vertical: 10 } })).toBe(false) // the shader does these
    expect(needsServer({ texture: 10 })).toBe(true)
    expect(needsServer({ lens: { purpleAmount: 5 } })).toBe(true) // the edge mask is server-only
    expect(needsServer({ transform: { upright: 'auto' } })).toBe(true) // not measured yet
    expect(needsServer({ transform: { upright: 'auto', uprightMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] } })).toBe(false)
    expect(changedKeys({ transform: { upright: 'level', constrain: true } })).toEqual(['transform.upright', 'transform.constrain'])
    expect(keyLabel('sharpen.amount')).toBe('Sharpening amount')
    expect(keyLabel('lens.purpleAmount')).toBe('Purple amount')
  })

  it('pasting Upright or auto CA measures them again on this photo', () => {
    const copied: DevelopParams = { transform: { upright: 'vertical', uprightMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, lens: { caAuto: true, caRed: 30, caBlue: -10 } }
    const out = pasteGroups({}, copied, ['transform', 'lens'])
    expect(out.transform).toEqual({ upright: 'vertical', uprightMatrix: null })
    expect(out.lens).toEqual({ caAuto: true, caRed: 0, caBlue: 0 })
    expect(remeasure(copied, ['basic'])).toBe(copied)
  })

  it('the fringe selector picks the band around the clicked hue', () => {
    expect(fringeBand(270, 0.6)).toEqual({ purpleAmount: 8, purpleHueLo: 35, purpleHueHi: 65 })
    expect(fringeBand(120, 0.5)).toEqual({ greenAmount: 8, greenHueLo: 35, greenHueHi: 65 })
    expect(fringeBand(20, 0.8)).toBeNull()
    expect(fringeBand(270, 0.05)).toBeNull()
  })
})
