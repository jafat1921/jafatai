import { lazy, Suspense, useId, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Box, Boxes, Eraser } from 'lucide-react'
import { ImageSourceField } from '@/components/media/ImageSourceField'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { SwitchRow } from '@/components/studio/switch-row'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { GenerateButton } from '@/components/generate/GenerateButton'
import { GeneratorPage, ResultsHeading } from '@/components/generate/GeneratorPage'
import { useGenEstimate } from '@/hooks/useGenEstimate'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { useMake3D } from '@/hooks/useModel3D'
import { useModels } from '@/hooks/useModels'
import { blocked3d, DEFAULT_FORM_3D, ENGINES, isModelReady, local3dEstimate, make3dPayload, QUALITIES, type Form3D } from '@/lib/model3d'
import type { Engine3D, MediaItem, Quality3D } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'

// three.js only arrives with the first model on screen
const ModelViewer = lazy(() => import('./ModelViewer').then((m) => ({ default: m.ModelViewer })))

const LIST = { kind: 'model' as const }

export function Studio3DPage() {
  const uid = useId()
  const [params] = useSearchParams()
  const [form, setForm] = useState<Form3D>({ ...DEFAULT_FORM_3D, sourceId: params.get('image') })
  const set = <K extends keyof Form3D>(k: K, v: Form3D[K]) => setForm((f) => ({ ...f, [k]: v }))
  const [note, setNote] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)

  const make = useMake3D()
  const { models: engines } = useModels('model3d')
  const engine = engines.find((m) => m.id === form.engine)
  const estimate = useGenEstimate({ kind: 'model3d', model: form.engine, speed: form.quality }, local3dEstimate(engine, form.engine, form.quality))
  const results = useMediaList(LIST)
  const items = flatItems(results.data)
  const ready = items.filter(isModelReady)
  const shown = ready.find((m) => m.id === picked) ?? ready[0] ?? null

  const why = blocked3d(form, engine)
  const quality = QUALITIES.find((q) => q.id === form.quality)

  const submit = () => {
    const body = make3dPayload(form)
    if (why || make.isPending || !body) return
    make.mutate(body, {
      onSuccess: (res) => {
        setNote(res.background_note ?? null)
        setPicked(null)
        announce('Making your 3D model. It appears below when it finishes.')
      },
    })
  }

  return (
    <GeneratorPage label="3D Studio" targets={[{ id: 'picture', label: 'Picture', hint: 'Turned into a 3D model', use: (m) => set('sourceId', m.id) }]}>
      <form
        aria-labelledby={`${uid}-title`}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            submit()
          }
        }}
        className="flex flex-col gap-4 rounded-[8px] border border-studio-border-strong bg-studio-panel p-3 shadow-card md:p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Box aria-hidden className="size-4 text-studio-accent-hover" />
          <h1 id={`${uid}-title`} className="font-display text-panel font-semibold md:text-title">
            3D Studio
          </h1>
          <p className="text-small text-studio-muted max-lg:hidden">One object, whole in frame, on a plain background works best.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-[auto_1fr]">
          <ImageSourceField
            label="Picture"
            required
            value={form.sourceId}
            onChange={(id) => set('sourceId', id)}
            aspectClass="aspect-square"
            removeLabel="Remove the picture"
            pickDescription="Pick the picture to turn into a 3D model."
          />

          <div className="flex min-w-0 flex-col gap-3">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="section-label mb-1.5">Engine</legend>
              <ToggleGroup type="single" aria-label="Engine" value={form.engine} onValueChange={(v) => v && set('engine', v as Engine3D)} className="flex w-full max-w-md">
                {ENGINES.map((e) => {
                  const info = engines.find((m) => m.id === e.id)
                  return (
                    <ToggleGroupItem key={e.id} value={e.id} disabled={info ? !info.available : false} aria-label={`${e.label}, ${e.hint.toLowerCase()}`} className="h-auto py-1.5">
                      <span className="flex flex-col items-center leading-tight">
                        <span className="font-medium">{e.label}</span>
                        <span className="text-small opacity-80">{e.hint}</span>
                      </span>
                    </ToggleGroupItem>
                  )
                })}
              </ToggleGroup>
            </fieldset>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="section-label mb-1.5">Quality</legend>
              <ToggleGroup type="single" aria-label="Quality" aria-describedby={`${uid}-q`} value={form.quality} onValueChange={(v) => v && set('quality', v as Quality3D)} className="w-full max-w-xs">
                {QUALITIES.map((q) => (
                  <ToggleGroupItem key={q.id} value={q.id}>
                    {q.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p id={`${uid}-q`} className="text-small text-studio-muted">
                {quality?.hint}
              </p>
            </fieldset>

            <SwitchRow
              id={`${uid}-bg`}
              checked={form.removeBackground}
              onChange={(v) => set('removeBackground', v)}
              icon={<Eraser aria-hidden className="size-3.5" />}
              title="Remove background"
              hint="Cuts the object out first. Turn off only for a picture that is already see-through."
              className="max-w-md"
            />
          </div>
        </div>

        {make.isError && <ErrorState compact title="Couldn't start the model" error={make.error} />}
        {note && (
          <p role="status" className="text-small text-studio-warning">
            {note}
          </p>
        )}
        <GenerateButton
          verb="Make 3D"
          what={`${quality?.label ?? 'Final'} model`}
          estimate={estimate}
          icon={<Box aria-hidden />}
          blocked={why}
          note="You get a GLB, plus OBJ, STL and USDZ downloads."
          pending={make.isPending}
        />
      </form>

      <ResultsHeading>Viewer</ResultsHeading>
      {shown?.media_url ? (
        <Suspense fallback={<Skeleton className="aspect-[4/3] w-full rounded-[8px]" />}>
          <ModelViewer key={shown.id} url={shown.media_url} title={shown.title || '3D model'} />
        </Suspense>
      ) : (
        <div className="rounded-[8px] border border-studio-border bg-studio-raised">
          <EmptyState icon={<Box />} title={items.length ? 'Your model is on its way' : 'No 3D models yet'}>
            {items.length ? 'It opens here as soon as it finishes.' : 'Add a picture and press Make 3D. You can turn it, light it and download it here.'}
          </EmptyState>
        </div>
      )}

      <ResultsHeading>Your models</ResultsHeading>
      {results.isError ? (
        <ErrorState title="Couldn't load your models" error={results.error} onRetry={() => results.refetch()} />
      ) : results.isPending ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-square" />
          ))}
        </div>
      ) : items.length ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 pb-8">
          {items.map((m) => (
            <li key={m.id}>
              <ModelTile item={m} selected={m.id === shown?.id} onView={() => setPicked(m.id)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="pb-8 text-small text-studio-muted">Finished models collect here.</p>
      )}
      {results.hasNextPage && (
        <button type="button" className="self-center pb-8 text-small underline" onClick={() => results.fetchNextPage()}>
          Show more
        </button>
      )}
    </GeneratorPage>
  )
}

const STATUS: Record<string, string> = { queued: 'Waiting', generating: 'Making…', failed: 'Failed', cancelled: 'Cancelled' }

function ModelTile({ item, selected, onView }: { item: MediaItem; selected: boolean; onView: () => void }) {
  const done = isModelReady(item)
  const label = STATUS[item.status ?? ''] ?? null
  return (
    <button
      type="button"
      onClick={onView}
      disabled={!done}
      aria-pressed={done ? selected : undefined}
      aria-label={`${item.title || '3D model'}${label ? `, ${label.toLowerCase()}` : ''}`}
      className={cn(
        'group flex w-full flex-col overflow-hidden rounded-[8px] border bg-studio-panel text-left shadow-card transition-colors',
        selected ? 'border-studio-accent ring-2 ring-studio-accent/40' : 'border-studio-border-strong hover:border-studio-border-hover',
        !done && 'cursor-default',
      )}
    >
      <span className="relative flex aspect-square items-center justify-center bg-studio-raised">
        {item.thumb_url ? (
          <img src={item.thumb_url} alt="" loading="lazy" className="size-full object-contain p-2" />
        ) : (
          <Boxes aria-hidden className="size-7 text-studio-faint" />
        )}
        {label && <span className="absolute left-1.5 top-1.5 rounded-[4px] bg-studio-panel/90 px-1.5 text-small text-studio-muted">{label}</span>}
      </span>
      <span className="truncate px-2 py-1.5 text-small">{item.title || '3D model'}</span>
    </button>
  )
}
