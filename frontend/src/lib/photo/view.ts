// Develop view settings shared by the toolbar, navigator and workspace

export type CompareMode = 'off' | 'lr' | 'lr-split' | 'tb' | 'tb-split'

export const COMPARE: { id: CompareMode; label: string; key: string }[] = [
  { id: 'off', label: 'Edited only', key: '' },
  { id: 'lr', label: 'Before | After', key: 'Y' },
  { id: 'lr-split', label: 'Before | After split', key: 'Shift+Y' },
  { id: 'tb', label: 'Before / After (top, bottom)', key: 'Alt+Y' },
  { id: 'tb-split', label: 'Before / After split (top, bottom)', key: '' },
]

export const GRIDS = [0, 3, 4, 6, 8, 12] as const

/** A zoom ratio is picture pixels to screen pixels; the canvas works in CSS pixels. */
export const ratioZoom = (scale: number) => scale / (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
