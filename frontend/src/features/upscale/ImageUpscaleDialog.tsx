import { useId, useState } from 'react'
import { RadioGroup } from 'radix-ui'
import { ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { Chip } from '@/components/studio/chip'
import { ErrorState } from '@/components/studio/states'
import { useImageUpscale, useImageUpscaleOptions } from '@/hooks/useUpscale'
import { IMAGE_TARGETS, gpuText, planFor, previewText } from '@/lib/imageUpscale'
import { modKey } from '@/lib/keyboard'
import type { Generation, ImageUpscaleEngine, ImageUpscaleEngineId, ImageUpscaleTarget, Job } from '@/lib/types'
import { cn } from '@/lib/utils'
import { trackJobs } from '@/stores/toasts'
import { announce } from '@/stores/ui'
import { DetailSlider } from './DetailSlider'

const ENGINE_COPY: Record<ImageUpscaleEngineId, { name: string; blurb: string; icon: typeof Sparkles }> = {
  redraw: { name: 'Redraw', blurb: 'Sharpest, adds detail. Z-Image repaints the fine texture.', icon: Sparkles },
  quick: { name: 'Quick', blurb: 'Real-ESRGAN. Seconds, cleaner edges, no new detail.', icon: Zap },
  best: { name: 'Faithful', blurb: 'SeedVR2. Restores detail and stays true to the original.', icon: ShieldCheck },
}

interface Props {
  source: Generation | null
  subject: string
  onOpenChange: (open: boolean) => void
  onQueued?: (job: Job) => void
  initialEngine?: ImageUpscaleEngineId
}

export function ImageUpscaleDialog({ source, subject, onOpenChange, onQueued, initialEngine }: Props) {
  return (
    <Dialog open={!!source} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {source && (
          <UpscaleForm
            source={source}
            subject={subject}
            initialEngine={initialEngine}
            onDone={(job) => {
              if (job) onQueued?.(job)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function UpscaleForm({
  source,
  subject,
  initialEngine,
  onDone,
}: {
  source: Generation
  subject: string
  initialEngine?: ImageUpscaleEngineId
  onDone: (job?: Job) => void
}) {
  const ids = { engine: useId(), target: useId(), variant: useId() }
  const options = useImageUpscaleOptions(source.id)
  const upscale = useImageUpscale(source)
  const engines = options.data?.engines ?? []

  const [engineId, setEngineId] = useState<ImageUpscaleEngineId | undefined>(initialEngine)
  const [target, setTarget] = useState<ImageUpscaleTarget>()
  const [variant, setVariant] = useState<'3b' | '7b'>()
  const [denoise, setDenoise] = useState<number>()

  const fallback = engines.find((e) => e.id === options.data?.default_engine && e.available) ?? engines.find((e) => e.available)
  const engine = engines.find((e) => e.id === engineId && e.available) ?? fallback
  const src = options.data ? { w: options.data.source.width, h: options.data.source.height } : null
  const plans = IMAGE_TARGETS.map((t) => ({ ...t, plan: src ? planFor(options.data, engine, t.id, src) : null }))
  const chosen = plans.find((p) => p.id === target && p.plan?.ok) ?? plans.find((p) => p.plan?.ok)
  const strength = denoise ?? engine?.denoise?.default ?? 0.33
  const variants = engine?.id === 'best' ? (engine.variants ?? []) : []
  const pickedVariant = variants.includes(variant!) ? variant : (engine?.default_variant ?? variants[0])
  const canSubmit = !!engine?.available && !!chosen && !upscale.isPending

  const submit = () => {
    if (!canSubmit || !engine || !chosen) return
    const body = {
      engine: engine.id,
      target: chosen.id,
      ...(engine.id === 'redraw' ? { denoise: Math.round(strength * 100) / 100 } : {}),
      ...(engine.id === 'best' && pickedVariant ? { variant: pickedVariant } : {}),
    }
    upscale.mutate(
      { id: source.id, body },
      {
        onSuccess: (job) => {
          trackJobs([job], `Upscale to ${chosen.label}`)
          announce(`Upscaling version ${source.version} to ${chosen.label}. It will appear in Versions.`)
          onDone(job)
        },
      },
    )
  }

  const plan = chosen?.plan?.ok ? chosen.plan : null
  return (
    <form
      className="flex flex-col gap-5"
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
    >
      <DialogHeader className="mb-0">
        <DialogTitle>Upscale {subject.toLowerCase()} · v{source.version}</DialogTitle>
        <DialogDescription>
          Makes a bigger, sharper copy as a new version. This one stays as it is; approve whichever you want used.
        </DialogDescription>
      </DialogHeader>

      <div>
        <div id={ids.engine} className="section-label mb-2">
          Engine
        </div>
        {options.isPending ? (
          <div className="grid gap-2 sm:grid-cols-3" role="status" aria-label="Loading engines">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : options.isError ? (
          <ErrorState compact title="Couldn't check the upscale engines" error={options.error} onRetry={() => options.refetch()} />
        ) : (
          <RadioGroup.Root
            aria-labelledby={ids.engine}
            value={engine?.id ?? ''}
            onValueChange={(v) => setEngineId(v as ImageUpscaleEngineId)}
            className="grid gap-2 sm:grid-cols-3"
          >
            {engines.map((e) => (
              <EngineCard key={e.id} engine={e} />
            ))}
          </RadioGroup.Root>
        )}
      </div>

      {variants.length > 1 && (
        <div role="group" aria-labelledby={ids.variant} className="flex items-center gap-2">
          <span id={ids.variant} className="section-label">
            Model size
          </span>
          {variants.map((v) => (
            <Chip key={v} selected={pickedVariant === v} onClick={() => setVariant(v)} className="h-8 px-3 text-body">
              {v.toUpperCase()}
            </Chip>
          ))}
          <span className="text-small text-studio-muted">7B is slower and a little more detailed.</span>
        </div>
      )}

      <div role="group" aria-labelledby={ids.target}>
        <div id={ids.target} className="section-label mb-2">
          Size
        </div>
        <div className="flex flex-wrap gap-1">
          {plans.map((p) => (
            <Chip
              key={p.id}
              selected={chosen?.id === p.id}
              disabled={!p.plan?.ok}
              aria-describedby={p.plan && !p.plan.ok ? `${ids.target}-${p.id}` : undefined}
              onClick={() => setTarget(p.id)}
              className="h-8 px-3 text-body disabled:cursor-not-allowed disabled:opacity-50"
            >
              {p.label}
            </Chip>
          ))}
        </div>
        {plans.map((p) =>
          p.plan && !p.plan.ok ? (
            <p key={p.id} id={`${ids.target}-${p.id}`} className="mt-1 text-small text-studio-muted">
              {p.label}: {p.plan.reason}
            </p>
          ) : null,
        )}
      </div>

      {engine?.id === 'redraw' && (
        <DetailSlider
          value={strength}
          min={engine.denoise?.min ?? 0.15}
          max={engine.denoise?.max ?? 0.5}
          onChange={setDenoise}
        />
      )}

      {src && plan && (
        <div className="rounded-[6px] border border-studio-border bg-studio-raised px-3 py-2" aria-live="polite">
          <p className="font-mono text-small text-studio-text">{previewText(src, plan.size)}</p>
          <p className="text-small text-studio-muted">
            {[gpuText(plan.estS), plan.capped ? 'held at this size to fit the GPU' : null].filter(Boolean).join(' · ') ||
              'GPU time depends on the size'}
          </p>
        </div>
      )}

      {upscale.isError && <ErrorState compact title="Couldn't start the upscale" error={upscale.error} />}

      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit} loading={upscale.isPending} aria-keyshortcuts="Control+Enter">
          Upscale{chosen ? ` to ${chosen.label}` : ''}
          <Kbd>{modKey}+Enter</Kbd>
        </Button>
      </DialogFooter>
    </form>
  )
}

function EngineCard({ engine }: { engine: ImageUpscaleEngine }) {
  const copy = ENGINE_COPY[engine.id] ?? { name: engine.label, blurb: engine.description ?? '', icon: Sparkles }
  return (
    <RadioGroup.Item
      value={engine.id}
      disabled={!engine.available}
      aria-labelledby={`img-eng-${engine.id}-title`}
      aria-describedby={`img-eng-${engine.id}-blurb`}
      className={cn(
        'flex flex-col items-start gap-1 rounded-[6px] border p-3 text-left transition-colors duration-150',
        'border-studio-border-strong bg-studio-raised hover:bg-studio-panel-hover',
        'data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70 data-[disabled]:hover:bg-studio-raised',
      )}
    >
      <span className="flex items-center gap-2">
        <copy.icon aria-hidden className="size-4 text-studio-accent-hover" />
        <span id={`img-eng-${engine.id}-title`} className="text-heading font-semibold">
          {copy.name}
        </span>
      </span>
      <span id={`img-eng-${engine.id}-blurb`} className="text-small text-studio-muted">
        {engine.available ? copy.blurb : `Unavailable: ${engine.reason || 'not installed on the server'}.`}
      </span>
      <span className="font-mono text-[11px] text-studio-muted">{engine.label}</span>
    </RadioGroup.Item>
  )
}
