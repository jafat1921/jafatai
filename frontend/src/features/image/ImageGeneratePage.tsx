import { useLocation, useSearchParams } from 'react-router'
import { Images } from 'lucide-react'
import { EmptyState } from '@/components/studio/states'
import { MediaGrid } from '@/components/media/MediaGrid'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { DEFAULT_IMAGE_FORM } from '@/lib/images'
import { normalizeModelId } from '@/lib/models'
import { imageFormFrom, type TemplatePrefill } from '@/lib/templates'
import { ImageGenerateForm } from './ImageGenerateForm'

export function ImageGeneratePage() {
  const location = useLocation()
  const [params] = useSearchParams()
  const tpl = (location.state as { template?: TemplatePrefill } | null)?.template
  const prompt = params.get('prompt') ?? ''
  const model = normalizeModelId(params.get('model')) ?? undefined
  const initial = { ...(tpl ? imageFormFrom(tpl.prefill, tpl.templateId) : { ...DEFAULT_IMAGE_FORM, prompt }), model }
  const results = useMediaList({ kind: 'image', origin: 'generated' })

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-label="Create image">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:px-8">
        {/* keyed so arriving from another template or Home starts a fresh form */}
        <ImageGenerateForm
          key={location.key}
          initial={initial}
          templateTitle={tpl?.templateTitle}
          modelPicked={!!model}
        />
        <div>
          <h2 className="section-label mb-3">Your images</h2>
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
              <EmptyState icon={<Images />} title="No images yet">
                Describe what you want above. Each variation appears here as it finishes.
              </EmptyState>
            }
          />
        </div>
      </div>
    </main>
  )
}
