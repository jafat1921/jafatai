import type { AudioEdit, AudioExportFormat, AudioFlag, AudioPreview, ChainPreset, FadeCurve, LoudnessTarget, TimeRegion } from './types'

// contract-v15: the non-destructive edit stack and the maths the editor needs around it

export const GAIN_RANGE = { min: -24, max: 24, step: 0.5, default: 0, label: 'Gain' }
export const SPEED_RANGE = { min: 0.5, max: 2, step: 0.05, default: 1, label: 'Speed' }
export const PITCH_RANGE = { min: -12, max: 12, step: 1, default: 0, label: 'Pitch' }
export const AMOUNT_RANGE = { min: 0, max: 100, step: 1, default: 70, label: 'Amount' }
export const FADE_MAX = 30
export const APPEND_MAX = 8
export const MARKERS_MAX = 100
export const MARKER_LABEL_MAX = 40
// shorter than this a drag is a click, and a region is not worth keeping
export const MIN_REGION_S = 0.05

export const FADE_CURVES: { value: FadeCurve; label: string }[] = [
  { value: 'tri', label: 'Linear' },
  { value: 'qsin', label: 'Smooth' },
  { value: 'exp', label: 'Exponential' },
  { value: 'log', label: 'Logarithmic' },
]

export const CHAIN_PRESETS: { value: ChainPreset; label: string; hint: string }[] = [
  { value: 'broadcast', label: 'Broadcast', hint: 'Clean, compressed, even' },
  { value: 'cinematic', label: 'Cinematic', hint: 'Wide, deep, a little air' },
  { value: 'podcast', label: 'Podcast', hint: 'Voice forward, gated' },
  { value: 'warm', label: 'Warm', hint: 'Softer top, fuller low end' },
  { value: 'raw', label: 'Raw', hint: 'Only a safety limiter' },
  { value: 'radio', label: 'Radio', hint: 'Band-limited and punchy' },
  { value: 'telephone', label: 'Telephone', hint: 'Narrow, distant line' },
  { value: 'hall', label: 'Hall', hint: 'Concert-hall reverb' },
]

export const LOUDNESS: { value: LoudnessTarget; label: string; lufs: number; tp: number }[] = [
  { value: 'web', label: 'Web', lufs: -14, tp: -1 },
  { value: 'podcast', label: 'Podcast', lufs: -16, tp: -1 },
  { value: 'broadcast', label: 'Broadcast', lufs: -23, tp: -2 },
  { value: 'acx', label: 'ACX audiobook', lufs: -19, tp: -3 },
]

export const loudnessLabel = (t: LoudnessTarget) => {
  const l = LOUDNESS.find((x) => x.value === t)
  return l ? `${l.label} ${minus(l.lufs)} LUFS` : t
}

export const EXPORT_FORMATS: { value: AudioExportFormat; label: string; ext: string }[] = [
  { value: 'wav16', label: 'WAV 16-bit', ext: 'wav' },
  { value: 'wav24', label: 'WAV 24-bit', ext: 'wav' },
  { value: 'wav32f', label: 'WAV 32-bit float', ext: 'wav' },
  { value: 'flac', label: 'FLAC', ext: 'flac' },
  { value: 'mp3_128', label: 'MP3 128 kb/s', ext: 'mp3' },
  { value: 'mp3_192', label: 'MP3 192 kb/s', ext: 'mp3' },
  { value: 'mp3_320', label: 'MP3 320 kb/s', ext: 'mp3' },
  { value: 'opus', label: 'Opus', ext: 'opus' },
  { value: 'mp4', label: 'MP4 video (waveform)', ext: 'mp4' },
]

export const FLAG_TEXT: Record<AudioFlag, string> = {
  clipping: 'Clipping',
  too_loud: 'Too loud',
  too_quiet: 'Too quiet',
  long_silence: 'Long silence',
}

// a real minus sign reads better than a hyphen next to numbers
export const minus = (n: number, digits = 0) => (n < 0 ? `−${Math.abs(n).toFixed(digits)}` : n.toFixed(digits))
const signed = (n: number, digits = 0) => (n > 0 ? `+${n.toFixed(digits)}` : minus(n, digits))

/** "1:05.3": the editor needs tenths; the tiles' clock() doesn't. */
export function stamp(s: number) {
  const t = Math.max(0, s)
  const m = Math.floor(t / 60)
  const sec = t - m * 60
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`
}

const round = (n: number, step = 0.001) => Math.round(n / step) * step
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** A region in order, inside 0..duration. */
export function clampRegion(r: TimeRegion, duration: number): TimeRegion {
  const a = clamp(Math.min(r.start, r.end), 0, duration)
  const b = clamp(Math.max(r.start, r.end), 0, duration)
  return { start: round(a), end: round(b) }
}

export const regionLength = (r: TimeRegion | null | undefined) => (r ? Math.max(0, r.end - r.start) : 0)

/** Sorted, with overlapping or touching cuts joined into one. */
export function mergeCuts(cuts: TimeRegion[]): TimeRegion[] {
  const sorted = cuts.filter((c) => c.end - c.start > 0).map((c) => ({ ...c })).sort((a, b) => a.start - b.start)
  const out: TimeRegion[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start <= last.end + 1e-6) last.end = Math.max(last.end, c.end)
    else out.push(c)
  }
  return out
}

/** The parts of the source that survive the trim and the cuts, in source time. */
export function keptSegments(edit: AudioEdit, duration: number): TimeRegion[] {
  const base = edit.trim ? clampRegion(edit.trim, duration) : { start: 0, end: duration }
  const segs: TimeRegion[] = []
  let at = base.start
  for (const c of mergeCuts(edit.cuts ?? [])) {
    if (c.end <= base.start || c.start >= base.end) continue
    if (c.start > at) segs.push({ start: at, end: Math.min(c.start, base.end) })
    at = Math.max(at, c.end)
  }
  if (at < base.end) segs.push({ start: at, end: base.end })
  return segs
}

const speedOf = (edit: AudioEdit) => (edit.speed && edit.speed > 0 ? edit.speed : 1)

/**
 * How long the edit comes out, before silence trim, looping and joins (those depend on the
 * audio itself, which only the server knows).
 */
export function outputLength(edit: AudioEdit, duration: number) {
  return keptSegments(edit, duration).reduce((n, s) => n + s.end - s.start, 0) / speedOf(edit)
}

/** Where a source moment lands in the edited output. Inside a cut it lands on the join. */
export function sourceToOutput(t: number, edit: AudioEdit, duration: number) {
  let out = 0
  for (const s of keptSegments(edit, duration)) {
    if (t < s.start) break
    if (t <= s.end) return (out + t - s.start) / speedOf(edit)
    out += s.end - s.start
  }
  return out / speedOf(edit)
}

/** The source moment behind a point in the edited output, so the waveform playhead can follow B. */
export function outputToSource(t: number, edit: AudioEdit, duration: number) {
  const segs = keptSegments(edit, duration)
  let left = Math.max(0, t) * speedOf(edit)
  for (const s of segs) {
    const len = s.end - s.start
    if (left <= len) return s.start + left
    left -= len
  }
  return segs.length ? segs[segs.length - 1].end : 0
}

/** Cutting a region: limited to what the trim keeps, then merged with the cuts already there. */
export function addCut(edit: AudioEdit, region: TimeRegion, duration: number): AudioEdit {
  const keep = edit.trim ? clampRegion(edit.trim, duration) : { start: 0, end: duration }
  const r = clampRegion(region, duration)
  const c = { start: Math.max(r.start, keep.start), end: Math.min(r.end, keep.end) }
  if (c.end - c.start < MIN_REGION_S) return edit
  return { ...edit, cuts: mergeCuts([...(edit.cuts ?? []), c]) }
}

/** Keeping a region: it becomes the trim, and cuts outside it go. */
export function keepRegion(edit: AudioEdit, region: TimeRegion, duration: number): AudioEdit {
  const r = clampRegion(region, duration)
  if (r.end - r.start < MIN_REGION_S) return edit
  const cuts = mergeCuts(edit.cuts ?? []).filter((c) => c.end > r.start && c.start < r.end)
  return { ...edit, trim: r, cuts }
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3

/** What gets sent: defaults dropped, an untouched edit is {} ("as it is"). */
export function compact(edit: AudioEdit, duration?: number): AudioEdit {
  const out: AudioEdit = {}
  const trim = edit.trim
  if (trim && !(duration != null && near(trim.start, 0) && near(trim.end, duration))) out.trim = { start: round(trim.start), end: round(trim.end) }
  const cuts = mergeCuts(edit.cuts ?? [])
  if (cuts.length) out.cuts = cuts.map((c) => ({ start: round(c.start), end: round(c.end) }))
  if (edit.gain_db && !near(edit.gain_db, 0)) out.gain_db = clamp(edit.gain_db, GAIN_RANGE.min, GAIN_RANGE.max)
  if (edit.fade_in && edit.fade_in.s > 0) out.fade_in = { s: clamp(edit.fade_in.s, 0, FADE_MAX), curve: edit.fade_in.curve }
  if (edit.fade_out && edit.fade_out.s > 0) out.fade_out = { s: clamp(edit.fade_out.s, 0, FADE_MAX), curve: edit.fade_out.curve }
  if (edit.speed != null && !near(edit.speed, 1)) out.speed = clamp(edit.speed, SPEED_RANGE.min, SPEED_RANGE.max)
  if (edit.pitch) out.pitch = clamp(Math.round(edit.pitch), PITCH_RANGE.min, PITCH_RANGE.max)
  if (edit.silence_trim) out.silence_trim = true
  if (edit.loop_to && edit.loop_to > 0) out.loop_to = edit.loop_to
  if (edit.append?.length) out.append = edit.append.slice(0, APPEND_MAX)
  if (edit.chain) out.chain = { preset: edit.chain.preset, amount: clamp(Math.round(edit.chain.amount), 0, 100) }
  if (edit.loudness) out.loudness = { target: edit.loudness.target }
  if (edit.markers?.length)
    out.markers = edit.markers.slice(0, MARKERS_MAX).map((m) => ({ t: round(m.t), label: m.label.slice(0, MARKER_LABEL_MAX) }))
  return Object.keys(out).length ? { version: 1, ...out } : {}
}

/** Only markers changed: nothing to hear, so no preview is worth asking for. */
export const changesSound = (edit: AudioEdit) => Object.keys(edit).some((k) => k !== 'version' && k !== 'markers')

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** "Trim 0:05.0–1:20.0 · 2 cuts · +3 dB …" for the version note and the screen reader. */
export function describe(edit: AudioEdit): string {
  const parts: string[] = []
  if (edit.trim) parts.push(`Trim ${stamp(edit.trim.start)}–${stamp(edit.trim.end)}`)
  if (edit.cuts?.length) parts.push(plural(edit.cuts.length, 'cut'))
  if (edit.silence_trim) parts.push('Silence trimmed')
  if (edit.speed && !near(edit.speed, 1)) parts.push(`Speed ${Number(edit.speed.toFixed(2))}×`)
  if (edit.pitch) parts.push(`Pitch ${signed(edit.pitch)} st`)
  if (edit.chain) parts.push(`${CHAIN_PRESETS.find((c) => c.value === edit.chain!.preset)?.label ?? edit.chain.preset} ${Math.round(edit.chain.amount)}%`)
  if (edit.gain_db) parts.push(`${signed(edit.gain_db, Number.isInteger(edit.gain_db) ? 0 : 1)} dB`)
  if (edit.loop_to) parts.push(`Loop to ${stamp(edit.loop_to)}`)
  if (edit.append?.length) parts.push(`Joined ${plural(edit.append.length, 'track')}`)
  if (edit.fade_in?.s) parts.push(`Fade in ${edit.fade_in.s} s`)
  if (edit.fade_out?.s) parts.push(`Fade out ${edit.fade_out.s} s`)
  if (edit.loudness) parts.push(loudnessLabel(edit.loudness.target))
  if (edit.markers?.length) parts.push(plural(edit.markers.length, 'marker'))
  return parts.length ? parts.join(' · ') : 'No changes'
}

/** Playback gain that brings both sides of an A/B to the quieter one's loudness. */
export function levelMatch(lufsA: number | null | undefined, lufsB: number | null | undefined) {
  if (lufsA == null || lufsB == null) return { a: 1, b: 1 }
  const floor = Math.min(lufsA, lufsB)
  return { a: 10 ** ((floor - lufsA) / 20), b: 10 ** ((floor - lufsB) / 20) }
}

// the server's thresholds (contract v15), applied to what it measured on a preview
export function previewFlags(p: Pick<AudioPreview, 'lufsI' | 'truePeakDb'> | null): AudioFlag[] {
  if (!p) return []
  const out: AudioFlag[] = []
  if (p.truePeakDb != null && p.truePeakDb >= -0.1) out.push('clipping')
  if (p.lufsI != null && p.lufsI > -9) out.push('too_loud')
  if (p.lufsI != null && p.lufsI < -30) out.push('too_quiet')
  return out
}

// ---------------------------------------------------------------- the waveform's visible window

export interface View {
  start: number
  span: number
}

export const MIN_SPAN_S = 0.5

export function clampView(v: View, duration: number): View {
  const span = clamp(v.span, Math.min(MIN_SPAN_S, duration || MIN_SPAN_S), Math.max(duration, MIN_SPAN_S))
  return { span, start: clamp(v.start, 0, Math.max(0, duration - span)) }
}

/** Zoom by a factor around a moment, keeping that moment under the same spot on screen. */
export function zoomView(v: View, factor: number, at: number, duration: number): View {
  const span = v.span / factor
  const frac = v.span ? (at - v.start) / v.span : 0.5
  return clampView({ span, start: at - frac * span }, duration)
}
