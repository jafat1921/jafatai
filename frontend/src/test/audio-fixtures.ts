import { vi } from 'vitest'
import type { AudioAnalysis, Generation, MediaItem, Peaks } from '@/lib/types'
import { media, T } from './media-fixtures'

// jsdom draws nothing and plays nothing; the audio pages only need both to exist

export function stubCanvas() {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => undefined),
    set: (target, key, value) => {
      target[key as string] = value
      return true
    },
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D)
}

export function stubMedia() {
  const play = vi.fn(() => Promise.resolve())
  const pause = vi.fn(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
  return { play, pause }
}

export function stubObjectUrls(url = 'blob:preview') {
  const create = vi.fn(() => url)
  const revoke = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true })
  return { create, revoke }
}

export const audioItem = (id: string, extra: Partial<MediaItem> = {}) =>
  media(id, {
    kind: 'audio',
    title: 'Rain take',
    width: null,
    height: null,
    duration_s: 10,
    media_url: `/media/${id}.flac`,
    thumb_url: `/media/${id}.png`,
    params: { kind: 'sfx', model: 'sa3_small_sfx' },
    ...extra,
  })

export const gen = (id: string, version: number, extra: Partial<Generation> = {}): Generation => ({
  id,
  target_type: 'media' as Generation['target_type'],
  target_id: 'a1',
  kind: 'audio' as Generation['kind'],
  version,
  status: 'done' as Generation['status'],
  prompt: '',
  params: {},
  seed: null,
  media_url: `/media/${id}.flac`,
  created_at: T,
  ...extra,
})

export const peaksOf = (duration = 10, n = 200): Peaks => ({
  duration_s: duration,
  sample_rate: 44100,
  channels: 2,
  peaks: Array.from({ length: n }, (_, i) => [-(i % 10) / 10, (i % 10) / 10] as [number, number]),
})

export const analysis = (extra: Partial<AudioAnalysis> = {}): AudioAnalysis => ({
  lufs_i: -12,
  lra: 5.5,
  true_peak_db: -0.05,
  sample_peak_db: -0.1,
  clipped_pct: 0.02,
  silences: [],
  flags: ['clipping'],
  ...extra,
})

/** What POST /audio/{id}/preview and /audio/mix/preview answer: mp3 bytes and the measurements. */
export const previewResponse = (lufs = -14, tp = -1) =>
  // a plain string body: undici's Response won't take jsdom's Blob
  new Response('mp3', {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'X-Duration-S': '8', 'X-Lufs-I': String(lufs), 'X-True-Peak-Db': String(tp), 'X-Render-Ms': '180' },
  })
