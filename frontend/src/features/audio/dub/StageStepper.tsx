import { AlertTriangle, Check, Eye, Loader2 } from 'lucide-react'
import { currentStage, DUB_STAGES, STAGE_LABEL, type Dub, type StageStatus } from '@/lib/dub'
import { cn } from '@/lib/utils'

const SAY: Record<StageStatus, string> = { pending: 'to do', running: 'running', done: 'done', failed: 'failed', review: 'waiting for your review' }

export function StageStepper({ dub }: { dub: Dub }) {
  const here = currentStage(dub)
  return (
    <ol aria-label="Dub steps" className="flex items-center gap-0.5 overflow-x-auto pb-1">
      {DUB_STAGES.map((s, i) => {
        const st = dub.stages[s]?.status ?? 'pending'
        const pct = st === 'running' ? Math.round((dub.job?.progress ?? dub.stages[s]?.progress ?? 0) * 100) : null
        return (
          <li key={s} aria-current={s === here ? 'step' : undefined} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <span aria-hidden className={cn('h-px w-3 md:w-5', st === 'pending' ? 'bg-studio-border' : 'bg-studio-accent')} />}
            <span
              title={dub.stages[s]?.error ?? undefined}
              className={cn(
                'flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] font-medium',
                st === 'done' && 'border-studio-accent/60 text-studio-text',
                st === 'pending' && 'border-studio-border text-studio-muted',
                st === 'running' && 'border-studio-accent bg-studio-accent/10 text-studio-text',
                st === 'review' && 'border-studio-warning bg-studio-warning/10 text-studio-text',
                st === 'failed' && 'border-studio-danger bg-studio-danger/10 text-studio-danger',
                s === here && 'ring-1 ring-studio-accent',
              )}
            >
              {st === 'done' && <Check aria-hidden className="size-3 text-studio-accent" />}
              {st === 'running' && <Loader2 aria-hidden className="size-3 animate-spin" />}
              {st === 'review' && <Eye aria-hidden className="size-3 text-studio-warning" />}
              {st === 'failed' && <AlertTriangle aria-hidden className="size-3" />}
              {STAGE_LABEL[s]}
              {pct != null && <span className="font-mono text-studio-muted">{pct}%</span>}
              <span className="sr-only">: {SAY[st]}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
