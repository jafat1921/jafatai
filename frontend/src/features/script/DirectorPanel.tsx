import { useState } from 'react'
import { Brain, ChevronRight, Clapperboard, Loader2, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useAiJob } from '@/hooks/useAi'
import { useJobAction } from '@/hooks/useJobs'
import { api } from '@/lib/api'
import type { Job } from '@/lib/types'
import { cn } from '@/lib/utils'

const active = (j?: Job) => j?.status === 'queued' || j?.status === 'running'

function liveMessage(job: Job) {
  if (job.status === 'queued') return 'Waiting for a worker to pick this up…'
  return job.message || 'Working…'
}

export function DirectorsReasoning({ thinking, defaultOpen = false }: { thinking?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!thinking) return null
  return (
    <div className="rounded-[6px] border border-studio-border bg-studio-raised">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-body font-medium"
      >
        <ChevronRight aria-hidden className={cn('size-4 transition-transform duration-150', open && 'rotate-90')} />
        <Brain aria-hidden className="size-4 text-studio-accent" />
        Director&apos;s reasoning
        <span className="ml-auto text-small font-normal text-studio-muted">{thinking.split(/\s+/).length} words</span>
      </button>
      {open && (
        <div className="max-h-80 overflow-y-auto whitespace-pre-wrap border-t border-studio-border px-4 py-3 text-small leading-5 text-studio-muted">
          {thinking}
        </div>
      )}
    </div>
  )
}

/** Big empty-state version: no scenes yet, the outline is being written (or hasn't started). */
export function DirectorEmptyState({ projectId, job }: { projectId: string; job?: Job }) {
  const start = useAiJob(() => api.ai.outline(projectId))
  const retry = useJobAction('retry')
  const current = start.job ?? job

  if (current && active(current)) {
    return (
      <div className="mx-auto flex h-full max-w-xl flex-col justify-center gap-4 px-6 py-10">
        <EmptyState icon={<Clapperboard />} title="The AI Director is outlining your film…">
          Scenes appear in the list as they are written. You can leave this page; the work carries on.
        </EmptyState>
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <p className="inline-flex items-center gap-2 text-body">
            <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-studio-accent" />
            {liveMessage(current)}
          </p>
          <Progress value={current.status === 'running' ? current.progress : null} label="Outline progress" />
        </div>
        <DirectorsReasoning thinking={current.result?.thinking} />
      </div>
    )
  }

  if (current?.status === 'failed') {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3 p-8">
        <ErrorState
          title="The AI Director couldn't finish the outline"
          error={current.error}
          onRetry={() => retry.mutate(current.id)}
        />
        <DirectorsReasoning thinking={current.result?.thinking} />
      </div>
    )
  }

  return (
    <EmptyState
      className="h-full"
      icon={<Sparkles />}
      title="Let the AI Director outline your film"
      action={
        <Button variant="primary" onClick={() => start.run(undefined)} loading={start.working}>
          <Sparkles aria-hidden />
          Start the outline
        </Button>
      }
    >
      It plans the scenes from your brief and runtime, drafts each one, and describes the cast. Every scene stays yours
      to rewrite.
      {start.error ? <span className="mt-2 block text-studio-danger">{(start.error as Error).message}</span> : null}
    </EmptyState>
  )
}

/** Slim banner above the editor while scenes exist: progress, then the reasoning after it's done. */
export function DirectorBanner({ job }: { job: Job }) {
  const [hidden, setHidden] = useState(false)
  const retry = useJobAction('retry')
  if (hidden) return null
  const running = active(job)

  return (
    <div className="flex flex-col gap-2 border-b border-studio-border bg-studio-panel px-5 py-2.5">
      <div className="flex items-center gap-2 text-small">
        {running ? (
          <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-studio-accent" />
        ) : (
          <Sparkles aria-hidden className="size-3.5 shrink-0 text-studio-accent" />
        )}
        <span role="status" className="min-w-0 flex-1 truncate">
          {running
            ? `AI Director: ${liveMessage(job)}`
            : job.status === 'failed'
              ? `AI Director stopped: ${job.error ?? 'unknown error'}`
              : `AI Director drafted ${job.result?.drafted_ids?.length ?? 0} scenes.`}
        </span>
        {job.status === 'failed' && (
          <Button size="sm" variant="secondary" onClick={() => retry.mutate(job.id)} loading={retry.isPending}>
            Retry
          </Button>
        )}
        {!running && (
          <Button size="icon-sm" variant="ghost" aria-label="Hide the AI Director banner" onClick={() => setHidden(true)}>
            <X aria-hidden />
          </Button>
        )}
      </div>
      {running && <Progress value={job.status === 'running' ? job.progress : null} label="Outline progress" />}
      <DirectorsReasoning thinking={job.result?.thinking} />
    </div>
  )
}
