import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { AlertTriangle, Ban, Clock, PenLine, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/studio/states'
import { useJobAction } from '@/hooks/useJobs'
import { useProject } from '@/hooks/useProjects'
import { usePreviewGenerations, useQuickJob } from '@/hooks/useQuick'
import { formatDuration } from '@/lib/duration'
import { currentStage, etaText, hasStarted, quickResult, readStages } from '@/lib/quick'
import type { Job } from '@/lib/types'
import { announce } from '@/stores/ui'
import { PreviewTiles } from './PreviewTiles'
import { QuickDone } from './QuickDone'
import { StageTimeline } from './StageTimeline'

export function QuickProgressPage() {
  const { quickId = '' } = useParams()
  const project = useProject(quickId)
  const { job, isPending, isError, error, refetch } = useQuickJob(quickId)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // land focus on the title after Create so keyboard and screen-reader users start here
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const title = project.data?.title ?? 'Your video'
  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="quick-title">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 md:px-8">
        <header className="flex flex-col gap-1">
          <Link to="/projects" className="self-start text-small text-studio-muted hover:text-studio-text">
            ← All projects
          </Link>
          <h1 id="quick-title" ref={headingRef} tabIndex={-1} className="font-display text-title font-semibold focus-visible:outline-none">
            {title}
          </h1>
          {project.data && (
            <p className="text-small text-studio-muted">
              Quick video · {formatDuration(project.data.target_runtime_s)} · {project.data.aspect_ratio}
            </p>
          )}
        </header>

        {project.isError && <ErrorState title="Couldn't load this video" error={project.error} onRetry={() => project.refetch()} />}
        {isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : isError ? (
          <ErrorState title="Couldn't load the progress" error={error} onRetry={() => refetch()} />
        ) : !job ? (
          <NoAutopilot projectId={quickId} />
        ) : job.status === 'done' && project.data ? (
          <QuickDone project={project.data} job={job} />
        ) : (
          <Running projectId={quickId} job={job} />
        )}
      </div>
    </main>
  )
}

function Running({ projectId, job }: { projectId: string; job: Job }) {
  const stages = readStages(job)
  const current = currentStage(stages)
  const result = quickResult(job)
  const previews = usePreviewGenerations(projectId, result.preview_ids ?? [])
  const cancel = useJobAction('cancel')
  const retry = useJobAction('retry')
  const [confirming, setConfirming] = useState(false)
  const failed = job.status === 'failed'
  const cancelled = job.status === 'cancelled'
  const failedStage = stages.find((s) => s.status === 'failed')

  // say each new stage once; the timeline itself isn't a live region (it changes too often)
  const spoken = useRef<string | undefined>(undefined)
  const stageLabel = current?.label
  const failedLabel = failedStage?.label
  useEffect(() => {
    const key = `${job.status}:${stageLabel}`
    if (spoken.current === key) return
    const first = spoken.current === undefined
    spoken.current = key
    if (first) return
    if (job.status === 'failed') announce(`Stopped at ${failedLabel ?? 'a step'}.`)
    else if (job.status === 'running' && stageLabel) announce(`${stageLabel} started.`)
  }, [job.status, stageLabel, failedLabel])

  return (
    <div className="flex flex-col gap-5">
      <StageTimeline stages={stages} />

      {failed || cancelled ? (
        <div role="alert" className="flex flex-col gap-2 rounded-[6px] border border-studio-danger/40 bg-studio-danger/5 p-3">
          <p className="flex items-center gap-2 text-body font-medium">
            {failed ? <AlertTriangle aria-hidden className="size-4 text-studio-danger" /> : <Ban aria-hidden className="size-4" />}
            {failed ? `Stopped at ${failedStage?.label ?? 'a step'}` : 'Cancelled'}
          </p>
          <p className="text-small text-studio-muted">
            {failed
              ? job.error || failedStage?.detail || 'Something went wrong on the server.'
              : 'Nothing more will be made.'}{' '}
            Retry carries on from {failedStage ? `“${failedStage.label}”` : 'where it stopped'}; finished steps aren't redone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={retry.isPending}
              onClick={() => retry.mutate(job.id, { onSuccess: () => announce('Carrying on.') })}
            >
              <RotateCcw aria-hidden />
              {failed ? 'Retry' : 'Resume'}
            </Button>
            <Button asChild variant="secondary">
              <Link to={`/projects/${projectId}/script`}>
                <PenLine aria-hidden />
                Open in Studio
              </Link>
            </Button>
          </div>
          {retry.isError && <ErrorState compact title="Couldn't retry" error={retry.error} />}
        </div>
      ) : (
        <section aria-labelledby="quick-now" className="flex flex-col gap-2 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3">
          <h2 id="quick-now" className="font-display text-panel font-semibold">
            {job.status === 'queued' && !hasStarted(job) ? 'Waiting for the GPU' : (current?.label ?? 'Working')}
          </h2>
          <p className="text-body text-studio-muted">{job.message || current?.detail || 'Getting started…'}</p>
          <Progress value={job.status === 'running' ? job.progress : null} label="Overall progress" />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex items-center gap-1.5 text-small text-studio-muted">
              <Clock aria-hidden className="size-3.5" />
              {etaText(result.eta_s)}
            </span>
            <span className="text-small text-studio-muted">You can close this page — we'll keep working.</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirming(true)} disabled={cancel.isPending}>
              <X aria-hidden />
              Cancel
            </Button>
          </div>
          {cancel.isError && <ErrorState compact title="Couldn't cancel" error={cancel.error} />}
        </section>
      )}

      <section aria-labelledby="quick-previews" className="flex flex-col gap-2">
        <h2 id="quick-previews" className="section-label">
          Made so far
        </h2>
        <PreviewTiles items={previews} />
      </section>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Cancel this video?"
        description="Work already finished is kept, and you can resume later from where it stopped."
        confirmLabel="Cancel video"
        tone="danger"
        onConfirm={() => cancel.mutate(job.id, { onSuccess: () => announce('Cancelled.') })}
      />
    </div>
  )
}

function NoAutopilot({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3">
      <p className="text-body">This project has no quick-create run. It may have been made in the Studio.</p>
      <Button asChild variant="primary">
        <Link to={`/projects/${projectId}/script`}>Open in Studio</Link>
      </Button>
    </div>
  )
}
