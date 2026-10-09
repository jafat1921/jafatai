import { useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ImageUpscale, Maximize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { MediaTile } from '@/components/media/MediaTile'
import { useMediaHost } from '@/components/generate/useMediaHost'
import { UploadZone } from '@/components/media/UploadZone'
import { qk } from '@/hooks/keys'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { mediaGeneration } from '@/lib/media'
import type { Generation, ImageUpscaleEngineId, Job, MediaItem, MediaKind, UpscaleEngineId } from '@/lib/types'
import { ImageUpscaleDialog } from './ImageUpscaleDialog'
import { UpscaleResults } from './UpscaleResults'
import { forgetUpscale, loadUpscales, rememberUpscale } from '@/lib/upscaleHistory'
import { UpscaleDialog } from './UpscaleDialog'

const COPY: Record<MediaKind, { title: string; blurb: string; engines: string[] }> = {
  image: {
    title: 'Upscale an image',
    blurb: 'Pick an image from your library or upload one. The bigger copy is saved as a new version; the original stays.',
    engines: ['redraw', 'quick', 'anime', 'best'],
  },
  video: {
    title: 'Upscale a video',
    blurb: 'Pick a finished video or upload a clip. Sound is kept untouched, and the result is saved as a new version.',
    engines: ['best', 'fast', 'quick'],
  },
}

/** /image/upscale and /video/upscale: choose a source, then the existing upscale dialog takes over. */
export function UpscalePickPage({ kind }: { kind: MediaKind }) {
  const [params] = useSearchParams()
  const qc = useQueryClient()
  const [source, setSource] = useState<MediaItem | null>(null)
  // "Upscale again" from a result card: the original's generation, not a library tile
  const [again, setAgain] = useState<{ gen: Generation; label: string } | null>(null)
  const [recent, setRecent] = useState(() => loadUpscales(kind))
  const sourceGen = source ? mediaGeneration(source) : (again?.gen ?? null)
  const close = () => {
    setSource(null)
    setAgain(null)
  }
  const queued = (job: Job) => {
    if (!sourceGen || !job.generation_id) return
    setRecent(
      rememberUpscale({
        jobId: job.id,
        sourceId: sourceGen.id,
        resultId: job.generation_id,
        kind,
        label: source?.title || again?.label || (kind === 'image' ? 'Image' : 'Video'),
        at: Date.now(),
      }),
    )
    qc.invalidateQueries({ queryKey: qk.upscales(kind) })
    requestAnimationFrame(() => document.getElementById('upscale-results')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))
  }
  const seen = useCallback((ids: string[]) => setRecent(ids.reduce((_, id) => forgetUpscale(id, kind), loadUpscales(kind))), [kind])
  const list = useMediaList({ kind, include: 'project' })
  const items = flatItems(list.data).filter((m) => m.media_url || m.thumb_url)
  const { handlers, host, failure } = useMediaHost({ items })
  // the page's own dialog does the upscale, so a queued job lands in "Your upscales"
  const tileHandlers = { ...handlers, upscale: setSource }
  const copy = COPY[kind]
  // ?engine= from a mega-menu model; ignored if it isn't one this kind of media has
  const engine = params.get('engine') ?? undefined
  const preset = engine && copy.engines.includes(engine) ? engine : undefined
  const Icon = kind === 'image' ? ImageUpscale : Maximize2

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="upscale-title">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 md:px-8">
        <header className="flex flex-col gap-1">
          <h1 id="upscale-title" className="flex items-center gap-2 font-display text-title font-semibold">
            <Icon aria-hidden className="size-5 text-studio-accent" />
            {copy.title}
          </h1>
          <p className="max-w-2xl text-body text-studio-muted">{copy.blurb}</p>
          <p className="text-small text-studio-muted">
            Need the {kind === 'image' ? 'video' : 'image'} version?{' '}
            <Link className="text-studio-accent-hover underline underline-offset-2" to={kind === 'image' ? '/video/upscale' : '/image/upscale'}>
              {kind === 'image' ? 'Upscale a video' : 'Upscale an image'}
            </Link>
          </p>
        </header>

        <UpscaleResults kind={kind} pending={recent} onSeen={seen} onAgain={(gen, label) => setAgain({ gen, label })} />

        <UploadZone kinds={[kind]} multiple={false} onUploaded={setSource} />

        <section aria-labelledby="upscale-pick" className="flex flex-col gap-3">
          <h2 id="upscale-pick" className="section-label">
            Or pick from your library
          </h2>
          {list.isPending ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="aspect-square" />
              ))}
            </div>
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState title={`No ${kind}s in your library yet`}>Upload one above.</EmptyState>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" aria-label={`Your ${kind}s`}>
              {items.map((m) => (
                <li key={m.id}>
                  <MediaTile item={m} selectable selected={source?.id === m.id} onToggle={() => setSource(m)} handlers={tileHandlers} />
                </li>
              ))}
            </ul>
          )}
          {failure && <ErrorState compact title="That didn't work" error={failure} />}
          {list.hasNextPage && (
            <Button variant="secondary" className="self-center" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              Load more
            </Button>
          )}
        </section>
      </div>

      {kind === 'image' ? (
        <ImageUpscaleDialog
          source={sourceGen}
          subject="Image"
          initialEngine={preset as ImageUpscaleEngineId | undefined}
          onOpenChange={(o) => !o && close()}
          onQueued={queued}
        />
      ) : (
        <UpscaleDialog
          render={sourceGen}
          initialEngine={preset as UpscaleEngineId | undefined}
          onOpenChange={(o) => !o && close()}
          onQueued={queued}
        />
      )}
      {host}
    </main>
  )
}
