import type {
  Generation,
  GenerationKind,
  ImageUpscaleEngine,
  ImageUpscaleEngineId,
  ImageUpscaleOptions,
  ImageUpscaleTarget,
} from './types'
import { formatEstimate } from './shots'
import { sizeText, type Size } from './upscale'

export const IMAGE_KINDS: readonly GenerationKind[] = [
  'portrait',
  'sheet_view',
  'establishing',
  'keyframe_start',
  'keyframe_end',
  'keyframe_mid',
]
export const isImageKind = (kind: GenerationKind) => IMAGE_KINDS.includes(kind)

export const IMAGE_TARGETS: { id: ImageUpscaleTarget; label: string }[] = [
  { id: '2x', label: '2×' },
  { id: '4x', label: '4×' },
  { id: '2k', label: '2K' },
  { id: '4k', label: '4K' },
]
const LONG_SIDE: Partial<Record<ImageUpscaleTarget, number>> = { '2k': 2048, '4k': 3840 }
const FACTOR: Partial<Record<ImageUpscaleTarget, number>> = { '2x': 2, '4x': 4 }

export interface SizeRule {
  maxLong: number
  multiple: number
  maxMp: number | null
}

export const ruleFor = (e: Pick<ImageUpscaleEngine, 'max_long_side' | 'multiple' | 'max_mp'>): SizeRule => ({
  maxLong: e.max_long_side,
  multiple: e.multiple ?? 2,
  maxMp: e.max_mp ?? null,
})

export type ImageSizePlan = { ok: true; size: Size; capped: boolean } | { ok: false; reason: string }

/** Mirrors app.upscale_image.image_size so the dialog can preview before (or without) the server. */
export function imageTargetSize(src: Size, target: ImageUpscaleTarget, rule: SizeRule): ImageSizePlan {
  const long = Math.max(src.w, src.h)
  const want = FACTOR[target] ?? (LONG_SIDE[target] ?? long) / long
  let s = Math.min(want, rule.maxLong / long)
  if (rule.maxMp) s = Math.min(s, Math.sqrt((rule.maxMp * 1e6) / (src.w * src.h)))
  if (s <= 1.01) {
    return { ok: false, reason: want <= 1.01 ? `Already ${sizeText(src)}, no bigger at this size.` : 'At the engine’s size limit already.' }
  }
  const snap = (x: number) => Math.max(rule.multiple, Math.floor(x / rule.multiple) * rule.multiple)
  return { ok: true, size: { w: snap(src.w * s), h: snap(src.h * s) }, capped: s < want - 1e-6 }
}

/** Server numbers win; the local mirror covers an options answer without estimates. */
export function planFor(
  options: ImageUpscaleOptions | undefined,
  engine: ImageUpscaleEngine | undefined,
  target: ImageUpscaleTarget,
  src: Size,
): ImageSizePlan & { estS?: number } {
  const est = engine && options?.estimates?.[engine.id]?.[target]
  if (est) {
    return est.allowed
      ? { ok: true, size: { w: est.width, h: est.height }, capped: !!est.capped, estS: est.est_gpu_s }
      : { ok: false, reason: est.reason }
  }
  if (!engine) return { ok: false, reason: 'Pick an engine first.' }
  return imageTargetSize(src, target, ruleFor(engine))
}

export const previewText = (src: Size, out: Size) => `${sizeText(src)} → ${sizeText(out)}`
export const gpuText = (seconds: number | undefined) => (seconds ? `About ${formatEstimate(seconds)} on the GPU` : null)

// plain words for the denoise slider; the number is still shown for people who know it
export function detailLabel(denoise: number) {
  if (denoise < 0.25) return 'Subtle'
  if (denoise < 0.4) return 'Balanced'
  return 'Strong'
}

export interface ImageUpscaleInfo {
  engine: ImageUpscaleEngineId
  target: ImageUpscaleTarget
  width: number | null
  height: number | null
  sourceId: string | null
  sourceVersion: number | null
}

export function imageUpscaleInfo(g: Pick<Generation, 'params' | 'parent_id'>): ImageUpscaleInfo | null {
  const u = (g.params ?? {}).upscale as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return null
  const num = (v: unknown) => (typeof v === 'number' ? v : null)
  return {
    engine: (u.engine as ImageUpscaleEngineId) ?? 'redraw',
    target: (u.target as ImageUpscaleTarget) ?? '2x',
    width: num(u.width),
    height: num(u.height),
    sourceId: (typeof u.source_id === 'string' ? u.source_id : null) ?? g.parent_id ?? null,
    sourceVersion: num(u.source_version),
  }
}

/** "4K" / "2K" by the long side of what came out, else the factor asked for. */
export function imageResolutionBadge(g: Pick<Generation, 'params' | 'parent_id'>) {
  const up = imageUpscaleInfo(g)
  if (!up) return null
  const long = Math.max(up.width ?? 0, up.height ?? 0)
  if (long >= 3800) return '4K'
  if (long >= 1900) return '2K'
  return IMAGE_TARGETS.find((t) => t.id === up.target)?.label ?? null
}

export function upscaledFromText(g: Generation, versions: Generation[]) {
  const up = imageUpscaleInfo(g)
  if (!up) return null
  const v = versions.find((x) => x.id === up.sourceId)?.version ?? up.sourceVersion
  return v ? `Upscaled from v${v}` : 'Upscaled'
}

const viewable = (g: Generation) => !!g.media_url && (g.status === 'ready' || g.status === 'approved')

/** The other half of a compare: an upscale's source, or a source's newest finished upscale. */
export function comparePartner(current: Generation, versions: Generation[]): Generation | undefined {
  const up = imageUpscaleInfo(current)
  if (up) {
    const src = versions.find((v) => v.id === up.sourceId)
    return src && viewable(src) ? src : undefined
  }
  return versions.find((v) => v.id !== current.id && imageUpscaleInfo(v)?.sourceId === current.id && viewable(v))
}
