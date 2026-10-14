import type { ImageStyle, StyleGroup } from './types'

/** Old saved runs and templates may still say "painterly"; the server maps it, and so do we for the chip. */
export function findStyle(styles: ImageStyle[], id: string | null | undefined, aliases: Record<string, string> = {}) {
  if (!id) return undefined
  return styles.find((s) => s.id === id) ?? styles.find((s) => s.id === aliases[id])
}

/** The gallery's visible cards: one group (or all) narrowed by every word of the search. */
export function filterStyles(styles: ImageStyle[], groups: StyleGroup[], group: string | null, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const groupLabel = (id: string) => groups.find((g) => g.id === id)?.label ?? ''
  return styles.filter((s) => {
    if (group && s.group !== group) return false
    const hay = `${s.label} ${s.subtitle} ${s.suffix} ${groupLabel(s.group)}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Image to Image's starting strength for a style: its group's preset, else the plain default. */
export function restyleStrength(style: ImageStyle | undefined, groups: StyleGroup[], fallback: number) {
  if (!style) return fallback
  const v = groups.find((g) => g.id === style.group)?.restyle_strength
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** The quiet stand-in for a style with no rendered example yet: its initials on a tinted card. */
export function initials(label: string) {
  const parts = label.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 2)).toUpperCase()
}
