import type { Job, Voice, VoiceGender } from './types'

// contract-v19: the Voice Gallery

export type GalleryAge = 'child' | 'young' | 'adult' | 'elder'
export type GalleryFacetName = 'language' | 'gender' | 'age' | 'style' | 'engine'

export interface GalleryVoice {
  id: string
  voice_id: string
  name: string
  language: string
  languages: string[]
  gender: VoiceGender
  age: GalleryAge
  accent: string
  styles: string[]
  engine: string
  kind: 'design' | 'preset'
  instruct?: string
  seed?: number
  preset?: string
  sample_url: string
  sample_ready: boolean
  added_voice_id: string | null
  starred: boolean
}

export interface GalleryFacetValue {
  value: string
  label: string
  count: number
}

export interface GalleryResponse {
  items: GalleryVoice[]
  total: number
  facets: Record<GalleryFacetName, GalleryFacetValue[]>
}

export type GalleryQuery = Partial<Record<GalleryFacetName | 'q', string>>

export type GallerySample = { ready: true; url: string } | { ready: false; job: Job }

export const GALLERY_PREFIX = 'gallery:'

export const FACET_NAMES: GalleryFacetName[] = ['language', 'gender', 'age', 'style', 'engine']

export const FACET_LABEL: Record<GalleryFacetName, string> = { language: 'Language', gender: 'Gender', age: 'Age', style: 'Style', engine: 'Engine' }

export const ENGINE_BADGE: Record<string, string> = { omnivoice: 'OmniVoice', voxcpm: 'VoxCPM2', kokoro: 'Kokoro' }

export const isGalleryId = (id: string | null | undefined): id is string => !!id && id.startsWith(GALLERY_PREFIX)

export const galleryIdOf = (voiceId: string) => voiceId.slice(GALLERY_PREFIX.length)

/** A gallery entry dressed as a library voice, so the Speak / Dialogue checks treat it like one. */
export function galleryAsVoice(g: GalleryVoice): Voice {
  return {
    id: g.voice_id,
    name: g.name,
    language: g.language,
    notes: [g.accent, g.styles.join(', ')].filter(Boolean).join(' · '),
    gender_hint: g.gender,
    kind: g.kind,
    ref: null,
    ref_text: '',
    design: g.kind === 'design' ? { description: g.instruct ?? '', seed: g.seed ?? 0, engine: g.engine } : null,
    preset: g.kind === 'preset' ? { engine: g.engine, id: g.preset ?? g.id } : null,
    portrait_url: null,
    starred: false,
    locked: true,
    consent: null,
    created_at: '',
    updated_at: '',
    uses: 0,
  }
}

/** Search words all have to appear somewhere: name, accent, styles, languages or the recipe. */
export function matchesGallery(g: GalleryVoice, q: string, languageName: (code: string) => string = (c) => c) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [g.name, g.accent, g.styles.join(' '), g.instruct ?? '', g.gender, g.age, ...g.languages.map(languageName)].join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}

// a stable tint per voice: the avatar keeps its colour across pages and reloads
const TINTS = ['bg-studio-accent-soft text-studio-accent-hover', 'bg-studio-gold/20 text-studio-text', 'bg-studio-raised text-studio-text', 'bg-studio-panel-hover text-studio-accent-hover']

export function tintOf(id: string) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return TINTS[h % TINTS.length]
}

export function initialsOf(name: string) {
  // "Aamir, Lahore narrator" -> "AL"; "Heart" -> "H"
  const words = name
    .replace(/\(.*?\)/g, '')
    .split(/[\s,]+/)
    .filter((w) => /^\p{L}/u.test(w))
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase()
}
