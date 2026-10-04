import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { applyClipPatch, moveClip, patchReelClip } from '@/lib/reel'
import type { Generation, Job, Reel, ReelClipPatch } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'

export function useReel(projectId: string) {
  return useQuery({ queryKey: qk.reel(projectId), queryFn: () => api.reel.get(projectId), enabled: !!projectId })
}

export function useRenders(projectId: string) {
  return useQuery({ queryKey: qk.renders(projectId), queryFn: () => api.reel.renders(projectId), enabled: !!projectId })
}

export function useReelEstimate(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.reelEstimate(projectId),
    queryFn: () => api.reel.estimate(projectId),
    enabled: enabled && !!projectId,
    retry: false,
    staleTime: 0,
  })
}

export const setReel = (qc: QueryClient, reel: Reel) => qc.setQueryData(qk.reel(reel.project_id), reel)

/** Renders list mirrors the server's "one approved render = the current cut" rule, newest first. */
export function upsertRender(qc: QueryClient, gen: Generation) {
  if (gen.kind !== 'render') return
  qc.setQueryData<Generation[]>(qk.renders(gen.target_id), (old) => {
    if (!old) return old
    let list = old.filter((g) => g.id !== gen.id)
    if (gen.status === 'approved') list = list.map((g) => (g.status === 'approved' ? { ...g, status: 'ready' as const } : g))
    return [gen, ...list].sort((a, b) => b.version - a.version || b.created_at.localeCompare(a.created_at))
  })
}

const REEL_JOB = /reel|assemble|mezzanine/

/** Assembly finishing creates a render the list hasn't seen; refetch once it lands. */
export function syncReelJob(qc: QueryClient, job: Job, before: Job | undefined) {
  if (!job.project_id || !REEL_JOB.test(job.type)) return
  if (job.status === before?.status) return
  if (job.status === 'done' || job.status === 'failed') {
    qc.invalidateQueries({ queryKey: qk.renders(job.project_id) })
    qc.invalidateQueries({ queryKey: qk.reel(job.project_id) })
  }
}

export function useSyncReel(projectId: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => api.reel.sync(projectId), onSuccess: (reel) => setReel(qc, reel) })
}

export function useUpdateClip(projectId: string) {
  const qc = useQueryClient()
  const key = qk.reel(projectId)
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ReelClipPatch }) => api.reel.updateClip(id, patch),
    // trims and transitions should feel instant; the server's `reel` event settles mezzanine status
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<Reel>(key)
      if (prev) qc.setQueryData(key, patchReelClip(prev, id, (c) => applyClipPatch(c, patch)))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
    },
    onSuccess: (clip) => {
      const cur = qc.getQueryData<Reel>(key)
      if (cur) qc.setQueryData(key, patchReelClip(cur, clip.id, (c) => ({ ...c, ...clip })))
    },
  })
}

export function useMoveClip(projectId: string) {
  const qc = useQueryClient()
  const key = qk.reel(projectId)
  return useMutation({
    mutationFn: ({ ids }: { clipId: string; dir: -1 | 1; ids: string[] }) => api.reel.reorder(projectId, ids),
    onMutate: async ({ clipId, dir }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<Reel>(key)
      const moved = prev && moveClip(prev, clipId, dir)
      if (moved) qc.setQueryData(key, moved.reel)
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
    },
    onSuccess: (reel) => setReel(qc, reel),
  })
}

export function useAssemble(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (sceneIds?: string[]) => api.reel.assemble(projectId, sceneIds),
    onSuccess: (job) => {
      upsertJob(qc, job)
      qc.invalidateQueries({ queryKey: qk.reel(projectId) })
    },
  })
}
