import type { Voice, VoiceEngine } from '@/lib/types'
import { T } from './media-fixtures'

const EN = { code: 'en', name: 'English' }
const UR = { code: 'ur', name: 'Urdu' }
const HI = { code: 'hi', name: 'Hindi' }
const PA = { code: 'pa', name: 'Punjabi' }

// shaped like contract-v16's engine table, trimmed to a handful of languages
export const ENGINES: VoiceEngine[] = [
  { id: 'omnivoice', label: 'OmniVoice', features: ['clone', 'design', 'tags'], languages: [EN, UR, HI, PA], licence: 'Apache-2.0', default_for: ['ur'] },
  { id: 'voxcpm', label: 'VoxCPM2', features: ['clone', 'design'], languages: [EN, HI], licence: 'Apache-2.0' },
  { id: 'chatterbox', label: 'Chatterbox', features: ['clone', 'emotion'], languages: [EN, HI], licence: 'MIT; output carries a Perth watermark' },
  {
    id: 'kokoro',
    label: 'Kokoro',
    features: ['preset_voices', 'fast'],
    languages: [EN],
    licence: 'Apache-2.0',
    presets: [{ id: 'af_heart', name: 'Heart', language: 'en' }],
  },
]

export const voice = (id: string, extra: Partial<Voice> = {}): Voice => ({
  id,
  name: `Voice ${id}`,
  language: 'en',
  notes: '',
  gender_hint: null,
  kind: 'clone',
  ref: { media_id: `m-${id}`, generation_id: `g-${id}`, duration_s: 9, url: `/media/${id}.wav` },
  ref_text: '',
  design: null,
  preset: null,
  portrait_url: null,
  starred: false,
  locked: false,
  consent: { name: 'Ayesha', statement: 'I have the right to use this voice, and the person it belongs to agreed to it being cloned.', at: T, user_id: 'u1' },
  created_at: T,
  updated_at: T,
  uses: 0,
  ...extra,
})

export const VOICES: Voice[] = [
  voice('v1', { name: 'Ayesha', language: 'ur', gender_hint: 'female', starred: true, uses: 12 }),
  voice('v2', { name: 'Old Narrator', kind: 'design', ref: null, consent: null, design: { description: 'deep elderly narrator', seed: 42, engine: 'omnivoice' } }),
  voice('v3', { name: 'Heart', kind: 'preset', ref: null, consent: null, preset: { engine: 'kokoro', id: 'af_heart' } }),
]
