import { spread } from './estimate'
import type { Engine3D, EstimateResult, Make3DRequest, MediaItem, ModelInfo, Quality3D } from './types'

// contract-v40-3d-studio.md

export interface Form3D {
  sourceId: string | null
  engine: Engine3D
  quality: Quality3D
  removeBackground: boolean
}

export const DEFAULT_FORM_3D: Form3D = { sourceId: null, engine: 'pixal3d', quality: 'final', removeBackground: true }

export const ENGINES: { id: Engine3D; label: string; hint: string }[] = [
  { id: 'pixal3d', label: 'Pixal3D', hint: 'True to the picture' },
  { id: 'trellis2', label: 'TRELLIS.2', hint: 'General' },
]

export const QUALITIES: { id: Quality3D; label: string; hint: string }[] = [
  { id: 'draft', label: 'Draft', hint: 'About half the time, lighter mesh and 2K textures' },
  { id: 'final', label: 'Final', hint: 'Full detail, 4K textures' },
]

// the server's rough share of a Final run (app/model3d.py QUALITY_FACTOR)
const QUALITY_FACTOR: Record<Quality3D, number> = { draft: 0.45, final: 1 }
const FALLBACK_S: Record<Engine3D, number> = { pixal3d: 300, trellis2: 270 }

export function make3dPayload(form: Form3D): Make3DRequest | null {
  if (!form.sourceId) return null
  return { source_id: form.sourceId, engine: form.engine, quality: form.quality, remove_background: form.removeBackground }
}

export function blocked3d(form: Form3D, engine: ModelInfo | undefined): string | null {
  if (!form.sourceId) return 'Add a picture first.'
  if (engine && !engine.available) return `${engine.label} isn't available right now${engine.reason ? `: ${engine.reason}` : '.'}`
  return null
}

export function local3dEstimate(engine: ModelInfo | undefined, id: Engine3D, quality: Quality3D): EstimateResult {
  const final = engine?.est_seconds ?? FALLBACK_S[id]
  return spread(final * QUALITY_FACTOR[quality], engine?.estimate_source === 'measured' ? 'measured' : 'rough')
}

export const isModelReady = (m: MediaItem) => (m.status ?? 'ready') === 'ready' || m.status === 'approved'

// "Teapot · 3D" -> "teapot-3d"; a file name that survives every OS
export function fileStem(title: string) {
  const stem = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60)
  return stem || 'model'
}
