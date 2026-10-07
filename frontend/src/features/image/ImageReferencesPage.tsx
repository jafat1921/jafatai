import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowRight, Layers, Package, Palette, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { MediaTile } from '@/components/media/MediaTile'
import { UploadZone } from '@/components/media/UploadZone'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { addSources, MAX_EDIT_SOURCES } from '@/lib/images'
import { Skeleton } from '@/components/ui/skeleton'

const USES = [
  { icon: UserRound, title: 'Keep a face', text: 'Use a portrait so the same person appears in a new scene, outfit or pose.' },
  { icon: Package, title: 'Keep a product', text: 'Drop in a product shot and place it on a table, a shelf or in someone’s hands.' },
  { icon: Palette, title: 'Borrow a style', text: 'Add an image whose colours or brushwork you like, and ask for the same look.' },
]

export function ImageReferencesPage() {
  const navigate = useNavigate()
  const [picked, setPicked] = useState<string[]>([])
  const list = useMediaList({ kind: 'image', include: 'project' })
  const items = flatItems(list.data).filter((m) => m.media_url || m.thumb_url)
  const full = picked.length >= MAX_EDIT_SOURCES

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : addSources(p, [id]).ids))

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="refs-title">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:px-8">
        <header className="flex flex-col gap-2">
          <h1 id="refs-title" className="flex items-center gap-2 font-display text-title font-semibold">
            <Layers aria-hidden className="size-5 text-studio-accent" />
            References
          </h1>
          <p className="max-w-2xl text-body text-studio-muted">
            Give Qwen-Image-Edit up to {MAX_EDIT_SOURCES} images to work from, then say how to combine them. Name them by number in your
            instruction: “the woman from image 1 holding the bottle from image 2”.
          </p>
        </header>

        <ul className="grid gap-3 md:grid-cols-3">
          {USES.map((u) => (
            <li key={u.title} className="flex gap-3 rounded-[8px] border border-studio-border bg-studio-panel p-3 shadow-card">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[6px] border border-studio-gold/60 bg-studio-raised text-studio-accent">
                <u.icon aria-hidden className="size-4" />
              </span>
              <span>
                <span className="block text-body font-medium">{u.title}</span>
                <span className="block text-small text-studio-muted">{u.text}</span>
              </span>
            </li>
          ))}
        </ul>

        <section aria-labelledby="refs-pick" className="flex flex-col gap-3">
          <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-[8px] bg-studio-bg/90 px-1 py-2 backdrop-blur">
            <h2 id="refs-pick" className="section-label">
              Pick references · {picked.length}/{MAX_EDIT_SOURCES}
            </h2>
            {full && <span className="text-small text-studio-muted">That's the limit. Unselect one to swap it.</span>}
            <Button
              variant="primary"
              className="ml-auto"
              disabled={!picked.length}
              onClick={() => navigate(`/image/edit?sources=${picked.join(',')}`)}
            >
              Open in Edit
              <ArrowRight aria-hidden />
            </Button>
          </div>
          <UploadZone compact kinds={['image']} onUploaded={(m) => setPicked((p) => addSources(p, [m.id]).ids)} />
          {list.isPending ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="aspect-square" />
              ))}
            </div>
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState title="No images to use yet">Upload a photo above, or create one first.</EmptyState>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3" aria-label="Your images">
              {items.map((m) => (
                <li key={m.id}>
                  <MediaTile item={m} selectable selected={picked.includes(m.id)} disabled={full} onToggle={() => toggle(m.id)} />
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
