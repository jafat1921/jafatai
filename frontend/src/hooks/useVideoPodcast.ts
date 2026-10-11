import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { busy } from '@/lib/podcast'
import type { Generation, Job, VideoPodcast, VideoPodcastPatch, VPQuality, VPRegenerate } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'

const POLL_MS = 2000

const making = (g: Generation | null | undefined) => g?.status === 'queued' || g?.status === 'generating'

// the orchestrator job, or any portrait / frame / track take still on its way (regenerate starts plain generate jobs)
export function aiVideoBusy(vp: VideoPodcast | null | undefined) {
  if (!vp) return false
  if (vp.status === 'running' || busy(vp.job)) return true
  if (vp.hosts.some((h) => making(h.portrait))) return true
  if (making(vp.set.establishing) || vp.angles.some((a) => making(a.frame))) return true
  return vp.plan.tracks.some((t) => making(t.takes.draft) || making(t.takes.final))
}

// the pipeline job itself: actions that change the record wait for it (the server answers 409)
export const jobRunning = (vp: VideoPodcast) => vp.status === 'running' || busy(vp.job)

export function useEpisodeAiVideo(episodeId: string | undefined) {
  return useQuery({
    queryKey: qk.episodeAiVideo(episodeId ?? ''),
    // 404 just means there isn't one yet
    queryFn: () =>
      api.aiVideo.getEpisodeAiVideo(episodeId!).catch((e) => {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }),
    enabled: !!episodeId,
  })
}

export function useAiVideo(id: string | undefined) {
  return useQuery({
    queryKey: qk.aiVideo(id ?? ''),
    queryFn: () => api.aiVideo.getAiVideo(id!),
    enabled: !!id,
    refetchInterval: (q) => (aiVideoBusy(q.state.data) ? POLL_MS : false),
  })
}

function put(qc: QueryClient, vp: VideoPodcast) {
  qc.setQueryData(qk.aiVideo(vp.id), vp)
  qc.setQueryData(qk.episodeAiVideo(vp.episode_id), vp)
  // estimate and characters hang off the same prefix
  qc.invalidateQueries({ queryKey: qk.aiVideo(vp.id), predicate: (q) => q.queryKey.length > 3 })
}

const isRecord = (r: unknown): r is VideoPodcast => !!r && typeof r === 'object' && 'plan' in r && 'stages' in r

function refresh(qc: QueryClient, id: string, res?: unknown) {
  if (isRecord(res)) return put(qc, res)
  qc.invalidateQueries({ queryKey: qk.aiVideo(id) })
}

function afterJob(qc: QueryClient, id: string, job: Job) {
  upsertJob(qc, job)
  qc.invalidateQueries({ queryKey: qk.jobs })
  qc.invalidateQueries({ queryKey: qk.aiVideo(id) })
}

export function useCreateAiVideo(episodeId: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: { aspect?: string } = {}) => api.aiVideo.createEpisodeAiVideo(episodeId, body), onSuccess: (vp) => put(qc, vp) })
}

export function usePatchAiVideo(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: VideoPodcastPatch) => api.aiVideo.patchAiVideo(id, body), onSuccess: (vp) => put(qc, vp) })
}

export function useContinueAiVideo(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => api.aiVideo.continueAiVideo(id), onSuccess: (job) => afterJob(qc, id, job) })
}

export function useRegenerateAiVideo(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: VPRegenerate) => api.aiVideo.regenerateAiVideo(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.jobs })
      qc.invalidateQueries({ queryKey: qk.aiVideo(id) })
    },
  })
}

export function useApproveAiVideoGeneration(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (generationId: string) => api.generations.approve(generationId), onSuccess: () => refresh(qc, id) })
}

export function useAiVideoCharacters(id: string, enabled: boolean) {
  return useQuery({ queryKey: qk.aiVideoCharacters(id), queryFn: () => api.aiVideo.aiVideoCharacters(id), enabled })
}

export function useReplanAiVideo(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => api.aiVideo.replanAiVideo(id), onSuccess: (r) => refresh(qc, id, r) })
}

export function useSwitchAiVideoCut(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: { at: number; camera: string }) => api.aiVideo.switchAiVideoCut(id, body), onSuccess: (r) => refresh(qc, id, r) })
}

export function usePatchAiVideoCut(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ cutId, camera }: { cutId: string; camera: string }) => api.aiVideo.patchAiVideoCut(id, cutId, { camera }),
    onSuccess: (r) => refresh(qc, id, r),
  })
}

export function useDeleteAiVideoCut(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (cutId: string) => api.aiVideo.deleteAiVideoCut(id, cutId), onSuccess: (r) => refresh(qc, id, r) })
}

export function useAiVideoEstimate(id: string, quality: VPQuality, trackIds?: string[]) {
  const tracks = trackIds?.join(',') ?? ''
  return useQuery({ queryKey: qk.aiVideoEstimate(id, quality, tracks), queryFn: () => api.aiVideo.aiVideoEstimate(id, quality, trackIds) })
}

export type VPRenderBody = { quality: VPQuality; track_ids?: string[]; from_piece?: number }

export function useRenderAiVideo(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (body: VPRenderBody) => api.aiVideo.renderAiVideo(id, body), onSuccess: (job) => afterJob(qc, id, job) })
}

export function useAssembleAiVideo(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (quality: VPQuality) => api.aiVideo.assembleAiVideo(id, quality), onSuccess: (job) => afterJob(qc, id, job) })
}

export function useDeleteAiVideo(id: string, episodeId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.aiVideo.deleteAiVideo(id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.aiVideo(id) })
      qc.setQueryData(qk.episodeAiVideo(episodeId), null)
    },
  })
}
