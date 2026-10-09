import type { MediaItem } from './types'

/** Photo catalogue (contract v11): marks, sources, the filter bar and the Lightroom key grammar. */

export type Flag = 'pick' | 'reject'
export type Label = 'red' | 'yellow' | 'green' | 'blue' | 'purple'
export type SortKey = 'taken' | 'added' | 'edited' | 'rating' | 'name' | 'size' | 'manual'
export type View = 'grid' | 'loupe' | 'compare' | 'survey'
export type AlbumKind = 'folder' | 'album' | 'smart' | 'shoot'

export const LABELS: { id: Label; name: string; key: string; swatch: string }[] = [
  // swatches sit on parchment, so they're a shade deeper than Lightroom's
  { id: 'red', name: 'Red', key: '6', swatch: '#b23a2e' },
  { id: 'yellow', name: 'Yellow', key: '7', swatch: '#c9a227' },
  { id: 'green', name: 'Green', key: '8', swatch: '#4f7a3a' },
  { id: 'blue', name: 'Blue', key: '9', swatch: '#3a5f8f' },
  { id: 'purple', name: 'Purple', key: '', swatch: '#6d4a8a' },
]

export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'taken', label: 'Capture time' },
  { id: 'added', label: 'Added' },
  { id: 'edited', label: 'Edit time' },
  { id: 'rating', label: 'Rating' },
  { id: 'name', label: 'Name' },
  { id: 'size', label: 'File size' },
  { id: 'manual', label: 'Custom order' },
]

export interface Album {
  id: string
  name: string
  kind: AlbumKind
  parent_id: string | null
  client_id: string | null
  client_name?: string | null
  shoot_date: string | null
  venue: string
  notes: string
  rules: SmartRules | null
  cover_id: string | null
  cover_url: string | null
  sort: number
  count: number
}

export interface SmartRule {
  field: string
  op: string
  value: string | number | boolean | null
}
export interface SmartRules {
  match: 'all' | 'any'
  rules: SmartRule[]
}

export interface Client {
  id: string
  name: string
  email: string
  phone: string
  notes: string
  shoots: number
  photos: number
}

export interface PhotoPage {
  items: MediaItem[]
  total: number
  offset: number
  next_offset: number | null
}

export interface FacetValue {
  value: string
  count: number
}
export interface Facets {
  flag: Record<string, number>
  rating: Record<string, number>
  label: Record<string, number>
  camera: FacetValue[]
  lens: FacetValue[]
  keyword: FacetValue[]
  date: { year: string; count: number; months: { month: string; count: number }[] }[]
  edited: { yes: number; no: number }
  total: number
}

/** Where the grid's photos come from. Kept in the URL as ?src=… so a source can be bookmarked. */
export type Source =
  | { kind: 'all' }
  | { kind: 'picks' }
  | { kind: 'rejected' }
  | { kind: 'unsorted' }
  | { kind: 'recent' }
  | { kind: 'favourites' }
  | { kind: 'album'; id: string }
  | { kind: 'client'; id: string }

export function parseSource(raw: string | null): Source {
  if (!raw) return { kind: 'all' }
  const [kind, id] = raw.split(':')
  if ((kind === 'album' || kind === 'client') && id) return { kind, id }
  if (['picks', 'rejected', 'unsorted', 'recent', 'favourites'].includes(kind)) return { kind } as Source
  return { kind: 'all' }
}

export const sourceKey = (s: Source) => ('id' in s ? `${s.kind}:${s.id}` : s.kind)

export interface FilterState {
  q: string
  ratingMin: number | null
  flags: string[] // pick | reject | none
  labels: string[] // red… | none
  cameras: string[]
  lenses: string[]
  keywords: string[]
  dateFrom: string | null
  dateTo: string | null
  edited: boolean | null
}

export const EMPTY_FILTER: FilterState = {
  q: '', ratingMin: null, flags: [], labels: [], cameras: [], lenses: [], keywords: [], dateFrom: null, dateTo: null, edited: null,
}

const list = (v: string | null, sep = ',') => (v ? v.split(sep).filter(Boolean) : [])

export function readFilter(p: URLSearchParams): FilterState {
  const r = Number(p.get('stars'))
  const ed = p.get('edited')
  return {
    q: p.get('q') ?? '',
    ratingMin: r >= 1 && r <= 5 ? r : null,
    flags: list(p.get('flag')),
    labels: list(p.get('label')),
    cameras: list(p.get('camera'), '|'),
    lenses: list(p.get('lens'), '|'),
    keywords: list(p.get('kw')),
    dateFrom: p.get('from'),
    dateTo: p.get('to'),
    edited: ed === '1' ? true : ed === '0' ? false : null,
  }
}

export function writeFilter(p: URLSearchParams, f: FilterState): URLSearchParams {
  const out = new URLSearchParams(p)
  const set = (k: string, v: string | null | undefined) => (v ? out.set(k, v) : out.delete(k))
  set('q', f.q.trim())
  set('stars', f.ratingMin ? String(f.ratingMin) : null)
  set('flag', f.flags.join(','))
  set('label', f.labels.join(','))
  set('camera', f.cameras.join('|'))
  set('lens', f.lenses.join('|'))
  set('kw', f.keywords.join(','))
  set('from', f.dateFrom)
  set('to', f.dateTo)
  set('edited', f.edited == null ? null : f.edited ? '1' : '0')
  return out
}

export const filterCount = (f: FilterState) =>
  [f.q.trim(), f.ratingMin, f.flags.length, f.labels.length, f.cameras.length, f.lenses.length, f.keywords.length, f.dateFrom || f.dateTo, f.edited != null]
    .filter(Boolean).length

/** The API query for a source + filter. Catalogue shortcuts are just pre-set filters. */
export function apiQuery(src: Source, f: FilterState): Record<string, string | number | boolean | undefined> {
  const q: Record<string, string | number | boolean | undefined> = {
    q: f.q.trim() || undefined,
    rating_min: f.ratingMin ?? undefined,
    flag: f.flags.join(',') || undefined,
    label: f.labels.join(',') || undefined,
    camera: f.cameras.join('|') || undefined,
    lens: f.lenses.join('|') || undefined,
    keyword: f.keywords.join(',') || undefined,
    date_from: f.dateFrom ?? undefined,
    date_to: f.dateTo ?? undefined,
    edited: f.edited ?? undefined,
  }
  if (src.kind === 'album') q.album_id = src.id
  if (src.kind === 'client') q.client_id = src.id
  if (src.kind === 'favourites') q.favourite = true
  if (src.kind === 'picks') q.flag = 'pick'
  if (src.kind === 'rejected') q.flag = 'reject'
  if (src.kind === 'unsorted') q.flag = 'none'
  // "Recently added" is the last 7 days of imports, like Lightroom's Previous Import but kinder to a week of shoots
  if (src.kind === 'recent') q.added_from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)
  return q
}

// ---------------------------------------------------------------- the key grammar

export type KeyAction =
  | { type: 'rate'; value: number }
  | { type: 'flag'; value: Flag | 'none' }
  | { type: 'label'; value: Label | 'none' }
  | { type: 'view'; value: View }
  | { type: 'develop' }
  | { type: 'target' }
  | { type: 'remove' }
  | { type: 'move'; dx: number; dy: number; extend: boolean }
  | { type: 'selectAll' }
  | { type: 'clear' }
  | { type: 'info' }

/** Lightroom's Library keys. Pressing a label's key again on a photo with that label clears it (the caller decides). */
export function keyAction(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>): KeyAction | null {
  const k = e.key
  const mod = e.ctrlKey || e.metaKey
  if (mod && k.toLowerCase() === 'a') return { type: 'selectAll' }
  if (mod || e.altKey) return null
  if (/^[0-5]$/.test(k)) return { type: 'rate', value: Number(k) }
  const label = LABELS.find((l) => l.key && l.key === k)
  if (label) return { type: 'label', value: label.id }
  switch (k.toLowerCase()) {
    case 'p':
      return { type: 'flag', value: 'pick' }
    case 'x':
      return { type: 'flag', value: 'reject' }
    case 'u':
      return { type: 'flag', value: 'none' }
    case 'g':
      return { type: 'view', value: 'grid' }
    case 'e':
      return { type: 'view', value: 'loupe' }
    case 'c':
      return { type: 'view', value: 'compare' }
    case 'n':
      return { type: 'view', value: 'survey' }
    case 'd':
      return { type: 'develop' }
    case 'b':
      return { type: 'target' }
    case 'i':
      return { type: 'info' }
  }
  if (k === 'Delete' || k === 'Backspace') return { type: 'remove' }
  if (k === 'Escape') return { type: 'clear' }
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  if (arrows[k]) return { type: 'move', dx: arrows[k][0], dy: arrows[k][1], extend: e.shiftKey }
  return null
}

/** Next focus index in a grid of `cols` columns. */
export function step(index: number, total: number, cols: number, dx: number, dy: number): number {
  if (total === 0) return -1
  const next = index + dx + dy * Math.max(1, cols)
  return Math.min(total - 1, Math.max(0, next))
}

// ---------------------------------------------------------------- display

export function exposureLine(m: Pick<MediaItem, 'focal_mm' | 'aperture' | 'shutter_s' | 'iso'>): string {
  const bits: string[] = []
  if (m.focal_mm) bits.push(`${Math.round(m.focal_mm)} mm`)
  if (m.aperture) bits.push(`f/${Number(m.aperture.toFixed(1))}`)
  if (m.shutter_s) bits.push(m.shutter_s >= 1 ? `${Number(m.shutter_s.toFixed(1))}s` : `1/${Math.round(1 / m.shutter_s)}`)
  if (m.iso) bits.push(`ISO ${m.iso}`)
  return bits.join(' · ')
}

export const sourceBadge = (type: string | null | undefined) =>
  type === 'image/x-raw' ? 'RAW' : type === 'image/heic' ? 'HEIC' : type === 'image/tiff' ? 'TIFF' : null

export function albumTree(albums: Album[]): { album: Album; depth: number }[] {
  const kids = new Map<string | null, Album[]>()
  for (const a of albums) kids.set(a.parent_id, [...(kids.get(a.parent_id) ?? []), a])
  const out: { album: Album; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const a of kids.get(parent) ?? []) {
      out.push({ album: a, depth })
      walk(a.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
