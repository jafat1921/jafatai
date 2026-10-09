import { Link, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ImageOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useMediaItem } from '@/hooks/useMedia'
import { usePhotoHistory } from '@/hooks/usePhoto'
import { api } from '@/lib/api'
import { editBase } from '@/lib/photo/history'
import type { Generation } from '@/lib/types'
import { LibraryNav } from './LibraryNav'
import { PhotoWorkspace } from './PhotoWorkspace'
import type { StudioTab } from './StudioPanel'

// browsers can't draw TIFF: edit from the thumbnail then (the server renders from the real file)
const viewable = (g: Generation | undefined) => (g ? (g.media_type === 'image/tiff' ? (g.thumb_url ?? null) : (g.media_url ?? g.thumb_url ?? null)) : null)

/** /image/studio/:generationId — a generation id or a Library item id (its current version). */
export function PhotoStudioPage() {
  const { generationId = '' } = useParams()
  const [search] = useSearchParams()
  const history = usePhotoHistory(generationId)
  const versions = history.data?.versions ?? []
  const opened = versions.find((v) => v.generation.id === generationId) ?? versions.find((v) => v.current) ?? versions[0]
  const { baseId, params } = opened ? editBase(opened) : { baseId: '', params: {} }
  const listed = versions.find((v) => v.generation.id === baseId)?.generation
  // the base can be an ancestor the history doesn't list (an older item's chain)
  const fetched = useQuery({ queryKey: ['generation', baseId], queryFn: () => api.generations.get(baseId), enabled: !!baseId && !listed })
  const base = listed ?? fetched.data
  const item = useMediaItem(history.data?.target_type === 'media' ? history.data.target_id : null).data
  const title = item?.title || opened?.generation.prompt?.slice(0, 60) || 'Photo'
  const tab = search.get('tab') === 'looks' ? 'looks' : undefined

  if (history.isPending) {
    return (
      <main className="flex h-full flex-col gap-3 p-4" aria-busy="true" aria-label="Photo Studio">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="flex-1" />
      </main>
    )
  }
  if (history.isError) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-3 p-6" aria-label="Photo Studio">
        <ErrorState title="Couldn't open this picture in Photo Studio" error={history.error} onRetry={() => history.refetch()} />
        <Button asChild variant="secondary" className="self-start">
          <Link to="/image/studio">Pick another picture</Link>
        </Button>
      </main>
    )
  }
  if (!opened || (opened.generation.media_type && !opened.generation.media_type.startsWith('image/'))) {
    return (
      <main aria-label="Photo Studio">
        <EmptyState icon={<ImageOff />} title="Nothing to develop here" action={<Button asChild variant="primary"><Link to="/image/studio">Pick a picture</Link></Button>}>
          Photo Studio works on finished images: generated, uploaded or from a project.
        </EmptyState>
      </main>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LibraryNav itemId={history.data?.target_type === 'media' ? history.data.target_id : null} />
      <div className="min-h-0 flex-1">
        <PhotoWorkspace
          key={opened.generation.id}
          routeId={generationId}
          history={history.data}
          opened={opened}
          baseId={baseId}
          sourceUrl={viewable(base) ?? viewable(opened.generation)}
          initial={params}
          title={title}
          initialTab={tab as StudioTab | undefined}
        />
      </div>
    </div>
  )
}
