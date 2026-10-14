import { audioKindOf } from './audio'
import { DEFAULT_IMAGE_FORM, IMAGE_ASPECTS, type ImageForm } from './images'
import { QUICK_ASPECTS, QUICK_STYLES, type QuickForm } from './quick'
import type { ImageAspect, ProjectCreate, QuickAspect, QuickStyle, Template, TemplateOption, TemplateStart, TemplateTool } from './types'

type Prefill = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const promptOf = (p: Prefill) => str(p.prompt) ?? str(p.prompt_scaffold) ?? ''

export function examplesOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const out = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string>
  return Object.keys(out).length ? out : undefined
}

/** What the router passes to a form opened from a prompt template. Nothing is generated until the user confirms. */
export interface TemplatePrefill {
  templateId: string
  templateTitle: string
  prefill: Prefill
}

export const PROMPT_TEMPLATES_ROUTE = { image: '/image/prompt-templates', video: '/video/prompt-templates', audio: '/audio/prompt-templates' } as const

export const TARGET_ROUTE: Record<TemplateStart['target'], string> = {
  quick: '/video/quick',
  studio: '/video/projects',
  image: '/image/generate',
  'image-edit': '/image/edit',
  audio: '/audio/song',
}

export const isEditTemplate = (t: Pick<Template, 'target'>) => t.target === 'image-edit'

// Used when the server can't answer /start: the template's own defaults say the same thing.
export function localStart(t: Template): TemplateStart {
  const d = t.defaults ?? {}
  if (isEditTemplate(t)) {
    const { instruction_scaffold, ...rest } = d
    return {
      target: 'image-edit',
      prefill: { ...rest, instruction: instruction_scaffold, refs_required: t.refs_required, ref_labels: t.ref_labels, options: t.options, tool: t.tool, template_id: t.id },
    }
  }
  if (t.type === 'image') return { target: 'image', prefill: d }
  if (t.type === 'audio') return { target: 'audio', prefill: { kind: audioKindOf(t), ...d } }
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
    examples: examplesOf(p.examples),
    // text-first templates ask for Qwen; the user can still switch
    ...(str(p.model) ? { model: str(p.model) } : {}),
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
  const examples = examplesOf(p.examples)
  if (examples) out.examples = examples
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

/** Edit Image opened from an edit template: the instruction plus the labelled pictures it needs. */
export interface EditTemplateForm {
  instruction: string
  model?: string
  count: number
  aspect: ImageAspect | null
  labels: string[]
  required: number
  options: TemplateOption[]
  examples?: Record<string, string>
  // v30: the tool that can run this card instead of the edit model
  tool?: TemplateTool
}

const isTool = (t: unknown): t is TemplateTool => !!t && typeof t === 'object' && typeof (t as TemplateTool).id === 'string'

const isOption = (o: unknown): o is TemplateOption =>
  !!o && typeof o === 'object' && typeof (o as TemplateOption).slot === 'string' && Array.isArray((o as TemplateOption).choices)

export function editFormFrom(p: Prefill): EditTemplateForm {
  const aspect = str(p.aspect)
  const count = num(p.count)
  const labels = Array.isArray(p.ref_labels) ? p.ref_labels.filter((x): x is string => typeof x === 'string').slice(0, 3) : []
  return {
    instruction: str(p.instruction) ?? str(p.instruction_scaffold) ?? '',
    model: str(p.model),
    count: count ? Math.min(4, Math.max(1, Math.round(count))) : 1,
    aspect: IMAGE_ASPECTS.some((a) => a.value === aspect) ? (aspect as ImageAspect) : null,
    labels,
    required: Math.min(labels.length || 3, num(p.refs_required) ?? 1),
    options: Array.isArray(p.options) ? p.options.filter(isOption) : [],
    examples: examplesOf(p.examples),
    tool: isTool(p.tool) ? p.tool : undefined,
  }
}

/**
 * Puts a picked choice into the text: over the [slot] while it's still there, else over the choice
 * picked before. If the user has since rewritten that part, the text is left alone.
 */
export function fillSlot(text: string, slot: string, value: string, previous?: string): string {
  const token = `[${slot}]`
  if (text.includes(token)) return text.replace(token, value)
  if (previous && text.includes(previous)) return text.replace(previous, value)
  return text
}
