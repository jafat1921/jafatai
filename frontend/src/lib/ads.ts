import { postBlob, request } from './api'
import { socialKey, type BrandContact, type BrandSocial, type ContactKey, type PaletteColour } from './brand'
import type { Job } from './types'

// contract-v36-ad-studio.md

export type AdFormat = '4:5' | '9:16' | '1:1' | '16:9' | '1.91:1' | '2:3' | 'yt'
export type AdStyle = 'frosted' | 'side_wash' | 'bottom_bar' | 'split' | 'badge' | 'minimal'
export type LogoPosition = 'tl' | 'tr' | 'tc' | 'bl' | 'br' | 'none'
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
  photos: Partial<Record<'portrait' | 'square' | 'wide', { base: AdGen | null; logo: AdGen | null; final: string | null; note: string | null }>>
}

export interface AdTexts {
  kicker: string
  headline: string
  body: string
  offers: string[]
  cta: string
  badge_big: string
  badge_small: string
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
}

export interface AdQuality {
  contrast: Record<string, { ratio: number; need: number; pass: boolean }>
  all_pass: boolean
  dropped: Partial<Record<'offers' | 'numbers' | 'channels' | 'copy_trimmed' | 'footer', string[]>>
  copy_check: { field: string; score: number | null; issue: string; before?: string; after?: string }[]
  treatment: string[]
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
  reset?: boolean
}

export interface AdOptions {
  formats: { id: AdFormat; label: string; width: number; height: number }[]
  styles: { id: AdStyle; label: string }[]
  font_presets: { id: string; label: string }[]
  logo_positions: LogoPosition[]
  image_models: { id: string; label: string; default: boolean }[]
  variants: { min: number; max: number; default: number }
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

export const STYLES: { id: AdStyle; label: string }[] = [
  { id: 'frosted', label: 'Frosted panel' },
  { id: 'side_wash', label: 'Side wash' },
  { id: 'bottom_bar', label: 'Bottom bar' },
  { id: 'split', label: 'Split colour block' },
  { id: 'badge', label: 'Price badge' },
  { id: 'minimal', label: 'Minimal centred' },
]

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
  return out
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

export const conceptFor = (c: AdCampaign, ad: Ad) => c.concepts.find((x) => x.id === ad.concept_id)
