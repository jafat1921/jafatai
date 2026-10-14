import type { SheetCatalogue, SheetListName, SheetPreset } from '@/lib/types'

// contract-v25-character-sheets.md: what the sheet picker needs besides the server's catalogue

export const SELECT = 'h-8 w-full rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body'

export const LISTS: { key: SheetListName; label: string; hint: string }[] = [
  { key: 'outfits', label: 'Outfits', hint: 'Field ops, evening dress' },
  { key: 'details', label: 'Wardrobe details', hint: 'Raincoat toggles, boot laces' },
  { key: 'props', label: 'Props & weapons', hint: 'Brass compass, dive knife' },
  { key: 'accessories', label: 'Accessories', hint: 'Dive watch, silver earrings' },
]
export const COUNT_LABELS: Record<string, string> = {
  turnaround: 'Turnaround', motion: 'Walking pose', head: 'Head angles', expressions: 'Expressions',
  closeup: 'Close-up', gestures: 'Hand gestures', postures: 'Postures',
}

export const minutes = (s: number) => Math.max(1, Math.round(s / 60))

/** Panels a request would make, the same sum the server does (hero + counts + named items). */
export function countPanels(cat: SheetCatalogue, preset: SheetPreset, counts: Record<string, number>, lists: Partial<Record<SheetListName, string[]>>) {
  const c = preset === 'custom' ? counts : cat.presets[preset].counts
  let n = 1 + Object.values(c).reduce((a, b) => a + (b || 0), 0)
  if (preset !== 'essential') {
    for (const l of LISTS) n += Math.min(cat.lists[l.key], (lists[l.key] ?? []).filter((x) => x.trim()).length)
  }
  return n
}
