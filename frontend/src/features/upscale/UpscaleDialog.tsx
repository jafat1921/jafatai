import { useId, useState } from 'react'
import { RadioGroup } from 'radix-ui'
import { Gauge, Sparkles, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { Chip } from '@/components/studio/chip'
import { ErrorState } from '@/components/studio/states'
import { useUpscale, useUpscaleOptions, useVideoSize } from '@/hooks/useUpscale'
import { modKey } from '@/lib/keyboard'
import { renderInfo } from '@/lib/stitch'
import type { Generation, Job, UpscaleEngine, UpscaleEngineId, UpscaleTarget } from '@/lib/types'
import {
  TARGETS,
  aspectSize,
  pickEngine,
  planText,
  planUpscale,
  renderSize,
  targetLabel,
  upscaleEstimate,
  type Size,
} from '@/lib/upscale'
import { cn } from '@/lib/utils'
import { trackJobs } from '@/stores/toasts'
import { announce } from '@/stores/ui'

const ENGINE_COPY: Record<UpscaleEngineId, { name: string; blurb: string; icon: typeof Sparkles }> = {
  best: { name: 'Best', blurb: 'Sharpest detail and steady motion. The slowest.', icon: Sparkles },
  fast: { name: 'Fast', blurb: 'Good detail in a fraction of the time.', icon: Zap },
  quick: { name: 'Quick preview', blurb: 'Frame by frame. Fine for a first look.', icon: Gauge },
}

interface Props {
  render: Generation | null
  // absent for a standalone library video
  projectId?: string
  aspectRatio?: string
  initialEngine?: UpscaleEngineId
  onOpenChange: (open: boolean) => void
  onQueued?: (job: Job) => void
}

export function UpscaleDialog({ render, projectId, aspectRatio, initialEngine, onOpenChange, onQueued }: Props) {
  return (
    <Dialog open={!!render} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {render && (
          <UpscaleForm
            render={render}
            projectId={projectId}
            aspectRatio={aspectRatio}
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
  render,
  projectId,
  aspectRatio,
  initialEngine,
  onDone,
}: Omit<Props, 'onOpenChange' | 'render' | 'onQueued'> & { render: Generation; onDone: (job?: Job) => void }) {
  const ids = { engine: useId(), target: useId() }
  const options = useUpscaleOptions()
  const upscale = useUpscale(projectId)
  const info = renderInfo(render)
  const probed = useVideoSize(render.media_url, renderSize(render))
  const src: Size = probed ?? aspectSize(aspectRatio)

  const engines = options.data?.engines ?? []
  const [engineId, setEngineId] = useState<UpscaleEngineId | undefined>(initialEngine)
  const [target, setTarget] = useState<UpscaleTarget>()
  // a preselected engine that isn't installed falls back to the default
  const picked = engines.find((e) => e.id === engineId && e.available)
  const engine = picked ?? engines.find((e) => e.id === pickEngine(engines, options.data?.default_engine))
  const offered = (options.data?.targets ?? []).map((t) => (typeof t === 'string' ? t : t.id))
  const targets = TARGETS.filter((t) => !offered.length || offered.includes(t.id))
  const plans = targets.map((t) => ({ ...t, plan: planUpscale(src, t.id, engine?.scales ?? []) }))
  // keep the user's pick while it's possible; otherwise fall back to the first target that works
  const chosen = plans.find((p) => p.id === target && p.plan.ok) ?? plans.find((p) => p.plan.ok)
  const canSubmit = !!engine?.available && !!chosen && !upscale.isPending

  const submit = () => {
    if (!canSubmit || !engine || !chosen) return
    upscale.mutate(
      { id: render.id, body: { engine: engine.id, target: chosen.id } },
      {
        onSuccess: (job) => {
          trackJobs([job], `${info.title} at ${chosen.label}`)
          announce(`Upscaling ${info.title} to ${chosen.label}.`)
          onDone(job)
        },
      },
    )
  }

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
        <DialogTitle>Upscale “{info.title}”</DialogTitle>
        <DialogDescription>
          Makes a sharper, bigger copy as a new version. The original stays as it is, and the sound is kept untouched.
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
            onValueChange={(v) => setEngineId(v as UpscaleEngineId)}
            className="grid gap-2 sm:grid-cols-3"
          >
            {engines.map((e) => (
              <EngineCard key={e.id} engine={e} durationS={info.durationS} />
            ))}
          </RadioGroup.Root>
        )}
      </div>

      <div role="group" aria-labelledby={ids.target}>
        <div id={ids.target} className="section-label mb-2">
          Target size
        </div>
        <div className="flex flex-wrap gap-1">
          {plans.map((p) => (
            <Chip
              key={p.id}
              selected={chosen?.id === p.id}
              disabled={!p.plan.ok || !engine}
              aria-describedby={!p.plan.ok ? `${ids.target}-${p.id}` : undefined}
              onClick={() => setTarget(p.id)}
              className="h-8 px-3 text-body disabled:cursor-not-allowed disabled:opacity-50"
            >
              {p.label}
            </Chip>
          ))}
        </div>
        {engine &&
          plans
            .filter((p) => !p.plan.ok)
            .map((p) => (
              <p key={p.id} id={`${ids.target}-${p.id}`} className="mt-1 text-small text-studio-muted">
                {p.label}: {p.plan.reason}
              </p>
            ))}
      </div>

      {chosen && engine && (
        <div className="rounded-[6px] border border-studio-border bg-studio-raised px-3 py-2" aria-live="polite">
          <p className="font-mono text-small text-studio-text">{planText(src, chosen.plan)}</p>
          <p className="text-small text-studio-muted">
            {[upscaleEstimate(engine, info.durationS), probed ? null : 'size guessed from the project aspect'].filter(Boolean).join(' · ') ||
              'GPU time depends on the length'}
          </p>
        </div>
      )}

      {upscale.isError && <ErrorState compact title="Couldn't start the upscale" error={upscale.error} />}

      <DialogFooter className="mt-0">
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit} loading={upscale.isPending} aria-keyshortcuts="Control+Enter">
          Upscale{chosen ? ` to ${targetLabel(chosen.id)}` : ''}
          <Kbd>{modKey}+Enter</Kbd>
        </Button>
      </DialogFooter>
    </form>
  )
}

function EngineCard({ engine, durationS }: { engine: UpscaleEngine; durationS: number | null }) {
  const copy = ENGINE_COPY[engine.id] ?? { name: engine.label, blurb: '', icon: Sparkles }
  const est = upscaleEstimate(engine, durationS)
  return (
    <RadioGroup.Item
      value={engine.id}
      disabled={!engine.available}
      aria-labelledby={`eng-${engine.id}-title`}
      aria-describedby={`eng-${engine.id}-blurb`}
      className={cn(
        'flex flex-col items-start gap-1 rounded-[6px] border p-3 text-left transition-colors duration-150',
        'border-studio-border-strong bg-studio-raised hover:bg-studio-panel-hover',
        'data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70 data-[disabled]:hover:bg-studio-raised',
      )}
    >
      <span className="flex items-center gap-2">
        <copy.icon aria-hidden className="size-4 text-studio-accent-hover" />
        <span id={`eng-${engine.id}-title`} className="text-heading font-semibold">
          {copy.name}
        </span>
      </span>
      <span id={`eng-${engine.id}-blurb`} className="text-small text-studio-muted">
        {engine.available ? copy.blurb : `Unavailable: ${engine.reason || 'not installed on the server'}.`}
        {engine.available && est && <span className="block">{est}</span>}
      </span>
      <span className="font-mono text-[11px] text-studio-muted">
        {engine.label} · ×{engine.scales.join(' / ×')}
      </span>
    </RadioGroup.Item>
  )
}
