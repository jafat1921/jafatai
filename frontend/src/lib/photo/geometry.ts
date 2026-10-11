import type { Crop, DevelopParams, TransformParams } from './types'

// The develop geometry chain, copied from backend app/photo/geometry.py (the parity fixture's
// "geometry" cases pin the two together). For an output pixel, backwards:
//   frame uv -(crop, rotate, flip, constrain zoom)-> canvas uv -(Transform homography)-> lens uv
//   -(distortion)-> captured uv -(lateral CA: red and blue scaled about the centre)-> texture.

export type Mat3 = number[] // row-major 3×3

export interface Geometry {
  // developed frame size in source pixels
  width: number
  height: number
  // 3×3 column-major affine for the shader: output uv (0..1, top-left origin) → canvas uv
  matrix: Float32Array
  // 3×3 column-major projective: canvas uv → lens uv (identity when there's no Transform)
  warp: Float32Array
  // radial distortion coefficient and the red / blue scale offsets
  k: number
  ca: [number, number]
  // the source's width / height, for the distortion radius and lens vignetting
  aspect: number
  zoom: number
}

export const F_LONG = 1.0
export const TILT_DEG = 20
export const CA_UNIT = 0.005
export const DIST_UNIT = 0.25

const rad = (d: number) => (d * Math.PI) / 180

/** Python's round(): halves go to the even neighbour, so a 45° straighten frames like the server. */
export function roundEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return o
}

export function inv(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det)
}

export function apply(m: Mat3, x: number, y: number): [number, number] {
  const z = m[6] * x + m[7] * y + m[8]
  return [(m[0] * x + m[1] * y + m[2]) / z, (m[3] * x + m[4] * y + m[5]) / z]
}

const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1]
const diag = (a: number, b: number, c = 1): Mat3 => [a, 0, 0, 0, b, 0, 0, 0, c]

function rx(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a)
  return [1, 0, 0, 0, c, -s, 0, s, c]
}
function ry(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a)
  return [c, 0, s, 0, 1, 0, -s, 0, c]
}
function rz(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

function camera(r: Mat3, w: number, h: number): Mat3 {
  const f = F_LONG * Math.max(w, h)
  return mul(mul(diag(f, f), r), diag(1 / f, 1 / f))
}

function recentre(hp: Mat3, w: number, h: number): Mat3 {
  const [cx, cy] = apply(hp, 0, 0)
  const t = mul(translate(-cx, -cy), hp)
  const e = 0.05 * Math.max(w, h)
  const px = apply(t, e, 0), mx = apply(t, -e, 0), py = apply(t, 0, e), my = apply(t, 0, -e)
  const jx = [(px[0] - mx[0]) / (2 * e), (px[1] - mx[1]) / (2 * e)]
  const jy = [(py[0] - my[0]) / (2 * e), (py[1] - my[1]) / (2 * e)]
  const det = Math.abs(jx[0] * jy[1] - jx[1] * jy[0])
  const s = det > 1e-9 ? 1 / Math.sqrt(det) : 1
  return mul(diag(s, s), t)
}

function toUv(hp: Mat3, w: number, h: number): Mat3 {
  const c: Mat3 = [w, 0, -w / 2, 0, h, -h / 2, 0, 0, 1]
  return mul(mul(inv(c), hp), c)
}

const T_DEFAULT = { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0 }

/** Transform's sliders as a forward uv homography (source → canvas); null when all neutral. */
export function manualTransform(t: TransformParams | undefined, w: number, h: number): Mat3 | null {
  const v = { ...T_DEFAULT, ...(t ?? {}) }
  if (![v.vertical, v.horizontal, v.rotate, v.aspect, v.offsetX, v.offsetY].some((x) => Math.abs(x) > 1e-6) && Math.abs(v.scale - 100) < 1e-6) return null
  const r = mul(mul(rz(rad(v.rotate)), rx(rad((-TILT_DEG * v.vertical) / 100))), ry(rad((TILT_DEG * v.horizontal) / 100)))
  let hp = recentre(camera(r, w, h), w, h)
  const a = Math.pow(2, v.aspect / 200)
  const sc = v.scale / 100
  hp = mul(mul(translate((0.25 * w * v.offsetX) / 100, (0.25 * h * v.offsetY) / 100), diag(sc * a, sc / a)), hp)
  return toUv(hp, w, h)
}

/** Upright then the manual sliders: source uv → canvas uv, or null. */
export function transformForward(t: TransformParams | undefined, w: number, h: number): Mat3 | null {
  const up = t?.upright && t.upright !== 'off' && t.uprightMatrix?.length === 9 ? t.uprightMatrix : null
  const m = manualTransform(t, w, h)
  if (!up) return m
  return m ? mul(m, up) : up
}

type GeoParams = Pick<DevelopParams, 'crop' | 'rotate' | 'flipH' | 'flipV' | 'lens' | 'transform'>

/** frame uv → canvas uv for crop, rotate (positive = clockwise; quarter turns turn the frame, the rest
 *  straightens and crops to the largest rectangle of the same aspect) and flip. Row-major. */
export function frameAffine(srcW: number, srcH: number, p: GeoParams): { m: Mat3; width: number; height: number } {
  const c: Crop = p.crop && p.crop.width > 0 && p.crop.height > 0 ? p.crop : { x: 0, y: 0, width: srcW, height: srcH }
  const rot = p.rotate ?? 0
  const quarters = roundEven(rot / 90)
  const rest = rot - quarters * 90
  const turned = Math.abs(quarters) % 2 === 1
  const w = turned ? c.height : c.width
  const h = turned ? c.width : c.height
  const cs = Math.abs(Math.cos(rad(rest)))
  const sn = Math.abs(Math.sin(rad(rest)))
  const s = rest ? Math.min(w / (w * cs + h * sn), h / (w * sn + h * cs)) : 1
  const outW = w * s
  const outH = h * s
  // output uv → centred output px → unflip → unrotate (by -rot) → crop px → source uv
  const th = rad(rot)
  const cos = Math.cos(th)
  const sin = Math.sin(th)
  const fx = p.flipH ? -1 : 1
  const fy = p.flipV ? -1 : 1
  const cx = c.x + c.width / 2
  const cy = c.y + c.height / 2
  const a = (fx * outW * cos) / srcW
  const b = (fy * outH * sin) / srcW
  const d = (-fx * outW * sin) / srcH
  const e = (fy * outH * cos) / srcH
  return { m: [a, b, cx / srcW - 0.5 * (a + b), d, e, cy / srcH - 0.5 * (d + e), 0, 0, 1], width: outW, height: outH }
}

export interface Warp {
  affine: Mat3
  inverse: Mat3 | null
  k: number
  ca: [number, number]
  aspect: number
  zoom: number
}

function canvasToLens(w: Omit<Warp, 'affine' | 'zoom'>, cu: number, cv: number): [number, number] {
  let su = cu
  let sv = cv
  if (w.inverse) {
    const m = w.inverse
    let z = m[6] * cu + m[7] * cv + m[8]
    if (Math.abs(z) < 1e-9) z = 1e-9
    su = z > 0 ? (m[0] * cu + m[1] * cv + m[2]) / z : -1
    sv = (m[3] * cu + m[4] * cv + m[5]) / z
  }
  if (Math.abs(w.k) > 1e-9) {
    const dx = (su - 0.5) * w.aspect
    const dy = sv - 0.5
    const f = 1 + (w.k * (dx * dx + dy * dy)) / (0.25 * (w.aspect * w.aspect + 1))
    su = 0.5 + (su - 0.5) * f
    sv = 0.5 + (sv - 0.5) * f
  }
  return [su, sv]
}

/** The largest zoom (≤ 1) of the canvas about its centre that keeps every edge on picture. */
function constrainZoom(w: Omit<Warp, 'affine' | 'zoom'>): number {
  const n = 32
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    pts.push([t, 0], [t, 1], [0, t], [1, t])
  }
  const inside = (z: number) =>
    pts.every(([u, v]) => {
      const [su, sv] = canvasToLens(w, 0.5 + (u - 0.5) * z, 0.5 + (v - 0.5) * z)
      return su >= -1e-6 && su <= 1 + 1e-6 && sv >= -1e-6 && sv <= 1 + 1e-6
    })
  if (inside(1)) return 1
  let lo = 0.2
  let hi = 1
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (inside(mid)) lo = mid
    else hi = mid
  }
  return lo
}

export function warpFor(srcW: number, srcH: number, p: GeoParams): Warp & { width: number; height: number } {
  const lens = p.lens ?? {}
  const fwd = transformForward(p.transform, srcW, srcH)
  const base = {
    inverse: fwd ? inv(fwd) : null,
    k: (-DIST_UNIT * (lens.distortion ?? 0)) / 100,
    ca: [(CA_UNIT * (lens.caRed ?? 0)) / 100, (CA_UNIT * (lens.caBlue ?? 0)) / 100] as [number, number],
    aspect: srcW / Math.max(1, srcH),
  }
  const fa = frameAffine(srcW, srcH, p)
  let affine = fa.m
  let zoom = 1
  if (p.transform?.constrain && (base.inverse || Math.abs(base.k) > 1e-9)) {
    zoom = constrainZoom(base)
    affine = mul([zoom, 0, 0.5 - 0.5 * zoom, 0, zoom, 0.5 - 0.5 * zoom, 0, 0, 1], affine)
  }
  return { ...base, affine, zoom, width: fa.width, height: fa.height }
}

/** output uv → captured uv (green channel), through the whole chain. */
export function warpUv(w: Warp, u: number, v: number): [number, number] {
  const [cu, cv] = apply(w.affine, u, v)
  return canvasToLens(w, cu, cv)
}

const colMajor = (m: Mat3) => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])

export function geometryFor(srcW: number, srcH: number, p: GeoParams): Geometry {
  const w = warpFor(srcW, srcH, p)
  return {
    width: w.width,
    height: w.height,
    matrix: colMajor(w.affine),
    warp: colMajor(w.inverse ?? I3),
    k: w.k,
    ca: w.ca,
    aspect: w.aspect,
    zoom: w.zoom,
  }
}

/** output uv → captured uv, for a Geometry as the shader gets it. */
export function mapUv(g: Geometry, u: number, v: number): [number, number] {
  const m = g.matrix
  const cu = m[0] * u + m[3] * v + m[6]
  const cv = m[1] * u + m[4] * v + m[7]
  const q = g.warp
  const back: Mat3 = [q[0], q[3], q[6], q[1], q[4], q[7], q[2], q[5], q[8]]
  return canvasToLens({ inverse: back, k: g.k, ca: g.ca, aspect: g.aspect }, cu, cv)
}

// Lightroom's crop list; ratios are width / height in landscape, X turns them portrait
export const ASPECTS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'original', label: 'Original', ratio: 0 },
  { id: '1:1', label: '1 × 1', ratio: 1 },
  { id: '5:4', label: '4 × 5', ratio: 5 / 4 },
  { id: '7:5', label: '5 × 7', ratio: 7 / 5 },
  { id: '3:2', label: '2 × 3', ratio: 3 / 2 },
  { id: '4:3', label: '3 × 4', ratio: 4 / 3 },
  { id: '11:8.5', label: '8.5 × 11', ratio: 11 / 8.5 },
  { id: '16:9', label: '16 × 9', ratio: 16 / 9 },
  { id: '16:10', label: '16 × 10', ratio: 16 / 10 },
  { id: 'custom', label: 'Custom', ratio: null },
]

/** width / height for an aspect choice; null means free. `portrait` is Lightroom's X. */
export function aspectRatio(id: string, src: { w: number; h: number } | null, portrait: boolean, custom: [number, number]): number | null {
  let r: number | null
  if (id === 'custom') r = custom[0] > 0 && custom[1] > 0 ? custom[0] / custom[1] : null
  else if (id === 'original') r = src ? src.w / src.h : null
  else r = ASPECTS.find((a) => a.id === id)?.ratio ?? null
  if (r == null) return null
  return portrait ? 1 / r : r
}

/** The biggest centred crop of a given aspect inside the source. */
export function cropForAspect(srcW: number, srcH: number, ratio: number): Crop {
  const r = ratio || srcW / srcH
  let w = srcW
  let h = w / r
  if (h > srcH) {
    h = srcH
    w = h * r
  }
  return { x: Math.round((srcW - w) / 2), y: Math.round((srcH - h) / 2), width: Math.round(w), height: Math.round(h) }
}

/** The same crop area turned to another aspect, about its centre and as big as fits. */
export function reshapeCrop(c: Crop, ratio: number, srcW: number, srcH: number): Crop {
  const cx = c.x + c.width / 2
  const cy = c.y + c.height / 2
  const area = c.width * c.height
  let w = Math.sqrt(area * ratio)
  let h = w / ratio
  const k = Math.min(1, srcW / w, srcH / h)
  w *= k
  h *= k
  return clampCrop({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, srcW, srcH)
}

/** Keep a crop inside the source and at least 16 px. */
export function clampCrop(c: Crop, srcW: number, srcH: number): Crop {
  const width = Math.max(16, Math.min(srcW, c.width))
  const height = Math.max(16, Math.min(srcH, c.height))
  return {
    x: Math.round(Math.max(0, Math.min(srcW - width, c.x))),
    y: Math.round(Math.max(0, Math.min(srcH - height, c.y))),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/** Straighten tool: the rotate that makes a line drawn on the unturned picture level (or plumb). */
export function straightenAngle(x0: number, y0: number, x1: number, y1: number): number | null {
  const dx = x1 - x0
  const dy = y1 - y0
  if (Math.hypot(dx, dy) < 8) return null
  let a = (Math.atan2(dy, dx) * 180) / Math.PI
  // nearest of level and plumb, so a line drawn up a wall works too
  while (a > 45) a -= 90
  while (a <= -45) a += 90
  return Math.round(-a * 10) / 10
}
