import type { Generation } from '@/lib/types'

// docs/api/contract-v9-photo.md

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
export type HslBand = (typeof HSL_BANDS)[number]
export type Hsl = { h: number; s: number; l: number }

export interface Crop {
  x: number
  y: number
  width: number
  height: number
}

export interface LightPoint {
  x: number
  y: number
  exposure: number
  falloff?: number
  refW?: number
  refH?: number
}

export interface PaletteEntry {
  centerR: number
  centerG: number
  centerB: number
  enabled: boolean
  h: number
  s: number
  l: number
  hex?: string
  coverage?: number
}

export interface DevelopParams {
  version?: number
  exposure?: number
  contrast?: number
  highlights?: number
  shadows?: number
  whites?: number
  blacks?: number
  temperature?: number
  tint?: number
  vibrance?: number
  saturation?: number
  clarity?: number
  sharpness?: number
  noiseReduction?: number
  vignette?: number
  curve?: Partial<Record<'blacks' | 'shadows' | 'mids' | 'highlights' | 'whites', number>>
  hsl?: Partial<Record<HslBand, Partial<Hsl>>>
  crop?: Crop | null
  rotate?: number
  flipH?: boolean
  flipV?: boolean
  lightPoints?: LightPoint[]
  palette?: PaletteEntry[]
  lut?: { look_id: string; amount: number } | null
}

export interface RangeSpec {
  min: number
  max: number
  step: number
  default: number
  label: string
  spatial?: boolean
}

export interface SchemaGroup {
  id: string
  label: string
  keys: string[]
}

export interface PhotoSchema {
  version: number
  defaults: DevelopParams
  ranges: Record<string, RangeSpec>
  groups: SchemaGroup[]
  hsl_bands: { id: HslBand; label: string; hue: number }[]
  spatial_keys: string[]
  formats: { id: ExportFormat; label: string; media_type: string }[]
  effects?: { id: string; label: string; hint?: string }[]
}

export type ExportFormat = 'jpeg' | 'png' | 'png16' | 'tiff16'

export interface Histogram {
  r: number[]
  g: number[]
  b: number[]
  luma: number[]
  clipped: { shadows: number; highlights: number }
}

export interface AutoResult {
  params: DevelopParams
  analysis?: Record<string, unknown>
  notes: string[]
}

export interface DevelopRecord {
  params: DevelopParams
  parent?: string
  base?: string
  format?: ExportFormat
  quality?: number
}

export interface HistoryVersion {
  generation: Generation
  current: boolean
  edit: 'develop' | 'effect' | 'look' | 'upscale' | null
  develop: DevelopRecord | null
  effect: { name: string; strength?: number; parent?: string } | null
  look: { id: string; name: string; intensity?: number; source_id?: string } | null
}

export interface PhotoHistory {
  target_type: string
  target_id: string
  current_id: string | null
  versions: HistoryVersion[]
}

export interface Look {
  id: string
  name: string
  description?: string | null
  category?: string | null
  source: 'builtin' | 'user' | 'imported'
  params: DevelopParams
  has_cube: boolean
  cube_size?: number | null
  editable: boolean
  spatial?: string[]
  thumb_url?: string | null
  created_at?: string
  updated_at?: string
}

export interface ImportReport {
  file: string
  ok: boolean
  kind?: 'xmp' | 'lrtemplate' | 'cube'
  look_id?: string
  name?: string
  mapped?: string[]
  unmapped?: string[]
  notes?: string[]
  cube_size?: number
  error?: string
}

export interface ImportResult {
  looks: Look[]
  reports: ImportReport[]
}

export interface PreviewResult {
  url: string
  ms: number | null
  outputSize: string | null
}
