// Recording a canvas to a video in the browser (contract v40 §7). No three.js in here, so it can be tested
// and loaded without the viewer.

export const TURNTABLE = { seconds: 6, size: 1080, fps: 30 }

// VP9 is smaller and sharper; older Safari and some Firefox builds only have VP8, or say "webm" and pick
const MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

export function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  if (typeof MediaRecorder.isTypeSupported !== 'function') return 'video/webm'
  return MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null
}

export function canRecord(): boolean {
  return pickMime() !== null && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
}

export const PAPER = '#f4ead5' // --panel-raised: the viewer's plain backdrop

export function paintBackdrop(ctx: CanvasRenderingContext2D, size: number, backdrop: 'plain' | 'checker') {
  if (backdrop === 'plain') {
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, size, size)
    return
  }
  // the same greys as the page's .checker, scaled so the squares read at 1080
  const cell = Math.round(size / 40)
  ctx.fillStyle = '#f4f4f4'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#d9d9d9'
  for (let y = 0; y < size; y += cell) {
    for (let x = (y / cell) % 2 ? cell : 0; x < size; x += cell * 2) ctx.fillRect(x, y, cell, cell)
  }
}

export interface RecordOpts {
  seconds?: number
  fps?: number
  signal?: AbortSignal
  onProgress?: (share: number) => void
  // injectable so tests don't depend on the page's frame clock
  frame?: (cb: () => void) => void
  now?: () => number
}

/** Records `canvas` while `draw(share)` paints it, share running 0 → 1 over `seconds`. Time-based, so a
 * slow machine drops frames rather than stretching the turn. Rejects with an AbortError on cancel. */
export function recordCanvas(canvas: HTMLCanvasElement, draw: (share: number) => void, opts: RecordOpts = {}): Promise<Blob> {
  const { seconds = TURNTABLE.seconds, fps = TURNTABLE.fps, signal, onProgress } = opts
  const frame = opts.frame ?? ((cb) => requestAnimationFrame(() => cb()))
  const now = opts.now ?? (() => performance.now())
  const mime = pickMime()
  if (!mime) return Promise.reject(new Error('This browser can’t record video.'))
  if (signal?.aborted) return Promise.reject(new DOMException('Recording cancelled', 'AbortError'))

  return new Promise<Blob>((resolve, reject) => {
    const stream = canvas.captureStream(fps)
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
    const chunks: Blob[] = []
    let cancelled = false
    rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data)
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      if (cancelled) reject(new DOMException('Recording cancelled', 'AbortError'))
      else resolve(new Blob(chunks, { type: mime.split(';')[0] }))
    }
    const stop = () => rec.state !== 'inactive' && rec.stop()
    signal?.addEventListener('abort', () => {
      cancelled = true
      stop()
    })

    draw(0)
    rec.start(500)
    const start = now()
    const step = () => {
      if (cancelled) return
      const share = Math.min(1, (now() - start) / (seconds * 1000))
      draw(share)
      onProgress?.(share)
      if (share >= 1) stop()
      else frame(step)
    }
    frame(step)
  })
}
