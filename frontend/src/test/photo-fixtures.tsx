import { vi } from 'vitest'
import { FALLBACK_GROUPS, FALLBACK_RANGES } from '@/lib/photo/params'
import type { HistoryVersion, Look, PhotoHistory, PhotoSchema } from '@/lib/photo/types'
import type { Generation } from '@/lib/types'
import { T } from './media-fixtures'

export const schema: PhotoSchema = {
  version: 1,
  defaults: {},
  ranges: FALLBACK_RANGES,
  groups: [...FALLBACK_GROUPS, { id: 'geometry', label: 'Crop & rotate', keys: ['crop', 'rotate', 'flipH', 'flipV'] }, { id: 'look', label: 'Look', keys: ['lut'] }],
  hsl_bands: [
    { id: 'red', label: 'Red', hue: 0 },
    { id: 'orange', label: 'Orange', hue: 30 },
    { id: 'yellow', label: 'Yellow', hue: 60 },
    { id: 'green', label: 'Green', hue: 120 },
    { id: 'aqua', label: 'Aqua', hue: 180 },
    { id: 'blue', label: 'Blue', hue: 240 },
    { id: 'purple', label: 'Purple', hue: 270 },
    { id: 'magenta', label: 'Magenta', hue: 300 },
  ],
  spatial_keys: ['clarity', 'sharpness', 'noiseReduction', 'lightPoints'],
  formats: [
    { id: 'jpeg', label: 'JPEG', media_type: 'image/jpeg' },
    { id: 'png', label: 'PNG', media_type: 'image/png' },
    { id: 'png16', label: 'PNG 16-bit', media_type: 'image/png' },
    { id: 'tiff16', label: 'TIFF 16-bit', media_type: 'image/tiff' },
  ],
}

export const gen = (id: string, extra: Partial<Generation> = {}): Generation => ({
  id,
  target_type: 'media',
  target_id: 'm1',
  kind: 'image',
  version: 1,
  status: 'ready',
  prompt: 'Lighthouse at dusk',
  params: {},
  seed: 1,
  media_url: `/api/media/${id}.jpg`,
  thumb_url: `/api/media/thumb/${id}?w=512`,
  media_type: 'image/jpeg',
  created_at: T,
  ...extra,
})

export const version = (g: Generation, extra: Partial<HistoryVersion> = {}): HistoryVersion => ({
  generation: g,
  current: false,
  edit: null,
  develop: null,
  effect: null,
  look: null,
  ...extra,
})

// v1 the upload, v2 developed from it (current)
export const history = (): PhotoHistory => ({
  target_type: 'media',
  target_id: 'm1',
  current_id: 'g2',
  versions: [
    version(gen('g2', { version: 2, parent_id: 'g1' }), {
      current: true,
      edit: 'develop',
      develop: { params: { version: 1, exposure: 20, contrast: 10 }, parent: 'g1', base: 'g1', format: 'jpeg' },
    }),
    version(gen('g1', { kind: 'upload' })),
  ],
})

export const look = (id: string, extra: Partial<Look> = {}): Look => ({
  id,
  name: `Look ${id}`,
  source: 'builtin',
  params: { contrast: 40, saturation: -20 },
  has_cube: false,
  editable: false,
  ...extra,
})

/** No WebGL in jsdom: the page runs on the server preview, which these tests mock. */
export function stubBrowser() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  let n = 0
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => `blob:preview-${++n}`), revokeObjectURL: vi.fn() }))
}

export const jpeg = () => new Response('jpeg', { status: 200, headers: { 'Content-Type': 'image/jpeg', 'X-Develop-Ms': '84' } })
