import { Link } from 'react-router'
import { ArrowRight, Inbox } from 'lucide-react'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { useJobs } from '@/hooks/useJobs'
import { api } from '@/lib/api'
import { etaText, jobOpenPath } from '@/lib/jobs'
import type { RailItem } from '@/lib/nav'
import { isActiveJob, jobLabel } from '@/lib/status'
import type { Job } from '@/lib/types'
import { cn, timeAgo } from '@/lib/utils'
import { useMyJobs } from '@/stores/toasts'

const SHOWN = 6

function TrayRow({ job, to }: { job: Job; to: string }) {
  const running = job.status === 'running'
  return (
    <li className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border bg-studio-raised p-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-medium">{jobLabel(job.type)}</span>
        {job.lane === 'image' || job.lane === 'video' ? (
          <span className="shrink-0 rounded-[4px] border border-studio-border px-1 text-small text-studio-muted">
            {job.lane === 'image' ? 'Image GPU' : 'Video GPU'}
          </span>
        ) : null}
        {job.type === 'media_zip' && job.status === 'done' ? (
          // the finished zip is a file to save, not a page to open
          <a href={api.exportUrl(job.id)} download className="inline-flex items-center gap-0.5 rounded-[4px] px-1 text-small text-studio-accent-hover underline-offset-2 hover:underline">
            Download
            <span className="sr-only"> the zip</span>
          </a>
        ) : (
          <PopoverClose asChild>
            <Link to={to} className="inline-flex items-center gap-0.5 rounded-[4px] px-1 text-small text-studio-accent-hover underline-offset-2 hover:underline">
              Open
              <span className="sr-only"> {jobLabel(job.type)}</span>
            </Link>
          </PopoverClose>
        )}
      </div>
      {isActiveJob(job.status) ? (
        <>
          <Progress value={running ? job.progress : null} label={`${jobLabel(job.type)} progress`} />
          <p className="flex justify-between gap-2 text-small text-studio-muted">
            <span>{running ? `${Math.round(job.progress * 100)}%` : 'In the queue'}</span>
            <span>{etaText(job)}</span>
          </p>
        </>
      ) : (
        <p className={cn('text-small', job.status === 'failed' ? 'text-studio-danger' : 'text-studio-muted')}>
          {job.status === 'done' ? 'Finished' : job.status === 'failed' ? 'Failed' : 'Cancelled'} {timeAgo(job.finished_at ?? job.created_at)}
        </p>
      )}
    </li>
  )
}

/** The rail's Queue item: a count badge, and a mini list of what's running with Open links. */
export function JobsTray({ item, className, current }: { item: RailItem; className: string; current: boolean }) {
  const { data } = useJobs()
  const mine = useMyJobs((s) => s.jobs)
  const jobs = data ?? []
  const active = jobs.filter((j) => isActiveJob(j.status)).sort((a, b) => (a.status === b.status ? a.created_at.localeCompare(b.created_at) : a.status === 'running' ? -1 : 1))
  const running = active.filter((j) => j.status === 'running').length
  const waiting = active.length - running
  const finished = jobs.filter((j) => !isActiveJob(j.status) && mine[j.id]).slice(0, 3)
  const to = (j: Job) => mine[j.id]?.to ?? jobOpenPath(j)

  return (
    <Popover>
      <PopoverTrigger className={className} aria-label={`Queue, ${running} running${waiting ? `, ${waiting} waiting` : ''}`} aria-current={current ? 'page' : undefined}>
        <span className="relative">
          <item.icon aria-hidden className="size-5" />
          {active.length > 0 && (
            <span aria-hidden className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-studio-accent px-1 text-center font-mono text-[11px] leading-4 text-studio-accent-fg">
              {active.length}
            </span>
          )}
        </span>
        <span aria-hidden className="text-center text-small leading-[1.1]">
          {item.label}
        </span>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" aria-label="Background jobs" className="flex w-80 flex-col gap-2">
        <h2 className="font-display text-panel font-semibold">Background jobs</h2>
        <p className="-mt-1 text-small text-studio-muted">
          {running} running · {waiting} waiting. Keep working; you'll get a note when yours finish.
        </p>
        {active.length === 0 && finished.length === 0 ? (
          <p className="flex items-center gap-2 py-3 text-small text-studio-muted">
            <Inbox aria-hidden className="size-4" />
            Nothing running.
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto" aria-label="Jobs">
            {[...active.slice(0, SHOWN), ...finished].map((j) => (
              <TrayRow key={j.id} job={j} to={to(j)} />
            ))}
          </ul>
        )}
        {active.length > SHOWN && <p className="text-small text-studio-muted">and {active.length - SHOWN} more</p>}
        <PopoverClose asChild>
          <Link to="/queue" className="inline-flex items-center gap-1 self-end text-small font-medium text-studio-accent-hover underline-offset-2 hover:underline">
            Open the queue
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </PopoverClose>
      </PopoverContent>
    </Popover>
  )
}
