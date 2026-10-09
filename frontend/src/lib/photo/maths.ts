import { HSL_BANDS, type DevelopParams, type LightPoint } from './types'

// The GPU-cheap half of the develop maths (contract v9 §1 + v2 tools from backend app/photo/colour.py).
// The shader in ./shader.ts is a line-by-line copy of this, and develop-parity.json (written by the
// backend tests) pins this file to the server engine.

export type RGB = [number, number, number]
export const PARAMS_VERSION = 2

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export const dec = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
export const enc = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055)
export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

export function smoothstep(e0: number, e1: number, x: number) {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** v1 params kept exposure on a ±100 slider for ±1.5 EV; v2 speaks EV like Lightroom. */
export function upgradeParams<T extends DevelopParams>(p: T): T {
  if ((p.version ?? 1) >= PARAMS_VERSION) return p
  const out = { ...p, version: PARAMS_VERSION }
  if (typeof p.exposure === 'number') out.exposure = Math.round(p.exposure * 15) / 1000
  return out
}

/** Step 5: per-channel linear gains, normalised so grey keeps its brightness. */
export function wbGains(temperature = 0, tint = 0): RGB {
  const t = temperature / 100
  const m = tint / 100
  const g = [(1 + 0.3 * t) * (1 + 0.15 * m), 1 - 0.15 * m, (1 - 0.3 * t) * (1 + 0.15 * m)].map((v) => Math.pow(v, 2.2))
  const y = luma(g[0], g[1], g[2])
  return [g[0] / y, g[1] / y, g[2] / y]
}

export const exposureGain = (ev = 0) => Math.pow(2, ev)

// ---------------------------------------------------------------- calibration

/** Camera primaries: hue turned ±20° about grey, saturation ±50%, rows renormalised (row-major 3×3). */
export function calibrationMatrix(c: DevelopParams['calibration']): number[] | null {
  const v = { redHue: 0, redSat: 0, greenHue: 0, greenSat: 0, blueHue: 0, blueSat: 0, ...(c ?? {}) }
  if (![v.redHue, v.redSat, v.greenHue, v.greenSat, v.blueHue, v.blueSat].some((x) => Math.abs(x) > 0.01)) return null
  const ax = 1 / Math.sqrt(3)
  const cols: number[][] = []
  ;(['red', 'green', 'blue'] as const).forEach((name, i) => {
    const e = [0, 0, 0]
    e[i] = 1
    const g = 1 / 3
    const ch = e.map((x) => x - g)
    const th = (((20 * v[`${name}Hue`]) / 100) * Math.PI) / 180
    // axis × ch, with axis = (1,1,1)/√3
    const cr = [ax * (ch[2] - ch[1]), ax * (ch[0] - ch[2]), ax * (ch[1] - ch[0])]
    const k = 1 + (0.5 * v[`${name}Sat`]) / 100
    cols.push(ch.map((x, j) => g + (x * Math.cos(th) + cr[j] * Math.sin(th)) * k))
  })
  const m: number[] = []
  for (let r = 0; r < 3; r++) {
    const row = [cols[0][r], cols[1][r], cols[2][r]]
    const sum = row[0] + row[1] + row[2]
    m.push(...row.map((x) => x / sum))
  }
  return m
}

// ---------------------------------------------------------------- tone

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

const bump = (x: number, c: number, half: number) => {
  const t = (x - c) / (half * 1.5)
  return Math.max(0, 1 - t * t) ** 2
}

/** Lightroom's region curve: four soft bumps between the split points. */
export function parametric(x: number, pc: NonNullable<DevelopParams['pcurve']>): number {
  const [s1, s2, s3] = [(pc.s1 ?? 25) / 100, (pc.s2 ?? 50) / 100, (pc.s3 ?? 75) / 100].sort((a, b) => a - b)
  const regions: [number, number, number][] = [
    [pc.shadows ?? 0, s1 / 2, s1 / 2],
    [pc.darks ?? 0, (s1 + s2) / 2, (s2 - s1) / 2],
    [pc.lights ?? 0, (s2 + s3) / 2, (s3 - s2) / 2],
    [pc.highlights ?? 0, (s3 + 1) / 2, (1 - s3) / 2],
  ]
  let out = 0
  for (const [amt, c, half] of regions) if (Math.abs(amt) > 0.01) out += ((0.15 * amt) / 100) * bump(x, c, Math.max(half, 0.02))
  return out
}

const parametricActive = (pc: DevelopParams['pcurve']) => !!pc && ['highlights', 'lights', 'darks', 'shadows'].some((k) => Math.abs((pc as Record<string, number>)[k] ?? 0) > 0.01)

/** Fritsch–Carlson monotone cubic through points (0..255 each axis); x in 0..1. */
export function monotone(points: [number, number][], x: number): number {
  const map = new Map<number, number>()
  for (const [px, py] of points) map.set(Math.round(px), py)
  const pts = [...map.entries()].sort((a, b) => a[0] - b[0])
  if (!pts.length || pts[0][0] > 0) pts.unshift([0, 0])
  if (pts[pts.length - 1][0] < 255) pts.push([255, 255])
  const xs = pts.map((p) => p[0] / 255)
  const ys = pts.map((p) => p[1] / 255)
  const n = xs.length
  if (n === 2) return clamp01(ys[0] + ((ys[1] - ys[0]) * (x - xs[0])) / (xs[1] - xs[0]))
  const d = xs.slice(1).map((_, i) => (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  const m = new Array(n).fill(0)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
    } else {
      const a = m[i] / d[i]
      const b = m[i + 1] / d[i]
      const r = a * a + b * b
      if (r > 9) {
        const t = 3 / Math.sqrt(r)
        m[i] = t * a * d[i]
        m[i + 1] = t * b * d[i]
      }
    }
  }
  let i = 0
  while (i < n - 2 && x >= xs[i + 1]) i++
  const h = xs[i + 1] - xs[i]
  const t = (x - xs[i]) / h
  const t2 = t * t
  const t3 = t2 * t
  return clamp01((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1])
}

const pointsActive = (pts: [number, number][] | undefined) => !!pts?.some(([x, y]) => Math.abs(x - y) > 0.5)

export interface ToneTables {
  master: Float32Array | null
  // per channel once a red/green/blue curve is set (each already includes the master)
  chans: [Float32Array, Float32Array, Float32Array] | null
}

export function toneActive(p: DevelopParams) {
  return ['contrast', 'highlights', 'shadows', 'whites', 'blacks'].some((k) => Math.abs((p as Record<string, number>)[k] ?? 0) > 0.01) ||
    Object.values(p.curve ?? {}).some((v) => Math.abs(v ?? 0) > 0.01) || parametricActive(p.pcurve) ||
    (['rgb', 'red', 'green', 'blue'] as const).some((c) => pointsActive(p.points?.[c]))
}

/** The whole tone stage as tables over 0..1 (sRGB in, sRGB out). */
export function toneTables(p: DevelopParams, n = 4096): ToneTables {
  if (!toneActive(p)) return { master: null, chans: null }
  const y = toneCurve(p, n)
  if (parametricActive(p.pcurve)) {
    let run = 0
    for (let i = 0; i < n; i++) {
      const v = clamp01(y[i] + parametric(y[i], p.pcurve!))
      run = i === 0 ? v : Math.max(run, v)
      y[i] = run
    }
  }
  if (pointsActive(p.points?.rgb)) for (let i = 0; i < n; i++) y[i] = monotone(p.points!.rgb!, y[i])
  const ch = (['red', 'green', 'blue'] as const).map((c) => p.points?.[c])
  if (!ch.some(pointsActive)) return { master: y, chans: null }
  const chans = ch.map((pts) => (pointsActive(pts) ? y.map((v) => monotone(pts!, v)) : y.slice())) as [Float32Array, Float32Array, Float32Array]
  return { master: null, chans }
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

/** RGBA float texture data (256×1) for the shader: R, G, B curves (identity when the tone stage is off). */
export function toneTexture(t: ToneTables, size = 256): Float32Array {
  const out = new Float32Array(size * 4)
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    for (let c = 0; c < 3; c++) out[i * 4 + c] = t.chans ? sampleCurve(t.chans[c], x) : t.master ? sampleCurve(t.master, x) : x
    out[i * 4 + 3] = 1
  }
  return out
}

/** Curves change saturation as a side effect; Refine below 100 pulls chroma back toward `before`. */
export function refineSaturation(before: RGB, after: RGB, refine: number): RGB {
  const ca = Math.max(...after) - Math.min(...after)
  const cb = Math.max(...before) - Math.min(...before)
  const y = luma(after[0], after[1], after[2])
  let k = ca > 1e-5 ? cb / Math.max(ca, 1e-5) : 1
  k = 1 + (1 - refine) * (Math.min(k, 4) - 1)
  return after.map((c) => clamp01(y + (c - y) * k)) as RGB
}

// ---------------------------------------------------------------- HSV tools

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

const hueDist = (h: number, c: number) => {
  const d = Math.abs(h - c) % 360
  return Math.min(d, 360 - d)
}

export type PointColor = NonNullable<DevelopParams['pointColor']>[number]

/** Point Color on an HSV triple: each sampled colour moves the pixels near it. */
export function pointColor(hsv: RGB, entries: PointColor[]): RGB {
  let [h, s, v] = hsv
  for (const e of entries) {
    const whW = 6 + (84 * (e.hueRange ?? 50)) / 100
    const wsW = 0.05 + (0.95 * (e.satRange ?? 50)) / 100
    const wvW = 0.05 + (0.95 * (e.lumRange ?? 50)) / 100
    let w = 1 - smoothstep(0.5 * whW, whW, hueDist(h, e.hue))
    w *= 1 - smoothstep(0.5 * wsW, wsW, Math.abs(s - e.sat))
    w *= 1 - smoothstep(0.5 * wvW, wvW, Math.abs(v - e.val))
    w *= smoothstep(0.02, 0.1, s)
    h = h + w * 30 * ((e.dh ?? 0) / 100)
    s = clamp01(s * (1 + (w * (e.ds ?? 0)) / 100))
    v = clamp01(v * (1 + (0.5 * w * (e.dl ?? 0)) / 100))
  }
  return [h, s, v]
}

export function bandValue(h: number, mix: Partial<Record<string, number>>): number {
  const hues = [...BAND_HUES, 360]
  const vals = [...HSL_BANDS.map((b) => mix[b] ?? 0), mix[HSL_BANDS[0]] ?? 0]
  const x = ((h % 360) + 360) % 360
  for (let i = 0; i < hues.length - 1; i++) {
    if (x <= hues[i + 1]) return vals[i] + ((vals[i + 1] - vals[i]) * (x - hues[i])) / (hues[i + 1] - hues[i])
  }
  return vals[0]
}

/** B&W: linear luminance brightened or darkened by the band the colour falls in. Returns linear grey. */
export function bwMix(lin: RGB, h: number, s: number, mix: Partial<Record<string, number>>): number {
  const y = luma(lin[0], lin[1], lin[2])
  return clamp01(y * (1 + ((s * bandValue(h, mix)) / 100) * 0.6))
}

// ---------------------------------------------------------------- grading

export function hueRgbLinear(hue: number): RGB {
  const h6 = (((hue % 360) + 360) % 360) / 60
  const srgb = [clamp01(Math.abs(h6 - 3) - 1), clamp01(2 - Math.abs(h6 - 2)), clamp01(2 - Math.abs(h6 - 4))]
  const lin = srgb.map(dec)
  const y = luma(lin[0], lin[1], lin[2])
  return lin.map((c) => c / y) as RGB
}

export type Grading = NonNullable<DevelopParams['grading']>
const ZONES = ['global', 'shadows', 'midtones', 'highlights'] as const

export function gradingActive(g: DevelopParams['grading']) {
  return !!g && ZONES.some((z) => Math.abs(g[z]?.s ?? 0) > 0.01 || Math.abs(g[z]?.l ?? 0) > 0.01)
}

export function grade(lin: RGB, yp: number, g: Grading): RGB {
  const m = 0.5 - (0.25 * (g.balance ?? 0)) / 100
  const k = 1 / (0.5 + (g.blending ?? 50) / 100)
  const ws = Math.pow(clamp01(1 - yp / m), k)
  const wh = Math.pow(clamp01((yp - m) / (1 - m)), k)
  const wm = clamp01(1 - ws - wh)
  const weight = { global: 1, shadows: ws, midtones: wm, highlights: wh }
  let out = lin
  for (const z of ZONES) {
    const zone = g[z]
    const s = zone?.s ?? 0
    const l = zone?.l ?? 0
    if (Math.abs(s) < 0.01 && Math.abs(l) < 0.01) continue
    const w = weight[z]
    if (Math.abs(s) > 0.01) {
      const t = hueRgbLinear(zone?.h ?? 0)
      out = out.map((c, i) => c * (1 + (t[i] - 1) * ((0.6 * s) / 100) * w)) as RGB
    }
    if (Math.abs(l) > 0.01) {
      const f = Math.pow(2, ((0.5 * l) / 100) * w)
      out = out.map((c) => c * f) as RGB
    }
  }
  return out.map(clamp01) as RGB
}

export function shadowTint(lin: RGB, yp: number, tint: number): RGB {
  const k = ((0.15 * tint) / 100) * (1 - yp) ** 2
  return [clamp01(lin[0] * (1 + k)), clamp01(lin[1] * (1 - k)), clamp01(lin[2] * (1 + k))]
}

// ---------------------------------------------------------------- vignette and grain

export interface VignetteParams {
  amount: number
  midpoint: number
  roundness: number
  feather: number
  highlights: number
  style: 'highlight' | 'color' | 'paint'
}

export function vignetteAlpha(u: number, v: number, aspect: number, vp: VignetteParams): number {
  let dx = u - 0.5
  let dy = v - 0.5
  const r = vp.roundness / 100
  if (r > 0) {
    const [sx, sy] = aspect >= 1 ? [1 + r * (aspect - 1), 1] : [1, 1 + r * (1 / aspect - 1)]
    const mx = Math.max(sx, sy)
    dx = (dx * sx) / mx
    dy = (dy * sy) / mx
  }
  const pw = 2 + 6 * Math.max(0, -r)
  const d = Math.pow(Math.pow(Math.abs(dx), pw) + Math.pow(Math.abs(dy), pw), 1 / pw) / 0.75
  const e0 = 0.1 + (0.8 * vp.midpoint) / 100
  const e1 = e0 + 0.05 + (0.9 * vp.feather) / 100
  return ((0.8 * Math.abs(vp.amount)) / 100) * smoothstep(e0, e1, d)
}

export function applyVignette(lin: RGB, a: number, vp: VignetteParams, yp: number): RGB {
  if (vp.amount >= 0) return lin.map((c) => c + (1 - c) * a) as RGB
  if (vp.style === 'paint') return lin.map((c) => c * (1 - a)) as RGB
  let aa = a
  if (vp.highlights > 0) aa *= 1 - (vp.highlights / 100) * smoothstep(0.6, 1, yp)
  // colour priority darkens luminance only, so hue and saturation stay put (same scale on every channel)
  return lin.map((c) => c * (1 - aa)) as RGB
}

/** Kept for older callers: the v1 vignette, which is the v2 one at its default shape. */
export function vignetteAt(lin: RGB, x: number, y: number, vignette: number): RGB {
  if (!vignette) return lin
  const vp: VignetteParams = { amount: vignette, midpoint: 50, roundness: 0, feather: 50, highlights: 0, style: 'highlight' }
  return applyVignette(lin, vignetteAlpha(x, y, 1, vp), vp, 0)
}

/** Integer hash -> -1..1, identical to the server's uint32 maths and the shader's. */
export function hash2(x: number, y: number): number {
  let h = (Math.imul(x >>> 0, 374761393) + Math.imul(y >>> 0, 668265263)) >>> 0
  h = Math.imul((h ^ (h >>> 13)) >>> 0, 1274126177) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return ((h & 0xffffff) / 16777215) * 2 - 1
}

function valueNoise(fx: number, fy: number): number {
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  let tx = fx - x0
  let ty = fy - y0
  tx = tx * tx * (3 - 2 * tx)
  ty = ty * ty * (3 - 2 * ty)
  const xi = x0 & 0xffff
  const yi = y0 & 0xffff
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

export interface GrainParams {
  amount: number
  size: number
  roughness: number
}

export function grainAt(u: number, v: number, frameLong: number, gp: GrainParams): number {
  const cell = 1 + (3 * gp.size) / 100
  const fx = (u * frameLong) / cell
  const fy = (v * frameLong) / cell
  let n = valueNoise(fx, fy)
  const rough = gp.roughness / 100
  if (rough > 0.01) n = n * (1 - 0.5 * rough) + 0.5 * rough * valueNoise(fx * 2.3 + 17, fy * 2.3 + 31)
  return ((0.12 * gp.amount) / 100) * n
}

// ---------------------------------------------------------------- light points

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

// ---------------------------------------------------------------- the pixel

export type Lut3 = (rgb: RGB) => RGB

export interface Prepared {
  gains: RGB
  calib: number[] | null
  tone: Float32Array
  tables: ToneTables
  refine: number
  table: RGB[]
  pointColor: PointColor[]
  bw: Partial<Record<string, number>> | null
  vib: number
  sat: number
  grading: Grading | null
  shadowTint: number
  vignette: number
  vig: VignetteParams
  grain: GrainParams
}

export function prepare(p: DevelopParams): Prepared {
  const wb = wbGains(p.temperature, p.tint)
  const ex = exposureGain(p.exposure)
  return {
    gains: [wb[0] * ex, wb[1] * ex, wb[2] * ex],
    calib: calibrationMatrix(p.calibration),
    tone: toneCurve(p),
    tables: toneTables(p),
    refine: (p.refineSat ?? 100) / 100,
    table: hslTable(p),
    pointColor: p.pointColor ?? [],
    bw: p.treatment === 'bw' ? (p.bw ?? {}) : null,
    vib: (p.vibrance ?? 0) / 100,
    sat: (p.saturation ?? 0) / 100,
    grading: gradingActive(p.grading) ? p.grading! : null,
    shadowTint: p.calibration?.shadowsTint ?? 0,
    vignette: p.vignette ?? 0,
    vig: {
      amount: p.vignette ?? 0, midpoint: p.vignetteMidpoint ?? 50, roundness: p.vignetteRoundness ?? 0, feather: p.vignetteFeather ?? 50,
      highlights: p.vignetteHighlights ?? 0, style: p.vignetteStyle ?? 'highlight',
    },
    grain: { amount: p.grainAmount ?? 0, size: p.grainSize ?? 25, roughness: p.grainRoughness ?? 50 },
  }
}

export interface PixelPlace {
  // 0..1 across the developed frame
  u?: number
  v?: number
  aspect?: number
  frameLong?: number
  stops?: number
  profile?: { lut: Lut3; amount: number } | null
  look?: { lut: Lut3; amount: number } | null
}

/**
 * One sRGB pixel (0..1) through the point operations, in the server engine's order:
 * calibration, WB + exposure, profile, tone (+ refine), HSL, Point Color, B&W or vibrance/saturation,
 * look, colour grading, shadow tint, vignette, grain.
 */
export function developPixel(rgb: RGB, pp: Prepared, x = 0.5, y = 0.5, stops = 0, place: PixelPlace = {}): RGB {
  const u = place.u ?? x
  const v = place.v ?? y
  const k = Math.pow(2, place.stops ?? stops)
  let lin = rgb.map(dec) as RGB
  if (pp.calib) {
    const m = pp.calib
    lin = [0, 1, 2].map((r) => Math.max(0, m[r * 3] * lin[0] + m[r * 3 + 1] * lin[1] + m[r * 3 + 2] * lin[2])) as RGB
  }
  lin = lin.map((c, i) => clamp01(c * pp.gains[i] * k)) as RGB
  let p = lin.map(enc) as RGB
  if (place.profile) {
    const q = place.profile.lut(p)
    const a = place.profile.amount
    p = p.map((c, i) => clamp01(c + (q[i] - c) * a)) as RGB
  }
  if (pp.tables.master || pp.tables.chans) {
    const before = p
    p = pp.tables.chans ? (p.map((c, i) => sampleCurve(pp.tables.chans![i], c)) as RGB) : (p.map((c) => sampleCurve(pp.tables.master!, c)) as RGB)
    if (pp.refine < 0.999) p = refineSaturation(before, p, pp.refine)
  }
  const h = applyHsl(p, pp.table)
  p = h.rgb
  let s = h.s
  let bwDone = false
  if (pp.pointColor.length || pp.bw) {
    let hsv = rgbToHsv(p[0], p[1], p[2])
    if (pp.pointColor.length) {
      hsv = pointColor(hsv, pp.pointColor)
      p = hsvToRgb(hsv[0], hsv[1], hsv[2])
      s = hsv[1]
    }
    if (pp.bw) {
      const g = enc(bwMix(p.map(dec) as RGB, hsv[0], hsv[1], pp.bw))
      p = [g, g, g]
      bwDone = true
    }
  }
  lin = p.map(dec) as RGB
  if (!bwDone) {
    const f = (1 + 0.6 * pp.vib * (1 - s)) * (1 + pp.sat)
    if (f !== 1) {
      const yl = luma(lin[0], lin[1], lin[2])
      lin = lin.map((c) => clamp01(yl + (c - yl) * f)) as RGB
    }
  }
  if (place.look) {
    const pb = lin.map(enc) as RGB
    const q = place.look.lut(pb)
    lin = pb.map((c, i) => dec(c + (q[i] - c) * place.look!.amount)) as RGB
  }
  if (pp.grading || Math.abs(pp.shadowTint) > 0.01) {
    const yp = enc(clamp01(luma(lin[0], lin[1], lin[2])))
    if (pp.grading) lin = grade(lin, yp, pp.grading)
    if (Math.abs(pp.shadowTint) > 0.01) lin = shadowTint(lin, yp, pp.shadowTint)
  }
  if (Math.abs(pp.vignette) > 0.005) {
    const yp = enc(clamp01(luma(lin[0], lin[1], lin[2])))
    lin = applyVignette(lin, vignetteAlpha(u, v, place.aspect ?? 1, pp.vig), pp.vig, yp)
  }
  let out = lin.map((c) => enc(clamp01(c))) as RGB
  if (pp.grain.amount > 0.5) {
    const n = grainAt(u, v, place.frameLong ?? 1000, pp.grain)
    out = out.map((c) => clamp01(c + n)) as RGB
  }
  return out
}

/** Trilinear lookup into a size³ RGB table (red fastest), as the server's apply_lut and the shader's texture. */
export function lut3(table: Uint8Array | Float32Array, size: number, scale = table instanceof Uint8Array ? 1 / 255 : 1): Lut3 {
  return (rgb) => {
    const f = rgb.map((c) => clamp01(c) * (size - 1))
    const i0 = f.map((x) => Math.min(Math.floor(x), size - 2))
    const t = f.map((x, i) => x - i0[i])
    const at = (r: number, g: number, b: number, c: number) => table[((b * size + g) * size + r) * 3 + c] * scale
    const out: RGB = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      let acc = 0
      for (let dr = 0; dr < 2; dr++) for (let dg = 0; dg < 2; dg++) for (let db = 0; db < 2; db++) {
        const w = (dr ? t[0] : 1 - t[0]) * (dg ? t[1] : 1 - t[1]) * (db ? t[2] : 1 - t[2])
        acc += w * at(i0[0] + dr, i0[1] + dg, i0[2] + db, c)
      }
      out[c] = acc
    }
    return out
  }
}
