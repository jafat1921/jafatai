import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Scene, ScenePatch } from '@/lib/types'
import { qk } from './keys'

const byOrder = (a: Scene, b: Scene) => a.order - b.order

export function useScenes(projectId: string) {
  return useQuery({
    queryKey: qk.scenes(projectId),
    queryFn: () => api.scenes.list(projectId),
    select: (scenes) => [...scenes].sort(byOrder),
  })
}

export function useCreateScene(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { heading?: string; after_scene_id?: string }) => api.scenes.create(projectId, body),
    onSuccess: () => {
      // inserting can shift `order` on siblings, so refetch rather than splice
      qc.invalidateQueries({ queryKey: qk.scenes(projectId) })
      qc.invalidateQueries({ queryKey: qk.project(projectId) })
    },
  })
}

export function useUpdateScene(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ScenePatch }) => api.scenes.update(id, patch),
    onSuccess: (scene) => {
      qc.setQueryData<Scene[]>(qk.scenes(projectId), (old) => old?.map((s) => (s.id === scene.id ? scene : s)))
    },
  })
}

export function useReorderScenes(projectId: string) {
  const qc = useQueryClient()
  const key = qk.scenes(projectId)
  return useMutation({
    mutationFn: (ids: string[]) => api.scenes.reorder(projectId, ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<Scene[]>(key)
      if (prev) {
        const byId = new Map(prev.map((s) => [s.id, s]))
        qc.setQueryData<Scene[]>(
          key,
          ids.flatMap((id, i) => {
            const s = byId.get(id)
            return s ? [{ ...s, order: i }] : []
          }),
        )
      }
      return { prev }
    },
    onError: (_err, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
    },
    onSuccess: (scenes) => qc.setQueryData(key, scenes),
  })
}
