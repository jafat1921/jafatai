import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { ResultTile } from '@/components/generate/ResultTile'
import { useMediaHost } from '@/components/generate/useMediaHost'
import type { MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'

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
  className?: string
}

export function MediaGrid({ items, label, loading, error, onRetry, empty, hasMore, loadingMore, onLoadMore, className }: Props) {
  const { handlers, host, failure } = useMediaHost({ items })
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || !onLoadMore || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoadMore(), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, onLoadMore, items.length])

  return (
    <section aria-label={label} className={cn('flex flex-col gap-3', className)}>
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
              <ResultTile item={item} handlers={handlers} ratio={item.kind === 'video' ? '16 / 9' : '1 / 1'} showTitle />
            </li>
          ))}
        </ul>
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
