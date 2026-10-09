import { useDeferredValue, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Aperture, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { MediaTile } from '@/components/media/MediaTile'
import { UploadZone } from '@/components/media/UploadZone'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import type { MediaItem } from '@/lib/types'

/** /image/studio: pick a picture from the library (project frames too) or upload one. */
export function PhotoStudioPickPage() {
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const [q, setQ] = useState('')
  const query = useDeferredValue(q.trim())
  const list = useMediaList({ kind: 'image', include: 'project', ...(query ? { q: query } : {}) })
  const items = flatItems(list.data).filter((m) => m.media_url || m.thumb_url)
  const looks = search.get('tab') === 'looks'
  const open = (m: MediaItem) => navigate(`/image/studio/${m.generation_id}${looks ? '?tab=looks' : ''}`)

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="studio-title">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 md:px-8">
        <header className="flex flex-col gap-1">
          <h1 id="studio-title" className="flex items-center gap-2 font-display text-title font-semibold">
            <Aperture aria-hidden className="size-5 text-studio-accent" />
            {looks ? 'Looks' : 'Photo Studio'}
          </h1>
          <p className="max-w-2xl text-body text-studio-muted">
            {looks
              ? 'Pick a picture to try looks on. Save your own, import Lightroom presets or LUTs, and carry any look onto a video.'
              : 'Develop any picture: light, colour, tone curve, crop and local light. Every save is a new version, so the original is never touched.'}
          </p>
        </header>

        <UploadZone kinds={['image']} multiple={false} onUploaded={open} />

        <section aria-labelledby="studio-pick" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="studio-pick" className="section-label">
              Or pick from your library
            </h2>
            <div className="relative w-full max-w-xs">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
              <Input type="search" placeholder="Search images" aria-label="Search images" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
            </div>
          </div>
          {list.isPending ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="aspect-square" />
              ))}
            </div>
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState title={query ? `Nothing matches “${query}”` : 'No images in your library yet'}>Upload one above to get started.</EmptyState>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3" aria-label="Your images">
              {items.map((m) => (
                <li key={m.id}>
                  <MediaTile item={m} onOpen={() => open(m)} />
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
    </main>
  )
}
