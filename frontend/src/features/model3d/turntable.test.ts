import { afterEach, describe, expect, it, vi } from 'vitest'
import { canRecord, pickMime, recordCanvas } from './turntable'

class FakeRecorder {
  static supported = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  static last: FakeRecorder | null = null
  static isTypeSupported = (m: string) => FakeRecorder.supported.includes(m)
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(
    public stream: MediaStream,
    public opts: MediaRecorderOptions,
  ) {
    FakeRecorder.last = this
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['frames'], { type: 'video/webm' }) })
    this.onstop?.()
  }
}

const track = { stop: vi.fn() }
function canvas() {
  const c = document.createElement('canvas')
  c.captureStream = vi.fn(() => ({ getTracks: () => [track] }) as unknown as MediaStream)
  return c
}

// a clock that moves a second each frame, and frames that run straight away
function clock() {
  let t = 0
  return { now: () => t, frame: (cb: () => void) => queueMicrotask(() => ((t += 1000), cb())) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeRecorder.supported = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  delete (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream
})

describe('turntable recording', () => {
  it('prefers VP9, falls back to VP8 or plain WebM, and says no without MediaRecorder', () => {
    expect(pickMime()).toBeNull()
    expect(canRecord()).toBe(false)
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    expect(pickMime()).toBe('video/webm;codecs=vp9')
    FakeRecorder.supported = ['video/webm']
    expect(pickMime()).toBe('video/webm')
    // no captureStream on the canvas (jsdom, old Safari): still no
    expect(canRecord()).toBe(false)
    HTMLCanvasElement.prototype.captureStream = vi.fn()
    expect(canRecord()).toBe(true)
  })

  it('draws one full turn over the length and hands back a WebM', async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    const c = canvas()
    const draw = vi.fn()
    const progress = vi.fn()
    const video = await recordCanvas(c, draw, { seconds: 4, ...clock(), onProgress: progress })
    expect(video.type).toBe('video/webm')
    expect(c.captureStream).toHaveBeenCalledWith(30)
    expect(FakeRecorder.last?.opts.mimeType).toBe('video/webm;codecs=vp9')
    expect(draw.mock.calls.map(([s]) => s)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(progress).toHaveBeenLastCalledWith(1)
    expect(track.stop).toHaveBeenCalled()
  })

  it('stops and rejects with an AbortError when cancelled', async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    const ctl = new AbortController()
    const draw = vi.fn((share: number) => share >= 0.5 && ctl.abort())
    await expect(recordCanvas(canvas(), draw, { seconds: 4, ...clock(), signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(draw).toHaveBeenCalledTimes(3)
    expect(FakeRecorder.last?.state).toBe('inactive')
  })
})
