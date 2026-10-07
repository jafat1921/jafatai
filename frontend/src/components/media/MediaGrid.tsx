import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { RegenerateDialog } from '@/components/review/RegenerateDialog'
import { ImageUpscaleDialog } from '@/features/upscale/ImageUpscaleDialog'
import { UpscaleDialog } from '@/features/upscale/UpscaleDialog'
import { useDeleteMedia, useMediaRegenerate } from '@/hooks/useMedia'
import { mediaAlt, mediaGeneration } from '@/lib/media'
import type { MediaItem, RegenerateMode } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { MediaActions, type MediaHandlers } from './MediaActions'
import { MediaDetailSheet } from './MediaDetail'
import { MediaTile } from './MediaTile'

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
  const [detail, setDetail] = useState<string | null>(null)
  const [regen, setRegen] = useState<{ item: MediaItem; mode: 'note' | 'edit' } | null>(null)
  const [upscaling, setUpscaling] = useState<MediaItem | null>(null)
  const [deleting, setDeleting] = useState<MediaItem | null>(null)
  const regenerate = useMediaRegenerate()
  const remove = useDeleteMedia()
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || !onLoadMore || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoadMore(), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, onLoadMore, items.length])

  const runRegenerate = (item: MediaItem, mode: RegenerateMode, extra?: { note?: string; prompt?: string }) =>
    regenerate.mutate(
      { id: item.id, mode, ...extra },
      {
        onSuccess: () => {
          setRegen(null)
          announce(`Regenerating ${mediaAlt(item)}. A new version is queued.`)
        },
      },
    )

  const handlers: MediaHandlers = {
    open: (item) => setDetail(item.id),
    regenerate: (item, mode) => (mode === 'same' ? runRegenerate(item, 'same') : setRegen({ item, mode })),
    upscale: setUpscaling,
    remove: setDeleting,
  }

  const failure = regenerate.error ?? remove.error

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
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
          {items.map((item) => (
            <li key={item.id}>
              <MediaTile item={item} onOpen={() => setDetail(item.id)} actions={(state) => <MediaActions item={item} state={state} handlers={handlers} />} />
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

      <MediaDetailSheet id={detail} onClose={() => setDetail(null)} />

      <RegenerateDialog
        mode={regen?.mode ?? null}
        initialPrompt={regen?.item.prompt ?? ''}
        onOpenChange={(o) => !o && setRegen(null)}
        onSubmit={(v) => regen && runRegenerate(regen.item, regen.mode, v)}
        pending={regenerate.isPending}
      />

      <ImageUpscaleDialog
        source={upscaling?.kind === 'image' ? mediaGeneration(upscaling) : null}
        subject="Image"
        onOpenChange={(o) => !o && setUpscaling(null)}
      />
      <UpscaleDialog
        render={upscaling?.kind === 'video' ? mediaGeneration(upscaling) : null}
        onOpenChange={(o) => !o && setUpscaling(null)}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting ? mediaAlt(deleting) : ''}”?`}
        description="This removes the item and all of its versions from your library. It can't be undone."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => {
          const item = deleting
          setDeleting(null)
          if (item) remove.mutate(item.id, { onSuccess: () => announce(`Deleted ${mediaAlt(item)}.`) })
        }}
      />
    </section>
  )
}
