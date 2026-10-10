import { readJSON, writeJSON } from './storage'
import type { VisualKind } from './types'

export interface UpscaleEntry {
  jobId: string
  sourceId: string
  resultId: string
  kind: VisualKind
  label: string
  at: number
}

const KEY = 'mixai.recentUpscales'
const KEEP = 12

// The upscale page used to forget a job the moment its dialog closed; this list keeps the
// last few per browser so the result (and the original) stay one click from download.
export function loadUpscales(kind: VisualKind): UpscaleEntry[] {
  return readJSON<UpscaleEntry[]>(KEY, []).filter((e) => e.kind === kind)
}

export function rememberUpscale(entry: UpscaleEntry): UpscaleEntry[] {
  const all = [entry, ...readJSON<UpscaleEntry[]>(KEY, []).filter((e) => e.resultId !== entry.resultId)].slice(0, KEEP * 2)
  writeJSON(KEY, all)
  return all.filter((e) => e.kind === entry.kind)
}

export function forgetUpscale(resultId: string, kind: VisualKind): UpscaleEntry[] {
  const all = readJSON<UpscaleEntry[]>(KEY, []).filter((e) => e.resultId !== resultId)
  writeJSON(KEY, all)
  return all.filter((e) => e.kind === kind)
}
