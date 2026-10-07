import type { Generation, SegmentStatus, UpscaleEngine, UpscaleSegment, UpscaleTarget } from './types'
import { formatEstimate } from './shots'

export interface Size {
  w: number
  h: number
}

export const TARGETS: { id: UpscaleTarget; label: string; box: Size }[] = [
  { id: '1080p', label: '1080p', box: { w: 1920, h: 1080 } },
  { id: '1440p', label: '1440p', box: { w: 2560, h: 1440 } },
  { id: '4k', label: '4K', box: { w: 3840, h: 2160 } },
]

export const targetLabel = (t: UpscaleTarget) => TARGETS.find((x) => x.id === t)?.label ?? t

// what the aspect tiles promise for a fresh project; used when the render carries no size
const ASPECT_SIZES: Record<string, Size> = {
  '16:9': { w: 1280, h: 720 },
  '9:16': { w: 720, h: 1280 },
  '1:1': { w: 1024, h: 1024 },
  '2.39:1': { w: 1280, h: 536 },
}
export const aspectSize = (ratio: string | undefined): Size => ASPECT_SIZES[ratio ?? ''] ?? ASPECT_SIZES['16:9']

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
export const sizeText = (s: Size) => `${s.w}×${s.h}`

/** Portrait sources go into a portrait box: "1080p" means the short side, whichever way round. */
export function targetBox(target: UpscaleTarget, src: Size): Size {
  const box = TARGETS.find((t) => t.id === target)!.box
  return src.h > src.w ? { w: box.h, h: box.w } : box
}

export interface UpscalePlan {
  ok: boolean
  reason?: string
  scale: number // the engine's pass factor
  upscaled: Size // straight out of the engine
  final: Size // after the fit-inside downscale
  box: Size
}

/**
 * Same rule as the server: pick the smallest engine scale that reaches the target box, run it,
 * then fit inside the box keeping the aspect ratio, with even dimensions.
 */
export function planUpscale(src: Size, target: UpscaleTarget, scales: number[]): UpscalePlan {
  const box = targetBox(target, src)
  const needed = Math.min(box.w / src.w, box.h / src.h)
  const sorted = [...scales].sort((a, b) => a - b)
  const max = sorted[sorted.length - 1] ?? 1
  const scale = sorted.find((s) => s >= needed - 1e-6) ?? max
  const upscaled = { w: Math.round(src.w * scale), h: Math.round(src.h * scale) }
  const final = { w: even(src.w * needed), h: even(src.h * needed) }
  const base = { scale, upscaled, final, box }
  if (needed <= 1) return { ...base, ok: false, reason: `The video is already ${sizeText(src)}, at or above ${targetLabel(target)}.` }
  if (!sorted.length || needed > max + 1e-6) {
    return { ...base, ok: false, reason: `Needs ×${needed.toFixed(1)} from ${sizeText(src)}; this engine goes up to ×${max}.` }
  }
  return { ...base, ok: true }
}

export function planText(src: Size, plan: UpscalePlan) {
  const fits = plan.final.w === plan.upscaled.w && plan.final.h === plan.upscaled.h
  const head = `${sizeText(src)} → ${sizeText(plan.upscaled)} (×${plan.scale})`
  return fits ? head : `${head} → ${sizeText(plan.final)}, fit to the ${sizeText(plan.box)} box`
}

export function upscaleEstimate(engine: UpscaleEngine | undefined, durationS: number | null) {
  if (!engine || durationS == null || !engine.est_gpu_s_per_output_s) return null
  return `About ${formatEstimate(engine.est_gpu_s_per_output_s * durationS)} on the GPU`
}

/** Best engine to preselect: the server default if it's usable, else the first available one. */
export function pickEngine(engines: UpscaleEngine[], preferred?: string) {
  const ok = engines.filter((e) => e.available)
  return (ok.find((e) => e.id === preferred) ?? ok[0])?.id
}

export interface UpscaleInfo {
  target: UpscaleTarget
  engine: string
  sourceId: string | null
  width: number | null
  height: number | null
}

export function upscaleInfo(g: Pick<Generation, 'params' | 'parent_id'>): UpscaleInfo | null {
  const u = (g.params ?? {}).upscale as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return null
  const num = (v: unknown) => (typeof v === 'number' ? v : null)
  return {
    target: (u.target as UpscaleTarget) ?? '1080p',
    engine: String(u.engine ?? ''),
    sourceId: (typeof u.source_id === 'string' ? u.source_id : null) ?? g.parent_id ?? null,
    width: num(u.width),
    height: num(u.height),
  }
}

/** "1080p" / "4K" for the card badge; plain renders only get one when the server told us the size. */
export function resolutionLabel(g: Pick<Generation, 'params' | 'parent_id'>): string | null {
  const up = upscaleInfo(g)
  if (up) return targetLabel(up.target)
  const p = g.params ?? {}
  const w = typeof p.width === 'number' ? p.width : null
  const h = typeof p.height === 'number' ? p.height : null
  if (!w || !h) return null
  const short = Math.min(w, h)
  if (short >= 2160) return '4K'
  if (short >= 1440) return '1440p'
  if (short >= 1080) return '1080p'
  return `${short}p`
}

export function renderSize(g: Pick<Generation, 'params'>): Size | null {
  const p = g.params ?? {}
  return typeof p.width === 'number' && typeof p.height === 'number' ? { w: p.width, h: p.height } : null
}

const STATUSES: SegmentStatus[] = ['queued', 'generating', 'done', 'failed']

export function readSegments(g: Pick<Generation, 'params'>): UpscaleSegment[] {
  const raw = (g.params ?? {}).segments
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is UpscaleSegment => !!s && typeof s.idx === 'number')
    .map((s) => ({ ...s, status: STATUSES.includes(s.status) ? s.status : 'queued' }))
    .sort((a, b) => a.idx - b.idx)
}

/** "Segment 14 of 120": the job message wins when it says so, otherwise count from the segments. */
export function segmentLine(segments: UpscaleSegment[], message?: string | null) {
  if (message && /segment\s+\d+/i.test(message)) return message
  if (!segments.length) return message || 'Preparing segments…'
  const n = segments.length
  const done = segments.filter((s) => s.status === 'done').length
  const current = segments.find((s) => s.status === 'generating')
  if (done === n) return `All ${n} segments done, joining`
  return current ? `Segment ${current.idx + 1} of ${n}` : `${done} of ${n} segments done`
}

export interface CompareSource {
  id: string
  url: string
  label: string // "Upscaled · 1080p", "Original · v3"
}

const playableRender = (r: Generation) => !!r.media_url && (r.status === 'ready' || r.status === 'approved')

/** The playing render first, then its source (if it's an upscale) or its newest finished upscale. */
export function compareSources(playing: Generation, all: Generation[], source: Generation | undefined): [CompareSource] | [CompareSource, CompareSource] {
  const label = (r: Generation) => {
    const up = upscaleInfo(r)
    return up ? `Upscaled · ${targetLabel(up.target)}` : `Original · v${r.version}`
  }
  const src = (r: Generation): CompareSource => ({ id: r.id, url: r.media_url!, label: label(r) })
  const self = src(playing)
  const other =
    (source && playableRender(source) ? source : undefined) ??
    all.find((r) => r.id !== playing.id && upscaleInfo(r)?.sourceId === playing.id && playableRender(r))
  return other ? [self, src(other)] : [self]
}
