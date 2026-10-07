import { Inbox } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useJobs } from '@/hooks/useJobs'
import { isActiveJob } from '@/lib/status'
import { useUi } from '@/stores/ui'
import { JobRow } from './JobRow'

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
