import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Location } from '@/lib/types'
import { qk } from './keys'

export function useLocations(projectId: string) {
  return useQuery({
    queryKey: qk.locations(projectId),
    queryFn: () => api.locations.list(projectId),
    enabled: !!projectId,
  })
}

export function useSaveLocation(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id?: string; name: string; description?: string }) =>
      id ? api.locations.update(id, body) : api.locations.create(projectId, body),
    onSuccess: (loc) => {
      qc.setQueryData<Location[]>(qk.locations(projectId), (old) => {
        if (!old) return [loc]
        return old.some((l) => l.id === loc.id) ? old.map((l) => (l.id === loc.id ? loc : l)) : [...old, loc]
      })
    },
  })
}

export function useDeleteLocation(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.locations.remove(id),
    onSuccess: (_v, id) => {
      qc.setQueryData<Location[]>(qk.locations(projectId), (old) => old?.filter((l) => l.id !== id))
      // scenes and shots pointing at it lose their location server-side
      qc.invalidateQueries({ queryKey: qk.scenes(projectId) })
      qc.invalidateQueries({ queryKey: qk.shots(projectId) })
    },
  })
}
