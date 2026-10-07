import { useId, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { Brush, Images } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { AspectChip, BrandDockChip, CountChip, ModelChip } from '@/components/generate/DockChips'
import { GenerateButton } from '@/components/generate/GenerateButton'
import { GeneratorPage, ResultsHeading } from '@/components/generate/GeneratorPage'
import { PromptDock } from '@/components/generate/PromptDock'
import { SessionResults } from '@/components/generate/SessionResults'
import { useDockModels } from '@/components/generate/useDockModels'
import { useRecordRun } from '@/components/generate/useRecordRun'
import { useBrandChoice } from '@/hooks/useBrandKits'
import { useGenEstimate } from '@/hooks/useGenEstimate'
import { flatItems, useImageEdit, useMediaList } from '@/hooks/useMedia'
import { withBrand } from '@/lib/brand'
import { localEstimate } from '@/lib/estimate'
import { addSources, editPayload, MAX_EDIT_SOURCES } from '@/lib/images'
import { normalizeModelId } from '@/lib/models'
import type { ImageAspect, ImageEditRequest, MediaItem } from '@/lib/types'
import { plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { CountPicker, ImageAspectTiles } from './controls'
import { EditSources } from './EditSources'

const PAGE = 'image-edit'
const idsFrom = (raw: string | null) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

interface EditRun {
  ids: string[]
  instruction: string
  count: number
  aspect: ImageAspect | null
  model?: string
  seed: string
  body: ImageEditRequest
  summary: string
}

export function ImageEditPage() {
  const uid = useId()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const location = useLocation()
  const fromState = (location.state as { sources?: string[] } | null)?.sources ?? []
  // ?sources=a,b from a tile's Edit button or the References page; never more than three
  const [ids, setIds] = useState<string[]>(() => addSources([], [...idsFrom(params.get('sources')), ...fromState]).ids)
  const [notice, setNotice] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [count, setCount] = useState(1)
  const [aspect, setAspect] = useState<ImageAspect | null>(null)
  const [seed, setSeed] = useState('')
  const wanted = normalizeModelId(params.get('model'))
  const [modelId, setModelId] = useState<string | undefined>(wanted ?? undefined)
  const edit = useImageEdit()
  const results = useMediaList({ kind: 'image', origin: 'generated' })
  const brand = useBrandChoice()
  const record = useRecordRun<EditRun>(PAGE)
  const { models, model, send, effective } = useDockModels('edit', modelId)
  const max = effective?.max_refs ?? MAX_EDIT_SOURCES
  const over = Math.max(0, ids.length - max)
  const estimate = useGenEstimate(effective ? { kind: 'image', model: effective.id, count } : null, localEstimate(effective, { count }))
  const name = model?.label ?? 'This model'

  const add = (items: MediaItem[]) => {
    const next = addSources(ids, items.map((m) => m.id), max)
    setIds(next.ids)
    setNotice(next.dropped ? `${name} takes ${max === 1 ? '1 image' : `up to ${max} images`}, so ${next.dropped === 1 ? "1 image wasn't" : `${next.dropped} images weren't`} added.` : null)
  }
  const blocked = over
    ? `Too many source images for ${name}.`
    : !ids.length
      ? 'Add at least one source image.'
      : instruction.trim().length < 3
        ? 'Say what should change.'
        : null

  const run = (r: EditRun) =>
    edit.mutate(r.body, {
      onSuccess: ({ items, jobs }) => {
        record({ prompt: r.body.instruction, summary: r.summary, settings: r, items: items ?? [], jobs, label: plural(items?.length ?? r.count, 'edit') })
        announce(`Editing. ${plural(items?.length ?? r.count, 'result')} on the way.`)
      },
    })

  const submit = () => {
    if (blocked || edit.isPending) return
    // images/edit has no magic prompt: an instruction is already specific
    const base = editPayload(ids, instruction, count, aspect, send && { id: send.id, max_refs: max })
    const n = Number.parseInt(seed, 10)
    const body = withBrand({ ...base, ...(Number.isFinite(n) && n >= 0 ? { seed: n } : {}) }, brand.sendId)
    const summary = [model?.label, plural(ids.length, 'source'), aspect ?? 'source shape', plural(count, 'result')].filter(Boolean).join(' · ')
    run({ ids, instruction, count, aspect, model: model?.id, seed, body, summary })
  }

  const refill = (r: Partial<EditRun>) => {
    if (r.ids) setIds(r.ids)
    if (r.instruction !== undefined) setInstruction(r.instruction)
    if (r.count) setCount(r.count)
    if (r.aspect !== undefined) setAspect(r.aspect)
    if (r.model) setModelId(r.model)
    if (r.seed !== undefined) setSeed(r.seed)
    announce('Settings copied into the prompt dock.')
  }

  return (
    <GeneratorPage
      label="Edit image"
      targets={[
        { id: 'ref', label: 'Reference', hint: 'Adds it to the source images', use: (m) => add([m]) },
        { id: 'i2i', label: 'Image to Image source', hint: 'Restyle or vary this picture instead', use: (m) => navigate(`/image/img2img?source=${m.id}`) },
      ]}
    >
      <PromptDock
        title="Edit Image"
        icon={<Brush aria-hidden className="size-4 text-studio-accent-hover" />}
        refs={
          <EditSources
            ids={ids}
            max={max}
            notice={over ? `${name} takes ${max === 1 ? '1 image' : `up to ${max} images`}. Remove ${over === 1 ? '1 image' : `${over} images`} or pick another model.` : notice}
            onAdd={add}
            onRemove={(id) => {
              setIds((cur) => cur.filter((x) => x !== id))
              setNotice(null)
            }}
          />
        }
        promptLabel="What should change?"
        prompt={instruction}
        onPrompt={setInstruction}
        mentions={{ refBudget: max, refsUsed: ids.length }}
        maxLength={2000}
        placeholder={ids.length > 1 ? 'e.g. Put the woman from image 1 in the jacket from image 2, on the street from image 3' : 'What should change? e.g. Make it night, with rain on the window'}
        chips={
          <>
            <ModelChip models={models} model={model} onChange={setModelId} highlighted={!!wanted} />
            <AspectChip value={aspect ?? 'Source shape'}>
              <ImageAspectTiles value={aspect} onChange={setAspect} allowAuto />
            </AspectChip>
            <CountChip value={`×${count}`}>
              <CountPicker value={count} onChange={setCount} />
            </CountChip>
            <BrandDockChip choice={brand} />
          </>
        }
        advanced={
          <div className="w-40">
            <Label htmlFor={`${uid}-seed`} className="mb-1.5">
              Seed
            </Label>
            <Input id={`${uid}-seed`} inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))} placeholder="Random" className="font-mono" />
          </div>
        }
        error={edit.isError ? <ErrorState compact title="Couldn't start the edit" error={edit.error} /> : null}
        footer={
          <GenerateButton
            verb="Edit"
            what={plural(count, 'result')}
            estimate={estimate}
            icon={<Brush aria-hidden />}
            blocked={blocked}
            note="The result is a new image; your sources stay as they are."
            pending={edit.isPending}
          />
        }
        onSubmit={submit}
      />
      <ResultsHeading>Your images</ResultsHeading>
      <SessionResults<EditRun>
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
        onReuse={(row) => refill(row.request?.settings ?? { instruction: row.prompt })}
        onUseAsRef={(m) => add([m])}
        refLabel="Add as source"
        reuseItem={(m) => refill({ instruction: m.prompt ?? '' })}
        empty={
          <EmptyState icon={<Images />} title="Nothing edited yet">
            Pick a source, say what to change, and the results land here.
          </EmptyState>
        }
      />
    </GeneratorPage>
  )
}
