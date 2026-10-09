import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { Check, Layers, SlidersHorizontal } from 'lucide-react'
import { sourceBadge } from '@/lib/catalogue'
import { DRAG_MIME } from '@/lib/selection'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { MarksBadge } from './marks'

interface Props {
  items: MediaItem[]
  focus: number
  selected: Set<string>
  cell: number
  onClickTile: (index: number, e: MouseEvent) => void
  onOpen: (index: number) => void
  onColumns: (cols: number) => void
  hasMore: boolean
  onMore: () => void
}

/**
 * Lightroom-style cells: the picture letterboxed on dark, marks in the cell's foot, rejects dimmed.
 * Tiles are plain buttons; ratings and flags change by keyboard or in the side panel, so nothing
 * interactive is nested inside them.
 */
export function PhotoGrid({ items, focus, selected, cell, onClickTile, onOpen, onColumns, hasMore, onMore }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const tiles = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => onColumns(Math.max(1, Math.floor((el.clientWidth + 8) / (cell + 8)))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [cell, onColumns])

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && onMore(), { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, onMore])

  // keyboard focus follows the focused photo, but only when the grid already has focus
  useEffect(() => {
    const t = tiles.current[focus]
    if (t && box.current?.contains(document.activeElement) && document.activeElement !== t) t.focus({ preventScroll: true })
    t?.scrollIntoView?.({ block: 'nearest' })
  }, [focus])

  const drag = (m: MediaItem) => (e: DragEvent) => {
    const ids = selected.has(m.id) ? [...selected] : [m.id]
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div ref={box} className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cell}px, 1fr))` }} role="list" aria-label="Photos">
      {items.map((m, i) => (
        <div role="listitem" key={m.id} style={{ contentVisibility: 'auto', containIntrinsicSize: `${cell}px ${cell + 26}px` }}>
          <Tile
            ref={(el) => {
              tiles.current[i] = el
            }}
            item={m}
            focused={i === focus}
            selected={selected.has(m.id)}
            onClick={(e) => onClickTile(i, e)}
            onDoubleClick={() => onOpen(i)}
            onDragStart={drag(m)}
            tabIndex={i === focus || (focus < 0 && i === 0) ? 0 : -1}
          />
        </div>
      ))}
      {hasMore && <div ref={sentinel} aria-hidden className="h-8" />}
    </div>
  )
}

interface TileProps {
  item: MediaItem
  focused: boolean
  selected: boolean
  onClick: (e: MouseEvent) => void
  onDoubleClick: () => void
  onDragStart: (e: DragEvent) => void
  tabIndex: number
  ref?: React.Ref<HTMLButtonElement>
}

function Tile({ item: m, focused, selected, onClick, onDoubleClick, onDragStart, tabIndex, ref }: TileProps) {
  const [broken, setBroken] = useState(false)
  const badge = sourceBadge(m.source_type)
  const name = m.title || m.original_name || 'Photo'
  return (
    <button
      ref={ref}
      type="button"
      draggable
      tabIndex={tabIndex}
      aria-pressed={selected}
      aria-label={`${name}${m.rating ? `, ${m.rating} stars` : ''}${m.flag === 'pick' ? ', pick' : m.flag === 'reject' ? ', rejected' : ''}${m.label ? `, ${m.label} label` : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDragStart={onDragStart}
      className={cn(
        'group flex w-full flex-col overflow-hidden rounded-[6px] border bg-studio-raised text-left transition-colors focus-visible:outline-none',
        selected ? 'border-studio-accent ring-2 ring-studio-accent' : 'border-studio-border hover:border-studio-border-hover',
        focused && 'ring-2 ring-studio-gold ring-offset-1 ring-offset-studio-bg',
      )}
    >
      <span className={cn('relative block aspect-square w-full bg-studio-darkroom', m.flag === 'reject' && 'opacity-45')}>
        {m.thumb_url && !broken ? (
          <img src={m.thumb_url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} className="size-full object-contain" />
        ) : (
          <span className="grid size-full place-items-center text-small text-studio-on-dark-muted">{m.status === 'ready' ? 'No preview' : 'Processing…'}</span>
        )}
        {selected && (
          <span aria-hidden className="absolute left-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-studio-accent text-studio-accent-fg">
            <Check className="size-3.5" />
          </span>
        )}
        <span className="absolute right-1.5 top-1.5 flex gap-1">
          {badge && <span className="rounded-[3px] bg-black/60 px-1 text-[10px] font-semibold tracking-wide text-white">{badge}</span>}
          {m.edited && (
            <span title="Edited" className="grid size-4 place-items-center rounded-[3px] bg-black/60 text-white">
              <SlidersHorizontal aria-hidden className="size-2.5" />
            </span>
          )}
          {m.versions_count > 1 && (
            <span title={`${m.versions_count} versions`} className="flex items-center gap-0.5 rounded-[3px] bg-black/60 px-1 text-[10px] text-white">
              <Layers aria-hidden className="size-2.5" />
              {m.versions_count}
            </span>
          )}
        </span>
      </span>
      <span className="flex h-[26px] items-center justify-between gap-1 px-1.5">
        <MarksBadge item={m} />
        <span className="truncate text-[11px] text-studio-muted">{name}</span>
      </span>
    </button>
  )
}
