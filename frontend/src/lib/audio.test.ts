import { describe, expect, it } from 'vitest'
import { CATALOG, MINIMAX } from '@/test/model-fixtures'
import {
  audioBlockedReason,
  audioDurationPresets,
  audioFormFrom,
  audioKindOf,
  audioPayload,
  clampAudioDuration,
  clock,
  DEFAULT_AUDIO_FORM,
  insertSection,
  maxAudioDuration,
} from './audio'
import { localEstimate } from './estimate'
import { checkFile, kindOfFile } from './upload'

const byId = (id: string) => CATALOG.audio.find((m) => m.id === id)!
const ace = byId('ace15_turbo')
const small = byId('sa3_small_music')
const medium = byId('sa3_medium')
const sfx = byId('sa3_small_sfx')

describe('audio payload', () => {
  it('sends a song with lyrics, vocal and language', () => {
    const f = { ...DEFAULT_AUDIO_FORM.song, prompt: '  qawwali, harmonium ', lyrics: '[verse]\nDil\n\n', vocal: 'male' as const, language: 'ur', count: 2, seed: '7', bpm: '92' }
    expect(audioPayload(f, ace)).toEqual({
      kind: 'song',
      prompt: 'qawwali, harmonium',
      model: 'ace15_turbo',
      duration_s: 120,
      count: 2,
      language: 'ur',
      vocal: 'male',
      lyrics: '[verse]\nDil',
      bpm: 92,
      seed: 7,
    })
  })

  it('drops the lyrics for an instrumental, and the timbre for a model that can’t use it', () => {
    const f = { ...DEFAULT_AUDIO_FORM.song, prompt: 'lofi', lyrics: '[verse]\nhello', vocal: 'none' as const, timbreId: 'a9' }
    const body = audioPayload(f, MINIMAX)
    expect(body.lyrics).toBeUndefined()
    expect(body.vocal).toBe('none')
    expect(body.timbre_ref_id).toBeUndefined()
    expect(audioPayload({ ...f, vocal: null }, ace).timbre_ref_id).toBe('a9')
  })

  it('keeps song-only fields off music and sfx, and BPM off sfx', () => {
    const music = audioPayload({ ...DEFAULT_AUDIO_FORM.music, prompt: 'score', lyrics: 'x', vocal: 'female', category: 'loop', bpm: '70' }, small)
    expect(music).toEqual({ kind: 'music', prompt: 'score', model: 'sa3_small_music', duration_s: 30, count: 1, category: 'loop', bpm: 70 })
    const fx = audioPayload({ ...DEFAULT_AUDIO_FORM.sfx, prompt: 'Thunder', bpm: '70', steps: '40' }, sfx)
    expect(fx).toEqual({ kind: 'sfx', prompt: 'Thunder', model: 'sa3_small_sfx', duration_s: 5, count: 1, steps: 40 })
  })
})

describe('audio limits', () => {
  it('caps the length at the model, and SFX at 30 s whatever the model says', () => {
    expect(maxAudioDuration('music', small)).toBe(120)
    expect(maxAudioDuration('music', medium)).toBe(380)
    expect(maxAudioDuration('sfx', sfx)).toBe(30)
    expect(clampAudioDuration(360, 'music', small)).toBe(120)
    expect(clampAudioDuration(0, 'sfx', sfx)).toBe(1)
    expect(audioDurationPresets('music', small).map((p) => p.label)).toEqual(['10 s', '30 s', '1 min', '2 min'])
    expect(audioDurationPresets('music', medium).map((p) => p.label)).toEqual(['10 s', '30 s', '1 min', '2 min', '3 min', '6 min'])
    expect(audioDurationPresets('song', { ...ace, max_duration_s: 150 }).map((p) => p.label)).toEqual(['30 s', '1 min', '2 min', '2 min 30 s'])
  })

  it('says what blocks a run', () => {
    const song = { ...DEFAULT_AUDIO_FORM.song, prompt: 'pop' }
    expect(audioBlockedReason(song, undefined)).toBe('No song model is available on this server yet.')
    expect(audioBlockedReason(song, sfx)).toBe("Stable Audio 3 Small SFX doesn't make songs. Pick another model.")
    expect(audioBlockedReason({ ...song, prompt: 'a' }, ace)).toBe('Add a few style tags first.')
    expect(audioBlockedReason({ ...song, lyrics: 'x'.repeat(6001) }, ace)).toMatch(/limit is 6,000/)
    expect(audioBlockedReason({ ...song, bpm: '300' }, ace)).toBe('BPM goes from 40 to 220.')
    expect(audioBlockedReason({ ...DEFAULT_AUDIO_FORM.sfx, prompt: '' }, sfx)).toBe('Describe the sound first.')
    expect(audioBlockedReason(song, ace)).toBeNull()
  })

  it('scales the local estimate by track length', () => {
    const est = localEstimate(ace, { durationS: 60, count: 2 })!
    // 20 s per 30 s track × 2 × 2 takes, rough spread
    expect(est.low_s).toBeCloseTo(80 * 0.7)
  })
})

describe('lyrics sections', () => {
  it('puts a section tag on its own line at the cursor', () => {
    expect(insertSection('', 0, 'verse')).toEqual({ text: '[verse]\n', cursor: 8 })
    expect(insertSection('line one', 8, 'chorus')).toEqual({ text: 'line one\n[chorus]\n', cursor: 18 })
    // mid-text: the rest moves to the line after the tag
    expect(insertSection('ab', 1, 'bridge').text).toBe('a\n[bridge]\nb')
  })
})

describe('audio helpers', () => {
  it('reads a template or result back into a form', () => {
    expect(audioFormFrom('song', { prompt_scaffold: 'ghazal', lyrics: '[verse]', duration_s: 60, vocal: 'duet', model: 'auto', count: 9 })).toMatchObject({
      prompt: 'ghazal',
      lyrics: '[verse]',
      durationS: 60,
      vocal: 'duet',
      count: 4,
    })
    expect(audioFormFrom('song', { model: 'auto' }).model).toBeUndefined()
    expect(audioKindOf({ category: 'Ambience', defaults: {} })).toBe('sfx')
    expect(audioKindOf({ category: 'Score', defaults: { kind: 'song' } })).toBe('song')
    expect(clock(92)).toBe('1:32')
  })

  it('knows audio uploads by type first, then by name', () => {
    const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type })
    expect(kindOfFile(file('take.m4a', 'audio/mp4'))).toBe('audio')
    expect(kindOfFile(file('note.webm', 'audio/webm'))).toBe('audio')
    expect(kindOfFile(file('clip.webm', ''))).toBe('video')
    expect(kindOfFile(file('mix.flac', ''))).toBe('audio')
    expect(checkFile(file('mix.wav', 'audio/wav'), ['audio'])).toBeNull()
    expect(checkFile(file('mix.wav', 'audio/wav'), ['image'])).toMatch(/isn't a file type we can use/)
  })
})
