import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Character } from '@/lib/types'
import { qk } from './keys'

export function useCharacters(projectId: string) {
  return useQuery({ queryKey: qk.characters(projectId), queryFn: () => api.characters.list(projectId) })
}

export function useCreateCharacter(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; description?: string }) => api.characters.create(projectId, body),
    onSuccess: (c) => {
      qc.setQueryData<Character[]>(qk.characters(projectId), (old) => (old ? [...old, c] : [c]))
      qc.invalidateQueries({ queryKey: qk.project(projectId) })
    },
  })
}

export function useUpdateCharacter(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; description?: string }) =>
      api.characters.update(id, body),
    onSuccess: (c) => {
      qc.setQueryData<Character[]>(qk.characters(projectId), (old) => old?.map((x) => (x.id === c.id ? c : x)))
    },
  })
}
