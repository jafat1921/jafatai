import type { Histogram } from './types'

/**
 * Same shape as the server's /histogram: 256 bins per channel plus luma, scaled so the tallest bin of
 * all four is 1, and the share of clipped pixels. `step` samples every n-th pixel to stay cheap.
 */
export function histogramOf(rgba: ArrayLike<number>, step = 1): Histogram {
  const r = new Array<number>(256).fill(0)
  const g = new Array<number>(256).fill(0)
  const b = new Array<number>(256).fill(0)
  const luma = new Array<number>(256).fill(0)
  let n = 0
  let lo = 0
  let hi = 0
  const stride = 4 * Math.max(1, Math.floor(step))
  for (let i = 0; i + 2 < rgba.length; i += stride) {
    const R = rgba[i]
    const G = rgba[i + 1]
    const B = rgba[i + 2]
    r[R]++
    g[G]++
    b[B]++
    luma[Math.min(255, Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B))]++
    if (R === 0 || G === 0 || B === 0) lo++
    if (R === 255 || G === 255 || B === 255) hi++
    n++
  }
  const top = Math.max(1, ...r, ...g, ...b, ...luma)
  const norm = (a: number[]) => a.map((v) => v / top)
  return { r: norm(r), g: norm(g), b: norm(b), luma: norm(luma), clipped: { shadows: n ? lo / n : 0, highlights: n ? hi / n : 0 } }
}
