import { postBlob, request } from './api'
import { socialKey, type BrandContact, type BrandSocial, type ContactKey, type PaletteColour } from './brand'
import type { Job } from './types'

// contract-v36-ad-studio.md

export type AdFormat = '4:5' | '9:16' | '1:1' | '16:9' | '1.91:1' | '2:3' | 'yt'
export type AdStyle =
  | 'frosted'
  | 'side_wash'
  | 'bottom_bar'
  | 'split'
  | 'badge'
  | 'minimal'
  | 'cutout_blob'
  | 'arch_mask'
  | 'circle_mask'
  | 'big_price'
  | 'editorial'
  | 'before_after'
  | 'quote'
export type MaskShape = 'arch' | 'circle' | 'teardrop' | 'blob'
export type AdQualityLevel = 'draft' | 'final'
export type LogoPosition = 'tl' | 'tr' | 'tc' | 'bl' | 'br' | 'stack' | 'none'
export type AdStageKey = 'concepts' | 'photos' | 'layout'
export type ColourRole = 'text' | 'accent' | 'button' | 'button_text' | 'footer' | 'footer_text' | 'pill' | 'block'

export interface AdBrief {
  subject: string
  description: string
  brief: string
  occasion: string
  market: string
  tone: string
  must_say: string
  offers: string[]
  formats: AdFormat[]
  variants: number
  image_model: string
  product_media_ids: string[]
  review: boolean
  logo_on_surface: boolean
  font_preset: string | null
  footer_items?: FooterItems | null
  // M16b; older campaigns don't carry these
  quality?: AdQualityLevel
  candidates?: number
  quotes?: AdQuote[]
  use_style?: boolean
}

export interface AdQuote {
  text: string
  by: string
}

/** What a footer shows: contact keys and social keys ("instagram:ixperts.se"). */
export interface FooterItems {
  contact: ContactKey[]
  socials: string[]
}

export interface AdFollow {
  show: boolean
  text: string
}

export interface AdGen {
  id: string
  status: string
  media_url: string | null
  thumb_url: string | null
  version: number
}

export interface AdCandidate {
  id: string
  status: string
  thumb_url: string | null
  media_url: string | null
  score: number | null
  issues: string[]
  picked: boolean
}

export interface AdPhotoSet {
  base: AdGen | null
  logo: AdGen | null
  final: string | null
  note: string | null
  candidates?: AdCandidate[]
  pick?: { by: 'vision' | 'heuristic' | 'only'; model: string | null }
  before?: AdGen | null
  upscaled?: boolean
  cutout?: boolean
  subject?: { box: number[] | null; face: number[] | null; source: string } | null
}

export interface HeadlineOption {
  headline: string
  key_word: string
  score: number
}

export interface AdConcept {
  id: string
  n: number
  approved: boolean
  edited: boolean
  insight: string
  kicker: string
  headline: string
  body: string
  cta: string
  offers: string[]
  layout: AdStyle
  photo_prompt: string
  placement: string
  logo_surface: string
  photo_model?: string
  copy_check?: AdQuality['copy_check']
  error: string | null
  guard: { offers_dropped?: string[]; numbers_removed?: string[]; channels_removed?: string[] }
  photos: Partial<Record<'portrait' | 'square' | 'wide', AdPhotoSet>>
  key_word?: string
  headline_options?: HeadlineOption[]
  quote?: number | null
}

export interface AdTexts {
  kicker: string
  headline: string
  body: string
  offers: string[]
  cta: string
  badge_big: string
  badge_small: string
  highlight?: string
  quote?: string
  quote_by?: string
}

export interface AdShape {
  mask: MaskShape
  colour: string
  seed: number
}

export interface AdSpec {
  format: AdFormat
  style: AdStyle
  font_preset: string
  language: string
  rtl: boolean
  texts: AdTexts
  colours: Partial<Record<ColourRole, string>>
  palette: PaletteColour[]
  logo: { position: LogoPosition; variant: string }
  footer: boolean
  contact: BrandContact
  socials: BrandSocial[]
  follow: AdFollow
  footer_items: FooterItems
  focus: { x: number; y: number }
  photo_id: string | null
  shape?: AdShape
  placement?: { flip: boolean | null }
  style_ref?: Record<string, unknown> | null
  assets?: { cutout: boolean; before: boolean }
  subject?: { box: number[] | null; face: number[] | null; source: string } | null
}

export interface AdReport {
  contrast?: Record<string, number>
  treatment?: string[]
  fonts?: Record<string, number>
  fit?: { scale: number; headline_scale: number; trimmed: string[] }
  logo?: { variant: string; plate: boolean; contrast?: number }
  footer_dropped?: number
  footer?: { rows: number; items: string[]; dropped: string[]; folded: boolean; size: number; box?: number[]; card?: boolean }
  buttons?: Record<'cta' | 'offer', { shape: string; bg: string; fg: string; arrow: boolean; inverted?: boolean }>
  quality?: AdQuality
  placement?: { focus: { x: number; y: number }; flip: boolean; overlap: number; source: string }
  highlight?: string | null
  fallback?: string | null
}

export interface AdQA {
  checked: boolean
  by: 'vision' | 'heuristic'
  score: number | null
  issues: string[]
  retried: { style: AdStyle; flip: boolean; score: number | null }[]
  flagged: boolean
}

export interface AdQuality {
  contrast: Record<string, { ratio: number; need: number; pass: boolean }>
  all_pass: boolean
  dropped: Partial<Record<'offers' | 'numbers' | 'channels' | 'copy_trimmed' | 'footer', string[]>>
  copy_check: { field: string; score: number | null; issue: string; before?: string; after?: string }[]
  treatment: string[]
  qa?: AdQA
}

export interface Ad {
  id: string
  concept_id: string
  format: AdFormat
  status: 'pending' | 'ready' | 'failed'
  error: string | null
  media_id: string | null
  generation_id: string | null
  version: number | null
  image_url: string | null
  thumb_url: string | null
  width: number
  height: number
  overrides: AdPatch
  report: AdReport
  spec: AdSpec | null
  stale: boolean
}

export interface AdKit {
  id: string
  name: string
  palette: PaletteColour[]
  contact: BrandContact
  socials: BrandSocial[]
  claims: string[]
  has_fonts: boolean
  has_logo: boolean
  missing_contact: string[]
  ad_style?: { active: boolean; layouts: string[]; summary: string }
}

export interface AdCampaign {
  id: string
  title: string
  language: string
  rtl: boolean
  stage: AdStageKey | 'done'
  status: 'running' | 'review' | 'failed' | 'done' | 'idle'
  review: AdStageKey | null
  stages: { key: AdStageKey; label: string; status: string; detail: string | null }[]
  brief: AdBrief
  brand_kit: AdKit | null
  concepts: AdConcept[]
  ads: Ad[]
  ad_json_url: string | null
  zip_url: string | null
  job: Job | null
  created_at: string
  updated_at: string
}

export interface AdSummary {
  id: string
  title: string
  language: string
  status: AdCampaign['status']
  review: AdStageKey | null
  formats: AdFormat[]
  concepts: number
  ads: number
  thumb_url: string | null
  updated_at: string
}

export type AdCreate = Partial<AdBrief> & { subject: string; title?: string; language?: string; brand_kit_id?: string | null }

export interface ConceptPatch {
  approved?: boolean
  kicker?: string
  headline?: string
  body?: string
  cta?: string
  offers?: string[]
  layout?: AdStyle
  photo_prompt?: string
  key_word?: string
  quote?: number | null
}

export interface AdPatch {
  texts?: Partial<AdTexts>
  style?: AdStyle
  font_preset?: string
  colours?: Partial<Record<ColourRole, string>>
  logo?: { position?: LogoPosition; variant?: string }
  footer?: boolean
  footer_items?: Partial<FooterItems>
  follow?: Partial<AdFollow>
  focus?: { x: number; y: number }
  shape?: Partial<AdShape>
  placement?: { flip: boolean | null }
  reset?: boolean
}

export interface AdOptions {
  formats: { id: AdFormat; label: string; width: number; height: number }[]
  styles: { id: AdStyle; label: string; needs?: string | null }[]
  font_presets: { id: string; label: string }[]
  logo_positions: LogoPosition[]
  image_models: { id: string; label: string; default: boolean }[]
  variants: { min: number; max: number; default: number }
  mask_shapes?: MaskShape[]
  candidates?: { min: number; max: number; default: number }
}

export const adsApi = {
  options: (kitId?: string | null) => request<AdOptions>('GET', '/ads/options', undefined, kitId ? { kit_id: kitId } : undefined),
  list: () => request<AdSummary[]>('GET', '/ads'),
  get: (id: string) => request<AdCampaign>('GET', `/ads/${id}`),
  create: (body: AdCreate) => request<AdCampaign>('POST', '/ads', body),
  remove: (id: string) => request<void>('DELETE', `/ads/${id}`),
  continue: (id: string) => request<Job>('POST', `/ads/${id}/continue`, {}),
  patchConcept: (id: string, conceptId: string, body: ConceptPatch) => request<AdCampaign>('PATCH', `/ads/${id}/concepts/${conceptId}`, body),
  regenerate: (id: string, conceptId: string, body: { what: 'copy' | 'photo' | 'layout'; layout?: AdStyle }) =>
    request<AdCampaign>('POST', `/ads/${id}/concepts/${conceptId}/regenerate`, body),
  patchAd: (id: string, adId: string, body: AdPatch) => request<Ad>('PATCH', `/ads/${id}/ads/${adId}`, body),
  preview: (id: string, adId: string, body: AdPatch) => postBlob(`/ads/${id}/ads/${adId}/preview`, body),
}

export const zipUrl = (id: string) => `/api/ads/${id}/zip`

export const FORMATS: { id: AdFormat; label: string; hint: string }[] = [
  { id: '4:5', label: 'Feed 4:5', hint: '1080 × 1350' },
  { id: '9:16', label: 'Story 9:16', hint: '1080 × 1920' },
  { id: '1:1', label: 'Square 1:1', hint: '1080 × 1080' },
  { id: '16:9', label: 'Banner 16:9', hint: '1920 × 1080' },
  { id: '1.91:1', label: 'Link ad 1.91:1', hint: '1200 × 628' },
  { id: '2:3', label: 'Pinterest 2:3', hint: '1000 × 1500' },
  { id: 'yt', label: 'YouTube thumbnail', hint: '1280 × 720' },
]

// the footer leans digital: links and handles first, the address only when picked
export const FOOTER_CONTACT: { key: ContactKey; label: string }[] = [
  { key: 'website', label: 'Website' },
  { key: 'booking_url', label: 'Booking link' },
  { key: 'phone', label: 'Phone' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'email', label: 'Email' },
  { key: 'opening_hours', label: 'Opening hours' },
  { key: 'location', label: 'Address' },
]
export const DEFAULT_FOOTER_CONTACT: ContactKey[] = ['website', 'booking_url', 'phone', 'whatsapp']

/** The footer pick a campaign starts from: the digital contact items the kit has, and its socials flagged for ads. */
export function defaultFooter(kit: { contact?: BrandContact; socials?: BrandSocial[] } | null | undefined): FooterItems {
  return {
    contact: DEFAULT_FOOTER_CONTACT.filter((k) => kit?.contact?.[k]?.trim()),
    socials: (kit?.socials ?? []).filter((s) => s.show_in_ads ?? true).map(socialKey),
  }
}

// `needs` mirrors the server's hint; without it the layout falls back to another one
export const STYLES: { id: AdStyle; label: string; needs?: string }[] = [
  { id: 'frosted', label: 'Frosted panel' },
  { id: 'side_wash', label: 'Side wash' },
  { id: 'bottom_bar', label: 'Bottom bar' },
  { id: 'split', label: 'Split colour block' },
  { id: 'badge', label: 'Price badge' },
  { id: 'minimal', label: 'Minimal centred' },
  { id: 'cutout_blob', label: 'Cut-out on a shape' },
  { id: 'arch_mask', label: 'Photo in an arch' },
  { id: 'circle_mask', label: 'Photo in a circle' },
  { id: 'big_price', label: 'Big price', needs: 'needs a price offer' },
  { id: 'editorial', label: 'Editorial' },
  { id: 'before_after', label: 'Before / after', needs: 'needs a before picture' },
  { id: 'quote', label: 'Quote card', needs: 'needs a quote' },
]

export const styleLabel = (id: string) => STYLES.find((s) => s.id === id)?.label ?? id

export const MASK_SHAPES: { id: MaskShape; label: string }[] = [
  { id: 'arch', label: 'Arch' },
  { id: 'circle', label: 'Circle' },
  { id: 'teardrop', label: 'Teardrop' },
  { id: 'blob', label: 'Blob' },
]
export const MASK_LAYOUTS: AdStyle[] = ['arch_mask', 'circle_mask']
export const MAX_QUOTES = 6

export const FONT_PRESETS = [
  { id: 'modern', label: 'Modern' },
  { id: 'clean', label: 'Clean' },
  { id: 'friendly', label: 'Friendly' },
  { id: 'elegant', label: 'Elegant' },
  { id: 'editorial', label: 'Editorial' },
]

export const LOGO_POSITIONS: { id: LogoPosition; label: string }[] = [
  { id: 'tl', label: 'Top left' },
  { id: 'tc', label: 'Top centre' },
  { id: 'tr', label: 'Top right' },
  { id: 'bl', label: 'Bottom left' },
  { id: 'br', label: 'Bottom right' },
  { id: 'stack', label: 'Above the button' },
  { id: 'none', label: 'No logo' },
]

export const COLOUR_ROLES: { id: ColourRole; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'accent', label: 'Accent' },
  { id: 'button', label: 'Button' },
  { id: 'footer', label: 'Footer' },
]

export const AD_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'sv', label: 'Swedish' },
  { value: 'de', label: 'German' },
  { value: 'nb', label: 'Norwegian' },
  { value: 'da', label: 'Danish' },
  { value: 'fi', label: 'Finnish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'pl', label: 'Polish' },
  { value: 'tr', label: 'Turkish' },
  { value: 'ur', label: 'Urdu' },
  { value: 'ar', label: 'Arabic' },
  { value: 'fa', label: 'Persian' },
  { value: 'hi', label: 'Hindi' },
]

export const IMAGE_MODELS = [
  { value: 'auto', label: 'Auto (photoreal, per concept)' },
  { value: 'zimage_turbo', label: 'Z-Image Turbo' },
  { value: 'qwen_image_2512', label: 'Qwen-Image 2512' },
  { value: 'hidream_o1', label: 'HiDream-O1' },
]

export const adsBusy = (c: AdCampaign | undefined) =>
  !!c && (c.status === 'running' || c.job?.status === 'queued' || c.job?.status === 'running')

export const STATUS_LABEL: Record<AdCampaign['status'], string> = {
  running: 'Working',
  review: 'Needs your OK',
  failed: 'Stopped',
  done: 'Finished',
  idle: 'Paused',
}

/** "#E2685C" for anything a user types that looks like a hex colour, else null. */
export function hexOrNull(v: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim())
  return m ? `#${m[1].toUpperCase()}` : null
}

/** What changed between a spec and an edited one, as the PATCH body (only what the user touched). */
export function patchFrom(base: AdSpec, edit: AdSpec): AdPatch {
  const out: AdPatch = {}
  const texts: Partial<AdTexts> = {}
  for (const k of Object.keys(edit.texts) as (keyof AdTexts)[]) {
    if (JSON.stringify(edit.texts[k]) !== JSON.stringify(base.texts[k])) (texts as Record<string, unknown>)[k] = edit.texts[k]
  }
  if (Object.keys(texts).length) out.texts = texts
  if (edit.style !== base.style) out.style = edit.style
  if (edit.font_preset !== base.font_preset) out.font_preset = edit.font_preset
  const colours: Partial<Record<ColourRole, string>> = {}
  for (const [k, v] of Object.entries(edit.colours)) if (v && v !== base.colours[k as ColourRole]) colours[k as ColourRole] = v
  if (Object.keys(colours).length) out.colours = colours
  if (edit.logo.position !== base.logo.position) out.logo = { position: edit.logo.position }
  if (edit.footer !== base.footer) out.footer = edit.footer
  const items: Partial<FooterItems> = {}
  if (!sameSet(edit.footer_items.contact, base.footer_items.contact)) items.contact = edit.footer_items.contact
  if (!sameSet(edit.footer_items.socials, base.footer_items.socials)) items.socials = edit.footer_items.socials
  if (Object.keys(items).length) out.footer_items = items
  const follow: Partial<AdFollow> = {}
  if (edit.follow.show !== base.follow.show) follow.show = edit.follow.show
  if (edit.follow.text !== base.follow.text) follow.text = edit.follow.text
  if (Object.keys(follow).length) out.follow = follow
  if (edit.shape && base.shape) {
    const shape: Partial<AdShape> = {}
    if (edit.shape.mask !== base.shape.mask) shape.mask = edit.shape.mask
    if (edit.shape.colour && edit.shape.colour !== base.shape.colour) shape.colour = edit.shape.colour
    if (edit.shape.seed !== base.shape.seed) shape.seed = edit.shape.seed
    if (Object.keys(shape).length) out.shape = shape
  }
  if (edit.placement && (edit.placement.flip ?? null) !== (base.placement?.flip ?? null)) out.placement = { flip: edit.placement.flip ?? null }
  return out
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

export const conceptFor = (c: AdCampaign, ad: Ad) => c.concepts.find((x) => x.id === ad.concept_id)
