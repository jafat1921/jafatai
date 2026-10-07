import { useId } from 'react'
import { Film, RectangleHorizontal, Timer, Waves } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AspectTiles } from '@/components/studio/aspect-tile'
import { DurationFields } from '@/components/studio/duration-picker'
import { ErrorState } from '@/components/studio/states'
import { SwitchRow } from '@/components/studio/switch-row'
import { DockChip } from '@/components/generate/DockChip'
import { BrandDockChip, ModelChip } from '@/components/generate/DockChips'
import { GenerateButton } from '@/components/generate/GenerateButton'
import { PromptDock } from '@/components/generate/PromptDock'
import { RefSlot } from '@/components/generate/RefSlot'
import { useDockModels } from '@/components/generate/useDockModels'
import { useMagicPrompt } from '@/components/generate/useMagicPrompt'
import { useBrandChoice } from '@/hooks/useBrandKits'
import { useGenEstimate } from '@/hooks/useGenEstimate'
import { withBrand } from '@/lib/brand'
import { formatDuration } from '@/lib/duration'
import { localEstimate } from '@/lib/estimate'
import { pickModel } from '@/lib/models'
import type { VideoAspect, VideoGenerateRequest } from '@/lib/types'
import { clampDuration, durationPresets, maxDuration, smoothBlockedReason, VIDEO_ASPECTS, videoBlockedReason, videoPayload, type VideoForm } from '@/lib/video'
import { announce } from '@/stores/ui'

export interface VideoRun {
  form: VideoForm
  body: VideoGenerateRequest
  summary: string
}

interface Props {
  // owned by the page, so Reuse settings and a dropped picture can fill it
  form: VideoForm
  setForm: React.Dispatch<React.SetStateAction<VideoForm>>
  modelPicked?: boolean
  onRun: (r: VideoRun) => void
  pending?: boolean
  error?: unknown
}

export function VideoCreateForm({ form, setForm, modelPicked, onRun, pending, error }: Props) {
  const uid = useId()
  const brand = useBrandChoice()
  const set = <K extends keyof VideoForm>(k: K, v: VideoForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const blockedBy = (m: Parameters<typeof videoBlockedReason>[0]) => videoBlockedReason(m, !!form.imageId)
  const { models, model, send, effective } = useDockModels('video', form.model, { blocked: blockedBy, prompt: form.prompt })
  const max = maxDuration(effective)
  const duration = clampDuration(form.durationS, effective)
  const smoothOff = smoothBlockedReason(effective, duration)
  const magic = useMagicPrompt(form.prompt, { kind: 'video', model: send?.id, brandKitId: brand.sendId })
  const estimate = useGenEstimate(
    effective ? { kind: 'video', model: effective.id, duration_s: duration } : null,
    localEstimate(effective, { durationS: duration }),
  )

  const blocked = !send
    ? 'No video model is available right now.'
    : videoBlockedReason(send, !!form.imageId)
      ? videoBlockedReason(send, !!form.imageId)
      : form.prompt.trim().length < 3
        ? 'Describe the clip first.'
        : null

  const chooseModel = (id: string) => {
    const m = models.find((x) => x.id === id)
    setForm((f) => ({ ...f, model: id, durationS: clampDuration(f.durationS, m) }))
  }
  const setImage = (id: string | null) => {
    if (id && model && videoBlockedReason(model, true)) {
      const next = pickModel(models.filter((m) => !videoBlockedReason(m, true)))
      setForm((f) => ({ ...f, imageId: id, model: next?.id, durationS: clampDuration(f.durationS, next) }))
      announce(`${model.label} can't start from an image, so ${next?.label ?? 'another model'} is selected.`)
      return
    }
    set('imageId', id)
  }

  const submit = () => {
    if (blocked || pending || !send) return
    const body = withBrand({ ...videoPayload({ ...form, durationS: duration }, send), ...magic.fields() }, brand.sendId)
    const summary = [model?.label, formatDuration(duration), form.aspect, form.imageId ? 'from a picture' : null, body.smooth_motion ? 'smooth ×2' : null].filter(Boolean).join(' · ')
    onRun({ form: { ...form, model: model?.id, durationS: duration }, body, summary })
  }

  return (
    <PromptDock
      title="Create Video"
      icon={<Film aria-hidden className="size-4 text-studio-accent-hover" />}
      headerExtra={<p className="text-small text-studio-muted max-lg:hidden">One prompt, one clip. For a whole film, use Quick Video.</p>}
      refs={
        <div className="flex items-start gap-3">
          <RefSlot label="Start image" value={form.imageId} onChange={setImage} removeLabel="Remove the start image" description="The clip opens on this frame and moves from there." />
        </div>
      }
      promptLabel="Describe the clip"
      prompt={form.prompt}
      onPrompt={(v) => set('prompt', v)}
      placeholder="e.g. Slow dolly in on a fisherman mending nets at dawn, gulls calling, waves on the hull"
      chips={
        <>
          <ModelChip models={models} model={model} onChange={chooseModel} blockedBy={blockedBy} highlighted={modelPicked} />
          <DockChip name="Length" value={formatDuration(duration)} icon={<Timer aria-hidden />}>
            <DurationFields
              // remount when the cap changes so the custom box re-validates against it
              key={`${effective?.id}-${max}`}
              label="Length"
              value={duration}
              onChange={(v) => set('durationS', v)}
              presets={durationPresets(effective)}
              max={max}
              limitNoun={` with ${effective?.label ?? 'this model'}`}
              estimateLine={null}
            />
          </DockChip>
          <DockChip name="Aspect" value={form.aspect} icon={<RectangleHorizontal aria-hidden />} wide>
            <div id={`${uid}-aspect`} className="section-label">
              Aspect
            </div>
            <AspectTiles value={form.aspect} onChange={(v) => set('aspect', v as VideoAspect)} labelledBy={`${uid}-aspect`} only={VIDEO_ASPECTS} />
          </DockChip>
          <BrandDockChip choice={brand} />
        </>
      }
      advanced={
        <div className="flex flex-wrap items-start gap-4">
          <div className="w-40">
            <Label htmlFor={`${uid}-seed`} className="mb-1.5">
              Seed
            </Label>
            <Input id={`${uid}-seed`} inputMode="numeric" value={form.seed} onChange={(e) => set('seed', e.target.value.replace(/\D/g, ''))} placeholder="Random" className="font-mono" />
          </div>
          {effective?.smooth_motion && (
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
      }
      magic={magic}
      error={error ? <ErrorState compact title="Couldn't start the clip" error={error} /> : null}
      footer={
        <GenerateButton
          verb="Render"
          what={`${formatDuration(duration)} clip`}
          estimate={estimate}
          icon={<Film aria-hidden />}
          blocked={blocked}
          note={form.imageId ? 'Starts on your image and moves from there.' : 'Made from your words alone.'}
          pending={pending}
        />
      }
      onSubmit={submit}
    />
  )
}
