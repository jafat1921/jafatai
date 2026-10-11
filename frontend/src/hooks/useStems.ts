import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { StemsMode } from '@/lib/stems'
import { qk } from './keys'
import { upsertJob } from './useJobs'

const POLL_MS = 1500

/** The splits made from one track, polled while one of them is still running. */
export function useStems(id: string | null | undefined) {
  return useQuery({
    queryKey: qk.stems(id ?? ''),
    queryFn: () => api.audio.stemsOf(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.jobs.length ? POLL_MS : false),
  })
}

export function useSplitStems(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { mode: StemsMode; version?: string }) => api.audio.stems(id, body),
    onSuccess: (res) => {
      upsertJob(qc, res.job)
      qc.invalidateQueries({ queryKey: qk.stems(id) })
      qc.invalidateQueries({ queryKey: qk.mediaLists })
    },
  })
}
