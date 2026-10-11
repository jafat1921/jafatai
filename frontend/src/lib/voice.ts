import { isArabicScriptLang } from './aerab'
import { MAX_TAKES } from './audio'
import type { DesignPreviewRequest, RefWarning, SpeakRequest, Voice, VoiceCreate, VoiceEngine, VoiceGender, VoiceKind, VoiceLanguage } from './types'

// contract-v16
export const SCRIPT_MAX = 5000
export const SPEED_MIN = 0.5
export const SPEED_MAX = 2
export const EXAGGERATION_MAX = 2
export const AUTO_ENGINE = 'auto'
export const DEFAULT_ENGINE = 'omnivoice'

// the server compares this character for character; change it only together with the backend
export const CONSENT_STATEMENT = 'I have the right to use this voice, and the person it belongs to agreed to it being cloned.'

// accepted 3–30 s; 5–15 s clones best
export const REF_MIN_S = 3
export const REF_MAX_S = 30
export const REF_GOOD_MIN_S = 5
export const REF_GOOD_MAX_S = 15

export const KIND_LABEL: Record<VoiceKind, string> = { clone: 'Cloned', design: 'Designed', preset: 'Preset' }

export const GENDERS: { value: VoiceGender; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'neutral', label: 'Neutral' },
]

export const EXPRESSION_TAGS = [
  { tag: '[laughter]', label: 'Laughter' },
  { tag: '[sigh]', label: 'Sigh' },
  { tag: '[breath]', label: 'Breath' },
  { tag: '[whisper]', label: 'Whisper' },
  { tag: '[pause 0.5s]', label: 'Pause 0.5 s' },
  { tag: '[pause 1s]', label: 'Pause 1 s' },
] as const

const TAG_RE = /\[(?:laughter|sigh|breath|whisper|pause\s+\d+(?:\.\d+)?\s*s)\]/i

export const hasTags = (text: string) => TAG_RE.test(text)

/** Drops a tag in at the caret with a space either side, so it never glues onto a word. */
export function insertTag(text: string, at: number, tag: string) {
  const i = Math.max(0, Math.min(at, text.length))
  const before = text.slice(0, i)
  const after = text.slice(i)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after.startsWith(' ') ? '' : ' '
  const next = `${before}${lead}${tag}${trail}${after}`
  return { text: next, cursor: before.length + lead.length + tag.length + 1 }
}

export const can = (e: VoiceEngine | undefined, feature: VoiceEngine['features'][number]) => !!e?.features.includes(feature)

export const speaks = (e: VoiceEngine | undefined, code: string) => !!e?.languages.some((l) => l.code === code)

/** Every language any engine knows, by code, for showing a voice's language by name. */
export function languageName(code: string, engines: VoiceEngine[]) {
  for (const e of engines) {
    const hit = e.languages.find((l) => l.code === code)
    if (hit) return hit.name
  }
  return code
}

/** Every language the engines know, each once, in the first engine's order. */
export function allLanguages(lists: VoiceLanguage[][]) {
  const seen = new Map<string, VoiceLanguage>()
  for (const list of lists) for (const l of list) if (!seen.has(l.code)) seen.set(l.code, l)
  return [...seen.values()]
}

/** What "auto" turns into, as the server decides it: a preset's own engine, the language's default, else OmniVoice. */
export function resolveEngine(engine: string, voice: Voice | undefined, language: string, engines: VoiceEngine[]): VoiceEngine | undefined {
  if (engine !== AUTO_ENGINE) return engines.find((e) => e.id === engine)
  if (voice?.kind === 'preset' && voice.preset) return engines.find((e) => e.id === voice.preset!.engine)
  return engines.find((e) => e.default_for?.includes(language)) ?? engines.find((e) => e.id === DEFAULT_ENGINE) ?? engines[0]
}

const listNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`)

/** Why this engine can't speak this line in this voice; null when it can. */
export function engineReason(e: VoiceEngine, language: string, voice: Voice | undefined, engines: VoiceEngine[]): string | null {
  if (!speaks(e, language)) {
    const others = engines.filter((x) => x.id !== e.id && speaks(x, language)).map((x) => x.label)
    return `${e.label} doesn't speak ${languageName(language, engines)}.${others.length ? ` Use ${listNames(others)}.` : ''}`
  }
  if (voice?.kind === 'clone' && !can(e, 'clone')) return `${e.label} can't speak in a cloned voice like ${voice.name}.`
  if (voice?.kind === 'design' && !can(e, 'design')) return `${e.label} can't speak in a designed voice like ${voice.name}.`
  if (voice?.kind === 'preset' && voice.preset && voice.preset.engine !== e.id) {
    return `${voice.name} is a ${engines.find((x) => x.id === voice.preset!.engine)?.label ?? voice.preset.engine} preset voice.`
  }
  return null
}

export interface SpeakSide {
  voiceId: string | null
  engine: string
}

export interface SpeakForm extends SpeakSide {
  text: string
  language: string
  speed: number
  count: number
  aerab: boolean
  // Advanced: '' leaves it to the engine
  steps: string
  guidance: string
  denoise: boolean
  exaggeration: string
  durationS: string
  seed: string
  // A/B: the same line again with a second voice or engine
  compare: boolean
  b: SpeakSide
}

export const DEFAULT_SPEAK_FORM: SpeakForm = {
  text: '',
  voiceId: null,
  engine: AUTO_ENGINE,
  language: 'en',
  speed: 1,
  count: 1,
  aerab: true,
  steps: '',
  guidance: '',
  denoise: true,
  exaggeration: '',
  durationS: '',
  seed: '',
  compare: false,
  b: { voiceId: null, engine: AUTO_ENGINE },
}

const int = (s: string) => {
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

const num = (s: string) => {
  const n = Number.parseFloat(s)
  return s.trim() && Number.isFinite(n) ? n : null
}

export const speedText = (v: number) => `${v.toFixed(2).replace(/0$/, '')}×`

export const clampSpeed = (v: number) => Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, v)) * 100) / 100

function sideReason(side: SpeakSide, language: string, voices: Voice[], engines: VoiceEngine[], prefix: string) {
  const voice = side.voiceId ? voices.find((v) => v.id === side.voiceId) : undefined
  if (side.voiceId && !voice) return `${prefix}That voice is no longer in the library. Pick another.`
  const e = resolveEngine(side.engine, voice, language, engines)
  if (!e) return `${prefix}That engine isn't on this server.`
  const why = engineReason(e, language, voice, engines)
  return why ? `${prefix}${why}` : null
}

/** Why the line can't be spoken yet, in words someone can act on; null when it can. */
export function speakBlockedReason(f: SpeakForm, voices: Voice[], engines: VoiceEngine[]): string | null {
  if (!engines.length) return 'No speech engine is available on this server yet.'
  if (!f.text.trim()) return 'Write the line to speak first.'
  if (f.text.length > SCRIPT_MAX) return `The script is ${f.text.length.toLocaleString('en')} characters; the limit is ${SCRIPT_MAX.toLocaleString('en')}.`
  const a = sideReason(f, f.language, voices, engines, f.compare ? 'A: ' : '')
  if (a) return a
  if (!f.compare) return null
  if (f.b.voiceId === f.voiceId && f.b.engine === f.engine) {
    return 'B is the same as A. Pick a different voice or engine for B.'
  }
  return sideReason(f.b, f.language, voices, engines, 'B: ')
}

/** The POST /audio/speak body; pass `side` for the B half of a comparison. */
export function speakPayload(f: SpeakForm, voices: Voice[], engines: VoiceEngine[], side: SpeakSide = f): SpeakRequest {
  const voice = side.voiceId ? voices.find((v) => v.id === side.voiceId) : undefined
  const e = resolveEngine(side.engine, voice, f.language, engines)
  const body: SpeakRequest = {
    text: f.text.trim().slice(0, SCRIPT_MAX),
    engine: side.engine || AUTO_ENGINE,
    language: f.language,
    speed: clampSpeed(f.speed),
    count: Math.min(MAX_TAKES, Math.max(1, Math.round(f.count))),
    denoise: f.denoise,
  }
  if (side.voiceId) body.voice_id = side.voiceId
  if (isArabicScriptLang(f.language)) body.aerab = f.aerab
  const steps = int(f.steps)
  if (steps !== null && steps > 0) body.steps = steps
  const guidance = num(f.guidance)
  if (guidance !== null && guidance >= 0) body.guidance = guidance
  const ex = num(f.exaggeration)
  if (can(e, 'emotion') && ex !== null) body.exaggeration = Math.min(EXAGGERATION_MAX, Math.max(0, ex))
  const length = num(f.durationS)
  if (length !== null && length > 0) body.duration_s = length
  const seed = int(f.seed)
  if (seed !== null && seed >= 0) body.seed = seed
  return body
}

/** Speak form from a finished take's params, for "Reuse settings". */
export function speakFormFrom(p: Record<string, unknown> | null | undefined): SpeakForm {
  const s = (k: string) => (typeof p?.[k] === 'string' ? (p[k] as string) : '')
  const n = (k: string) => (typeof p?.[k] === 'number' ? (p[k] as number) : null)
  return {
    ...DEFAULT_SPEAK_FORM,
    text: s('text'),
    voiceId: s('voice_id') || null,
    engine: s('engine') || AUTO_ENGINE,
    language: s('language') || 'en',
    speed: n('speed') ?? 1,
    seed: n('seed') != null ? String(n('seed')) : '',
  }
}

/** A finished item the Speak page made: newer servers say kind speech, older ones only carry the text. */
export const isSpeech = (p: Record<string, unknown> | null | undefined) => p?.kind === 'speech' || typeof p?.text_spoken === 'string'

// reference clips

export function refWarnings(durationS: number | null | undefined): RefWarning[] {
  if (durationS == null) return []
  if (durationS < REF_GOOD_MIN_S) return ['short']
  if (durationS > REF_GOOD_MAX_S) return ['long']
  return []
}

export const REF_WARNING_TEXT: Record<RefWarning, string> = {
  short: 'Under 5 seconds: the clone may not sound much like the speaker. 5 to 15 seconds works best.',
  long: 'Over 15 seconds: it works, but a clean 5 to 15 second stretch usually clones better.',
}

export function refProblem(durationS: number | null | undefined): string | null {
  if (durationS == null) return null
  if (durationS < REF_MIN_S) return `The clip is ${durationS.toFixed(1)} s; a reference needs at least ${REF_MIN_S} s of speech.`
  if (durationS > REF_MAX_S) return `The clip is ${Math.round(durationS)} s; a reference can be up to ${REF_MAX_S} s. Trim it in the Editor first.`
  return null
}

export interface CloneForm {
  name: string
  language: string
  gender: VoiceGender | null
  notes: string
  refMediaId: string | null
  refDurationS: number | null
  refText: string
  consentName: string
  consented: boolean
}

export const EMPTY_CLONE: CloneForm = {
  name: '',
  language: 'en',
  gender: null,
  notes: '',
  refMediaId: null,
  refDurationS: null,
  refText: '',
  consentName: '',
  consented: false,
}

export function cloneBlockedReason(f: CloneForm): string | null {
  if (!f.name.trim()) return 'Name the voice first.'
  if (!f.refMediaId) return 'Add a reference clip: upload one or record it here.'
  const bad = refProblem(f.refDurationS)
  if (bad) return bad
  if (!f.consentName.trim()) return 'Type the name of the person who agreed.'
  if (!f.consented) return 'Tick the consent statement to clone this voice.'
  return null
}

export function clonePayload(f: CloneForm): VoiceCreate {
  const body: VoiceCreate = {
    name: f.name.trim(),
    language: f.language,
    kind: 'clone',
    ref_media_id: f.refMediaId ?? undefined,
    consent: { name: f.consentName.trim(), statement: CONSENT_STATEMENT },
  }
  if (f.refText.trim()) body.ref_text = f.refText.trim()
  if (f.notes.trim()) body.notes = f.notes.trim()
  if (f.gender) body.gender_hint = f.gender
  return body
}

// designing a voice

// OmniVoice designs from a fixed list of attributes only, so the presets speak its language
export const DESIGN_PRESETS = [
  { id: 'narrator', label: 'Narrator', description: 'male, middle-aged, low pitch, slow' },
  { id: 'urdu-narrator', label: 'Urdu narrator', description: 'male, middle-aged, low pitch, indian accent, slow' },
  { id: 'anchor', label: 'News anchor', description: 'female, young adult, moderate pitch, british accent' },
  { id: 'whisper', label: 'Whisper', description: 'female, young adult, whisper' },
  { id: 'elder', label: 'Elder', description: 'male, elderly, low pitch, slow' },
  { id: 'child', label: 'Child', description: 'female, child, high pitch' },
  { id: 'radio', label: 'Radio host', description: 'male, young adult, low pitch, american accent' },
  { id: 'storyteller', label: 'Storyteller', description: 'female, middle-aged, moderate pitch, indian accent, slow' },
  { id: 'villain', label: 'Villain', description: 'male, middle-aged, very low pitch, slow' },
] as const

// what OmniVoice understands in a description (its own list); anything else is dropped
export const OMNIVOICE_WORDS = 'male or female · child, teenager, young adult, middle-aged, elderly · very low to very high pitch · whisper · American, British, Australian, Canadian, Indian (closest to Pakistani), Chinese, Japanese, Korean, Portuguese or Russian accent · slow or fast'

// a line with most of the sounds in it; other languages get the server's own sample
const SAMPLES: Record<string, string> = {
  en: 'The quick brown fox jumps over the lazy dog.',
  ur: 'صبح کی ٹھنڈی ہوا میں پرندوں نے خوشی کا گیت گایا۔',
  hi: 'सुबह की ठंडी हवा में पंछियों ने ख़ुशी का गीत गाया।',
  es: 'El veloz murciélago hindú comía feliz cardillo y kiwi.',
  fr: 'Portez ce vieux whisky au juge blond qui fume.',
  de: 'Victor jagt zwölf Boxkämpfer quer über den großen Sylter Deich.',
}

export const sampleLine = (language: string) => SAMPLES[language] ?? ''

export interface DesignForm {
  description: string
  language: string
  engine: string
  text: string
  seed: string
  // keep the seed between previews, so tweaks to the description keep the same identity
  lockSeed: boolean
}

export const DEFAULT_DESIGN_FORM: DesignForm = { description: '', language: 'en', engine: DEFAULT_ENGINE, text: sampleLine('en'), seed: '', lockSeed: false }

export const designEngines = (engines: VoiceEngine[]) => engines.filter((e) => can(e, 'design'))

export function designBlockedReason(f: DesignForm, engines: VoiceEngine[]): string | null {
  const able = designEngines(engines)
  if (!able.length) return 'No engine on this server can design a voice yet.'
  if (f.description.trim().length < 3) return 'Describe the voice first, or start from a preset.'
  const e = able.find((x) => x.id === f.engine)
  if (!e) return 'Pick an engine that can design a voice.'
  return engineReason(e, f.language, undefined, engines)
}

export function designPayload(f: DesignForm): DesignPreviewRequest {
  const body: DesignPreviewRequest = { description: f.description.trim(), language: f.language, engine: f.engine }
  const seed = int(f.seed)
  if (f.lockSeed && seed !== null && seed >= 0) body.seed = seed
  if (f.text.trim()) body.text = f.text.trim().slice(0, SCRIPT_MAX)
  return body
}

export interface DesignTake {
  itemId: string
  description: string
  seed: number
  engine: string
  language: string
}

export const designVoiceBody = (name: string, t: DesignTake): VoiceCreate => ({
  name: name.trim(),
  language: t.language,
  kind: 'design',
  design: { description: t.description, seed: t.seed, engine: t.engine },
})

export const initialOf = (name: string) => (name.trim()[0] ?? '?').toUpperCase()
