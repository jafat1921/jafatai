import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Job } from '@/lib/types'
import { qk } from './keys'

export function useJobs() {
  return useQuery({
    queryKey: qk.jobs,
    queryFn: () => api.jobs.list(),
    // SSE keeps this fresh; the slow poll only covers a dropped stream
    refetchInterval: 60_000,
  })
}

export function useJob(id: string | null | undefined) {
  const { data } = useJobs()
  return id ? data?.find((j) => j.id === id) : undefined
}

export function upsertJob(qc: QueryClient, job: Job) {
  qc.setQueryData<Job[]>(qk.jobs, (old) => {
    if (!old) return [job]
    const i = old.findIndex((j) => j.id === job.id)
    if (i === -1) return [job, ...old].slice(0, 100)
    const next = old.slice()
    next[i] = job
    return next
  })
}

export function useJobAction(action: 'cancel' | 'retry') {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => (action === 'cancel' ? api.jobs.cancel(id) : api.jobs.retry(id)),
    onSuccess: (job) => upsertJob(qc, job),
  })
}
