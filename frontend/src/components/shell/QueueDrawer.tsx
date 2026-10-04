import { Inbox, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { useJobAction, useJobs } from '@/hooks/useJobs'
import { isActiveJob, jobLabel, jobStatus } from '@/lib/status'
import type { Job } from '@/lib/types'
import { timeAgo } from '@/lib/utils'
import { useUi } from '@/stores/ui'

function JobRow({ job }: { job: Job }) {
  const cancel = useJobAction('cancel')
  const retry = useJobAction('retry')
  const active = isActiveJob(job.status)
  const status = jobStatus(job.status, job.status === 'running' ? job.progress : undefined)

  return (
    <li className="flex flex-col gap-2 rounded-[6px] border border-studio-border bg-studio-raised p-2.5 shadow-card">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-medium">{jobLabel(job.type)}</span>
        <StatusPill status={status} />
      </div>
      {job.status === 'running' && <Progress value={job.progress} label={`${jobLabel(job.type)} progress`} />}
      {job.status === 'queued' && <Progress value={null} label={`${jobLabel(job.type)} waiting`} />}
      <div className="flex items-center gap-2 text-small text-studio-muted">
        <span className="min-w-0 flex-1 truncate" title={job.error || job.message}>
          {job.status === 'failed' && job.error
            ? job.error
            : job.message && job.message.toLowerCase() !== status.label.toLowerCase()
              ? job.message
              : timeAgo(job.finished_at ?? job.created_at)}
        </span>
        {job.gpu && <span className="font-mono">{job.gpu}</span>}
        {/* TODO: real ETA once the worker reports throughput; placeholder keeps the layout stable */}
        {active && <span className="font-mono">ETA —</span>}
        {job.gpu_seconds != null && !active && <span className="font-mono">{Math.round(job.gpu_seconds)}s GPU</span>}
      </div>
      {(active || job.status === 'failed' || job.status === 'cancelled') && (
        <div className="flex justify-end gap-1">
          {active ? (
            <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
              <X aria-hidden />
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="secondary" loading={retry.isPending} onClick={() => retry.mutate(job.id)}>
              <RotateCcw aria-hidden />
              Retry
            </Button>
          )}
        </div>
      )}
      {(cancel.isError || retry.isError) && (
        <p className="text-small text-studio-danger" role="alert">
          {(cancel.error ?? retry.error)?.message}
        </p>
      )}
    </li>
  )
}

export function QueueDrawer() {
  const open = useUi((s) => s.queueOpen)
  const setOpen = useUi((s) => s.setQueueOpen)
  const jobs = useJobs()

  const list = jobs.data ?? []
  const active = list.filter((j) => isActiveJob(j.status))
  const recent = list.filter((j) => !isActiveJob(j.status)).slice(0, 30)
  const running = active.filter((j) => j.status === 'running').length

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent aria-describedby="queue-summary">
        <div className="border-b border-studio-border px-4 py-3.5">
          <SheetTitle className="font-display text-panel font-semibold">Queue</SheetTitle>
          <SheetDescription id="queue-summary" className="text-small text-studio-muted">
            {running} running · {active.length - running} waiting
          </SheetDescription>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 p-3">
            {jobs.isPending && [0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
            {jobs.isError && <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />}
            {jobs.isSuccess && list.length === 0 && (
              <EmptyState icon={<Inbox />} title="Nothing in the queue">
                Generations and renders show up here while they run.
              </EmptyState>
            )}
            {active.length > 0 && (
              <section aria-label="Active jobs">
                <h3 className="section-label mb-2">Active ({active.length})</h3>
                <ul className="flex flex-col gap-2">
                  {active.map((j) => (
                    <JobRow key={j.id} job={j} />
                  ))}
                </ul>
              </section>
            )}
            {recent.length > 0 && (
              <section aria-label="Recent jobs">
                <h3 className="section-label mb-2">Recent</h3>
                <ul className="flex flex-col gap-2">
                  {recent.map((j) => (
                    <JobRow key={j.id} job={j} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
