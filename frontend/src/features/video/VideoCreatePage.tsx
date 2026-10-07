import { useLocation, useSearchParams } from 'react-router'
import { Film } from 'lucide-react'
import { EmptyState } from '@/components/studio/states'
import { MediaGrid } from '@/components/media/MediaGrid'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { normalizeModelId } from '@/lib/models'
import { DEFAULT_VIDEO_FORM } from '@/lib/video'
import { VideoCreateForm } from './VideoCreateForm'

export function VideoCreatePage() {
  const location = useLocation()
  const [params] = useSearchParams()
  const model = normalizeModelId(params.get('model')) ?? undefined
  const results = useMediaList({ kind: 'video', origin: 'generated' })

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-label="Create video">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:px-8">
        <VideoCreateForm
          key={location.key}
          initial={{ ...DEFAULT_VIDEO_FORM, prompt: params.get('prompt') ?? '', imageId: params.get('image'), model }}
          modelPicked={!!model}
        />
        <div>
          <h2 className="section-label mb-3">Your clips</h2>
          <MediaGrid
            label="Results"
            items={flatItems(results.data)}
            loading={results.isPending}
            error={results.isError ? results.error : undefined}
            onRetry={() => results.refetch()}
            hasMore={results.hasNextPage}
            loadingMore={results.isFetchingNextPage}
            onLoadMore={() => results.fetchNextPage()}
            empty={
              <EmptyState icon={<Film />} title="No clips yet">
                Describe a moment above. Each clip appears here as it finishes.
              </EmptyState>
            }
          />
        </div>
      </div>
    </main>
  )
}
