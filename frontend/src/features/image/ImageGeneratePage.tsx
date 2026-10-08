import { useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { Images } from 'lucide-react'
import { EmptyState } from '@/components/studio/states'
import { GeneratorPage, ResultsHeading } from '@/components/generate/GeneratorPage'
import { SessionResults } from '@/components/generate/SessionResults'
import { useRecordRun } from '@/components/generate/useRecordRun'
import { flatItems, useImageGenerate, useMediaList } from '@/hooks/useMedia'
import { DEFAULT_IMAGE_FORM, type ImageForm } from '@/lib/images'
import { modelUsedId, normalizeModelId } from '@/lib/models'
import { imageFormFrom, type TemplatePrefill } from '@/lib/templates'
import { plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { ImageGenerateForm, type ImageRun } from './ImageGenerateForm'

const PAGE = 'image-create'

export function ImageGeneratePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const tpl = (location.state as { template?: TemplatePrefill } | null)?.template
  const model = normalizeModelId(params.get('model')) ?? undefined
  const base = tpl ? imageFormFrom(tpl.prefill, tpl.templateId) : { ...DEFAULT_IMAGE_FORM, prompt: params.get('prompt') ?? '' }
  // ?model= wins; otherwise a text template's Qwen hint
  const first = { ...base, model: model ?? base.model }
  // Reuse settings remounts the dock with the saved form
  const [prefill, setPrefill] = useState<{ n: number; form: ImageForm }>({ n: 0, form: first })
  const results = useMediaList({ kind: 'image', origin: 'generated' })
  const generate = useImageGenerate()
  const record = useRecordRun<ImageRun>(PAGE)

  const run = (r: ImageRun) =>
    generate.mutate(r.body, {
      onSuccess: ({ items, jobs }) => {
        record({ prompt: r.body.prompt, summary: r.summary, settings: r, items: items ?? [], jobs, label: plural(items?.length ?? r.form.count, 'image') })
        announce(`Creating ${plural(items?.length ?? r.form.count, 'image')}. They appear below as they finish.`)
      },
    })

  const refill = (form: ImageForm) => {
    setPrefill((p) => ({ n: p.n + 1, form }))
    announce('Settings copied into the prompt dock.')
  }

  return (
    <GeneratorPage
      label="Create image"
      targets={[
        { id: 'edit', label: 'Edit source', hint: 'Opens Edit Image with this picture', use: (m) => navigate(`/image/edit?sources=${m.id}`) },
        { id: 'i2i', label: 'Image to Image source', hint: 'Restyle or vary this picture', use: (m) => navigate(`/image/img2img?source=${m.id}`) },
      ]}
    >
      {/* keyed so arriving from another template or Home starts a fresh form */}
      <ImageGenerateForm
        key={`${location.key}-${prefill.n}`}
        initial={prefill.form}
        templateTitle={prefill.n ? undefined : tpl?.templateTitle}
        modelPicked={!!model && !prefill.n}
        onRun={run}
        pending={generate.isPending}
        error={generate.error}
      />
      <ResultsHeading>Your images</ResultsHeading>
      <SessionResults<ImageRun>
        page={PAGE}
        label="Results"
        items={flatItems(results.data)}
        loading={results.isPending}
        error={results.isError ? results.error : undefined}
        onRetryLoad={() => results.refetch()}
        hasMore={results.hasNextPage}
        loadingMore={results.isFetchingNextPage}
        onLoadMore={() => results.fetchNextPage()}
        onRetry={(req) => run(req.settings)}
        onReuse={(row) =>
          refill(
            row.request?.settings.form ?? {
              ...DEFAULT_IMAGE_FORM,
              prompt: row.prompt,
              count: Math.min(4, row.items.length),
              model: modelUsedId(row.items[0]?.params, { model: row.items[0]?.model }) ?? undefined,
            },
          )
        }
        reuseItem={(m) => refill({ ...DEFAULT_IMAGE_FORM, prompt: m.prompt ?? m.title, model: modelUsedId(m.params, { model: m.model }) ?? undefined, seed: m.seed != null ? String(m.seed) : '' })}
        empty={
          <EmptyState icon={<Images />} title="No images yet">
            Describe what you want above. Each variation appears here as it finishes.
          </EmptyState>
        }
      />
    </GeneratorPage>
  )
}
