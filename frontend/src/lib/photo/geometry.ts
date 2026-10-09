import type { Crop, DevelopParams } from './types'

export interface Geometry {
  // developed frame size in source pixels
  width: number
  height: number
  // 3×3 column-major affine: output uv (0..1, top-left origin) → source uv
  matrix: Float32Array
}

const rad = (d: number) => (d * Math.PI) / 180

/**
 * Crop, then rotate (positive = clockwise; quarter turns turn the frame, the rest straightens and
 * crops to the largest rectangle of the same aspect), then flip. Contract-v9 §1 step 2.
 */
export function geometryFor(srcW: number, srcH: number, p: Pick<DevelopParams, 'crop' | 'rotate' | 'flipH' | 'flipV'>): Geometry {
  const c: Crop = p.crop && p.crop.width > 0 && p.crop.height > 0 ? p.crop : { x: 0, y: 0, width: srcW, height: srcH }
  const rot = p.rotate ?? 0
  const quarters = Math.round(rot / 90)
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
  // x' = fx*(u-0.5)*outW, y' = fy*(v-0.5)*outH;  x = x'cos + y'sin, y = -x'sin + y'cos
  const a = (fx * outW * cos) / srcW
  const b = (fy * outH * sin) / srcW
  const d = (-fx * outW * sin) / srcH
  const e = (fy * outH * cos) / srcH
  const tx = cx / srcW - 0.5 * (a + b)
  const ty = cy / srcH - 0.5 * (d + e)
  return { width: outW, height: outH, matrix: new Float32Array([a, d, 0, b, e, 0, tx, ty, 1]) }
}

export function mapUv(g: Geometry, u: number, v: number): [number, number] {
  const m = g.matrix
  return [m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]]
}

export const ASPECTS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'original', label: 'Original', ratio: 0 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
]

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
