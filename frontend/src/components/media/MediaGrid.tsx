import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { ResultTile } from '@/components/generate/ResultTile'
import { useMediaHost } from '@/components/generate/useMediaHost'
import { boxFrom, intersects, type Box, type Mods } from '@/lib/selection'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface GridSelection {
  ids: Set<string>
  onSelect: (item: MediaItem, mods: Mods) => void
  // drag-box on desktop: the ids under the box, and whether Shift/Ctrl/Cmd was held
  onMarquee?: (ids: string[], additive: boolean) => void
  dragRefs?: (item: MediaItem) => string[]
}

interface Props {
  items: MediaItem[]
  label: string
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  empty?: React.ReactNode
  // infinite scroll: a sentinel under the grid asks for the next page as it comes into view
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  selection?: GridSelection
  className?: string
}

// a press has to travel this far before it counts as a drag-box rather than a click
const MARQUEE_SLOP = 4

export function MediaGrid({ items, label, loading, error, onRetry, empty, hasMore, loadingMore, onLoadMore, selection, className }: Props) {
  const { handlers, host, failure } = useMediaHost({ items })
  const sentinel = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLElement>(null)
  const start = useRef<{ x: number; y: number; additive: boolean } | null>(null)
  // the box in client coordinates, plus where the section sat when it was drawn
  const [drag, setDrag] = useState<{ box: Box; ox: number; oy: number } | null>(null)
  const box = drag?.box ?? null

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || !onLoadMore || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoadMore(), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, onLoadMore, items.length])

  const onPointerDown = (e: RPointerEvent<HTMLElement>) => {
    // desktop only: on touch a drag is a scroll
    if (!selection?.onMarquee || (e.pointerType && e.pointerType !== 'mouse') || e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-select-id],button,a,input,[role="menu"]')) return
    start.current = { x: e.clientX, y: e.clientY, additive: e.shiftKey || e.ctrlKey || e.metaKey }
  }
  const onPointerMove = (e: RPointerEvent<HTMLElement>) => {
    const s = start.current
    if (!s) return
    if (!box && Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) < MARQUEE_SLOP) return
    if (!box) e.currentTarget.setPointerCapture?.(e.pointerId)
    const r = e.currentTarget.getBoundingClientRect()
    setDrag({ box: boxFrom(s.x, s.y, e.clientX, e.clientY), ox: r.left, oy: r.top })
  }
  const onPointerUp = () => {
    const s = start.current
    start.current = null
    if (!s || !box || !root.current || !selection?.onMarquee) return setDrag(null)
    const hits: string[] = []
    root.current.querySelectorAll<HTMLElement>('[data-select-id]').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (intersects(box, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })) hits.push(el.dataset.selectId!)
    })
    setDrag(null)
    selection.onMarquee(hits, s.additive)
  }

  return (
    <section
      ref={root}
      aria-label={label}
      className={cn('relative flex flex-col gap-3', selection?.onMarquee && 'select-none', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        start.current = null
        setDrag(null)
      }}
    >
      {failure && <ErrorState compact title="That didn't work" error={failure} />}
      {error ? (
        <ErrorState title={`Couldn't load ${label.toLowerCase()}`} error={error} onRetry={onRetry} />
      ) : loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4" role="status" aria-label={`Loading ${label.toLowerCase()}`}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-square" />
          ))}
        </div>
      ) : items.length === 0 ? (
        empty
      ) : (
        // uniform square cells keep the library scannable; the lightbox shows the real shape
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
          {items.map((item) => (
            <li key={item.id}>
              <ResultTile
                item={item}
                handlers={handlers}
                ratio={item.kind === 'video' ? '16 / 9' : '1 / 1'}
                showTitle
                select={
                  selection && {
                    selected: selection.ids.has(item.id),
                    active: selection.ids.size > 0,
                    onSelect: (mods) => selection.onSelect(item, mods),
                    dragRefs: selection.dragRefs && (() => selection.dragRefs!(item)),
                  }
                }
              />
            </li>
          ))}
        </ul>
      )}

      {drag && (
        <div
          aria-hidden
          data-testid="marquee"
          className="pointer-events-none absolute z-20 rounded-[2px] border border-studio-accent bg-studio-accent/10"
          style={{ left: drag.box.left - drag.ox, top: drag.box.top - drag.oy, width: drag.box.right - drag.box.left, height: drag.box.bottom - drag.box.top }}
        />
      )}

      {hasMore && (
        <div ref={sentinel} className="flex justify-center py-2">
          <Button variant="secondary" onClick={onLoadMore} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}
      {loadingMore && (
        <p className="flex items-center justify-center gap-2 text-small text-studio-muted" role="status">
          <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" /> Loading more…
        </p>
      )}
      {host}
    </section>
  )
}
