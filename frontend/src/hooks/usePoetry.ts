import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { poetryApi, poetryBusy, type PoetryCreate, type PoetryShort, type Timing } from '@/lib/poetry'
import type { Job } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'

const POLL_MS = 2500

export const poetryKey = (id: string) => ['poetry', id] as const
const LIST = ['poetry', 'list'] as const

export function usePoetryList() {
  return useQuery({ queryKey: LIST, queryFn: poetryApi.list })
}

export function usePoetry(id: string | undefined) {
  return useQuery({
    queryKey: poetryKey(id ?? ''),
    queryFn: () => poetryApi.get(id!),
    enabled: !!id,
    refetchInterval: (q) => (poetryBusy(q.state.data) ? POLL_MS : false),
  })
}

function put(qc: QueryClient, ps: PoetryShort) {
  qc.setQueryData(poetryKey(ps.id), ps)
  qc.invalidateQueries({ queryKey: LIST })
}

function afterJob(qc: QueryClient, id: string, job: Job) {
  upsertJob(qc, job)
  qc.invalidateQueries({ queryKey: qk.jobs })
  qc.invalidateQueries({ queryKey: poetryKey(id) })
}

export function useCreatePoetry() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: PoetryCreate) => poetryApi.create(body), onSuccess: (ps) => put(qc, ps) })
}

export function useDeletePoetry() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (id: string) => poetryApi.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: LIST }) })
}

export function usePatchPoem(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: { lyrics: string; title?: string }) => poetryApi.patchPoem(id, body), onSuccess: (ps) => put(qc, ps) })
}

export function usePatchTimings(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (rows: Timing[]) => poetryApi.patchTimings(id, rows), onSuccess: (ps) => put(qc, ps) })
}

export function usePatchScenes(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (scenes: { id: string; image_prompt?: string; motion_prompt?: string }[]) => poetryApi.patchScenes(id, scenes),
    onSuccess: (ps) => put(qc, ps),
  })
}

export function useContinuePoetry(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => poetryApi.continue(id), onSuccess: (job) => afterJob(qc, id, job) })
}

export function useRegenerateScene(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ sceneId, ...body }: { sceneId: string; what: 'keyframe' | 'clip'; image_prompt?: string; motion_prompt?: string }) =>
      poetryApi.regenerateScene(id, sceneId, body),
    onSuccess: (ps) => {
      put(qc, ps)
      qc.invalidateQueries({ queryKey: qk.jobs })
    },
  })
}

export function useRegenerateSong(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => poetryApi.regenerateSong(id), onSuccess: (job) => afterJob(qc, id, job) })
}

export function useRenderPoetry(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => poetryApi.render(id), onSuccess: (job) => afterJob(qc, id, job) })
}
