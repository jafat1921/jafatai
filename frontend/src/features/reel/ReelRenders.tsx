import { useState } from 'react'
import { Download, Film, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { ReviewBar } from '@/components/review/ReviewBar'
import { useGenerationActions } from '@/hooks/useGenerations'
import { useJob, useJobAction } from '@/hooks/useJobs'
import { useRenders } from '@/hooks/useReel'
import { generationStatus, isPendingGeneration } from '@/lib/status'
import type { Generation } from '@/lib/types'
import { cn, timeAgo } from '@/lib/utils'
import { announce } from '@/stores/ui'

export function DownloadButton({ render, size = 'sm' }: { render: Generation; size?: 'sm' | 'md' }) {
  if (!render.media_url || isPendingGeneration(render.status)) return null
  return (
    <Button asChild size={size} variant="secondary">
      <a href={render.media_url} download={`film-v${render.version}.mp4`}>
        <Download aria-hidden />
        Download
      </a>
    </Button>
  )
}

/** Assembled films, newest first. Approving one makes it the current cut (shown in Output). */
export function ReelRenders({ projectId, aspectClass, onReassemble }: { projectId: string; aspectClass: string; onReassemble?: () => void }) {
  const renders = useRenders(projectId)
  const actions = useGenerationActions()
  const cancel = useJobAction('cancel')
  const [viewId, setViewId] = useState<string>()
  const [versionsOpen, setVersionsOpen] = useState(false)
  const list = (renders.data ?? []).filter((r) => r.status !== 'rejected')
  const current = list.find((r) => r.id === viewId) ?? list.find((r) => r.status === 'approved') ?? list[0]
  const job = useJob(current?.job_id)

  if (renders.isPending) return <Skeleton className={cn('w-full', aspectClass)} />
  if (renders.isError) return <ErrorState compact title="Couldn't load renders" error={renders.error} onRetry={() => renders.refetch()} />
  if (!current) {
    return (
      <EmptyState icon={<Film />} title="No film assembled yet">
        Assemble a draft to get one MP4 of the whole film.
      </EmptyState>
    )
  }
  const pending = isPendingGeneration(current.status)
  const busy = actions.approve.isPending || actions.unapprove.isPending || actions.reject.isPending || actions.restore.isPending
  const err = [actions.approve, actions.unapprove, actions.reject, actions.restore].find((m) => m.isError)?.error

  return (
    <div className="flex flex-col gap-2">
      <div className={cn('darkroom relative w-full overflow-hidden rounded-[6px]', aspectClass)}>
        {current.media_url && !pending ? (
          <video key={current.id} src={current.media_url} controls playsInline preload="metadata" className="size-full object-contain" aria-label={`Film render, version ${current.version}`} />
        ) : (
          <span className="shimmer-dark flex size-full items-center justify-center">
            <Loader2 aria-hidden className="size-6 animate-spin text-studio-on-dark-muted" />
          </span>
        )}
      </div>
      <ReviewBar
        status={current.status}
        version={current.version}
        versionCount={list.length}
        progress={job?.progress}
        error={job?.error}
        busy={busy}
        versionsOpen={versionsOpen}
        onApprove={() => actions.approve.mutate(current.id, { onSuccess: () => announce(`Render v${current.version} is now the current cut.`) })}
        onUnapprove={() => actions.unapprove.mutate(current.id)}
        onRegenerate={() => onReassemble?.()}
        onReject={() => actions.reject.mutate(current.id, { onSuccess: () => setViewId(undefined) })}
        onRestore={() => actions.restore.mutate(current.id)}
        onToggleVersions={() => setVersionsOpen((v) => !v)}
        onCancel={current.job_id ? () => cancel.mutate(current.job_id!) : undefined}
      />
      <div className="flex flex-wrap items-center gap-2">
        <DownloadButton render={current} />
        {current.status === 'approved' && <span className="text-small text-studio-muted">Current cut</span>}
      </div>
      {err && <ErrorState compact title="That didn't work" error={err} />}
      {versionsOpen && (
        <ol aria-label="Film renders" className="flex flex-col gap-1">
          {list.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                aria-pressed={r.id === current.id}
                onClick={() => setViewId(r.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[6px] border px-2 py-1 text-left text-small',
                  r.id === current.id ? 'border-studio-accent bg-studio-accent-soft' : 'border-studio-border hover:bg-studio-panel-hover',
                )}
              >
                <span className="font-mono">v{r.version}</span>
                <span className="flex-1 text-studio-muted">{timeAgo(r.created_at)}</span>
                <StatusPill status={generationStatus(r.status)} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
