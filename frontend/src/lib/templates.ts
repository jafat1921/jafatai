import { audioKindOf } from './audio'
import { DEFAULT_IMAGE_FORM, IMAGE_ASPECTS, type ImageForm } from './images'
import { QUICK_ASPECTS, QUICK_STYLES, type QuickForm } from './quick'
import type {
  BrandSurface,
  ControlType,
  ImageAspect,
  MediaItem,
  ProjectCreate,
  QuickAspect,
  QuickStyle,
  Template,
  TemplateOption,
  TemplateStart,
  TemplateTool,
  UserTemplateRequest,
} from './types'

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
  'image-control': '/image/control',
  'image-brand': '/image/brand',
  audio: '/audio/song',
}

export const isEditTemplate = (t: Pick<Template, 'target'>) => t.target === 'image-edit'
export const isControlTemplate = (t: Pick<Template, 'target'>) => t.target === 'image-control'
export const isBrandTemplate = (t: Pick<Template, 'target'>) => t.target === 'image-brand'

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
  if (isBrandTemplate(t)) {
    const { instruction_scaffold, ...rest } = d
    return {
      target: 'image-brand',
      prefill: {
        ...rest,
        instruction: instruction_scaffold,
        ref_labels: t.ref_labels,
        options: t.options,
        brand_refs: t.brand_refs,
        surface: t.surface,
        scene_prompt: t.scene?.prompt_scaffold,
        scene_aspect: t.scene?.aspect,
        template_id: t.id,
      },
    }
  }
  if (isControlTemplate(t)) {
    const { prompt_scaffold, ...rest } = d
    return { target: 'image-control', prefill: { ...rest, prompt: prompt_scaffold, control: t.control?.type, template_id: t.id } }
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

/** What "Save as template" starts from: a result's recipe, or the form as it is now (contract v31). */
export interface TemplateDraft {
  target: 'generate' | 'edit'
  prompt: string
  title?: string
  style?: string | null
  model?: string | null
  aspect?: ImageAspect | null
  count: number
  negative?: string
  // edit: how many pictures it took, and what they were called
  refLabels?: string[]
  fromMediaId?: string
}

const aspectOf = (v: unknown) => (IMAGE_ASPECTS.some((a) => a.value === v) ? (v as ImageAspect) : null)

/** A finished Create or Edit result as a template draft; null for uploads, restyles, tools and control runs. */
export function draftFromItem(m: MediaItem): TemplateDraft | null {
  const p = m.params ?? {}
  if (m.kind !== 'image' || m.origin !== 'generated' || p.img2img_of || p.control_of || p.image_tool || p.upscale) return null
  const edit = Array.isArray(p.edit_of)
  const prompt = edit ? str(p.instruction) : (str(p.user_prompt) ?? m.prompt)
  if (!prompt?.trim()) return null
  const refs = edit ? Math.min(3, (p.edit_of as unknown[]).length) : 0
  return {
    target: edit ? 'edit' : 'generate',
    prompt: prompt.trim(),
    title: m.title,
    style: edit ? null : (str(p.style) ?? null),
    model: str(p.model) ?? null,
    aspect: aspectOf(p.aspect),
    count: 1,
    negative: edit ? '' : (str(p.negative) ?? ''),
    refLabels: edit ? Array.from({ length: refs }, (_, i) => `Image ${i + 1}`) : undefined,
    fromMediaId: m.id,
  }
}

export function templateBody(d: TemplateDraft, title: string, prompt: string, labels: string[]): UserTemplateRequest {
  const body: UserTemplateRequest = { title: title.trim(), target: d.target, prompt: prompt.trim(), count: Math.min(4, Math.max(1, d.count || 1)) }
  if (d.model && d.model !== 'auto') body.model = d.model
  if (d.aspect) body.aspect = d.aspect
  if (d.target === 'edit') body.ref_labels = labels.map((l) => l.trim()).filter(Boolean)
  else {
    if (d.style) body.style = d.style
    if (d.negative?.trim()) body.negative = d.negative.trim()
  }
  if (d.fromMediaId) body.from_media_id = d.fromMediaId
  return body
}

/** Wraps the selected words in [brackets]: the part that changes each time the template is used. */
export function markSlot(text: string, start: number, end: number): { text: string; caret: number } | null {
  const picked = text.slice(start, end)
  const word = picked.trim()
  if (!word || word.length > 40 || /[[\]\n]/.test(word)) return null
  const lead = picked.length - picked.trimStart().length
  const s = start + lead
  const e = s + word.length
  const next = `${text.slice(0, s)}[${word}]${text.slice(e)}`
  return { text: next, caret: e + 2 }
}

/** Control to image opened from a card (contract v31). */
export interface ControlTemplateForm {
  prompt: string
  control: ControlType
  useAsIs: boolean
  strength: number
  count: number
  style: string | null
  examples?: Record<string, string>
}

const CONTROLS: ControlType[] = ['depth', 'canny', 'pose', 'hed', 'scribble']

export function controlFormFrom(p: Prefill): ControlTemplateForm {
  const control = str(p.control) as ControlType | undefined
  const strength = num(p.strength)
  const count = num(p.count)
  return {
    prompt: promptOf(p),
    control: control && CONTROLS.includes(control) ? control : 'depth',
    useAsIs: p.use_as_is === true,
    strength: strength ? Math.min(1, Math.max(0.65, strength)) : 0.8,
    count: count ? Math.min(4, Math.max(1, Math.round(count))) : 2,
    style: str(p.style) ?? null,
    examples: examplesOf(p.examples),
  }
}

/** The Brand page opened from a brand card (contract v35). {tokens} stay in; the server fills them from the kit. */
export interface BrandTemplateForm {
  instruction: string
  scenePrompt: string
  sceneAspect: ImageAspect
  aspect: ImageAspect | null
  count: number
  label: string
  refs: string[]
  surface: BrandSurface
  options: TemplateOption[]
  examples?: Record<string, string>
}

export function brandFormFrom(p: Prefill): BrandTemplateForm {
  const labels = Array.isArray(p.ref_labels) ? p.ref_labels.filter((x): x is string => typeof x === 'string') : []
  const refs = Array.isArray(p.brand_refs) ? p.brand_refs.filter((x): x is string => typeof x === 'string') : []
  const count = num(p.count)
  return {
    instruction: str(p.instruction) ?? '',
    scenePrompt: str(p.scene_prompt) ?? '',
    sceneAspect: aspectOf(p.scene_aspect) ?? '1:1',
    aspect: aspectOf(p.aspect),
    count: count ? Math.min(4, Math.max(1, Math.round(count))) : 1,
    label: labels[0] ?? 'Photo',
    refs: refs.length ? refs : ['logo'],
    surface: p.surface === 'dark' ? 'dark' : 'light',
    options: Array.isArray(p.options) ? p.options.filter(isOption) : [],
    examples: examplesOf(p.examples),
  }
}

/** A picked choice that names a surface wins; otherwise the card's own. */
export function surfaceFor(options: TemplateOption[], picked: Record<string, number>, fallback: BrandSurface): BrandSurface {
  for (const o of options) {
    const c = picked[o.slot] === undefined ? undefined : o.choices[picked[o.slot]]
    if (c?.surface) return c.surface
  }
  return fallback
}
