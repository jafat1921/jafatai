import { useEffect, useState, type RefObject } from 'react'

// Canvas helpers shared by the transport's mini waveform, the editor and the Score a Clip lanes.

/** A colour token from the stylesheet, so the canvas follows the Antique Atelier palette. */
export function token(name: string, fallback: string) {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Sizes the backing store to CSS pixels × devicePixelRatio and returns a context drawing in CSS pixels. */
export function prepare(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(width * dpr))
  const h = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return ctx
}

/**
 * Peaks between two moments as one bar per CSS pixel: each column takes the min and max of the
 * buckets under it, so zooming out never drops a transient.
 */
export function drawPeaks(
  ctx: CanvasRenderingContext2D,
  peaks: [number, number][],
  duration: number,
  from: number,
  to: number,
  width: number,
  height: number,
  colour: string,
) {
  if (!peaks.length || duration <= 0 || to <= from) return
  const per = peaks.length / duration
  const mid = height / 2
  ctx.fillStyle = colour
  for (let x = 0; x < width; x++) {
    const t0 = from + ((to - from) * x) / width
    const t1 = from + ((to - from) * (x + 1)) / width
    let i0 = Math.floor(t0 * per)
    const i1 = Math.max(i0 + 1, Math.ceil(t1 * per))
    if (i0 >= peaks.length) break
    if (i0 < 0) i0 = 0
    let lo = 0
    let hi = 0
    for (let i = i0; i < i1 && i < peaks.length; i++) {
      if (peaks[i][0] < lo) lo = peaks[i][0]
      if (peaks[i][1] > hi) hi = peaks[i][1]
    }
    const top = mid - hi * mid
    const h = Math.max(1, (hi - lo) * mid)
    ctx.fillRect(x, top, 1, h)
  }
}

/** The element's CSS size, kept current. */
export function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const r = el.getBoundingClientRect()
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}
