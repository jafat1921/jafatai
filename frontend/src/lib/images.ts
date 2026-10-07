import type { GenerationStatus, ImageAspect, ImageEditRequest, ImageGenerateRequest, Job, MediaItem } from './types'

// sizes are the server's ~1 MP snapped to /64 (contract-v5), shown so people know what they'll get
export const IMAGE_ASPECTS: { value: ImageAspect; label: string; size: string; w: number; h: number }[] = [
  { value: '1:1', label: 'Square', size: '1024×1024', w: 20, h: 20 },
  { value: '16:9', label: 'Wide', size: '1344×768', w: 28, h: 16 },
  { value: '9:16', label: 'Tall', size: '768×1344', w: 13, h: 22 },
  { value: '4:3', label: 'Classic', size: '1152×896', w: 24, h: 18 },
  { value: '3:4', label: 'Portrait', size: '896×1152', w: 17, h: 22 },
  { value: '2:3', label: 'Photo tall', size: '832×1216', w: 15, h: 22 },
  { value: '3:2', label: 'Photo wide', size: '1216×832', w: 26, h: 17 },
]

export const IMAGE_STYLES = [
  { value: 'photoreal', label: 'Photoreal' },
  { value: 'cinematic', label: 'Cinematic' },
  { value: 'illustration', label: 'Illustration' },
  { value: 'anime', label: 'Anime' },
  { value: '3d', label: '3D render' },
  { value: 'painting', label: 'Painting' },
] as const

export const MAX_EDIT_SOURCES = 3
export const MAX_COUNT = 4

export interface ImageForm {
  prompt: string
  negative: string
  aspect: ImageAspect
  count: number
  style: string | null
  seed: string
  steps: string
  templateId?: string
}

export const DEFAULT_IMAGE_FORM: ImageForm = {
  prompt: '',
  negative: '',
  aspect: '1:1',
  count: 2,
  style: null,
  seed: '',
  steps: '',
}

const clampCount = (n: number) => Math.min(MAX_COUNT, Math.max(1, Math.round(n) || 1))
const optInt = (s: string) => {
  const n = Number.parseInt(s.trim(), 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function imagePayload(f: ImageForm): ImageGenerateRequest {
  const body: ImageGenerateRequest = { prompt: f.prompt.trim(), aspect: f.aspect, count: clampCount(f.count) }
  if (f.negative.trim()) body.negative = f.negative.trim()
  if (f.style) body.style = f.style
  const seed = optInt(f.seed)
  if (seed !== undefined) body.seed = seed
  const steps = optInt(f.steps)
  if (steps) body.steps = Math.min(50, steps)
  if (f.templateId) body.template_id = f.templateId
  return body
}

export function editPayload(sourceIds: string[], instruction: string, count: number, aspect: ImageAspect | null): ImageEditRequest {
  const body: ImageEditRequest = {
    source_ids: [...new Set(sourceIds)].slice(0, MAX_EDIT_SOURCES),
    instruction: instruction.trim(),
    count: clampCount(count),
  }
  if (aspect) body.aspect = aspect
  return body
}

/** Adds ids up to the limit; returns the new list and whether anything was dropped. */
export function addSources(current: string[], incoming: string[]): { ids: string[]; dropped: number } {
  const ids = [...current]
  let dropped = 0
  for (const id of incoming) {
    if (ids.includes(id)) continue
    if (ids.length >= MAX_EDIT_SOURCES) dropped++
    else ids.push(id)
  }
  return { ids, dropped }
}

// "[product]" style slots in template prompts; the user swaps them for their own words
const SLOT = /\[[^\]\n]{1,40}\]/g

export const placeholdersIn = (text: string) => [...new Set(text.match(SLOT) ?? [])]

export function splitPlaceholders(text: string): { text: string; slot: boolean }[] {
  const out: { text: string; slot: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(SLOT)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), slot: false })
    out.push({ text: m[0], slot: true })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), slot: false })
  return out
}

export type TileState = 'pending' | 'ready' | 'failed'

/** MediaItem has no status in the contract; combine what the item, its generation and its job say. */
export function tileState(item: MediaItem, gen?: { status: GenerationStatus } | null, job?: Job): TileState {
  const status = gen?.status ?? item.status
  if (status === 'failed' || job?.status === 'failed') return 'failed'
  if (status === 'queued' || status === 'generating') return 'pending'
  if (job && (job.status === 'queued' || job.status === 'running')) return 'pending'
  return item.media_url ? 'ready' : 'pending'
}

export const sizeLabel = (m: Pick<MediaItem, 'width' | 'height'>) => (m.width && m.height ? `${m.width}×${m.height}` : null)
