import { DEFAULT_IMAGE_FORM, IMAGE_ASPECTS, type ImageForm } from './images'
import { QUICK_ASPECTS, QUICK_STYLES, type QuickForm } from './quick'
import type { ImageAspect, ProjectCreate, QuickAspect, QuickStyle, Template, TemplateStart } from './types'

type Prefill = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const promptOf = (p: Prefill) => str(p.prompt) ?? str(p.prompt_scaffold) ?? ''

/** What the router passes to a form opened from a template. Nothing is generated until the user confirms. */
export interface TemplatePrefill {
  templateId: string
  templateTitle: string
  prefill: Prefill
}

export const TARGET_ROUTE: Record<TemplateStart['target'], string> = {
  quick: '/video/quick',
  studio: '/video/projects',
  image: '/image/generate',
}

// Used when the server can't answer /start: the template's own defaults say the same thing.
export function localStart(t: Template): TemplateStart {
  const d = t.defaults ?? {}
  if (t.type === 'image') return { target: 'image', prefill: d }
  return { target: d.authoring_mode && d.authoring_mode !== 'quick' ? 'studio' : 'quick', prefill: d }
}

export function imageFormFrom(p: Prefill, templateId?: string): ImageForm {
  const aspect = str(p.aspect)
  const count = num(p.count)
  return {
    ...DEFAULT_IMAGE_FORM,
    prompt: promptOf(p),
    negative: str(p.negative) ?? '',
    aspect: IMAGE_ASPECTS.some((a) => a.value === aspect) ? (aspect as ImageAspect) : DEFAULT_IMAGE_FORM.aspect,
    count: count ? Math.min(4, Math.max(1, Math.round(count))) : DEFAULT_IMAGE_FORM.count,
    style: str(p.style) ?? null,
    templateId: templateId ?? str(p.template_id),
  }
}

export function quickFormFrom(p: Prefill): Partial<QuickForm> {
  const out: Partial<QuickForm> = {}
  const prompt = promptOf(p)
  if (prompt) out.prompt = prompt
  const d = num(p.duration_s)
  if (d) out.durationS = d
  const aspect = str(p.aspect_ratio) ?? str(p.aspect)
  if (QUICK_ASPECTS.includes(aspect as QuickAspect)) out.aspect = aspect as QuickAspect
  const style = str(p.style)
  if (QUICK_STYLES.some((s) => s.value === style)) out.style = style as QuickStyle
  if (typeof p.dialogue === 'boolean') out.dialogue = p.dialogue
  return out
}

export function studioFrom(p: Prefill, title?: string): Partial<ProjectCreate> {
  const mode = str(p.authoring_mode)
  return {
    title: str(p.title) ?? title ?? '',
    authoring_mode: mode === 'scene_by_scene' ? 'scene_by_scene' : 'ai_director',
    logline: str(p.logline_hint) ?? str(p.logline) ?? promptOf(p),
    target_runtime_s: num(p.target_runtime_s) ?? num(p.duration_s),
    aspect_ratio: str(p.aspect_ratio),
  }
}
