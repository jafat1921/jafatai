import { useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { Film } from 'lucide-react'
import { EmptyState } from '@/components/studio/states'
import { GeneratorPage, ResultsHeading } from '@/components/generate/GeneratorPage'
import { SessionResults } from '@/components/generate/SessionResults'
import { useRecordRun } from '@/components/generate/useRecordRun'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { useVideoGenerate } from '@/hooks/useModels'
import { modelUsedId, normalizeModelId } from '@/lib/models'
import { DEFAULT_VIDEO_FORM, videoResult, type VideoForm } from '@/lib/video'
import { announce } from '@/stores/ui'
import { VideoCreateForm, type VideoRun } from './VideoCreateForm'

const PAGE = 'video-create'

export function VideoCreatePage() {
  // a fresh dock when arriving again from the menu or Home with new ?prompt / ?model
  return <VideoCreate key={useLocation().key} />
}

function VideoCreate() {
  const [params] = useSearchParams()
  const model = normalizeModelId(params.get('model')) ?? undefined
  const first: VideoForm = { ...DEFAULT_VIDEO_FORM, prompt: params.get('prompt') ?? '', imageId: params.get('image'), model }
  const [form, setForm] = useState<VideoForm>(first)
  const results = useMediaList({ kind: 'video', origin: 'generated' })
  const generate = useVideoGenerate()
  const record = useRecordRun<VideoRun>(PAGE)

  const run = (r: VideoRun) =>
    generate.mutate(r.body, {
      onSuccess: (res) => {
        const { items, jobs } = videoResult(res)
        record({ prompt: r.body.prompt, summary: r.summary, settings: r, items, jobs, label: 'Your clip' })
        announce('Making your clip. It appears below when it finishes.')
      },
    })
  const refill = (patch: Partial<VideoForm>, quiet = false) => {
    setForm((f) => ({ ...f, ...patch }))
    if (!quiet) announce('Settings copied into the prompt dock.')
  }

  return (
    <GeneratorPage
      label="Create video"
      targets={[{ id: 'start', label: 'Start frame', hint: 'The clip opens on this picture', use: (m) => refill({ imageId: m.id }, true) }]}
    >
      <VideoCreateForm
        form={form}
        setForm={setForm}
        modelPicked={!!model && form.model === model}
        onRun={run}
        pending={generate.isPending}
        error={generate.error}
      />
      <ResultsHeading>Your clips</ResultsHeading>
      <SessionResults<VideoRun>
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
          refill(row.request?.settings.form ?? { ...DEFAULT_VIDEO_FORM, prompt: row.prompt, model: modelUsedId(row.items[0]?.params) ?? undefined })
        }
        onUseAsRef={(m) => refill({ imageId: m.id }, true)}
        refLabel="Use as start frame"
        reuseItem={(m) => refill({ prompt: m.prompt ?? '', model: modelUsedId(m.params, { model: m.model }) ?? undefined })}
        empty={
          <EmptyState icon={<Film />} title="No clips yet">
            Describe a moment above. Each clip appears here as it finishes.
          </EmptyState>
        }
      />
    </GeneratorPage>
  )
}
