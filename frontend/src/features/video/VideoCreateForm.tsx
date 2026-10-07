import { useId, useState } from 'react'
import { ChevronDown, Film, Waves } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ModelPicker } from '@/components/models/ModelPicker'
import { AspectTiles } from '@/components/studio/aspect-tile'
import { DurationFields } from '@/components/studio/duration-picker'
import { ErrorState } from '@/components/studio/states'
import { SwitchRow } from '@/components/studio/switch-row'
import { useModels, useVideoGenerate } from '@/hooks/useModels'
import { formatDuration } from '@/lib/duration'
import { modKey } from '@/lib/keyboard'
import { pickModel, secondsText } from '@/lib/models'
import type { VideoAspect } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  clampDuration,
  durationPresets,
  maxDuration,
  smoothBlockedReason,
  VIDEO_ASPECTS,
  videoBlockedReason,
  videoPayload,
  type VideoForm,
} from '@/lib/video'
import { announce } from '@/stores/ui'
import { StartImage } from './StartImage'

export function VideoCreateForm({ initial, modelPicked }: { initial: VideoForm; modelPicked?: boolean }) {
  const uid = useId()
  const { models } = useModels('video')
  const [form, setForm] = useState<VideoForm>(initial)
  const [advanced, setAdvanced] = useState(false)
  const generate = useVideoGenerate()
  const set = <K extends keyof VideoForm>(k: K, v: VideoForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  const blocked = (id: string | undefined, hasImage: boolean) => {
    const m = models.find((x) => x.id === id)
    return !m || !!videoBlockedReason(m, hasImage)
  }
  const model = pickModel(models.filter((m) => !videoBlockedReason(m, !!form.imageId)), form.model) ?? pickModel(models, form.model)
  const max = maxDuration(model)
  const duration = clampDuration(form.durationS, model)
  const smoothOff = smoothBlockedReason(model, duration)
  const canSubmit = !!model && form.prompt.trim().length >= 3 && !generate.isPending && !videoBlockedReason(model, !!form.imageId)

  const chooseModel = (id: string) => {
    const m = models.find((x) => x.id === id)
    setForm((f) => ({ ...f, model: id, durationS: clampDuration(f.durationS, m) }))
  }
  const setImage = (id: string | null) => {
    if (id && blocked(model?.id, true)) {
      const next = pickModel(models.filter((m) => !videoBlockedReason(m, true)))
      setForm((f) => ({ ...f, imageId: id, model: next?.id, durationS: clampDuration(f.durationS, next) }))
      announce(`${model?.label} can't start from an image, so ${next?.label ?? 'another model'} is selected.`)
      return
    }
    set('imageId', id)
  }

  const submit = () => {
    if (!canSubmit || !model) return
    generate.mutate(videoPayload({ ...form, durationS: duration }, model), {
      onSuccess: () => announce('Making your clip. It appears below when it finishes.'),
    })
  }

  return (
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
      <div className="flex items-center gap-2">
        <Film aria-hidden className="size-4 text-studio-accent-hover" />
        <h1 id={`${uid}-title`} className="font-display text-title font-semibold">
          Create Video
        </h1>
        <p className="text-small text-studio-muted max-sm:hidden">One prompt, one clip. For a whole film, use Quick Video or a Studio project.</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-prompt`}>Describe the clip</Label>
        <Textarea
          id={`${uid}-prompt`}
          dir="auto"
          rows={3}
          maxLength={4000}
          value={form.prompt}
          onChange={(e) => set('prompt', e.target.value)}
          placeholder="e.g. Slow dolly in on a fisherman mending nets at dawn, gulls calling, waves on the hull"
          className="min-h-24 text-[15px] leading-6"
        />
      </div>

      <StartImage id={form.imageId} onChange={setImage} />

      <ModelPicker
        label="Model"
        models={models}
        value={model?.id}
        onChange={chooseModel}
        blockedBy={(m) => videoBlockedReason(m, !!form.imageId)}
        highlighted={modelPicked}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <DurationFields
          // remount when the cap changes so the custom box re-validates against it
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
          <div>
            <div id={`${uid}-aspect`} className="section-label mb-2">
              Aspect
            </div>
            <AspectTiles value={form.aspect} onChange={(v) => set('aspect', v as VideoAspect)} labelledBy={`${uid}-aspect`} only={VIDEO_ASPECTS} />
          </div>
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
        </div>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={advanced}
          aria-controls={`${uid}-adv`}
          onClick={() => setAdvanced((a) => !a)}
          className="flex items-center gap-1.5 rounded-[6px] px-1 text-small text-studio-muted hover:text-studio-text"
        >
          <ChevronDown aria-hidden className={cn('size-3.5 transition-transform duration-150', advanced && 'rotate-180')} />
          Advanced
        </button>
        {advanced && (
          <div id={`${uid}-adv`} className="mt-2 w-40">
            <Label htmlFor={`${uid}-seed`} className="mb-1.5">
              Seed
            </Label>
            <Input id={`${uid}-seed`} inputMode="numeric" value={form.seed} onChange={(e) => set('seed', e.target.value.replace(/\D/g, ''))} placeholder="Random" className="font-mono" />
          </div>
        )}
      </div>

      {generate.isError && <ErrorState compact title="Couldn't start the clip" error={generate.error} />}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="mr-auto text-small text-studio-muted">
          {form.imageId ? 'Starts on your image and moves from there.' : 'Made from your words alone.'}
        </p>
        <Button type="submit" size="lg" variant="primary" disabled={!canSubmit} loading={generate.isPending} aria-keyshortcuts="Control+Enter">
          <Film aria-hidden />
          Create clip
          <Kbd>{modKey}+Enter</Kbd>
        </Button>
      </div>
    </form>
  )
}
