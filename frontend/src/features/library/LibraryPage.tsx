import { useDeferredValue, useId, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Film, Images, Search, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Chip } from '@/components/studio/chip'
import { EmptyState } from '@/components/studio/states'
import { MediaGrid } from '@/components/media/MediaGrid'
import { UploadZone } from '@/components/media/UploadZone'
import { TopBarActions } from '@/components/shell/TopBarActions'
import { flatItems, libraryFilter, LIBRARY_ORIGINS as ORIGINS, useMediaList, type OriginFilter } from '@/hooks/useMedia'
import type { MediaKind } from '@/lib/types'

export function LibraryPage({ kind }: { kind: MediaKind }) {
  const uid = useId()
  const [q, setQ] = useState('')
  const [origin, setOrigin] = useState<OriginFilter>('all')
  const [tag, setTag] = useState<string | null>(null)
  const query = useDeferredValue(q)
  const list = useMediaList(libraryFilter(kind, origin, query, tag))
  const items = flatItems(list.data)
  // TODO: ask the server for the tag list; this only knows tags on pages already loaded
  const tags = useMemo(() => [...new Set(items.flatMap((m) => m.tags ?? []))].sort().slice(0, 12), [items])
  const noun = kind === 'image' ? 'images' : 'videos'
  const filtered = !!(query.trim() || tag || origin !== 'all')

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby={`${uid}-title`}>
      <TopBarActions>
        <Button asChild size="sm" variant="primary">
          <Link to={kind === 'image' ? '/image/generate' : '/video/quick'}>
            <Wand2 aria-hidden />
            {kind === 'image' ? 'Create image' : 'Quick video'}
          </Link>
        </Button>
      </TopBarActions>
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id={`${uid}-title`} className="font-display text-title font-semibold">
              {kind === 'image' ? 'Image library' : 'Video library'}
            </h1>
            <p className="text-body text-studio-muted">
              {kind === 'image' ? 'Everything you created, uploaded or approved in a project.' : 'Finished films from every project, quick videos and uploads.'}
            </p>
          </div>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
            <Input type="search" placeholder={`Search ${noun}`} aria-label={`Search ${noun}`} value={q} onChange={(e) => setQ(e.target.value)} className="w-64 pl-8" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div role="group" aria-label="Where from" className="flex flex-wrap gap-1">
            {ORIGINS.map((o) => (
              <Chip key={o.value} selected={origin === o.value} onClick={() => setOrigin(o.value)}>
                {o.label}
              </Chip>
            ))}
          </div>
          {tags.length > 0 && (
            <div role="group" aria-label="Tags" className="flex flex-wrap items-center gap-1">
              <span className="section-label mr-1">Tags</span>
              {tags.map((t) => (
                <Chip key={t} selected={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                  {t}
                </Chip>
              ))}
            </div>
          )}
        </div>

        <UploadZone compact kinds={[kind]} />

        <MediaGrid
          label={kind === 'image' ? 'Images' : 'Videos'}
          items={items}
          loading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => list.refetch()}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => list.fetchNextPage()}
          empty={
            filtered ? (
              <EmptyState icon={<Search />} title={`No ${noun} match`}>
                Try another word or filter.
              </EmptyState>
            ) : (
              <EmptyState icon={kind === 'image' ? <Images /> : <Film />} title={`No ${noun} yet`}>
                {kind === 'image' ? 'Create an image or upload one, and it lands here.' : 'Finish a quick video or a project render, or upload a clip.'}
              </EmptyState>
            )
          }
        />
      </div>
    </main>
  )
}
