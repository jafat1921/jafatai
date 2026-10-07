import { useId, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Images, Shuffle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { BrandChip } from '@/components/brand/BrandChip'
import { ImageSourceField } from '@/components/media/ImageSourceField'
import { MediaGrid } from '@/components/media/MediaGrid'
import { ModelPicker } from '@/components/models/ModelPicker'
import { SpeedPicker } from '@/components/models/SpeedPicker'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useBrandChoice } from '@/hooks/useBrandKits'
import { flatItems, useImg2Img, useMediaItem, useMediaList } from '@/hooks/useMedia'
import { useModels } from '@/hooks/useModels'
import { DEFAULT_I2I_FORM, i2iModels, img2imgPayload, type Img2ImgForm } from '@/lib/img2img'
import { modKey } from '@/lib/keyboard'
import { defaultSpeed, normalizeModelId, pickModel } from '@/lib/models'
import { plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { BeforeAfter } from './BeforeAfter'
import { CountPicker, ImageAspectTiles } from './controls'
import { StrengthSlider } from './StrengthSlider'

export function Img2ImgPage() {
  const uid = useId()
  const [params] = useSearchParams()
  const wanted = normalizeModelId(params.get('model'))
  const [form, setForm] = useState<Img2ImgForm>({ ...DEFAULT_I2I_FORM, sourceId: params.get('source') })
  const [modelId, setModelId] = useState<string | undefined>(wanted ?? undefined)
  const [speedId, setSpeedId] = useState<string | undefined>()
  const [batch, setBatch] = useState<string[]>([])
  const set = <K extends keyof Img2ImgForm>(k: K, v: Img2ImgForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  const { models: all } = useModels('image')
  const models = i2iModels(all)
  const model = pickModel(models, modelId)
  const speed = model?.speeds?.find((s) => s.id === speedId && s.available !== false) ?? defaultSpeed(model)
  const brand = useBrandChoice()
  const run = useImg2Img()
  const results = useMediaList({ kind: 'image', origin: 'generated' })
  const source = useMediaItem(form.sourceId)
  const items = flatItems(results.data)
  const latest = items.find((m) => batch.includes(m.id) && m.media_url)
  const sourceUrl = source.data?.media_url ?? source.data?.thumb_url

  const canSubmit = !!form.sourceId && form.prompt.trim().length >= 3 && !run.isPending
  const submit = () => {
    if (!canSubmit || !form.sourceId) return
    run.mutate(img2imgPayload({ ...form, sourceId: form.sourceId }, model, speed?.id, brand.sendId), {
      onSuccess: ({ items: made }) => {
        setBatch((made ?? []).map((m) => m.id))
        announce(`Making ${plural(made?.length ?? form.count, 'variation')}. They appear below as they finish.`)
      },
    })
  }

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-label="Image to image">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:px-8">
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
          className="flex flex-col gap-4 rounded-[8px] border border-studio-border-strong bg-studio-panel p-4 shadow-card"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Shuffle aria-hidden className="size-4 text-studio-accent-hover" />
            <h1 id={`${uid}-title`} className="font-display text-title font-semibold">
              Image to Image
            </h1>
            <p className="text-small text-studio-muted max-sm:hidden">Restyle or vary your picture. The layout stays, the look changes.</p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <ImageSourceField
              label="Your picture"
              required
              value={form.sourceId}
              onChange={(id) => set('sourceId', id)}
              globalPaste
              aspectClass="aspect-square"
              pickDescription="The picture to restyle or vary."
            />
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-prompt`}>Describe the result</Label>
                <Textarea
                  id={`${uid}-prompt`}
                  dir="auto"
                  rows={3}
                  maxLength={4000}
                  value={form.prompt}
                  onChange={(e) => set('prompt', e.target.value)}
                  placeholder="e.g. Oil painting, warm evening light, visible brush strokes"
                  className="min-h-20 text-[15px] leading-6"
                />
              </div>
              <StrengthSlider value={form.strength} onChange={(v) => set('strength', v)} />
            </div>
          </div>

          <ModelPicker label="Model" models={models} value={model?.id} onChange={(id) => {
              setModelId(id)
              setSpeedId(undefined)
            }} highlighted={!!wanted} />
          {model?.speeds?.length ? <SpeedPicker model={model} value={speed?.id} onChange={setSpeedId} /> : null}
          <BrandChip choice={brand} />

          <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
            <ImageAspectTiles value={form.aspect === 'source' ? null : form.aspect} onChange={(v) => set('aspect', v ?? 'source')} allowAuto autoLabel="Keep source" />
            <CountPicker value={form.count} onChange={(n) => set('count', n)} />
          </div>
          <div className="w-40">
            <Label htmlFor={`${uid}-seed`} className="mb-1.5">
              Seed
            </Label>
            <Input id={`${uid}-seed`} inputMode="numeric" value={form.seed} onChange={(e) => set('seed', e.target.value.replace(/\D/g, ''))} placeholder="Random" className="font-mono" />
          </div>

          {run.isError && <ErrorState compact title="Couldn't start" error={run.error} />}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <p className="mr-auto text-small text-studio-muted">
              {form.sourceId ? 'Your picture stays as it is; each result is a new image.' : 'Add your picture first: drop, paste or pick one.'}
            </p>
            <Button type="submit" size="lg" variant="primary" disabled={!canSubmit} loading={run.isPending} aria-keyshortcuts="Control+Enter">
              <Shuffle aria-hidden />
              Create
              <Kbd>{modKey}+Enter</Kbd>
            </Button>
          </div>
        </form>

        {latest?.media_url && sourceUrl && (
          <section aria-label="Before and after" className="max-w-3xl">
            <h2 className="section-label mb-3">Before and after</h2>
            <BeforeAfter before={sourceUrl} after={latest.media_url} alt={latest.title || form.prompt} />
          </section>
        )}

        <div>
          <h2 className="section-label mb-3">Your images</h2>
          <MediaGrid
            label="Results"
            items={items}
            loading={results.isPending}
            error={results.isError ? results.error : undefined}
            onRetry={() => results.refetch()}
            hasMore={results.hasNextPage}
            loadingMore={results.isFetchingNextPage}
            onLoadMore={() => results.fetchNextPage()}
            empty={
              <EmptyState icon={<Images />} title="Nothing yet">
                Add a picture, say how it should look, and the results land here.
              </EmptyState>
            }
          />
        </div>
      </div>
    </main>
  )
}
