import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { FALLBACK_MODELS } from '@/lib/models'
import type { Job, MediaBatch, MediaItem, ModelInfo, ModelType, Project, ProjectSettings, VideoGenerateRequest } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'
import { upsertMedia } from './useMedia'

const TYPES: ModelType[] = ['image', 'edit', 'video', 'upscale']

const modelsQuery = (type: ModelType) => ({
  queryKey: qk.models(type),
  queryFn: () => api.models.list(type),
  // the catalog only changes when the server is redeployed
  staleTime: 5 * 60_000,
  retry: false,
})

// An older server answers 404 (or something odd); an empty catalog is never right either.
// Either way the hard-coded list keeps every page working.
const resolve = (type: ModelType, data: ModelInfo[] | undefined, failed: boolean) =>
  !failed && Array.isArray(data) && data.length ? { models: data, fallback: false } : { models: FALLBACK_MODELS[type], fallback: true }

export function useModels(type: ModelType) {
  const q = useQuery(modelsQuery(type))
  return { ...resolve(type, q.data, q.isError), loading: q.isPending }
}

/** Every type at once, for the mega-menus. */
export function useCatalog(): Record<ModelType, ModelInfo[]> {
  const qs = useQueries({ queries: TYPES.map(modelsQuery) })
  return Object.fromEntries(TYPES.map((t, i) => [t, resolve(t, qs[i].data, qs[i].isError).models])) as Record<ModelType, ModelInfo[]>
}

export function useUpdateProjectSettings(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    // the server merges the patch into project.settings
    mutationFn: (patch: ProjectSettings) => api.projects.update(projectId, { settings: patch }),
    onMutate: (patch) => {
      const prev = qc.getQueryData<Project>(qk.project(projectId))
      if (prev) qc.setQueryData<Project>(qk.project(projectId), { ...prev, settings: { ...prev.settings, ...patch } })
      return { prev }
    },
    onError: (_e, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.project(projectId), ctx.prev)
    },
    onSuccess: (p) => {
      if (p?.id !== projectId) return
      qc.setQueryData(qk.project(projectId), p)
      qc.setQueryData<Project[]>(qk.projects, (old) => old?.map((x) => (x.id === p.id ? p : x)))
    },
  })
}

export function useVideoGenerate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: VideoGenerateRequest) => api.videos.generate(body),
    onSuccess: (res) => {
      const batch = res as Partial<MediaBatch>
      const single = res as MediaItem & { job?: Job | null }
      const items: MediaItem[] = Array.isArray(batch.items) ? batch.items : [single]
      items.forEach((m) => m?.id && upsertMedia(qc, m))
      ;[...(batch.jobs ?? []), ...(single.job ? [single.job] : [])].forEach((j) => upsertJob(qc, j))
      qc.invalidateQueries({ queryKey: qk.jobs })
      qc.invalidateQueries({ queryKey: qk.dashboard })
    },
  })
}
