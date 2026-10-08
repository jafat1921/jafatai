import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ImageUpscale, Maximize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { MediaTile } from '@/components/media/MediaTile'
import { UploadZone } from '@/components/media/UploadZone'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { mediaGeneration } from '@/lib/media'
import type { ImageUpscaleEngineId, Job, MediaItem, MediaKind, UpscaleEngineId } from '@/lib/types'
import { ImageUpscaleDialog } from './ImageUpscaleDialog'
import { UpscaleResults } from './UpscaleResults'
import { forgetUpscale, loadUpscales, rememberUpscale } from '@/lib/upscaleHistory'
import { UpscaleDialog } from './UpscaleDialog'

const COPY: Record<MediaKind, { title: string; blurb: string; engines: string[] }> = {
  image: {
    title: 'Upscale an image',
    blurb: 'Pick an image from your library or upload one. The bigger copy is saved as a new version; the original stays.',
    engines: ['redraw', 'quick', 'best'],
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
  const [source, setSource] = useState<MediaItem | null>(null)
  const [recent, setRecent] = useState(() => loadUpscales(kind))
  const queued = (job: Job) => {
    if (!source || !job.generation_id) return
    const original = mediaGeneration(source)
    if (!original) return
    setRecent(
      rememberUpscale({
        jobId: job.id,
        sourceId: original.id,
        resultId: job.generation_id,
        kind,
        label: source.title || (kind === 'image' ? 'Image' : 'Video'),
        at: Date.now(),
      }),
    )
    requestAnimationFrame(() => document.getElementById('upscale-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  const list = useMediaList({ kind, include: 'project' })
  const items = flatItems(list.data).filter((m) => m.media_url || m.thumb_url)
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

        <UpscaleResults entries={recent} onRemove={(id) => setRecent(forgetUpscale(id, kind))} />

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
                  <MediaTile item={m} selectable selected={source?.id === m.id} onToggle={() => setSource(m)} />
                </li>
              ))}
            </ul>
          )}
          {list.hasNextPage && (
            <Button variant="secondary" className="self-center" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              Load more
            </Button>
          )}
        </section>
      </div>

      {kind === 'image' ? (
        <ImageUpscaleDialog
          source={source ? mediaGeneration(source) : null}
          subject="Image"
          initialEngine={preset as ImageUpscaleEngineId | undefined}
          onOpenChange={(o) => !o && setSource(null)}
          onQueued={queued}
        />
      ) : (
        <UpscaleDialog
          render={source ? mediaGeneration(source) : null}
          initialEngine={preset as UpscaleEngineId | undefined}
          onOpenChange={(o) => !o && setSource(null)}
          onQueued={queued}
        />
      )}
    </main>
  )
}
