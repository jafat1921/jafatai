import { spread } from './estimate'
import type { CharacterSheet, Engine3D, EstimateResult, MagicFields, Make3DRequest, MediaItem, ModelInfo, Quality3D, Start3D, View3D } from './types'

// contract-v40-3d-studio.md

export interface Form3D {
  from: Start3D
  sourceId: string | null
  prompt: string
  characterId: string | null
  views: Record<View3D, string | null>
  engine: Engine3D
  quality: Quality3D
  removeBackground: boolean
}

export const NO_VIEWS: Record<View3D, string | null> = { front: null, left: null, back: null, right: null }

export const DEFAULT_FORM_3D: Form3D = {
  from: 'picture',
  sourceId: null,
  prompt: '',
  characterId: null,
  views: NO_VIEWS,
  engine: 'pixal3d',
  quality: 'final',
  removeBackground: true,
}

export const STARTS: { id: Start3D; label: string }[] = [
  { id: 'picture', label: 'Picture' },
  { id: 'text', label: 'Text' },
  { id: 'character', label: 'Character' },
  { id: 'views', label: 'Four views' },
]

export const VIEWS: { id: View3D; label: string }[] = [
  { id: 'front', label: 'Front' },
  { id: 'left', label: 'Left' },
  { id: 'back', label: 'Back' },
  { id: 'right', label: 'Right' },
]

// Character Studio's turnaround panels as the server reads them (app/model3d.py character_views): the side
// panel is the left view, and nothing is mirrored into a right one
const TURN: [View3D, string][] = [
  ['front', 'turn_front'],
  ['left', 'turn_side'],
  ['back', 'turn_back'],
]

export function sheetViews(sheet: CharacterSheet | undefined): View3D[] {
  if (!sheet) return []
  const ready = new Set(sheet.panels.filter((p) => p.current).map((p) => p.key))
  const views = TURN.filter(([, key]) => ready.has(key)).map(([v]) => v)
  return views[0] === 'front' && views.length >= 2 ? views : []
}

const filledViews = (form: Form3D) => VIEWS.map((v) => v.id).filter((v) => form.views[v])

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

/** Why the engine choice is fixed to Pixal3D: several views only work with it. */
export function engineLock(form: Form3D, characterViews: View3D[]): string | null {
  if (form.from === 'views') return 'Four views work with Pixal3D only.'
  if (form.from === 'character' && characterViews.length) return 'The turnaround views work with Pixal3D only.'
  return null
}

/** text: the prompt and magic-prompt fields, for a text start. */
export function make3dPayload(form: Form3D, text?: { prompt: string } & MagicFields, locked = false): Make3DRequest | null {
  const common = { engine: locked ? ('pixal3d' as const) : form.engine, quality: form.quality, remove_background: form.removeBackground }
  switch (form.from) {
    case 'picture':
      return form.sourceId ? { source_id: form.sourceId, ...common } : null
    case 'text': {
      const prompt = (text?.prompt ?? form.prompt).trim()
      // the picture is made on a plain background, so it's always cut out
      return prompt ? { ...text, ...common, prompt, remove_background: true } : null
    }
    case 'character':
      return form.characterId ? { character_id: form.characterId, ...common } : null
    case 'views': {
      const front = form.views.front
      if (!front || filledViews(form).length < 2) return null
      const views = { front, ...Object.fromEntries(filledViews(form).filter((v) => v !== 'front').map((v) => [v, form.views[v]!])) }
      return { views, ...common, engine: 'pixal3d' }
    }
  }
}

export function blocked3d(form: Form3D, engine: ModelInfo | undefined, viewsWhy?: string | null): string | null {
  if (form.from === 'picture' && !form.sourceId) return 'Add a picture first.'
  if (form.from === 'text' && form.prompt.trim().length < 3) return 'Describe the object first.'
  if (form.from === 'character' && !form.characterId) return 'Pick a character first.'
  if (form.from === 'views') {
    if (!form.views.front) return 'Add the front view first.'
    if (filledViews(form).length < 2) return 'Add at least one more view: left, back or right.'
    if (viewsWhy) return `Four views aren't available right now: ${viewsWhy}`
  }
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
