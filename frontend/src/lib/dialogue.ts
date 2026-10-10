import type { Job } from './types'

// contract-v17: dialogue and narration scripts

export const NARRATOR = 'narrator'
export const LINE_MAX = 5000
// above this the line list only mounts the rows on screen
export const VIRTUAL_AFTER = 200
export const WORDS_PER_S = 2.5

export type LineStatus = 'empty' | 'stale' | 'rendering' | 'ready' | 'failed'
export type SplitMode = 'sentences' | 'paragraphs' | 'lines'
export type LoudnessPreset = 'web' | 'podcast' | 'broadcast' | 'acx' | 'none'

export interface CastMember {
  id: string
  name: string
  voice_id: string | null
  color: string | null
}

export interface ScriptLine {
  id: string
  speaker_id: string
  text: string
  voice_id: string | null
  speed: number | null
  emotion: string | null
  pause_after_s: number | null
  para: boolean
  take_id?: string | null
  take_media_id?: string | null
  take_url?: string | null
  duration_s?: number | null
  fingerprint?: string | null
  status: LineStatus
  error?: string | null
}

export interface ScriptSettings {
  gap_s: number
  paragraph_gap_s: number
  loudness: LoudnessPreset
  aerab: boolean
}

export interface ScriptMix {
  media_id: string
  generation_id: string
  url: string | null
  duration_s: number | null
  built_at: string | null
  stale: boolean
}

export interface ScriptCounts {
  lines: number
  ready: number
  stale: number
  empty: number
  rendering: number
  failed: number
}

export interface Script {
  id: string
  title: string
  language: string
  engine: string
  project_id: string | null
  cast: CastMember[]
  lines: ScriptLine[]
  settings: ScriptSettings
  mix: ScriptMix | null
  mix_job: Job | null
  stems_job: Job | null
  counts: ScriptCounts
  created_at: string
  updated_at: string
}

export interface ScriptSummary {
  id: string
  title: string
  language: string
  project_id: string | null
  counts: ScriptCounts
  has_mix: boolean
  created_at: string
  updated_at: string
}

export interface ScriptCreate {
  title: string
  language?: string
  engine?: string
  project_id?: string | null
}

export type LinePatch = Pick<ScriptLine, 'speaker_id' | 'text' | 'voice_id' | 'speed' | 'emotion' | 'pause_after_s' | 'para'> & { id?: string }

export interface ScriptPatch {
  title?: string
  language?: string
  engine?: string
  cast?: CastMember[]
  lines?: LinePatch[]
  settings?: ScriptSettings
}

export interface RenderResponse {
  jobs: Job[]
  queued: number
  failed: number
}

export const STATUS_LABEL: Record<LineStatus, string> = {
  empty: 'Not rendered',
  stale: 'Changed',
  rendering: 'Rendering',
  ready: 'Ready',
  failed: 'Failed',
}

export const LOUDNESS_LABEL: Record<LoudnessPreset, string> = {
  podcast: 'Podcast (−16 LUFS)',
  web: 'Web (−14 LUFS)',
  broadcast: 'Broadcast EBU (−23 LUFS)',
  acx: 'Audiobook ACX (−19 LUFS)',
  none: 'As rendered',
}

const rid = (prefix: string) => `${prefix}${Math.random().toString(16).slice(2, 12).padEnd(10, '0')}`
export const newLineId = () => rid('l_')
export const newCastId = () => rid('c_')

export const hasText = (l: Pick<ScriptLine, 'text'>) => l.text.trim().length > 0
export const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

export function blankLine(speakerId: string = NARRATOR): ScriptLine {
  return { id: newLineId(), speaker_id: speakerId, text: '', voice_id: null, speed: null, emotion: null, pause_after_s: null, para: false, status: 'empty' }
}

const EDITABLE = ['speaker_id', 'text', 'voice_id', 'speed', 'emotion', 'pause_after_s', 'para'] as const

export const toPatch = (l: ScriptLine): LinePatch => {
  const out = { id: l.id } as LinePatch
  for (const k of EDITABLE) (out as unknown as Record<string, unknown>)[k] = l[k]
  return out
}

/** Did the user change what this line says (or how) since the server last saw it? */
export function edited(local: ScriptLine, server: ScriptLine | undefined) {
  if (!server) return true
  return EDITABLE.some((k) => (k === 'text' ? local.text.trim() !== server.text.trim() : (local[k] ?? null) !== (server[k] ?? null)))
}

/**
 * Lay fresh server lines under the local draft: the draft keeps what the user typed, the server's
 * bookkeeping (status, take, fingerprint) comes through. A line edited since its last save reads as
 * changed until the save lands.
 */
export function mergeServer(local: ScriptLine[], server: ScriptLine[], dirty: boolean): ScriptLine[] {
  if (!dirty) return server
  const byId = new Map(server.map((l) => [l.id, l]))
  return local.map((l) => {
    const s = byId.get(l.id)
    // added here and not saved yet
    if (!s) return { ...l, status: 'empty' as const }
    const mine = { ...s, ...pickEditable(l) }
    if (edited(l, s) && hasText(l) && s.status !== 'rendering') mine.status = s.take_id ? 'stale' : 'empty'
    return mine
  })
}

function pickEditable(l: ScriptLine) {
  const out: Partial<ScriptLine> = {}
  for (const k of EDITABLE) (out as Record<string, unknown>)[k] = l[k]
  return out
}

/** What "Render N changed" sends: lines with words that aren't ready or on their way. */
export const changedLines = (lines: ScriptLine[]) => lines.filter((l) => hasText(l) && (l.status === 'stale' || l.status === 'empty' || l.status === 'failed'))

export function mixBlockedReason(lines: ScriptLine[], dirty = false): string | null {
  const spoken = lines.filter(hasText)
  if (spoken.length === 0) return 'Add a line to mix'
  if (dirty) return 'Saving your changes…'
  const rendering = spoken.filter((l) => l.status === 'rendering').length
  const waiting = spoken.filter((l) => l.status !== 'ready' && l.status !== 'rendering').length
  if (waiting) return `${waiting} line${waiting === 1 ? '' : 's'} to render first`
  if (rendering) return `${rendering} line${rendering === 1 ? '' : 's'} still rendering`
  return null
}

export function gapAfter(l: ScriptLine, s: ScriptSettings) {
  if (l.pause_after_s != null) return l.pause_after_s
  return l.para ? s.paragraph_gap_s : s.gap_s
}

const lineSeconds = (l: ScriptLine) => (l.status === 'ready' && l.duration_s ? l.duration_s : words(l.text) / WORDS_PER_S / (l.speed || 1))

/** Seconds of the finished mix: real take lengths where there are takes, words / 2.5 elsewhere. */
export function runtimeEstimate(lines: ScriptLine[], s: ScriptSettings) {
  const spoken = lines.filter(hasText)
  return spoken.reduce((sum, l, i) => sum + lineSeconds(l) + (i < spoken.length - 1 ? gapAfter(l, s) : 0), 0)
}

export function progressOf(lines: ScriptLine[]) {
  const spoken = lines.filter(hasText)
  const ready = spoken.filter((l) => l.status === 'ready').length
  return { ready, total: spoken.length, rendering: spoken.filter((l) => l.status === 'rendering').length }
}

export function moveLine<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list
  const next = list.slice()
  const [it] = next.splice(from, 1)
  next.splice(to, 0, it)
  return next
}

// ---------------------------------------------------------------- the paste preview

// The server does the real split (POST /scripts/{id}/split); this mirrors its rules closely enough to
// preview who says what before anything is saved.
const PREFIX = /^\s*([\p{L}][\p{L}\p{N} .'-]{0,39}?)\s*:\s+(\S.*)$/u
const CUE = /^[A-Z][A-Z0-9 .'-]{1,40}(\s*\([^)]*\))?$/
const SENTENCE = /[^.!?…۔؟।]+(?:[.!?…۔؟।]+["'”’)\]]*|$)/g
const ABBR = /\b(?:Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|vs|etc)\.$/i

export interface PreviewLine {
  speaker: string
  text: string
  emotion?: string
}

export function sentences(text: string): string[] {
  const parts = (text.match(SENTENCE) ?? []).map((p) => p.trim()).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += ` ${p}`
    else out.push(p)
  }
  return out.length ? out : text.trim() ? [text.trim()] : []
}

const isCue = (line: string) => CUE.test(line) && line.split(/\s+/).length <= 5
const cueName = (line: string) => line.replace(/\s*\([^)]*\)\s*$/, '').trim()
const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase()) : s)
const speakerName = (raw: string, narrator: string) => (/^(narrator|narration|v\.o\.|vo)$/i.test(raw.trim()) ? narrator : titleCase(raw.trim()))

export function isScreenplay(text: string) {
  const rows = text.split('\n').map((r) => r.trim())
  return rows.some((r, i) => isCue(r) && rows[i + 1] && !isCue(rows[i + 1]))
}

function screenplay(text: string, narrator: string): (PreviewLine & { para: boolean })[] {
  const out: (PreviewLine & { para: boolean })[] = []
  let who: string | null = null
  let emotion: string | undefined
  let buf: string[] = []
  let kind: 'dialogue' | 'action' | null = null
  const flush = () => {
    if (buf.length) out.push({ speaker: who ?? narrator, text: buf.join(' '), emotion, para: false })
    buf = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) {
      flush()
      if (out.length) out[out.length - 1].para = true
      who = null
      kind = null
      emotion = undefined
      continue
    }
    if (isCue(line)) {
      flush()
      who = speakerName(cueName(line), narrator)
      kind = 'dialogue'
      emotion = undefined
      continue
    }
    if (line.startsWith('(') && line.endsWith(')')) {
      if (kind === 'dialogue') {
        flush()
        emotion = line.replace(/^\(|\)$/g, '').trim() || undefined
      }
      continue
    }
    if (kind !== 'dialogue' && kind !== 'action') {
      flush()
      who = narrator
      kind = 'action'
    }
    buf.push(line)
  }
  flush()
  return out
}

function plain(text: string, mode: SplitMode, narrator: string): (PreviewLine & { para: boolean })[] {
  const out: (PreviewLine & { para: boolean })[] = []
  for (const block of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const rows = block.split('\n').map((r) => r.trim()).filter(Boolean)
    if (!rows.length) continue
    let who = narrator
    const start = out.length
    for (const row of rows) {
      const m = PREFIX.exec(row)
      if (m && m[1].split(/\s+/).length <= 4) {
        who = speakerName(m[1], narrator)
        out.push({ speaker: who, text: m[2].trim(), para: false })
      } else if (mode !== 'lines' && out.length > start && out[out.length - 1].speaker === who) {
        out[out.length - 1].text += ` ${row}`
      } else {
        out.push({ speaker: who, text: row, para: false })
      }
    }
    if (out.length > start) out[out.length - 1].para = true
  }
  return out
}

export function splitPreview(text: string, mode: SplitMode, defaultSpeaker = 'Narrator'): PreviewLine[] {
  if (!text.trim()) return []
  const utts = isScreenplay(text) ? screenplay(text, defaultSpeaker) : plain(text, mode, defaultSpeaker)
  return utts.flatMap((u) => (mode === 'sentences' ? sentences(u.text) : [u.text.split(/\s+/).join(' ')]).map((t) => ({ speaker: u.speaker, text: t, emotion: u.emotion })))
}
