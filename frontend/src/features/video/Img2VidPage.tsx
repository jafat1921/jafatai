import { useId, useState } from 'react'
import { useSearchParams } from 'react-router'
import { AudioLines, Clapperboard, Film, Waves } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { BrandChip } from '@/components/brand/BrandChip'
import { MediaGrid } from '@/components/media/MediaGrid'
import { ModelPicker } from '@/components/models/ModelPicker'
import { DurationFields } from '@/components/studio/duration-picker'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { SwitchRow } from '@/components/studio/switch-row'
import { useBrandChoice } from '@/hooks/useBrandKits'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { useModels, useVideoGenerate } from '@/hooks/useModels'
import { formatDuration } from '@/lib/duration'
import { modKey } from '@/lib/keyboard'
import { has, normalizeModelId, pickModel, secondsText } from '@/lib/models'
import { clampDuration, DEFAULT_I2V_FORM, durationPresets, i2vBlockedReason, i2vPayload, maxDuration, smoothBlockedReason, type I2vForm } from '@/lib/video'
import { announce } from '@/stores/ui'
import { StartImage } from './StartImage'

export function Img2VidPage() {
  const uid = useId()
  const [params] = useSearchParams()
  const wanted = normalizeModelId(params.get('model'))
  const [form, setForm] = useState<I2vForm>({ ...DEFAULT_I2V_FORM, startId: params.get('image'), model: wanted ?? undefined })
  const set = <K extends keyof I2vForm>(k: K, v: I2vForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const { models } = useModels('video')
  const brand = useBrandChoice()
  const generate = useVideoGenerate()
  const results = useMediaList({ kind: 'video', origin: 'generated' })

  const blocked = (m: (typeof models)[number]) => i2vBlockedReason(m, !!form.endId)
  const model = pickModel(models.filter((m) => !blocked(m)), form.model)
  const max = maxDuration(model)
  const duration = clampDuration(form.durationS, model)
  const smoothOff = smoothBlockedReason(model, duration)
  const canSubmit = !!model && !!form.startId && form.prompt.trim().length >= 3 && !generate.isPending

  const submit = () => {
    if (!canSubmit || !model || !form.startId) return
    generate.mutate(i2vPayload({ ...form, startId: form.startId, durationS: duration }, model, brand.sendId), {
      onSuccess: () => announce('Animating your picture. The clip appears below when it finishes.'),
    })
  }

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-label="Image to video">
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
            <Clapperboard aria-hidden className="size-4 text-studio-accent-hover" />
            <h1 id={`${uid}-title`} className="font-display text-title font-semibold">
              Image to Video
            </h1>
            <p className="text-small text-studio-muted max-sm:hidden">Animate your picture. Add an end picture to say where it lands.</p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <StartImage id={form.startId} onChange={(id) => set('startId', id)} required globalPaste />
            <StartImage id={form.endId} onChange={(id) => set('endId', id)} end />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-prompt`}>Describe the motion</Label>
            <Textarea
              id={`${uid}-prompt`}
              dir="auto"
              rows={3}
              maxLength={4000}
              value={form.prompt}
              onChange={(e) => set('prompt', e.target.value)}
              placeholder="e.g. Slow push in, steam rises from the cup, leaves drift past the window"
              className="min-h-20 text-[15px] leading-6"
            />
          </div>

          <ModelPicker
            label="Model"
            models={models}
            value={model?.id}
            onChange={(id) => setForm((f) => ({ ...f, model: id, durationS: clampDuration(f.durationS, models.find((m) => m.id === id)) }))}
            blockedBy={blocked}
            highlighted={!!wanted}
          />
          <BrandChip choice={brand} />

          <div className="grid gap-4 md:grid-cols-2">
            <DurationFields
              key={`${model?.id}-${max}`}
              label="Length"
              value={duration}
              onChange={(v) => set('durationS', v)}
              presets={durationPresets(model)}
              max={max}
              limitNoun={` with ${model?.label ?? 'this model'}`}
              estimateLine={
                <p className="text-small text-studio-muted" aria-live="polite">
                  <span className="font-mono text-studio-text">{formatDuration(duration)}</span>
                  {model?.est_seconds ? ` · a typical clip takes about ${secondsText(model.est_seconds)}` : ''}
                </p>
              }
            />
            <div className="flex flex-col gap-3">
              <p className="flex items-start gap-2 rounded-[6px] border border-studio-border bg-studio-raised p-2.5 text-small text-studio-muted">
                <AudioLines aria-hidden className="mt-0.5 size-3.5 shrink-0 text-studio-accent-hover" />
                {has(model, 'audio')
                  ? `${model?.label} adds sound that fits the motion: ambience and effects. Describe sounds in the prompt to steer it.`
                  : 'This model makes silent clips.'}
              </p>
              {model?.smooth_motion && (
                <SwitchRow
                  id={`${uid}-smooth`}
                  checked={form.smooth && !smoothOff}
                  disabled={!!smoothOff}
                  onChange={(v) => set('smooth', v)}
                  icon={<Waves aria-hidden className="size-3.5" />}
                  title="Smooth motion ×2"
                  hint={smoothOff ?? 'Doubles the frame rate (24 → 48 fps). Adds render time.'}
                />
              )}
              <div className="w-40">
                <Label htmlFor={`${uid}-seed`} className="mb-1.5">
                  Seed
                </Label>
                <Input id={`${uid}-seed`} inputMode="numeric" value={form.seed} onChange={(e) => set('seed', e.target.value.replace(/\D/g, ''))} placeholder="Random" className="font-mono" />
              </div>
            </div>
          </div>

          {generate.isError && <ErrorState compact title="Couldn't start the clip" error={generate.error} />}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <p className="mr-auto text-small text-studio-muted">
              {!form.startId ? 'Add a start picture first.' : form.endId ? 'Moves from your start picture to your end picture.' : 'Opens on your picture and moves from there.'}
            </p>
            <Button type="submit" size="lg" variant="primary" disabled={!canSubmit} loading={generate.isPending} aria-keyshortcuts="Control+Enter">
              <Film aria-hidden />
              Animate
              <Kbd>{modKey}+Enter</Kbd>
            </Button>
          </div>
        </form>

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
                Add a picture and describe the motion. Each clip appears here as it finishes.
              </EmptyState>
            }
          />
        </div>
      </div>
    </main>
  )
}
