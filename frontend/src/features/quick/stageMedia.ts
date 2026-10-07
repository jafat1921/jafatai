import { rangeText } from '@/lib/estimate'
import type { QuickStageKey, QuickStageMedia, QuickStageThumb } from '@/lib/types'

export const STRIP_MAX = 4

/** The thumbnails and caption for one stage's mini strip (UI polish P3). */
export function stageStrip(key: QuickStageKey, media: QuickStageMedia | undefined): { thumbs: QuickStageThumb[]; text?: string } {
  if (!media) return { thumbs: [] }
  if (key === 'outline') return { thumbs: [], text: media.outline?.text || undefined }
  const list = key === 'upscale' ? [] : (media[key] ?? [])
  return { thumbs: list.filter((t) => !!t.url) }
}

/** "~4–9 min left" from the server's [low, high] seconds; null when there's no range yet. */
export function etaRangeText(range: [number, number] | null | undefined) {
  if (!Array.isArray(range) || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[1] <= 0) return null
  if (range[1] < 60) return 'Almost there'
  return `${rangeText(range[0], range[1])} left`
}
