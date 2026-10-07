import { formatEstimate } from './shots'
import type { ModelCapability, ModelInfo, ModelSpeed, ModelType } from './types'

// What an older server (no /api/models) actually runs. Only what was wired before contract v6,
// so nothing here can be picked that the server would reject.
const base = { capabilities: [] as ModelCapability[], available: true, default: false }

export const FALLBACK_MODELS: Record<ModelType, ModelInfo[]> = {
  image: [
    {
      ...base,
      id: 'zimage_turbo',
      type: 'image',
      label: 'Z-Image Turbo',
      badge: 'FAST',
      description: 'Photoreal text to image',
      capabilities: ['t2i'],
      est_seconds: 7,
      default: true,
    },
  ],
  edit: [
    {
      ...base,
      id: 'qwen_image_edit_2511',
      type: 'edit',
      label: 'Qwen-Image-Edit 2511',
      badge: 'BEST',
      description: 'Edit and combine up to 3 references',
      capabilities: ['edit', 'refs'],
      max_refs: 3,
      default: true,
    },
  ],
  video: [
    {
      ...base,
      id: 'ltx23_distilled',
      type: 'video',
      label: 'LTX-2.3',
      badge: 'NEW',
      description: 'Text and image to video, with sound and long takes',
      capabilities: ['t2v', 'i2v', 'flf', 'audio', 'longtake'],
      max_duration_s: 300,
      default: true,
    },
  ],
  upscale: [
    { ...base, id: 'seedvr2', type: 'upscale', label: 'SeedVR2', badge: 'BEST', description: 'Faithful restoration', default: true },
    { ...base, id: 'flashvsr', type: 'upscale', label: 'FlashVSR 1.1', badge: 'FAST', description: 'Fast video upscale' },
    { ...base, id: 'esrgan', type: 'upscale', label: 'Real-ESRGAN ×4', badge: 'QUICK', description: 'Fast enlargement' },
    { ...base, id: 'zimage_redraw', type: 'upscale', label: 'Z-Image redraw', badge: 'UPSCALE', description: 'Repaints fine texture' },
  ],
}

// ?model= values from links made before the catalog existed (bookmarks, the old mega-menu)
const LEGACY_IDS: Record<string, string> = {
  'z-image-turbo': 'zimage_turbo',
  'qwen-image-edit': 'qwen_image_edit_2511',
  'ltx-2.3': 'ltx23_distilled',
}

export const normalizeModelId = (id: string | null | undefined) => (id ? (LEGACY_IDS[id] ?? id) : null)

export const VIDEO_STANDARD = 'ltx23_distilled'
export const VIDEO_HQ = 'ltx23_hq'

/** The wanted model when it can be used, else the catalog default, else the first usable one. */
export function pickModel(models: ModelInfo[], wanted?: string | null): ModelInfo | undefined {
  const usable = models.filter((m) => m.available)
  const id = normalizeModelId(wanted)
  return usable.find((m) => m.id === id) ?? usable.find((m) => m.default) ?? usable[0]
}

export const has = (m: Pick<ModelInfo, 'capabilities'> | undefined, c: ModelCapability) => !!m?.capabilities.includes(c)

export type CapabilityIcon = 'sound' | 'mute' | 'text' | 'refs' | 'long' | 'image' | 'frames' | 'angles' | 'type'

/** Plain-words capability chips. Video always says whether it has sound, since that's the first thing people ask. */
export function capabilityLabels(m: ModelInfo): { icon: CapabilityIcon; text: string }[] {
  const out: { icon: CapabilityIcon; text: string }[] = []
  if (m.type === 'video') out.push(has(m, 'audio') ? { icon: 'sound', text: 'Sound' } : { icon: 'mute', text: 'No sound' })
  if (has(m, 'text_render')) out.push({ icon: 'text', text: 'Text in images' })
  if (m.type === 'video' && has(m, 't2v') && !has(m, 'i2v')) out.push({ icon: 'type', text: 'Text only' })
  if (has(m, 'i2v')) out.push({ icon: 'image', text: 'Start image' })
  if (has(m, 'flf')) out.push({ icon: 'frames', text: 'First & last frame' })
  if (m.max_refs) out.push({ icon: 'refs', text: m.max_refs === 1 ? '1 reference' : `Up to ${m.max_refs} refs` })
  if (has(m, 'longtake')) out.push({ icon: 'long', text: 'Long takes' })
  if (has(m, 'multi_angle')) out.push({ icon: 'angles', text: 'Multi-angle' })
  return out
}

export function defaultSpeed(m: ModelInfo | undefined): ModelSpeed | undefined {
  if (!m?.speeds?.length) return undefined
  const ok = m.speeds.filter((s) => s.available !== false)
  return ok.find((s) => s.id === m.default_speed) ?? ok[0]
}

/** est_seconds is for the default speed; fewer steps scale it down roughly in proportion. */
export function estimateSeconds(m: ModelInfo | undefined, speedId?: string | null): number | undefined {
  if (!m?.est_seconds) return undefined
  // est_seconds is measured at the declared default, whether or not it's usable right now
  const def = m.speeds?.find((x) => x.id === m.default_speed) ?? m.speeds?.[0]
  const s = m.speeds?.find((x) => x.id === speedId)
  if (!def || !s || !def.steps) return m.est_seconds
  return Math.max(1, Math.round((m.est_seconds * s.steps) / def.steps))
}

// short outputs read better exact ("7 s"); longer ones go through the usual rounding
export const secondsText = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : formatEstimate(s))

// ── Auto model ────────────────────────────────────────────────────────────────
// Newer servers list an "auto" entry per type and report params.model_resolved on each result.
// Older ones don't, so the picker makes its own Auto that quietly stands for the default model.
export const AUTO_ID = 'auto'

const AUTO_HINT: Record<ModelType, string> = {
  image: 'Picks for your prompt: text in quotes goes to Qwen-Image, everything else to the fastest good model',
  edit: 'Picks the edit model that fits your references',
  video: 'Picks the video model that fits your length and pictures',
  upscale: 'Picks the upscaler for the source',
}

/** Auto first and default. `serverAuto` says whether the server will resolve "auto" itself. */
export function withAuto(models: ModelInfo[], type: ModelType): { models: ModelInfo[]; serverAuto: boolean } {
  const server = models.find((m) => m.id === AUTO_ID)
  // the real default keeps its flag: modelToSend falls back to it when the server can't resolve "auto"
  const rest = models.filter((m) => m.id !== AUTO_ID)
  const base = pickModel(rest)
  if (!base) return { models, serverAuto: !!server }
  // the server's entry may not spell out capabilities and limits; the default model's stand in,
  // so payload rules (image_id needs i2v…) and the length cap still work with Auto
  const auto: ModelInfo = {
    ...base,
    id: AUTO_ID,
    label: 'Auto',
    badge: null,
    description: AUTO_HINT[type],
    speeds: undefined,
    default_speed: undefined,
    ...(server ? { ...server, capabilities: server.capabilities?.length ? server.capabilities : base.capabilities } : {}),
    available: server ? server.available !== false : base.available,
    default: true,
  }
  return { models: [auto, ...rest], serverAuto: !!server }
}

// the server's auto rules (contract-v6 P1), mirrored so the estimate and an older server agree with it
const TEXT_WORDS = /["“”«»「」]|\b(poster|sign|logo|text|banner|billboard)\b/i
const NON_LATIN = /[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u

/** What Auto will most likely pick for this prompt; only a guess, the result tile shows the real one. */
export function guessAuto(type: ModelType, models: ModelInfo[], ctx: { prompt?: string; count?: number } = {}): ModelInfo | undefined {
  const usable = models.filter((m) => m.id !== AUTO_ID && m.available)
  const byId = (id: string) => usable.find((m) => m.id === id)
  if (type === 'image') {
    const p = ctx.prompt ?? ''
    if (TEXT_WORDS.test(p) || NON_LATIN.test(p)) return byId('qwen_image_2512') ?? pickModel(usable)
    if ((ctx.count ?? 1) >= 4) return byId('flux2_klein') ?? pickModel(usable)
  }
  return pickModel(usable)
}

/** What goes into the request's `model`: "auto" when the server understands it, else our own guess. */
export function modelToSend(type: ModelType, models: ModelInfo[], chosen: ModelInfo | undefined, serverAuto: boolean, ctx: { prompt?: string; count?: number } = {}) {
  if (chosen?.id !== AUTO_ID || serverAuto) return chosen
  return guessAuto(type, models, ctx)
}

/** The model that actually made a result, from whatever the server sent. */
export function modelUsedId(...sources: (Record<string, unknown> | null | undefined)[]): string | null {
  for (const p of sources) {
    const id = p?.model_resolved ?? p?.model
    if (typeof id === 'string' && id && id !== AUTO_ID) return id
  }
  return null
}

export function modelLabel(catalog: Record<string, ModelInfo[] | undefined>, id: string | null | undefined) {
  if (!id) return null
  for (const list of Object.values(catalog)) {
    const m = list?.find((x) => x.id === id)
    if (m) return m.label
  }
  return id.replace(/_/g, ' ')
}
