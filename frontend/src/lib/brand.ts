// contract-v7-brand.md. snake_case so kits pass through untouched.
import type { Generation, Shot } from './types'

export type LogoVariant = 'primary' | 'light' | 'dark'
export type ClosingPref = 'auto' | 'ai_packshot' | 'logo_reveal'
export type BrandPurpose = 'logo' | 'font' | 'product' | 'reference'

export interface LogoRef {
  media_id: string
  description: string
}

export interface BrandProduct {
  media_id: string
  name: string
  description: string
}

export interface PaletteColour {
  hex: string
  name?: string | null
}

export type CardBg = number | string | null

export interface CardSettings {
  enabled: boolean
  duration_s: number
  bg: CardBg
  show_tagline: boolean
  show_name: boolean
}

export interface BrandSettings {
  watermark: {
    enabled: boolean
    position: 'tl' | 'tr' | 'bl' | 'br'
    size_pct: number
    opacity: number
    margin_pct: number
    variant: 'auto' | LogoVariant
  }
  end_card: CardSettings
  intro_card: CardSettings
  lower_third: { enabled: boolean; at_s: number; duration_s: number; text?: string | null; subtext?: string | null }
  grade: { enabled: boolean; strength: number }
  // being added with the closing shot; older servers drop it
  closing?: ClosingPref
}

export interface BrandAsset {
  media_id: string
  kind?: string | null
  media_url?: string | null
  missing: boolean
}

export interface BrandKit {
  id: string
  workspace_id: string
  name: string
  is_default: boolean
  palette: PaletteColour[]
  style_text: string
  voice_text: string
  tagline: string
  logos: Partial<Record<LogoVariant, LogoRef>>
  products: BrandProduct[]
  font_files: string[]
  reference_media_ids: string[]
  settings: BrandSettings
  assets: Record<string, BrandAsset>
  prompt_context?: string
  created_at: string
  updated_at: string
}

export type BrandKitPatch = Partial<
  Pick<BrandKit, 'name' | 'palette' | 'style_text' | 'voice_text' | 'tagline' | 'logos' | 'products' | 'font_files' | 'reference_media_ids'>
> & { settings?: Partial<{ [K in keyof BrandSettings]: unknown }> }

export interface BrandPlacement {
  asset_id: string
  asset_type: 'logo' | 'product'
  surface: string
  prominence: 'hero' | 'background'
  // the planner marks its own; ours say "user" so a re-plan leaves them alone
  source?: 'ai' | 'user'
}

export type PreviewKind = 'image' | 'end_card' | 'intro_card' | 'lower_third'

export interface LogoRevealRequest {
  duration_s: number
  aspect: '16:9' | '9:16' | '1:1' | '4:5'
  background: { kind: 'color' | 'image'; color?: number | string; media_id?: string }
  show_tagline: boolean
  title?: string
}

export const DEFAULT_SETTINGS: BrandSettings = {
  watermark: { enabled: false, position: 'br', size_pct: 12, opacity: 0.85, margin_pct: 3, variant: 'auto' },
  end_card: { enabled: false, duration_s: 2.5, bg: null, show_tagline: true, show_name: false },
  intro_card: { enabled: false, duration_s: 2, bg: null, show_tagline: false, show_name: true },
  lower_third: { enabled: false, at_s: 1, duration_s: 4 },
  grade: { enabled: false, strength: 0.25 },
  closing: 'auto',
}

export const MAX_PALETTE = 6
export const MIN_PALETTE = 3
export const MAX_REFS = 6
export const MAX_PRODUCTS = 12
export const MAX_FONTS = 4

export const LOGO_SLOTS: { variant: LogoVariant; title: string; hint: string }[] = [
  { variant: 'primary', title: 'Main logo', hint: 'The one used most. A transparent PNG or SVG works best.' },
  { variant: 'light', title: 'For dark backgrounds', hint: 'A light or white version, optional.' },
  { variant: 'dark', title: 'For light backgrounds', hint: 'A dark version, optional.' },
]

export const CLOSING_OPTIONS: { value: ClosingPref; title: string; hint: string }[] = [
  { value: 'auto', title: 'Auto', hint: 'The AI picks what suits the advert.' },
  { value: 'ai_packshot', title: 'AI packshot', hint: 'Your product with the logo on it, slow push-in. Drawn by the AI.' },
  { value: 'logo_reveal', title: 'Exact logo reveal', hint: 'Built from your real logo file, so it is pixel-perfect.' },
]

const HEX6 = /^#?([0-9a-f]{6})$/i
const HEX3 = /^#?([0-9a-f]{3})$/i

/** "#0f4c5c", "0F4C5C" and "#abc" all become "#RRGGBB"; anything else is null. */
export function normalizeHex(v: string): string | null {
  const s = v.trim()
  const six = s.match(HEX6)
  if (six) return `#${six[1].toUpperCase()}`
  const three = s.match(HEX3)
  if (three) return `#${three[1].replace(/./g, (c) => c + c).toUpperCase()}`
  return null
}

export interface KitDraft {
  name: string
  palette: PaletteColour[]
  style_text: string
  voice_text: string
  tagline: string
  logos: Partial<Record<LogoVariant, LogoRef>>
  products: BrandProduct[]
  font_files: string[]
  reference_media_ids: string[]
  settings: BrandSettings
}

export const draftFrom = (k: BrandKit): KitDraft => ({
  name: k.name,
  palette: k.palette ?? [],
  style_text: k.style_text ?? '',
  voice_text: k.voice_text ?? '',
  tagline: k.tagline ?? '',
  logos: k.logos ?? {},
  products: k.products ?? [],
  font_files: k.font_files ?? [],
  reference_media_ids: k.reference_media_ids ?? [],
  settings: { ...DEFAULT_SETTINGS, ...k.settings, closing: k.settings?.closing ?? 'auto' },
})

/** Everything wrong with a draft, in words. Empty means it can be saved. */
export function kitProblems(d: KitDraft): string[] {
  const out: string[] = []
  if (!d.name.trim()) out.push('Give the kit a name.')
  d.palette.forEach((c, i) => {
    if (!normalizeHex(c.hex)) out.push(`Colour ${i + 1} (“${c.hex}”) isn't a hex colour like #0F4C5C.`)
  })
  if (d.palette.length > MAX_PALETTE) out.push(`Use at most ${MAX_PALETTE} colours.`)
  if (d.reference_media_ids.length > MAX_REFS) out.push(`Use at most ${MAX_REFS} mood references.`)
  if (d.products.length > MAX_PRODUCTS) out.push(`Use at most ${MAX_PRODUCTS} products.`)
  d.products.forEach((p, i) => {
    if (!p.name.trim()) out.push(`Product ${i + 1} needs a name.`)
  })
  if (d.font_files.length > MAX_FONTS) out.push(`Use at most ${MAX_FONTS} fonts.`)
  return out
}

/** The PATCH body: hexes normalised, empty names dropped, settings sent whole. */
export function kitPatch(d: KitDraft): BrandKitPatch {
  return {
    name: d.name.trim(),
    palette: d.palette.map((c) => ({ hex: normalizeHex(c.hex) ?? c.hex, ...(c.name?.trim() ? { name: c.name.trim() } : {}) })),
    style_text: d.style_text,
    voice_text: d.voice_text,
    tagline: d.tagline,
    logos: d.logos,
    products: d.products.map((p) => ({ ...p, name: p.name.trim() })),
    font_files: d.font_files,
    reference_media_ids: d.reference_media_ids,
    settings: d.settings,
  }
}

/** Adds reference ids up to MAX_REFS; says how many didn't fit. */
export function addRefs(current: string[], incoming: string[], max = MAX_REFS) {
  const ids = [...current]
  let dropped = 0
  for (const id of incoming) {
    if (ids.includes(id)) continue
    if (ids.length >= max) dropped++
    else ids.push(id)
  }
  return { ids, dropped }
}

/** Adds the kit to a generator's body only when the chip is on. */
export function withBrand<T extends object>(body: T, kitId: string | null | undefined): T & { brand_kit_id?: string } {
  return kitId ? { ...body, brand_kit_id: kitId } : body
}

export interface BrandAssetOption {
  id: string
  type: 'logo' | 'product'
  label: string
  url?: string | null
}

/** Logos and products a shot can place, with thumbnails from the kit's asset map. */
export function placeableAssets(kit: BrandKit | undefined): BrandAssetOption[] {
  if (!kit || !kit.logos) return []
  const url = (id: string) => kit.assets?.[id]?.media_url
  const logos = LOGO_SLOTS.flatMap(({ variant, title }) => {
    const ref = kit.logos[variant]
    return ref ? [{ id: ref.media_id, type: 'logo' as const, label: variant === 'primary' ? 'Logo' : `Logo (${title.toLowerCase()})`, url: url(ref.media_id) }] : []
  })
  const products = (kit.products ?? []).map((p) => ({ id: p.media_id, type: 'product' as const, label: p.name, url: url(p.media_id) }))
  return [...logos, ...products]
}

export const projectKitId = (settings: Record<string, unknown> | undefined) => (typeof settings?.brand_kit_id === 'string' ? settings.brand_kit_id : null)

export const placementsOf =(shot: Shot) => shot.brand_placements ?? []

export const placementsLocked = (shot: Shot) => !!shot.brand_placements_locked || placementsOf(shot).some((p) => p.source === 'user')

export type ClosingKind = 'ai_packshot' | 'logo_reveal'

export function closingOf(shot: Shot): ClosingKind | null {
  const c = shot.closing ?? shot.brand_closing ?? null
  return c === 'ai_packshot' || c === 'logo_reveal' ? c : null
}

export const CLOSING_LABEL: Record<ClosingKind, string> = { ai_packshot: 'Packshot', logo_reveal: 'Logo reveal' }

export interface LogoCheck {
  checked: boolean
  passed?: boolean
  present?: boolean
  legible?: boolean
  distorted?: boolean
  score?: number
  issues?: string[]
  reason?: string
}

export type LogoCheckView =
  | { state: 'ok'; score?: number }
  | { state: 'issues'; issues: string[] }
  | { state: 'unchecked'; reason: string }

/** What a frame's params.logo_check says, or null when the frame wasn't checked at all. */
export function logoCheckOf(frame: Pick<Generation, 'params'> | null | undefined): LogoCheckView | null {
  const c = frame?.params?.logo_check as LogoCheck | undefined
  if (!c || typeof c !== 'object') return null
  if (!c.checked) return { state: 'unchecked', reason: c.reason || "The vision model wasn't available." }
  if (c.passed) return { state: 'ok', score: c.score }
  const issues = [...(c.issues ?? [])]
  if (!issues.length) {
    if (c.present === false) issues.push("The logo isn't in the frame.")
    if (c.legible === false) issues.push("The logo isn't legible.")
    if (c.distorted) issues.push('The logo is distorted.')
    if (!issues.length) issues.push('The logo looks off.')
  }
  return { state: 'issues', issues }
}

export const logoRetryNote = (issues: string[]) =>
  `Show the brand logo clearly: sharp, legible, undistorted and true to the reference. Fix: ${issues.join(' ')}`

export const FONT_PREVIEW = 'Your brand, beautifully told · آپ کا برانڈ، خوبصورتی سے'
