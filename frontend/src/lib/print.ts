/** Print Studio (contract v41, admins only): signs, boards, flyers and stickers at real sizes. */
import { postBlob, request } from './api'
import type { Job } from './types'

export type PrintJobType = 'sign' | 'board' | 'flyer' | 'sticker'
export type Distance = 'near' | 'street' | 'road'
export type DesignFamily = 'typographic' | 'photo' | 'illustration'
export type Decor = 'none' | 'awning' | 'frame'
export type FileFormat = 'pdf' | 'png' | 'jpg' | 'svg' | 'zip'
export type Shape = 'rect' | 'round'
export type ShapeFamily = 'wide' | 'tall' | 'square' | 'sheet'

export interface PrintLines {
  name: string
  tagline?: string
  offers?: string[]
  opening_hours?: string
  phone?: string
  address?: string
  website?: string
}

export interface PrintCreate {
  title?: string
  job: PrintJobType
  width_cm: number
  height_cm: number
  dpi?: number | null
  bleed_mm?: number
  shape?: Shape
  viewing_distance?: Distance | null
  business_type?: string
  lines: PrintLines
  language: string
  style?: string
  brief?: string
  brand_kit_id?: string | null
  product_media_ids?: string[]
  photo_media_ids?: string[]
  variants?: number
  quality?: 'draft' | 'final'
  review?: boolean
  export_all?: boolean
  print_safe?: boolean
}

export interface PrintSize {
  width_cm: number
  height_cm: number
  dpi: number
  bleed_mm: number
  shape: Shape
  px: [number, number]
  trim_px: [number, number]
  mp: number
  label: string
  family: ShapeFamily
  min_cap_mm: number
}

export interface MinText {
  cap_mm: number | null
  cap_cm: number | null
  role: string | null
  need_mm: number
  distance: Distance
  pass: boolean
}

export interface GamutNote {
  role: string
  hex: string
  safe: string
  chroma: number
  ceiling: number
}

export interface PrintReport {
  family?: ShapeFamily
  layout?: string
  contrast?: Record<string, number>
  all_pass?: boolean
  min_text?: MinText
  colours?: { ground: string; ink: string; accent: string; band_ink: string }
  gamut?: GamutNote[]
  dropped?: string[]
  below_min?: string[]
  fonts?: Record<string, number>
  boxes?: { trim: number[]; safe: number[] }
  canvas?: { width_mm: number; height_mm: number; bleed_mm: number; dpi: number; px: number[]; mp: number; label: string }
  shape?: Shape
  fallback?: { asked: string; used: string } | null
}

export interface DesignTexts {
  name: string
  tagline: string
  headline: string
  offers: string[]
  hours: string
  phone: string
  address: string
  website: string
  cta: string
}

export interface DesignSpec {
  job: PrintJobType
  design: DesignFamily
  layout: string
  decor: Decor
  hero: 'name' | 'headline'
  caps: boolean
  size: { width_mm: number; height_mm: number; bleed_mm: number; dpi: number; shape: Shape }
  language: string
  rtl: boolean
  texts: DesignTexts
  colours: { ground?: string; ink?: string; accent?: string }
  font_preset: string
  display_font?: string
  logo: { position: 'auto' | 'none'; variant: string }
  focus: { x: number; y: number }
  print_safe: boolean
}

export interface DesignFile {
  url: string
  media_type: string
  bytes: number | null
  generation_id: string
}

export interface PrintDesign {
  id: string
  concept_id: string
  n: number | null
  status: 'pending' | 'ready' | 'failed'
  error: string | null
  media_id: string | null
  generation_id: string | null
  version: number | null
  image_url: string | null
  thumb_url: string | null
  width: number | null
  height: number | null
  overrides: Record<string, unknown>
  report: PrintReport
  spec: DesignSpec | null
  files: { status: 'none' | 'ready' | 'stale'; files: Partial<Record<FileFormat, DesignFile>>; made_at: string | null }
  stale: boolean
}

export interface PrintConcept {
  id: string
  n: number
  approved: boolean
  family: DesignFamily
  layout: string
  decor: Decor
  hero: 'name' | 'headline'
  headline: string
  cta: string
  font: string
  caps: boolean
  insight: string
  offers: string[]
  colours: { ground?: string; ink?: string; accent?: string }
  error: string | null
  pictures: Record<string, { upscaled: boolean; owner: boolean; base: { id: string; thumb_url: string | null } | null }>
}

export interface PrintStage {
  key: string
  label: string
  status: 'pending' | 'running' | 'review' | 'done' | 'failed' | 'skipped'
  detail: string | null
}

export interface PrintJob {
  id: string
  kind: 'print'
  title: string
  language: string
  rtl: boolean
  stage: string
  status: 'running' | 'review' | 'failed' | 'done' | 'idle'
  review: string | null
  stages: PrintStage[]
  brief: PrintCreate & { lines: PrintLines }
  size: PrintSize
  brand_kit: { id: string; name: string; has_fonts?: boolean; has_logo?: boolean } | null
  concepts: PrintConcept[]
  designs: PrintDesign[]
  job: Job | null
  created_at: string
  updated_at: string
}

export interface PrintSummary {
  id: string
  title: string
  language: string
  status: PrintJob['status']
  job: PrintJobType
  size: PrintSize
  designs: number
  thumb_url: string | null
  updated_at: string
}

export interface PrintPreset {
  id: string
  label: string
  job: PrintJobType
  width_cm: number
  height_cm: number
  shape?: Shape
}

export interface PrintOptions {
  jobs: { id: PrintJobType; label: string; dpi: number; distance: Distance }[]
  presets: PrintPreset[]
  dpis: number[]
  max_mp: number
  distances: { id: Distance; label: string; metres: number; min_cap_mm: number }[]
  layouts: Record<ShapeFamily, { id: string; label: string; photo: boolean }[]>
  font_presets: { id: string; label: string }[]
  display_fonts?: { id: string; label: string }[]
}

export interface DesignPatch {
  texts?: Partial<DesignTexts>
  layout?: string
  decor?: Decor
  hero?: 'name' | 'headline'
  caps?: boolean
  font_preset?: string
  display_font?: string
  colours?: Partial<Record<'ground' | 'ink' | 'accent', string>>
  logo?: { position?: 'auto' | 'none' }
  print_safe?: boolean
  reset?: boolean
}

export const printApi = {
  options: () => request<PrintOptions>('GET', '/print/options'),
  list: () => request<PrintSummary[]>('GET', '/print'),
  get: (id: string) => request<PrintJob>('GET', `/print/${id}`),
  create: (body: PrintCreate) => request<PrintJob>('POST', '/print', body),
  remove: (id: string) => request<void>('DELETE', `/print/${id}`),
  continue: (id: string) => request<Job>('POST', `/print/${id}/continue`, {}),
  patchDesign: (id: string, designId: string, body: DesignPatch) => request<PrintDesign>('PATCH', `/print/${id}/designs/${designId}`, body),
  preview: (id: string, designId: string, body: DesignPatch) => postBlob(`/print/${id}/designs/${designId}/preview`, body),
  files: (id: string, designIds: string[] | null) => request<Job>('POST', `/print/${id}/files`, { design_ids: designIds }),
  resize: (id: string, designId: string, body: { width_cm: number; height_cm: number; job?: PrintJobType }) =>
    request<PrintJob>('POST', `/print/${id}/designs/${designId}/resize`, body),
  regenerate: (id: string, conceptId: string, what: 'picture' | 'copy') => request<PrintJob>('POST', `/print/${id}/concepts/${conceptId}/regenerate`, { what }),
}

// ---------------------------------------------------------------- sizes (the server's sizes.py, for the picker)

export const MM_PER_INCH = 25.4
export const DPIS = [100, 150, 200, 300] as const
export const MAX_MP = 160
export const DEFAULT_BLEED_MM = 3
export const DEFAULT_DPI: Record<PrintJobType, number> = { sign: 150, board: 150, flyer: 300, sticker: 300 }
export const DEFAULT_DISTANCE: Record<PrintJobType, Distance> = { sign: 'street', board: 'street', flyer: 'near', sticker: 'near' }
export const JOB_LABELS: Record<PrintJobType, string> = { sign: 'Shop sign', board: 'Poster / board', flyer: 'Flyer / menu', sticker: 'Window sticker' }
export const DISTANCES: { id: Distance; label: string; metres: number }[] = [
  { id: 'near', label: 'Close up', metres: 0.6 },
  { id: 'street', label: 'Street', metres: 5 },
  { id: 'road', label: 'Road', metres: 20 },
]

export const PRESETS: PrintPreset[] = [
  { id: 'sign-25x70', label: 'Shop sign 25 × 70', job: 'sign', width_cm: 25, height_cm: 70 },
  { id: 'sign-70x25', label: 'Fascia 70 × 25', job: 'sign', width_cm: 70, height_cm: 25 },
  { id: 'poster-50x70', label: 'Poster 50 × 70', job: 'board', width_cm: 50, height_cm: 70 },
  { id: 'poster-70x100', label: 'Poster 70 × 100', job: 'board', width_cm: 70, height_cm: 100 },
  { id: 'board-106x160', label: 'Board 106 × 160', job: 'board', width_cm: 106, height_cm: 160 },
  { id: 'a5', label: 'A5', job: 'flyer', width_cm: 14.8, height_cm: 21 },
  { id: 'a4', label: 'A4', job: 'flyer', width_cm: 21, height_cm: 29.7 },
  { id: 'a3', label: 'A3', job: 'flyer', width_cm: 29.7, height_cm: 42 },
  { id: 'sticker-round-10', label: 'Round sticker Ø 10', job: 'sticker', width_cm: 10, height_cm: 10, shape: 'round' },
  { id: 'sticker-30x10', label: 'Sticker 30 × 10', job: 'sticker', width_cm: 30, height_cm: 10 },
]

const px = (mm: number, dpi: number) => Math.max(1, Math.round((mm * dpi) / MM_PER_INCH))

export function pixels(widthCm: number, heightCm: number, dpi: number, bleedMm = DEFAULT_BLEED_MM) {
  const w = widthCm * 10
  const h = heightCm * 10
  const full: [number, number] = [px(w + 2 * bleedMm, dpi), px(h + 2 * bleedMm, dpi)]
  return { trim: [px(w, dpi), px(h, dpi)] as [number, number], full, mp: (full[0] * full[1]) / 1e6 }
}

export const tooBig = (widthCm: number, heightCm: number, dpi: number, bleedMm = DEFAULT_BLEED_MM) => pixels(widthCm, heightCm, dpi, bleedMm).mp > MAX_MP

/** The highest offered dpi at or under `want` that stays under the size limit. */
export function bestDpi(widthCm: number, heightCm: number, want: number, bleedMm = DEFAULT_BLEED_MM) {
  const ok = [...DPIS].filter((d) => d <= want).sort((a, b) => b - a).find((d) => !tooBig(widthCm, heightCm, d, bleedMm))
  return ok ?? DPIS[0]
}

const num = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-GB', { maximumFractionDigits: 1 })

export const sizeLabel = (widthCm: number, heightCm: number, dpi: number) => {
  const [w, h] = pixels(widthCm, heightCm, dpi).trim
  return `${num(widthCm)} × ${num(heightCm)} cm · ${dpi} dpi · ${w} × ${h} px`
}

export function shapeFamily(job: PrintJobType, widthCm: number, heightCm: number, shape: Shape = 'rect'): ShapeFamily {
  if (shape === 'round') return 'square'
  if (job === 'flyer') return 'sheet'
  const r = widthCm / Math.max(heightCm, 1e-6)
  return r >= 1.3 ? 'wide' : r <= 0.77 ? 'tall' : 'square'
}

export const minCapMm = (d: Distance) => Math.round(Math.max(1.5, (DISTANCES.find((x) => x.id === d)?.metres ?? 5) * 3) * 10) / 10

/** A free size typed in cm or mm, as centimetres. */
export const toCm = (value: number, unit: 'cm' | 'mm') => (unit === 'mm' ? value / 10 : value)

// a guess from the shop's own words; the owner can always pick the language
export function guessLanguage(text: string): string {
  if (/[ٹڈڑںےۓھ]/.test(text)) return 'ur'
  if (/[؀-ۿ]/.test(text)) return 'ar'
  if (/[åäöÅÄÖ]/.test(text)) return 'sv'
  if (/[æøÆØ]/.test(text)) return 'nb'
  if (/[üßÜ]/.test(text)) return 'de'
  return 'en'
}

export const printBusy = (j: PrintJob | undefined) => !!j && (j.status === 'running' || j.job?.status === 'queued' || j.job?.status === 'running')

export const STATUS_LABEL: Record<PrintJob['status'], string> = {
  running: 'Working',
  review: 'Needs your OK',
  failed: 'Stopped',
  done: 'Ready',
  idle: 'Not started',
}

export const FAMILY_LABEL: Record<DesignFamily, string> = { typographic: 'Type only', photo: 'Photo-led', illustration: 'Illustration' }

export const FORMAT_LABEL: Record<FileFormat, string> = { pdf: 'PDF (print)', png: 'PNG', jpg: 'JPG', svg: 'SVG (editable)', zip: 'Layers (ZIP)' }

export const ROLE_LABEL: Record<string, string> = {
  name: 'Name',
  tagline: 'Tagline',
  headline: 'Hero line',
  offers: 'Offers',
  price: 'Prices',
  hours: 'Opening hours',
  phone: 'Phone',
  address: 'Address',
  website: 'Website',
  cta: 'Button',
  info: 'Contact band',
}

export const FONT_PRESETS = [
  { id: 'bold', label: 'Bold sans (Archivo Black)' },
  { id: 'condensed', label: 'Condensed caps (Bebas Neue)' },
  { id: 'impact', label: 'Heavy condensed (Anton)' },
  { id: 'modern', label: 'Modern (Montserrat)' },
  { id: 'friendly', label: 'Friendly (Poppins)' },
  { id: 'elegant', label: 'Elegant (Playfair + Inter)' },
]

// the name's face on its own; '' keeps the one the type sets
export const DISPLAY_FONTS = [
  { id: '', label: 'As the type' },
  { id: 'archivo', label: 'Archivo Black' },
  { id: 'anton', label: 'Anton' },
  { id: 'bebas', label: 'Bebas Neue' },
  { id: 'poppins', label: 'Poppins ExtraBold' },
  { id: 'montserrat', label: 'Montserrat ExtraBold' },
  { id: 'oswald', label: 'Oswald Bold' },
  { id: 'playfair', label: 'Playfair Display Black' },
]

export const LAYOUTS: Record<ShapeFamily, { id: string; label: string; photo: boolean }[]> = {
  wide: [
    { id: 'band', label: 'Name with emblem and band', photo: false },
    { id: 'awning', label: 'Awning stripes', photo: false },
    { id: 'photo_side', label: 'Photo at the side', photo: true },
  ],
  tall: [
    { id: 'stack', label: 'Stacked lines', photo: false },
    { id: 'hero_top', label: 'Photo on top', photo: true },
    { id: 'photo_middle', label: 'Name, photo, details', photo: true },
    { id: 'logo_hero', label: 'The logo as the headline', photo: false },
  ],
  square: [
    { id: 'centre', label: 'Centred', photo: false },
    { id: 'photo_circle', label: 'Photo in a circle', photo: true },
    { id: 'logo_hero', label: 'The logo as the headline', photo: false },
  ],
  sheet: [
    { id: 'menu', label: 'Menu / price list', photo: false },
    { id: 'menu_photo', label: 'Menu with a photo', photo: true },
  ],
}

export const fileUrl = (d: PrintDesign, fmt: FileFormat) => d.files.files[fmt]?.url ?? null

export const megabytes = (bytes: number | null | undefined) =>
  bytes == null ? '' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
