import type { BrandKit } from './brand'

/**
 * Home "Blueprints" (P4): each card opens the right tool already filled in. Template recipes go
 * through POST /templates/{id}/start like the Templates page; the rest are plain routes.
 */
export interface Recipe {
  id: string
  title: string
  blurb: string
  icon: 'film' | 'ad' | 'sheet' | 'animate' | 'poster' | 'upscale' | 'reveal' | 'photo' | 'teaser'
  templateId?: string
  // a route, or for template recipes extra query on the target (e.g. the Qwen model for text)
  to?: string
  query?: Record<string, string>
  // for recipes with no server template
  prefill?: Record<string, unknown>
  brand?: boolean
}

export const RECIPES: Recipe[] = [
  {
    id: 'quick-film',
    title: 'Quick film',
    blurb: 'One idea to a finished 30-second film: script, cast, shots and the cut.',
    icon: 'film',
    to: '/video/quick',
    prefill: { prompt: 'A [who] [does what] in [where], told in three short scenes', duration_s: 30 },
  },
  { id: 'product-ad', title: 'Product ad', blurb: 'A 30 s advert built around your brand kit, ending on the logo.', icon: 'ad', templateId: 'video-product-ad-30s', brand: true },
  { id: 'character-sheet', title: 'Character sheet', blurb: 'Front, side and back views of one character on a clean sheet.', icon: 'sheet', templateId: 'image-character-sheet' },
  { id: 'animate-still', title: 'Animate a still', blurb: 'Pick a picture and describe the motion; it becomes a clip.', icon: 'animate', to: '/video/img2vid' },
  {
    id: 'poster-text',
    title: 'Poster with text',
    blurb: 'Qwen-Image writes the words you put in quotes, legibly.',
    icon: 'poster',
    templateId: 'image-poster',
    query: { model: 'qwen_image_2512' },
  },
  { id: 'upscale-video', title: 'Upscale my video', blurb: 'Take a render or upload to 1080p, 1440p or 4K.', icon: 'upscale', to: '/video/upscale' },
  { id: 'logo-reveal', title: 'Brand logo reveal', blurb: 'A short animated logo sting from your brand kit.', icon: 'reveal', to: '/brand-kits' },
]

// Instant brand: only offered once a kit exists, so there is always something to brand with
export const BRAND_RECIPES: Recipe[] = [
  { id: 'brand-product-shot', title: 'On-brand product shot', blurb: 'Studio shots in your palette and look.', icon: 'photo', templateId: 'image-product-shot', brand: true },
  { id: 'brand-teaser', title: 'Vertical teaser (15 s)', blurb: 'A social cut that ends on your logo.', icon: 'teaser', templateId: 'video-vertical-teaser-15s', brand: true },
  { id: 'brand-story', title: 'Brand story (60 s)', blurb: 'A minute-long story told in your voice.', icon: 'film', templateId: 'video-brand-story-60s', brand: true },
]

export const defaultKit = (kits: BrandKit[]) => kits.find((k) => k.is_default) ?? kits[0]

/** Where a route recipe goes; the logo reveal lands on the kit's editor when there is one. */
export function recipeRoute(r: Recipe, kits: BrandKit[]): string {
  if (r.id === 'logo-reveal') {
    const kit = defaultKit(kits)
    return kit ? `/brand-kits/${kit.id}` : '/brand-kits'
  }
  return r.to ?? '/'
}
