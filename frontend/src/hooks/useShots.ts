import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Generation, Shot, ShotPatch, ShotType } from '@/lib/types'
import { qk } from './keys'

export function useProjectShots(projectId: string) {
  return useQuery({ queryKey: qk.shots(projectId), queryFn: () => api.shots.list(projectId), enabled: !!projectId })
}

const allShotLists = { queryKey: ['shots'] }

export function upsertShot(qc: QueryClient, shot: Shot) {
  qc.setQueryData<Shot[]>(qk.shots(shot.project_id), (old) => {
    if (!old) return old
    return old.some((s) => s.id === shot.id) ? old.map((s) => (s.id === shot.id ? shot : s)) : [...old, shot]
  })
}

type FrameField = 'start_frame' | 'end_frame'

// Mirrors "current = approved, else newest" so cards update before the server's `shot` event arrives.
// Returns undefined when we can't know the fallback (the current one was rejected) and need a refetch.
export function nextCurrent(cur: Generation | null | undefined, gen: Generation): Generation | null | undefined {
  if (cur?.id === gen.id) return gen.status === 'rejected' ? undefined : gen
  if (gen.status === 'rejected') return cur
  if (gen.status === 'approved') return gen
  if (cur?.status === 'approved') return cur
  if (!cur || gen.version >= cur.version) return gen
  return cur
}

export function patchShotsFromGeneration(qc: QueryClient, gen: Generation) {
  if (gen.target_type !== 'shot') return
  let refetch = false
  qc.setQueriesData<Shot[]>(allShotLists, (old) =>
    old?.map((s) => {
      if (s.id !== gen.target_id) return s
      if (gen.kind === 'take') {
        if (gen.status === 'approved') return { ...s, approved_take: gen }
        if (s.approved_take?.id === gen.id) return { ...s, approved_take: null }
        return s
      }
      const field: FrameField | null =
        gen.kind === 'keyframe_start' ? 'start_frame' : gen.kind === 'keyframe_end' ? 'end_frame' : null
      if (!field) return s
      const next = nextCurrent(s[field], gen)
      if (next === undefined) {
        refetch = true
        return s
      }
      return next === s[field] ? s : { ...s, [field]: next }
    }),
  )
  if (refetch) qc.invalidateQueries(allShotLists)
}

export function useCreateShot(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ sceneId, ...body }: { sceneId: string; shot_type?: ShotType; after_shot_id?: string; description?: string }) =>
      api.shots.create(sceneId, body),
    onSuccess: () => {
      // inserting shifts `order` on siblings
      qc.invalidateQueries({ queryKey: qk.shots(projectId) })
      qc.invalidateQueries({ queryKey: qk.project(projectId) })
    },
  })
}

export function useUpdateShot(projectId: string) {
  const qc = useQueryClient()
  const key = qk.shots(projectId)
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ShotPatch }) => api.shots.update(id, patch),
    // optimistic, so toggles like the seam feel instant
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<Shot[]>(key)
      qc.setQueryData<Shot[]>(key, (old) => old?.map((s) => (s.id === id ? { ...s, ...patch } : s)))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
    },
    onSuccess: (shot) => upsertShot(qc, shot),
  })
}

export function useDeleteShot(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.shots.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.shots(projectId) })
      qc.invalidateQueries({ queryKey: qk.project(projectId) })
    },
  })
}

export function useReorderShots(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ sceneId, ids }: { sceneId: string; ids: string[] }) => api.shots.reorder(sceneId, ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.shots(projectId) }),
  })
}

export function useClearStale() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: api.shots.clearStale, onSuccess: (s) => upsertShot(qc, s) })
}

export function useRenderTakes() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ shotId, count, durationS }: { shotId: string; count?: number; durationS?: number }) =>
      api.shots.renderTakes(shotId, count, durationS),
    onSuccess: (_jobs, { shotId }) => {
      qc.invalidateQueries({ queryKey: qk.jobs })
      qc.invalidateQueries({ queryKey: qk.generationsFor('shot', shotId, 'take') })
    },
  })
}

export function useRenderScene() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ sceneId, count }: { sceneId: string; count?: number }) => api.shots.renderScene(sceneId, count),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.jobs })
      qc.invalidateQueries({ queryKey: ['generations', 'shot'] })
    },
  })
}
