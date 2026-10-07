import { useEffect, useRef } from 'react'
import { Download, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { useMediaRegenerate } from '@/hooks/useMedia'
import { downloadUrl } from '@/lib/media'
import { sessionRows, type SessionRow } from '@/lib/sessions'
import type { MediaItem } from '@/lib/types'
import { plural, timeAgo } from '@/lib/utils'
import { useSessions, type SessionRequest } from '@/stores/sessions'
import { announce } from '@/stores/ui'
import { ResultTile } from './ResultTile'
import { useMediaHost } from './useMediaHost'

const EXCERPT = 140

function downloadAll(items: MediaItem[]) {
  // one click per file; browsers allow a short burst like this from a user gesture
  items
    .filter((m) => m.media_url || m.thumb_url)
    .forEach((m, i) =>
      setTimeout(() => {
        const a = document.createElement('a')
        a.href = downloadUrl(m.generation_id)
        a.download = ''
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, i * 250),
    )
}

interface Props<S> {
  page: string
  label: string
  items: MediaItem[]
  loading?: boolean
  error?: unknown
  onRetryLoad?: () => void
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  empty: React.ReactNode
  // resubmit a request made in this tab with its saved settings
  onRetry?: (req: SessionRequest<S>) => void
  // refill the dock: from a saved request, or from what a history row's first item says
  onReuse: (row: SessionRow<S>) => void
  onUseAsRef?: (item: MediaItem) => void
  refLabel?: string
  reuseItem?: (item: MediaItem) => void
}

/** Results as one row per generation request, newest first, with row and tile actions. */
export function SessionResults<S>({
  page,
  label,
  items,
  loading,
  error,
  onRetryLoad,
  hasMore,
  loadingMore,
  onLoadMore,
  empty,
  onRetry,
  onReuse,
  onUseAsRef,
  refLabel,
  reuseItem,
}: Props<S>) {
  const requests = useSessions((s) => s.requests).filter((r) => r.page === page) as SessionRequest<S>[]
  const rows = sessionRows(items, requests)
  const { handlers, host, failure } = useMediaHost({ items, onUseAsRef, refLabel, reuse: reuseItem })
  const regenerate = useMediaRegenerate()
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || !onLoadMore || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoadMore(), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, onLoadMore, items.length])

  const retry = (row: SessionRow<S>) => {
    if (row.request && onRetry) return onRetry(row.request)
    // history rows: a new version of each generated image, same prompt, new seed
    row.items.filter((m) => m.kind === 'image' && m.origin === 'generated').forEach((m) => regenerate.mutate({ id: m.id, mode: 'same' }))
    announce(`Regenerating ${plural(row.items.length, 'item')}.`)
  }
  const canRetry = (row: SessionRow<S>) => (row.request ? !!onRetry : row.items.some((m) => m.kind === 'image' && m.origin === 'generated'))

  return (
    <section aria-label={label} className="flex flex-col gap-5">
      {(failure || regenerate.error) && <ErrorState compact title="That didn't work" error={failure ?? regenerate.error} />}
      {error ? (
        <ErrorState title={`Couldn't load ${label.toLowerCase()}`} error={error} onRetry={onRetryLoad} />
      ) : loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="status" aria-label={`Loading ${label.toLowerCase()}`}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-square" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        empty
      ) : (
        <ol className="flex flex-col gap-6">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-2" aria-label={`Request: ${row.prompt.slice(0, 60) || 'untitled'}`}>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-body" dir="auto" title={row.prompt}>
                    {row.prompt.length > EXCERPT ? `${row.prompt.slice(0, EXCERPT)}…` : row.prompt || <span className="text-studio-muted">No prompt</span>}
                  </p>
                  <p className="text-small text-studio-muted">
                    {[row.summary, timeAgo(row.at)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div role="group" aria-label="Row actions" className="flex shrink-0 items-center gap-0.5">
                  {canRetry(row) && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => retry(row)}>
                      <RefreshCw aria-hidden />
                      <span className="max-sm:sr-only">Retry</span>
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="ghost" onClick={() => onReuse(row)}>
                    <RotateCcw aria-hidden />
                    <span className="max-sm:sr-only">Reuse settings</span>
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => downloadAll(row.items)} aria-label={`Download all ${plural(row.items.length, 'file')}`}>
                    <Download aria-hidden />
                    <span className="max-sm:sr-only">Download all</span>
                  </Button>
                </div>
              </div>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
                {row.items.map((item) => (
                  <li key={item.id}>
                    <ResultTile item={item} handlers={handlers} aspectHint={(row.request?.settings as { aspect?: string } | undefined)?.aspect} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
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
