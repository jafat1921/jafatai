import { useMemo, useState } from 'react'
import { Inbox, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Chip } from '@/components/studio/chip'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { JobRow } from '@/components/shell/JobRow'
import { TopBarActions } from '@/components/shell/TopBarActions'
import { useJobs } from '@/hooks/useJobs'
import { isActiveJob } from '@/lib/status'
import type { Job } from '@/lib/types'

type Filter = 'active' | 'failed' | 'done' | 'all'

const FILTERS: { value: Filter; label: string; test: (j: Job) => boolean }[] = [
  { value: 'active', label: 'Running & waiting', test: (j) => isActiveJob(j.status) },
  { value: 'failed', label: 'Failed', test: (j) => j.status === 'failed' },
  { value: 'done', label: 'Finished', test: (j) => j.status === 'done' || j.status === 'cancelled' },
  { value: 'all', label: 'Everything', test: () => true },
]

// One lane per GPU; jobs still waiting for a GPU sit in their own lane.
function lanes(list: Job[]) {
  const by = new Map<string, Job[]>()
  for (const j of list) {
    const key = j.gpu || (j.status === 'queued' ? 'Waiting for a GPU' : 'No GPU')
    by.set(key, [...(by.get(key) ?? []), j])
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export function QueuePage() {
  const jobs = useJobs()
  const [filter, setFilter] = useState<Filter>('active')
  const list = useMemo(() => jobs.data ?? [], [jobs.data])
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.value, list.filter(f.test).length])) as Record<Filter, number>, [list])
  const visible = list.filter(FILTERS.find((f) => f.value === filter)!.test)
  const running = list.filter((j) => j.status === 'running').length

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="queue-title">
      <TopBarActions>
        <Button size="sm" variant="secondary" onClick={() => jobs.refetch()} loading={jobs.isFetching}>
          <RotateCcw aria-hidden />
          Refresh
        </Button>
      </TopBarActions>
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6 md:px-8">
        <div>
          <h1 id="queue-title" className="font-display text-title font-semibold">
            Queue
          </h1>
          <p className="text-body text-studio-muted" aria-live="polite">
            {running} running · {counts.active - running} waiting · updates live
          </p>
        </div>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Chip key={f.value} selected={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label} ({counts[f.value]})
            </Chip>
          ))}
        </div>

        {jobs.isPending && [0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
        {jobs.isError && <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />}
        {jobs.isSuccess && visible.length === 0 && (
          <EmptyState icon={<Inbox />} title={filter === 'active' ? 'Nothing running' : 'Nothing here'}>
            {filter === 'active' ? 'Generations, renders and upscales show up here while they run.' : 'Try another filter.'}
          </EmptyState>
        )}
        {visible.length > 0 &&
          (filter === 'active' ? (
            lanes(visible).map(([lane, items]) => (
              <section key={lane} aria-label={lane}>
                <h2 className="section-label mb-2 font-mono">
                  {lane} ({items.length})
                </h2>
                <ul className="flex flex-col gap-2">
                  {items.map((j) => (
                    <JobRow key={j.id} job={j} />
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Jobs">
              {visible.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </ul>
          ))}
      </div>
    </main>
  )
}
