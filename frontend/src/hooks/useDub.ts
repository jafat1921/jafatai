import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dubBusy, transcriptBusy, type Dub, type DubCreate, type DubExportBody, type DubPatch } from '@/lib/dub'
import type { Job } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'

const POLL_MS = 1500

export function useDubs() {
  return useQuery({ queryKey: qk.dubs, queryFn: () => api.dubs.list(), refetchInterval: (q) => (q.state.data?.some((d) => dubBusy(d)) ? 4000 : false) })
}

export function useDub(id: string | undefined) {
  return useQuery({
    queryKey: qk.dub(id ?? ''),
    queryFn: () => api.dubs.get(id!),
    enabled: !!id,
    // a stage job hands on to the next one by itself; keep polling until the pipeline rests
    refetchInterval: (q) => (dubBusy(q.state.data) ? POLL_MS : false),
  })
}

const put = (qc: QueryClient, d: Dub) => {
  qc.setQueryData(qk.dub(d.id), d)
  qc.invalidateQueries({ queryKey: qk.dubs })
  if (d.job) upsertJob(qc, d.job)
}

export function useCreateDub() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: DubCreate) => api.dubs.create(body), onSuccess: (d) => put(qc, d) })
}

export function usePatchDub(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: DubPatch) => api.dubs.update(id, body), onSuccess: (d) => put(qc, d) })
}

export function useDeleteDub() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (id: string) => api.dubs.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: qk.dubs }) })
}

export function useContinueDub(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => api.dubs.continue(id), onSuccess: (d) => put(qc, d) })
}

export function useRegenDub(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: { lang: string; segment_ids?: string[] }) => api.dubs.regen(id, body), onSuccess: (d) => put(qc, d) })
}

export function useSplitSegment(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: { segment_id: string; at: number }) => api.dubs.split(id, body), onSuccess: (d) => put(qc, d) })
}

export function useMergeSegments(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (ids: string[]) => api.dubs.merge(id, ids), onSuccess: (d) => put(qc, d) })
}

function afterJob(qc: QueryClient, job: Job) {
  upsertJob(qc, job)
  qc.invalidateQueries({ queryKey: qk.jobs })
  qc.invalidateQueries({ queryKey: qk.mediaLists })
}

export function useExportDub(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: DubExportBody) => api.dubs.export(id, body), onSuccess: (res) => afterJob(qc, res.job) })
}

// ---------------------------------------------------------------- transcripts

export function useTranscripts() {
  return useQuery({ queryKey: qk.transcripts, queryFn: () => api.transcripts.list() })
}

export function useTranscript(id: string | null | undefined) {
  return useQuery({
    queryKey: qk.transcript(id ?? ''),
    queryFn: () => api.transcripts.get(id!),
    enabled: !!id,
    refetchInterval: (q) => (transcriptBusy(q.state.data) ? POLL_MS : false),
  })
}

export function useStartTranscribe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { media_id: string; language?: string; words?: boolean; cleanup?: boolean }) => api.transcripts.start(body),
    onSuccess: (res) => {
      upsertJob(qc, res.job)
      qc.invalidateQueries({ queryKey: qk.transcripts })
    },
  })
}

export function useCleanupTranscript(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.transcripts.cleanup(id),
    onSuccess: (job) => {
      upsertJob(qc, job)
      qc.invalidateQueries({ queryKey: qk.transcript(id) })
    },
  })
}

export function useSubtitleVideo(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: { mode: 'soft' | 'burn'; clean?: boolean }) => api.transcripts.video(id, body), onSuccess: (res) => afterJob(qc, res.job) })
}
