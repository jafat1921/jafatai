import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { tileState } from '@/lib/images'
import { withInto } from '@/stores/generateInto'
import type { Generation, ImageEditRequest, ImageGenerateRequest, Img2ImgRequest, MediaDetail, MediaItem, MediaKind, MediaOrigin, MediaPage, MediaQuery, RegenerateMode } from '@/lib/types'
import { qk } from './keys'
import { upsertJob, useJobs } from './useJobs'

export type MediaFilter = Omit<MediaQuery, 'cursor'>

export type OriginFilter = 'all' | MediaOrigin

export const LIBRARY_ORIGINS: { value: OriginFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'generated', label: 'Generated' },
  { value: 'upload', label: 'Uploads' },
  { value: 'project', label: 'From projects' },
]

/** Pure: the list query for the chosen filters. "All" includes approved project results. */
export function libraryFilter(
  kind: MediaKind,
  origin: OriginFilter,
  q: string,
  tag: string | null,
  scope: { folderId?: string | null; favourite?: boolean } = {},
): MediaFilter {
  const f: MediaFilter = { kind }
  if (origin === 'all') f.include = 'project'
  else f.origin = origin
  if (q.trim()) f.q = q.trim()
  if (tag) f.tag = tag
  if (scope.folderId) f.folder_id = scope.folderId
  if (scope.favourite) f.favourite = 1
  return f
}


export function useMediaList(filter: MediaFilter, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.mediaList(filter),
    queryFn: ({ pageParam }) => api.media.list({ limit: 40, ...filter, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor || undefined,
    enabled,
  })
}

export const flatItems = (data: InfiniteData<MediaPage> | undefined) => data?.pages.flatMap((p) => p.items ?? []) ?? []

export function useMediaItem(id: string | null | undefined) {
  return useQuery({ queryKey: qk.mediaItem(id ?? ''), queryFn: () => api.media.get(id!), enabled: !!id })
}

// would the server have put this item in that list? (text and tag searches are left to the server)
function belongs(filter: MediaFilter, item: MediaItem) {
  if (filter.q || filter.tag || filter.favourite) return false
  if (filter.folder_id && filter.folder_id !== item.folder_id) return false
  if (filter.kind && filter.kind !== item.kind) return false
  if (filter.origin && filter.origin !== item.origin) return false
  if (filter.project_id && filter.project_id !== item.project_id) return false
  return item.origin !== 'project' || filter.include === 'project' || filter.origin === 'project'
}

/** Merges a created or updated item into every cached list, newest on top; also used by the `media` SSE event. */
export function upsertMedia(qc: QueryClient, item: MediaItem) {
  for (const q of qc.getQueryCache().findAll({ queryKey: qk.mediaLists })) {
    const filter = (q.queryKey[2] ?? {}) as MediaFilter
    qc.setQueryData<InfiniteData<MediaPage>>(q.queryKey, (old) => {
      if (!old) return old
      let found = false
      const pages = old.pages.map((p) => ({
        ...p,
        items: (p.items ?? []).map((m) => {
          if (m.id !== item.id) return m
          found = true
          return { ...m, ...item }
        }),
      }))
      if (!found && belongs(filter, item) && pages.length) pages[0] = { ...pages[0], items: [item, ...pages[0].items] }
      return { ...old, pages }
    })
  }
  qc.setQueryData<MediaDetail>(qk.mediaItem(item.id), (old) => (old ? { ...old, ...item } : old))
}

export function removeMedia(qc: QueryClient, id: string) {
  qc.setQueriesData<InfiniteData<MediaPage>>({ queryKey: qk.mediaLists }, (old) =>
    old ? { ...old, pages: old.pages.map((p) => ({ ...p, items: p.items.filter((m) => m.id !== id) })) } : old,
  )
  qc.removeQueries({ queryKey: qk.mediaItem(id) })
}

function useBatch<B>(fn: (body: B) => ReturnType<typeof api.images.generate>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: ({ items, jobs }) => {
      // oldest first so the batch ends up in its own order at the top
      ;[...(items ?? [])].reverse().forEach((m) => upsertMedia(qc, m))
      ;(jobs ?? []).forEach((j) => upsertJob(qc, j))
      qc.invalidateQueries({ queryKey: qk.dashboard })
    },
  })
}

export const useImageGenerate = () => useBatch((body: ImageGenerateRequest) => api.images.generate(withInto('image', body)))
export const useImageEdit = () => useBatch((body: ImageEditRequest) => api.images.edit(withInto('image', body)))
export const useImg2Img = () => useBatch((body: Img2ImgRequest) => api.images.img2img(withInto('image', body)))

export function useMediaRegenerate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; mode: RegenerateMode; note?: string; prompt?: string }) => api.media.regenerate(id, body),
    onSuccess: (job, { id }) => {
      upsertJob(qc, job)
      qc.invalidateQueries({ queryKey: qk.mediaItem(id) })
    },
  })
}

export function useDeleteMedia() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.media.remove(id),
    onSuccess: (_, id) => {
      removeMedia(qc, id)
      qc.invalidateQueries({ queryKey: qk.dashboard })
    },
  })
}

/** Live state of an item's current version: SSE generation events land in qk.generation, jobs in the jobs list. */
export function useTileState(item: MediaItem) {
  const gen = useQuery({
    queryKey: qk.generation(item.generation_id),
    queryFn: () => Promise.resolve(null as Generation | null),
    enabled: false,
  }).data
  const jobs = useJobs().data
  const job = jobs?.filter((j) => j.generation_id === item.generation_id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  return { state: tileState(item, gen, job), job, gen: gen ?? undefined, progress: job?.status === 'running' ? job.progress : undefined }
}
