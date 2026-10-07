import { useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import { Boxes, FolderUp, MapPin, Users } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { MediaGrid } from '@/components/media/MediaGrid'
import { UploadZone } from '@/components/media/UploadZone'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { useProjects } from '@/hooks/useProjects'
import { plural } from '@/lib/utils'

function Heading({ id, icon: Icon, children }: { id: string; icon: typeof Users; children: React.ReactNode }) {
  return (
    <h2 id={id} className="flex scroll-mt-4 items-center gap-2 font-display text-panel font-semibold">
      <Icon aria-hidden className="size-4 text-studio-accent" />
      {children}
    </h2>
  )
}

function ProjectAssets() {
  const projects = useProjects()
  if (projects.isPending) return <Skeleton className="h-24" />
  if (projects.isError) return <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
  const withCast = (projects.data ?? []).filter((p) => p.counts?.characters > 0)
  if (!withCast.length) {
    return <p className="text-body text-studio-muted">Characters and locations live inside each project's Cast &amp; World stage. None yet.</p>
  }
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
      {withCast.map((p) => (
        <li key={p.id}>
          <Link
            to={`/projects/${p.id}/cast`}
            className="flex flex-col gap-1 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card hover:bg-studio-panel-hover"
          >
            <span className="font-display text-panel font-semibold">{p.title}</span>
            <span className="text-small text-studio-muted">{plural(p.counts.characters, 'character')} · open Cast &amp; World</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function AssetsPage() {
  const uploads = useMediaList({ origin: 'upload' })
  const { hash } = useLocation()
  // the Assets menu links to #characters, #uploads…; the router doesn't scroll to hashes itself
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: 'start' })
  }, [hash])
  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="assets-title">
      <div className="mx-auto flex max-w-7xl flex-col gap-7 px-4 py-6 md:px-8">
        <div>
          <h1 id="assets-title" className="font-display text-title font-semibold">
            Assets
          </h1>
          <p className="text-body text-studio-muted">What you bring in and reuse. Cross-project characters and LoRAs come in a later milestone.</p>
        </div>

        <section aria-labelledby="characters" className="flex flex-col gap-3">
          <Heading id="characters" icon={Users}>
            Characters &amp; locations
          </Heading>
          <span id="locations" className="sr-only" />
          <p className="flex items-center gap-1.5 text-small text-studio-muted">
            <MapPin aria-hidden className="size-3.5" /> For now they belong to a project. Pick one to see its cast and places.
          </p>
          <ProjectAssets />
        </section>

        <section aria-labelledby="uploads" className="flex flex-col gap-3">
          <Heading id="uploads" icon={FolderUp}>
            Uploads
          </Heading>
          <UploadZone kinds={['image', 'video']} compact />
          <MediaGrid
            label="Uploads"
            items={flatItems(uploads.data)}
            loading={uploads.isPending}
            error={uploads.isError ? uploads.error : undefined}
            onRetry={() => uploads.refetch()}
            hasMore={uploads.hasNextPage}
            loadingMore={uploads.isFetchingNextPage}
            onLoadMore={() => uploads.fetchNextPage()}
            empty={<p className="text-body text-studio-muted">Nothing uploaded yet. Drop images or clips above.</p>}
          />
        </section>

        <section aria-labelledby="loras">
          <EmptyState icon={<Boxes />} title="LoRAs are on the way" className="rounded-[8px] border border-dashed border-studio-border-strong">
            Train or import a LoRA once and use the same face or style in every project. Coming in a later milestone.
          </EmptyState>
          <span id="loras" className="sr-only">
            LoRAs
          </span>
        </section>
      </div>
    </main>
  )
}
