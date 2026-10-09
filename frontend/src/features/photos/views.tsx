import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { exposureLine, sourceBadge } from '@/lib/catalogue'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { MarksBadge } from './marks'

function when(iso: string | null | undefined) {
  if (!iso) return null
  return new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The I-key overlay: what Lightroom shows over a loupe photo. */
function InfoOverlay({ item }: { item: MediaItem }) {
  const line = exposureLine(item)
  return (
    <div className="pointer-events-none absolute left-3 top-3 max-w-[70%] rounded-[6px] bg-black/55 px-2.5 py-1.5 text-small text-white">
      <div className="flex items-center gap-2">
        <span className="font-medium">{item.title || item.original_name}</span>
        {sourceBadge(item.source_type) && <span className="rounded-[3px] bg-white/20 px-1 text-[10px]">{sourceBadge(item.source_type)}</span>}
        <MarksBadge item={item} dark />
      </div>
      <div className="text-[12px] text-white/80">{[item.camera, line, when(item.captured_at)].filter(Boolean).join(' · ')}</div>
    </div>
  )
}

export function LoupeView({ item, info, onPrev, onNext, index, total }: {
  item: MediaItem | undefined
  info: boolean
  onPrev: () => void
  onNext: () => void
  index: number
  total: number
}) {
  const [zoom, setZoom] = useState(false)
  if (!item) return <p className="p-6 text-studio-muted">Pick a photo to look at it larger.</p>
  const src = item.media_url ?? item.thumb_url ?? undefined
  return (
    <div className="relative flex h-full min-h-[320px] flex-col overflow-hidden rounded-[8px] bg-studio-darkroom">
      <div className={cn('relative min-h-0 flex-1', zoom ? 'overflow-auto' : 'overflow-hidden')}>
        <img
          key={item.id}
          src={src}
          alt={item.title || 'Photo'}
          onClick={() => setZoom((z) => !z)}
          title={zoom ? 'Click to fit' : 'Click for 100%'}
          className={cn('mx-auto', zoom ? 'max-w-none cursor-zoom-out' : 'size-full cursor-zoom-in object-contain')}
        />
        {info && <InfoOverlay item={item} />}
      </div>
      <div className="flex items-center justify-between border-t border-white/10 px-2 py-1 text-small text-studio-on-dark-muted">
        <button type="button" onClick={onPrev} disabled={index <= 0} aria-label="Previous photo" className="rounded p-1 hover:text-studio-on-dark disabled:opacity-30">
          <ChevronLeft className="size-5" />
        </button>
        <span aria-live="polite">
          {index + 1} of {total} · {zoom ? '100%' : 'Fit'} · <kbd>I</kbd> info
        </span>
        <button type="button" onClick={onNext} disabled={index >= total - 1} aria-label="Next photo" className="rounded p-1 hover:text-studio-on-dark disabled:opacity-30">
          <ChevronRight className="size-5" />
        </button>
      </div>
    </div>
  )
}

/** C: the select on the left stays, candidates step through on the right; ↑ makes the candidate the select. */
export function CompareView({ select, candidate, info }: { select: MediaItem | undefined; candidate: MediaItem | undefined; info: boolean }) {
  const pane = (m: MediaItem | undefined, role: string) => (
    <figure className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[8px] bg-studio-darkroom">
      <figcaption className="flex items-center justify-between px-2 py-1 text-small text-studio-on-dark-muted">
        <span className="font-medium text-studio-on-dark">{role}</span>
        {m && <MarksBadge item={m} dark />}
      </figcaption>
      {m ? (
        <div className="relative min-h-0 flex-1">
          <img src={m.media_url ?? m.thumb_url ?? undefined} alt={`${role}: ${m.title}`} className="size-full object-contain" />
          {info && <InfoOverlay item={m} />}
        </div>
      ) : (
        <p className="p-4 text-small text-studio-on-dark-muted">Select two or more photos to compare.</p>
      )}
    </figure>
  )
  return (
    <div className="flex h-full min-h-[320px] flex-col gap-2 md:flex-row">
      {pane(select, 'Select')}
      {pane(candidate, 'Candidate')}
    </div>
  )
}

/** N: every selected photo at once; the focused one takes the keys. */
export function SurveyView({ items, focusId, onFocus }: { items: MediaItem[]; focusId: string | null; onFocus: (id: string) => void }) {
  if (items.length < 2) return <p className="p-6 text-studio-muted">Select two or more photos (Shift-click or Ctrl-click) to survey them side by side.</p>
  const cols = items.length <= 2 ? 2 : items.length <= 4 ? 2 : items.length <= 9 ? 3 : 4
  return (
    <div className="grid h-full min-h-[320px] gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.slice(0, 16).map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onFocus(m.id)}
          aria-pressed={m.id === focusId}
          aria-label={m.title || 'Photo'}
          className={cn('relative flex min-h-[140px] flex-col overflow-hidden rounded-[8px] bg-studio-darkroom focus-visible:outline-none', m.id === focusId ? 'ring-2 ring-studio-gold' : 'ring-1 ring-white/10', m.flag === 'reject' && 'opacity-50')}
        >
          <img src={m.thumb_url ?? m.media_url ?? undefined} alt="" className="min-h-0 w-full flex-1 object-contain" />
          <span className="flex h-6 items-center justify-between px-1.5 text-[11px] text-studio-on-dark-muted">
            <MarksBadge item={m} dark />
            <span className="truncate">{m.title}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
