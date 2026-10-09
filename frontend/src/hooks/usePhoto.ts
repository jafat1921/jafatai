import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { DevelopParams, ExportFormat, Look } from '@/lib/photo/types'
import { useJobs } from './useJobs'

export const photoKeys = {
  schema: ['photo', 'schema'] as const,
  history: (id: string) => ['photo', 'history', id] as const,
  histories: ['photo', 'history'] as const,
  looks: ['looks'] as const,
  palette: (id: string) => ['photo', 'palette', id] as const,
}

export const usePhotoSchema = () => useQuery({ queryKey: photoKeys.schema, queryFn: api.photo.schema, staleTime: Infinity })

/**
 * Versions of the item. Refreshes while one of them is still rendering, so the filmstrip fills in
 * without waiting on the event stream.
 */
export function usePhotoHistory(id: string | undefined) {
  const jobs = useJobs()
  const q = useQuery({
    queryKey: photoKeys.history(id ?? ''),
    queryFn: () => api.photo.history(id!),
    enabled: !!id,
    refetchInterval: (query) =>
      query.state.data?.versions.some((v) => v.generation.status === 'queued' || v.generation.status === 'generating') ? 3000 : false,
  })
  // a photo job we know about just finished: pick the new version up straight away
  const busy = (jobs.data ?? []).some((j) => (j.type === 'photo_render' || j.type === 'look_video') && (j.status === 'queued' || j.status === 'running'))
  return { ...q, busy }
}

export function useRenderPhoto(historyId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, params, format = 'jpeg', note }: { id: string; params: DevelopParams; format?: ExportFormat; note?: string }) =>
      api.photo.render(id, { params, format, ...(note ? { note } : {}) }),
    onSuccess: () => {
      if (historyId) qc.invalidateQueries({ queryKey: photoKeys.history(historyId) })
      qc.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
}

export function useRevertPhoto(historyId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (genId: string) => api.photo.revert(genId),
    onSuccess: (h) => {
      if (historyId) qc.setQueryData(photoKeys.history(historyId), h)
      qc.invalidateQueries({ queryKey: ['media'] })
    },
  })
}

export const useAutoSuggest = () => useMutation({ mutationFn: (id: string) => api.photo.auto(id) })

export const useLooks = () => useQuery({ queryKey: photoKeys.looks, queryFn: api.looks.list })

export function useLookMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: photoKeys.looks })
  const patchList = (fn: (l: Look[]) => Look[]) => qc.setQueryData<Look[]>(photoKeys.looks, (old) => (old ? fn(old) : old))
  return {
    create: useMutation({
      mutationFn: api.looks.create,
      onSuccess: (look) => {
        // user looks sit after the built-ins, newest first
        patchList((l) => {
          const builtins = l.filter((x) => x.source === 'builtin')
          return [...builtins, look, ...l.filter((x) => x.source !== 'builtin')]
        })
        refresh()
      },
    }),
    rename: useMutation({
      mutationFn: ({ id, name }: { id: string; name: string }) => api.looks.update(id, { name }),
      onSuccess: (look) => patchList((l) => l.map((x) => (x.id === look.id ? look : x))),
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.looks.remove(id),
      onSuccess: (_, id) => patchList((l) => l.filter((x) => x.id !== id)),
    }),
    importFiles: useMutation({ mutationFn: api.looks.importFiles, onSuccess: refresh }),
    applyVideo: useMutation({
      mutationFn: ({ id, generationId, intensity }: { id: string; generationId: string; intensity: number }) =>
        api.looks.applyVideo(id, { generation_id: generationId, intensity }),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
    }),
  }
}
