import { AlertTriangle, Check, Circle, Loader2, MinusCircle } from 'lucide-react'
import type { QuickStage, QuickStageStatus } from '@/lib/types'
import { formatEstimate } from '@/lib/shots'
import { cn } from '@/lib/utils'

const VIEW: Record<QuickStageStatus, { text: string; icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  pending: { text: 'Waiting', icon: Circle, cls: 'border-studio-border-strong text-studio-muted' },
  running: { text: 'In progress', icon: Loader2, cls: 'border-studio-accent bg-studio-accent-soft text-studio-accent-hover' },
  done: { text: 'Done', icon: Check, cls: 'border-studio-success/60 text-studio-success' },
  failed: { text: 'Failed', icon: AlertTriangle, cls: 'border-studio-danger bg-studio-danger/10 text-studio-danger' },
  skipped: { text: 'Skipped', icon: MinusCircle, cls: 'border-studio-border text-studio-muted opacity-70' },
}

function took(s: QuickStage) {
  if (s.status !== 'done' || !s.started_at || !s.finished_at) return null
  const secs = (new Date(s.finished_at).getTime() - new Date(s.started_at).getTime()) / 1000
  return Number.isFinite(secs) && secs > 0 ? formatEstimate(secs) : null
}

/** Writing → Cast → … → Upscaling. Each step says its state in words, not just colour. */
export function StageTimeline({ stages }: { stages: QuickStage[] }) {
  return (
    <ol aria-label="Progress" className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {stages.map((s, i) => {
        const v = VIEW[s.status] ?? VIEW.pending
        const time = took(s)
        return (
          <li
            key={s.key}
            aria-current={s.status === 'running' ? 'step' : undefined}
            className={cn('flex items-center gap-2 rounded-[6px] border px-2.5 py-2', v.cls)}
          >
            <v.icon aria-hidden className={cn('size-4 shrink-0', s.status === 'running' && 'animate-spin')} />
            <span className="flex min-w-0 flex-col">
              <span className="text-body font-medium text-studio-text">
                <span className="sr-only">Step {i + 1}: </span>
                {s.label}
              </span>
              <span className="text-small">
                {v.text}
                {time && <span className="text-studio-muted"> · {time}</span>}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
