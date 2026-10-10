import { describe, expect, it } from 'vitest'
import { ENGINES, VOICES } from '@/test/voice-fixtures'
import {
  clonePayload,
  cloneBlockedReason,
  CONSENT_STATEMENT,
  DEFAULT_DESIGN_FORM,
  DEFAULT_SPEAK_FORM,
  designBlockedReason,
  designPayload,
  designVoiceBody,
  EMPTY_CLONE,
  engineReason,
  hasTags,
  insertTag,
  refProblem,
  refWarnings,
  resolveEngine,
  speakBlockedReason,
  speakPayload,
  type SpeakForm,
} from './voice'

const form = (extra: Partial<SpeakForm> = {}): SpeakForm => ({ ...DEFAULT_SPEAK_FORM, text: 'Hello there.', ...extra })
const eng = (id: string) => ENGINES.find((e) => e.id === id)!

describe('voice: expression tags', () => {
  it('finds tags, pauses included', () => {
    expect(hasTags('well [sigh] fine')).toBe(true)
    expect(hasTags('wait [pause 0.5s] now')).toBe(true)
    expect(hasTags('[verse] not a speech tag')).toBe(false)
  })

  it('inserts at the caret with spaces, never glued to a word', () => {
    expect(insertTag('Hello there', 5, '[laughter]')).toEqual({ text: 'Hello [laughter] there', cursor: 17 })
    expect(insertTag('', 0, '[sigh]')).toEqual({ text: '[sigh] ', cursor: 7 })
    expect(insertTag('Yes. ', 5, '[pause 1s]').text).toBe('Yes. [pause 1s] ')
  })
})

describe('voice: engines', () => {
  it('auto is the preset engine for a preset voice, the language default, else OmniVoice', () => {
    expect(resolveEngine('auto', VOICES[2], 'en', ENGINES)?.id).toBe('kokoro')
    expect(resolveEngine('auto', undefined, 'ur', ENGINES)?.id).toBe('omnivoice')
    expect(resolveEngine('auto', undefined, 'en', ENGINES)?.id).toBe('omnivoice')
    expect(resolveEngine('chatterbox', undefined, 'en', ENGINES)?.id).toBe('chatterbox')
  })

  it('explains why an engine is out: language, clone, design, preset', () => {
    expect(engineReason(eng('chatterbox'), 'ur', undefined, ENGINES)).toBe("Chatterbox doesn't speak Urdu. Use OmniVoice.")
    expect(engineReason(eng('kokoro'), 'en', VOICES[0], ENGINES)).toBe("Kokoro can't speak in a cloned voice like Ayesha.")
    expect(engineReason(eng('chatterbox'), 'en', VOICES[1], ENGINES)).toBe("Chatterbox can't speak in a designed voice like Old Narrator.")
    expect(engineReason(eng('omnivoice'), 'en', VOICES[2], ENGINES)).toBe('Heart is a Kokoro preset voice.')
    expect(engineReason(eng('omnivoice'), 'ur', VOICES[0], ENGINES)).toBeNull()
  })
})

describe('voice: speak form', () => {
  it('blocks with reasons someone can act on', () => {
    expect(speakBlockedReason(form({ text: '  ' }), VOICES, ENGINES)).toBe('Write the line to speak first.')
    expect(speakBlockedReason(form(), VOICES, [])).toMatch(/No speech engine/)
    expect(speakBlockedReason(form({ text: 'x'.repeat(5001) }), VOICES, ENGINES)).toMatch(/limit is 5,000/)
    expect(speakBlockedReason(form({ engine: 'chatterbox', language: 'ur' }), VOICES, ENGINES)).toBe("Chatterbox doesn't speak Urdu. Use OmniVoice.")
    expect(speakBlockedReason(form({ voiceId: 'v1', engine: 'kokoro' }), VOICES, ENGINES)).toMatch(/can't speak in a cloned voice/)
    expect(speakBlockedReason(form({ voiceId: 'gone' }), VOICES, ENGINES)).toMatch(/no longer in the library/)
    expect(speakBlockedReason(form({ voiceId: 'v1', language: 'ur' }), VOICES, ENGINES)).toBeNull()
  })

  it('A/B needs B to differ and to work', () => {
    const ab = form({ compare: true, voiceId: 'v1', b: { voiceId: 'v1', engine: 'auto' } })
    expect(speakBlockedReason(ab, VOICES, ENGINES)).toMatch(/B is the same as A/)
    expect(speakBlockedReason({ ...ab, b: { voiceId: 'v1', engine: 'kokoro' } }, VOICES, ENGINES)).toMatch(/^B: Kokoro can't/)
    expect(speakBlockedReason({ ...ab, b: { voiceId: 'v1', engine: 'chatterbox' } }, VOICES, ENGINES)).toBeNull()
  })

  it('payload: the basics, aerab for Urdu, and only the advanced values that were set', () => {
    expect(speakPayload(form(), VOICES, ENGINES)).toEqual({ text: 'Hello there.', engine: 'auto', language: 'en', speed: 1, count: 1, denoise: true })
    const ur = speakPayload(form({ text: ' سلام ', voiceId: 'v1', language: 'ur', aerab: false, speed: 2.4, count: 9 }), VOICES, ENGINES)
    expect(ur).toEqual({ text: 'سلام', engine: 'auto', language: 'ur', voice_id: 'v1', aerab: false, speed: 2, count: 4, denoise: true })
    const adv = speakPayload(form({ steps: '32', guidance: '2.5', denoise: false, durationS: '6', seed: '7', exaggeration: '0.8' }), VOICES, ENGINES)
    expect(adv).toMatchObject({ steps: 32, guidance: 2.5, denoise: false, duration_s: 6, seed: 7 })
    // exaggeration is Chatterbox's alone
    expect(adv).not.toHaveProperty('exaggeration')
    expect(speakPayload(form({ engine: 'chatterbox', exaggeration: '3' }), VOICES, ENGINES).exaggeration).toBe(2)
  })

  it('payload for side B swaps only the voice and engine', () => {
    const f = form({ voiceId: 'v1', compare: true, b: { voiceId: null, engine: 'chatterbox' } })
    const b = speakPayload(f, VOICES, ENGINES, f.b)
    expect(b).not.toHaveProperty('voice_id')
    expect(b).toMatchObject({ engine: 'chatterbox', text: 'Hello there.' })
  })
})

describe('voice: cloning', () => {
  const ready = { ...EMPTY_CLONE, name: 'Bilal', refMediaId: 'a1', refDurationS: 8, consentName: 'Bilal Khan', consented: true }

  it('warns outside 5–15 s and refuses outside 3–30 s', () => {
    expect(refWarnings(4)).toEqual(['short'])
    expect(refWarnings(10)).toEqual([])
    expect(refWarnings(20)).toEqual(['long'])
    expect(refProblem(2)).toMatch(/at least 3 s/)
    expect(refProblem(31)).toMatch(/up to 30 s/)
    expect(refProblem(null)).toBeNull()
  })

  it('needs a name, a clip and consent', () => {
    expect(cloneBlockedReason({ ...ready, name: '' })).toMatch(/Name the voice/)
    expect(cloneBlockedReason({ ...ready, refMediaId: null })).toMatch(/reference clip/)
    expect(cloneBlockedReason({ ...ready, consentName: ' ' })).toMatch(/name of the person/)
    expect(cloneBlockedReason({ ...ready, consented: false })).toMatch(/Tick the consent/)
    expect(cloneBlockedReason(ready)).toBeNull()
  })

  it('sends the consent statement word for word', () => {
    expect(clonePayload({ ...ready, gender: 'male', refText: ' Salaam ' })).toEqual({
      name: 'Bilal',
      language: 'en',
      kind: 'clone',
      ref_media_id: 'a1',
      ref_text: 'Salaam',
      gender_hint: 'male',
      consent: { name: 'Bilal Khan', statement: CONSENT_STATEMENT },
    })
    expect(CONSENT_STATEMENT).toBe('I have the right to use this voice, and the person it belongs to agreed to it being cloned.')
  })
})

describe('voice: design', () => {
  it('needs a description and a design engine that speaks the language', () => {
    expect(designBlockedReason({ ...DEFAULT_DESIGN_FORM }, ENGINES)).toMatch(/Describe the voice/)
    expect(designBlockedReason({ ...DEFAULT_DESIGN_FORM, description: 'calm', engine: 'chatterbox' }, ENGINES)).toMatch(/can design/)
    expect(designBlockedReason({ ...DEFAULT_DESIGN_FORM, description: 'calm', engine: 'voxcpm', language: 'ur' }, ENGINES)).toMatch(/doesn't speak Urdu/)
    expect(designBlockedReason({ ...DEFAULT_DESIGN_FORM, description: 'calm' }, [ENGINES[3]])).toMatch(/No engine/)
  })

  it('sends the seed only while it is locked, and saves the recipe', () => {
    const f = { ...DEFAULT_DESIGN_FORM, description: 'warm elder', seed: '99' }
    expect(designPayload(f)).not.toHaveProperty('seed')
    expect(designPayload({ ...f, lockSeed: true })).toMatchObject({ seed: 99, engine: 'omnivoice', text: 'The quick brown fox jumps over the lazy dog.' })
    expect(designPayload({ ...f, text: ' ' })).not.toHaveProperty('text')
    expect(designVoiceBody(' Dada ', { itemId: 'i', description: 'warm elder', seed: 99, engine: 'omnivoice', language: 'ur' })).toEqual({
      name: 'Dada',
      language: 'ur',
      kind: 'design',
      design: { description: 'warm elder', seed: 99, engine: 'omnivoice' },
    })
  })
})
