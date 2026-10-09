import { describe, expect, it, vi } from 'vitest'
import { geometryFor, mapUv } from './geometry'
import { histogramOf } from './histogram'
import { applyHsl, dec, developPixel, enc, exposureGain, hslTable, prepare, toneCurve, toneLut, wbGains, type RGB } from './maths'
import { changedKeys, compact, mergeParams, needsServer, scaleParams, setValue } from './params'
import { createRenderer, hasWebGL2 } from './shader'
import { initUndo, push, redo, undo } from './undo'

// Reference values worked out by hand from contract-v9 §1 (sRGB transfer, step 5 gains, step 6).
const FIXTURES = {
  exposurePlusOneStop: { in: 0.5, out: 0.685836 },
  exposurePlusOneStopDark: { in: 0.2, out: 0.285384 },
  warmGains: [1.580634, 0.887475, 0.404922],
  warmGrey: [0.616644, 0.47307, 0.325801],
}

const close = (a: number[], b: number[], eps = 1e-4) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)))

describe('develop maths (WebGL preview reference)', () => {
  it('sRGB transfer round-trips', () => {
    for (const v of [0, 0.01, 0.04045, 0.2, 0.5, 0.93, 1]) expect(enc(dec(v))).toBeCloseTo(v, 6)
  })

  it('identity params leave every pixel alone', () => {
    const pp = prepare({})
    for (const px of [[0, 0, 0], [0.5, 0.5, 0.5], [0.9, 0.2, 0.1], [0.12, 0.6, 0.85], [1, 1, 1]] as RGB[]) {
      close(developPixel(px, pp, 0.1, 0.9), px, 1e-3)
    }
  })

  it('exposure +1 stop doubles linear light', () => {
    expect(exposureGain(100 / 1.5)).toBeCloseTo(2, 6)
    const pp = prepare({ exposure: 100 / 1.5 })
    const { exposurePlusOneStop: a, exposurePlusOneStopDark: b } = FIXTURES
    close(developPixel([a.in, a.in, a.in], pp), [a.out, a.out, a.out], 1e-3)
    close(developPixel([b.in, b.in, b.in], pp), [b.out, b.out, b.out], 1e-3)
  })

  it('white balance warms without changing the brightness of grey', () => {
    const g = wbGains(100, 0)
    close(g, FIXTURES.warmGains, 1e-5)
    expect(0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]).toBeCloseTo(1, 6)
    close(developPixel([0.5, 0.5, 0.5], prepare({ temperature: 100 })), FIXTURES.warmGrey, 1e-3)
    // tint: magenta lifts red and blue against green
    const t = wbGains(0, 60)
    expect(t[0]).toBeGreaterThan(t[1])
    expect(t[2]).toBeGreaterThan(t[1])
  })

  it('tone curve is monotonic, even when the sliders fight it', () => {
    const p = { contrast: 100, curve: { shadows: 100, mids: -100, highlights: 60 }, blacks: -100, whites: 100, highlights: -100 }
    for (const curve of [toneCurve(p), toneLut(p)]) {
      for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1])
      expect(curve[0]).toBeGreaterThanOrEqual(0)
      expect(curve[curve.length - 1]).toBeLessThanOrEqual(1)
    }
    const id = toneLut({})
    expect(id[0]).toBe(0)
    expect(id[128]).toBeCloseTo(128 / 255, 5)
    expect(id[255]).toBeCloseTo(1, 6)
    // curve offsets: ±100 is ±0.5 at the anchor
    expect(toneCurve({ curve: { mids: 50 } })[2048]).toBeCloseTo(0.5 + 0.25, 2)
  })

  it('HSL leaves greys untouched and shifts only nearby bands', () => {
    const table = hslTable({ hsl: { red: { s: -100 } } })
    expect(applyHsl([0.5, 0.5, 0.5], table).rgb).toEqual([0.5, 0.5, 0.5])
    const red = applyHsl([0.8, 0.1, 0.1], table)
    expect(red.s).toBeCloseTo(0, 5)
    // a pure blue is past red's neighbours: no change
    expect(applyHsl([0.1, 0.1, 0.8], table).rgb).toEqual([0.1, 0.1, 0.8])
  })

  it('saturation -100 is monochrome', () => {
    const [r, g, b] = developPixel([0.8, 0.3, 0.1], prepare({ saturation: -100 }))
    expect(r).toBeCloseTo(g, 4)
    expect(g).toBeCloseTo(b, 4)
  })

  it('dark vignette only touches the corners', () => {
    const pp = prepare({ vignette: -100 })
    close(developPixel([0.5, 0.5, 0.5], pp, 0.5, 0.5), [0.5, 0.5, 0.5], 1e-4)
    expect(developPixel([0.5, 0.5, 0.5], pp, 0, 0)[0]).toBeLessThan(0.4)
  })
})

describe('geometry', () => {
  it('identity maps output uv straight onto the source', () => {
    const g = geometryFor(400, 200, {})
    expect([g.width, g.height]).toEqual([400, 200])
    close(mapUv(g, 0, 0), [0, 0])
    close(mapUv(g, 1, 1), [1, 1])
  })

  it('crop narrows the source window', () => {
    const g = geometryFor(400, 200, { crop: { x: 100, y: 50, width: 200, height: 100 } })
    expect([g.width, g.height]).toEqual([200, 100])
    close(mapUv(g, 0, 0), [0.25, 0.25])
    close(mapUv(g, 1, 1), [0.75, 0.75])
  })

  it('a quarter turn clockwise turns the frame and puts the top on the right', () => {
    const g = geometryFor(400, 200, { rotate: 90 })
    expect(g.width).toBeCloseTo(200)
    expect(g.height).toBeCloseTo(400)
    // right-middle of the output is the top-middle of the source
    close(mapUv(g, 1, 0.5), [0.5, 0])
  })

  it('straightening shrinks to the largest rectangle of the same aspect, and flips mirror', () => {
    const g = geometryFor(400, 400, { rotate: 10 })
    expect(g.width).toBeLessThan(400)
    expect(g.width / g.height).toBeCloseTo(1, 6)
    const f = geometryFor(400, 200, { flipH: true })
    close(mapUv(f, 0, 0.5), [1, 0.5])
  })
})

describe('params helpers', () => {
  it('sets dotted keys immutably and compacts zeros away', () => {
    const a = setValue({}, 'hsl.red.s', 20)
    const b = setValue(a, 'exposure', 0)
    expect(a).toEqual({ hsl: { red: { s: 20 } } })
    expect(compact(b)).toEqual({ hsl: { red: { s: 20 } } })
    expect(changedKeys(b)).toEqual(['hsl.red.s'])
  })

  it('merges looks over params and scales by intensity', () => {
    const merged = mergeParams({ exposure: 10, curve: { mids: 5 } }, scaleParams({ contrast: 40, curve: { whites: 20 } }, 0.5))
    expect(merged).toEqual({ exposure: 10, contrast: 20, curve: { mids: 5, whites: 10 } })
  })

  it('knows which edits need the server for an exact preview', () => {
    expect(needsServer({ exposure: 30 })).toBe(false)
    expect(needsServer({ clarity: 30 })).toBe(true)
    expect(needsServer({ lut: { look_id: 'l1', amount: 100 } })).toBe(true)
  })
})

describe('histogram', () => {
  it('bins, normalises to the tallest bin and counts clipping', () => {
    const px = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255])
    const h = histogramOf(px)
    expect(h.r[0]).toBe(1)
    expect(h.r[255]).toBe(1)
    expect(h.luma[128]).toBe(1)
    expect(h.clipped.shadows).toBeCloseTo(1 / 3)
    expect(h.clipped.highlights).toBeCloseTo(1 / 3)
  })
})

describe('undo', () => {
  it('folds one drag into a single step', () => {
    let s = initUndo(0)
    s = push(s, 1, 'drag', 0)
    s = push(s, 2, 'drag', 100)
    s = push(s, 3, null, 200)
    expect(s.past).toEqual([0, 2])
    s = undo(s)
    expect(s.present).toBe(2)
    s = undo(s)
    expect(s.present).toBe(0)
    s = redo(s)
    expect(s.present).toBe(2)
  })
})

describe('WebGL feature detection', () => {
  it('falls back when WebGL2 is missing', () => {
    const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement
    expect(hasWebGL2(() => canvas)).toBe(false)
    expect(createRenderer(canvas)).toBeNull()
  })

  it('falls back when the shader will not build', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gl = {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      createProgram: () => ({}),
      createShader: () => ({}),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => false,
      getShaderInfoLog: () => 'no highp',
    }
    const canvas = { getContext: vi.fn(() => gl) } as unknown as HTMLCanvasElement
    expect(hasWebGL2(() => canvas)).toBe(true)
    expect(createRenderer(canvas)).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
