import { HSL_BANDS, type DevelopParams, type LightPoint } from './types'

// The GPU-cheap half of contract-v9 §1 "The maths". The shader in ./shader.ts is a line-by-line copy of
// this; keep the two in step (photo-maths.test.ts pins both to the contract's formulas).

export type RGB = [number, number, number]

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export const dec = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
export const enc = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055)
export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

export function smoothstep(e0: number, e1: number, x: number) {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** Step 5: per-channel linear gains, normalised so grey keeps its brightness. */
export function wbGains(temperature = 0, tint = 0): RGB {
  const t = temperature / 100
  const m = tint / 100
  const g = [(1 + 0.3 * t) * (1 + 0.15 * m), 1 - 0.15 * m, (1 - 0.3 * t) * (1 + 0.15 * m)].map((v) => Math.pow(v, 2.2))
  const y = luma(g[0], g[1], g[2])
  return [g[0] / y, g[1] / y, g[2] / y]
}

export const exposureGain = (exposure = 0) => Math.pow(2, (1.5 * exposure) / 100)

const gauss = (t: number, mu: number, s: number) => Math.exp(-((t - mu) ** 2) / (2 * s * s))

/** Step 10, sampled at `n` points and made monotonic with a running maximum. */
export function toneCurve(p: DevelopParams, n = 4096): Float32Array {
  const c = p.curve ?? {}
  const anchors = [c.blacks ?? 0, c.shadows ?? 0, c.mids ?? 0, c.highlights ?? 0, c.whites ?? 0].map((v) => (0.5 * v) / 100)
  const a = (0.5 * (p.contrast ?? 0)) / 100
  const bl = (p.blacks ?? 0) / 100
  const sh = (p.shadows ?? 0) / 100
  const hi = (p.highlights ?? 0) / 100
  const wh = (p.whites ?? 0) / 100
  const out = new Float32Array(n)
  let run = 0
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1)
    const t = x + a * (x - 0.5) * 4 * x * (1 - x)
    const seg = Math.min(3, Math.floor(clamp01(t) / 0.25))
    const u = (clamp01(t) - seg * 0.25) / 0.25
    const o = anchors[seg] * (1 - u) + anchors[seg + 1] * u
    const regional = 0.35 * (bl * gauss(t, 0.05, 0.1) + sh * gauss(t, 0.25, 0.18) + hi * gauss(t, 0.7, 0.18) + wh * gauss(t, 0.92, 0.1))
    const v = clamp01(t + o + regional)
    run = i === 0 ? v : Math.max(run, v)
    out[i] = run
  }
  return out
}

/** Linear lookup into a curve table; the shader does the same with two texel fetches. */
export function sampleCurve(curve: ArrayLike<number>, x: number) {
  const f = clamp01(x) * (curve.length - 1)
  const i = Math.floor(f)
  const j = Math.min(curve.length - 1, i + 1)
  return curve[i] + (curve[j] - curve[i]) * (f - i)
}

/** The 256-entry table the shader gets as a texture, taken from the 4096-point curve. */
export function toneLut(p: DevelopParams, size = 256): Float32Array {
  const full = toneCurve(p)
  const lut = new Float32Array(size)
  for (let i = 0; i < size; i++) lut[i] = sampleCurve(full, i / (size - 1))
  return lut
}

export function rgbToHsv(r: number, g: number, b: number): RGB {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max === 0 ? 0 : d / max, max]
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const hh = (((h % 360) + 360) % 360) / 60
  const c = v * s
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = v - c
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
  return [r + m, g + m, b + m]
}

export const BAND_HUES = [0, 30, 60, 120, 180, 240, 270, 300]

/** The two neighbouring band centres around a hue, and how far between them it sits. */
export function bandBlend(hue: number): { i: number; j: number; t: number } {
  for (let i = 0; i < BAND_HUES.length; i++) {
    const lo = BAND_HUES[i]
    const hiHue = i === BAND_HUES.length - 1 ? 360 : BAND_HUES[i + 1]
    if (hue >= lo && hue < hiHue) return { i, j: (i + 1) % BAND_HUES.length, t: (hue - lo) / (hiHue - lo) }
  }
  return { i: 0, j: 1, t: 0 }
}

/** The 8 bands as [h, s, l] in -1..1, in BAND_HUES order. */
export function hslTable(p: DevelopParams): RGB[] {
  return HSL_BANDS.map((b) => {
    const v = p.hsl?.[b] ?? {}
    return [(v.h ?? 0) / 100, (v.s ?? 0) / 100, (v.l ?? 0) / 100]
  })
}

/** Step 11 on an sRGB pixel. Returns the new pixel and the HSV saturation step 12 needs. */
export function applyHsl(rgb: RGB, table: RGB[]): { rgb: RGB; s: number } {
  const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2])
  const w = smoothstep(0.02, 0.1, s)
  if (w === 0) return { rgb, s }
  const { i, j, t } = bandBlend(h)
  const adj = [0, 1, 2].map((k) => table[i][k] * (1 - t) + table[j][k] * t)
  if (!adj[0] && !adj[1] && !adj[2]) return { rgb, s }
  const nh = h + w * 30 * adj[0]
  const ns = clamp01(s * (1 + w * adj[1]))
  const nv = clamp01(v * (1 + 0.5 * w * adj[2]))
  return { rgb: hsvToRgb(nh, ns, nv), s: ns }
}

export function vignetteAt(lin: RGB, x: number, y: number, vignette: number): RGB {
  if (!vignette) return lin
  const d = Math.sqrt((x - 0.5) ** 2 + (y - 0.5) ** 2) / 0.75
  const a = 0.8 * Math.abs(vignette / 100) * smoothstep(0.5, 1, d)
  return vignette < 0 ? (lin.map((c) => c * (1 - a)) as RGB) : (lin.map((c) => c + (1 - c) * a) as RGB)
}

/**
 * Light points without the luma-similarity term (that needs the whole picture): a plain Gaussian
 * in stops. Coordinates are already in output pixels.
 */
export function lightStops(px: number, py: number, points: { x: number; y: number; f: number; e: number }[]) {
  let stops = 0
  for (const p of points) {
    const d2 = (px - p.x) ** 2 + (py - p.y) ** 2
    stops += ((1.5 * p.e) / 100) * Math.exp(-d2 / (2 * p.f * p.f))
  }
  return stops
}

/** Light points scaled from their reference frame (default: the full-size developed frame) onto `w`×`h`. */
export function pointsFor(points: LightPoint[] | undefined, w: number, h: number, fullW = w, fullH = h) {
  return (points ?? []).slice(0, 16).map((p) => {
    const rw = p.refW || fullW
    const rh = p.refH || fullH
    const k = w / rw
    return { x: p.x * k, y: p.y * (h / rh), f: (p.falloff ?? 0.25 * Math.max(rw, rh)) * k, e: p.exposure }
  })
}

export interface Prepared {
  gains: RGB
  tone: Float32Array
  table: RGB[]
  vib: number
  sat: number
  vignette: number
}

export function prepare(p: DevelopParams): Prepared {
  const wb = wbGains(p.temperature, p.tint)
  const ex = exposureGain(p.exposure)
  return {
    gains: [wb[0] * ex, wb[1] * ex, wb[2] * ex],
    tone: toneCurve(p),
    table: hslTable(p),
    vib: (p.vibrance ?? 0) / 100,
    sat: (p.saturation ?? 0) / 100,
    vignette: p.vignette ?? 0,
  }
}

/**
 * One sRGB pixel (0..1) through steps 4–14 minus the spatial and LUT steps. (x, y) is the pixel's
 * position on the developed frame in 0..1, for the vignette; `stops` is any local light.
 */
export function developPixel(rgb: RGB, pp: Prepared, x = 0.5, y = 0.5, stops = 0): RGB {
  const k = Math.pow(2, stops)
  let lin = rgb.map((c, i) => clamp01(dec(c) * pp.gains[i] * k)) as RGB
  let p = lin.map(enc) as RGB
  p = p.map((c) => sampleCurve(pp.tone, c)) as RGB
  const h = applyHsl(p, pp.table)
  lin = h.rgb.map(dec) as RGB
  const f = (1 + 0.6 * pp.vib * (1 - h.s)) * (1 + pp.sat)
  if (f !== 1) {
    const yl = luma(lin[0], lin[1], lin[2])
    lin = lin.map((c) => clamp01(yl + (c - yl) * f)) as RGB
  }
  lin = vignetteAt(lin, x, y, pp.vignette)
  return lin.map((c) => enc(clamp01(c))) as RGB
}
