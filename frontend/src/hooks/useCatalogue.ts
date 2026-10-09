import { useCallback, useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Album, Client, PhotoPage, SortKey } from '@/lib/catalogue'
import type { MediaItem } from '@/lib/types'
import { uploadPhoto } from '@/lib/upload'

type Q = Record<string, string | number | boolean | undefined>

export const catalogueKeys = {
  photos: ['photos'] as const,
  list: (q: Q, sort: SortKey, order: string) => ['photos', 'list', q, sort, order] as const,
  facets: (q: Q) => ['photos', 'facets', q] as const,
  albums: ['albums'] as const,
  clients: ['clients'] as const,
}

const PAGE = 100

export function usePhotoList(q: Q, sort: SortKey, order: 'asc' | 'desc') {
  return useInfiniteQuery({
    queryKey: catalogueKeys.list(q, sort, order),
    queryFn: ({ pageParam }) => api.photos.list({ ...q, sort, order, offset: pageParam, limit: PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last: PhotoPage) => last.next_offset ?? undefined,
  })
}

export const photosOf = (data: InfiniteData<PhotoPage> | undefined) => data?.pages.flatMap((p) => p?.items ?? []) ?? []

export const useFacets = (q: Q) => useQuery({ queryKey: catalogueKeys.facets(q), queryFn: () => api.photos.facets(q), staleTime: 15_000 })
export const useAlbums = () => useQuery({ queryKey: catalogueKeys.albums, queryFn: api.albums.list })
export const useClients = () => useQuery({ queryKey: catalogueKeys.clients, queryFn: api.clients.list })

type Marks = { rating?: number; flag?: 'pick' | 'reject' | 'none'; label?: string }

/** Ratings, flags and labels show at once; the server catches up (and wins if it disagrees). */
export function useMarks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ids, marks }: { ids: string[]; marks: Marks }) => api.photos.marks({ ids, ...marks }),
    onMutate: async ({ ids, marks }) => {
      await qc.cancelQueries({ queryKey: catalogueKeys.photos })
      const patch: Partial<MediaItem> = {}
      if (marks.rating != null) patch.rating = marks.rating
      if (marks.flag) patch.flag = marks.flag === 'none' ? '' : marks.flag
      if (marks.label) patch.label = (marks.label === 'none' ? '' : marks.label) as MediaItem['label']
      const set = new Set(ids)
      qc.setQueriesData<InfiniteData<PhotoPage>>({ queryKey: [...catalogueKeys.photos, 'list'] }, (old) =>
        old && { ...old, pages: old.pages.map((p) => ({ ...p, items: p.items.map((m) => (set.has(m.id) ? { ...m, ...patch } : m)) })) },
      )
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [...catalogueKeys.photos, 'facets'] })
      qc.invalidateQueries({ queryKey: catalogueKeys.albums })
    },
  })
}

export function useAlbumMutations() {
  const qc = useQueryClient()
  const done = () => {
    qc.invalidateQueries({ queryKey: catalogueKeys.albums })
    qc.invalidateQueries({ queryKey: catalogueKeys.photos })
    qc.invalidateQueries({ queryKey: catalogueKeys.clients })
  }
  return {
    create: useMutation({ mutationFn: api.albums.create, onSuccess: done }),
    update: useMutation({ mutationFn: ({ id, ...body }: Partial<Album> & { id: string }) => api.albums.update(id, body), onSuccess: done }),
    remove: useMutation({ mutationFn: api.albums.remove, onSuccess: done }),
    items: useMutation({
      mutationFn: ({ id, ids, action }: { id: string; ids: string[]; action?: 'add' | 'remove' }) => api.albums.items(id, ids, action),
      onSuccess: done,
    }),
    order: useMutation({ mutationFn: ({ id, ids }: { id: string; ids: string[] }) => api.albums.order(id, ids), onSuccess: done }),
  }
}

export function useClientMutations() {
  const qc = useQueryClient()
  const done = () => {
    qc.invalidateQueries({ queryKey: catalogueKeys.clients })
    qc.invalidateQueries({ queryKey: catalogueKeys.albums })
  }
  return {
    create: useMutation({ mutationFn: api.clients.create, onSuccess: done }),
    update: useMutation({ mutationFn: ({ id, ...body }: Partial<Client> & { id: string }) => api.clients.update(id, body), onSuccess: done }),
    remove: useMutation({ mutationFn: api.clients.remove, onSuccess: done }),
  }
}

// ---------------------------------------------------------------- import queue

export interface ImportRow {
  key: string
  name: string
  progress: number
  state: 'waiting' | 'uploading' | 'done' | 'duplicate' | 'failed'
  error?: string
  item?: MediaItem
}

const CONCURRENCY = 3

/** Three files at a time: a 300-photo card dump shouldn't open 300 connections or starve the grid. */
export function usePhotoImport() {
  const qc = useQueryClient()
  const [rows, setRows] = useState<ImportRow[]>([])
  const queue = useRef<{ key: string; file: File; fields: { album_id?: string; on_duplicate?: 'skip' | 'keep' } }[]>([])
  const active = useRef(0)
  const aborts = useRef(new Map<string, () => void>())

  const patchRow = (key: string, p: Partial<ImportRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const again = useRef<() => void>(() => {})
  const pump = useCallback(() => {
    while (active.current < CONCURRENCY && queue.current.length) {
      const job = queue.current.shift()!
      active.current += 1
      patchRow(job.key, { state: 'uploading' })
      const h = uploadPhoto(job.file, (f) => patchRow(job.key, { progress: f }), job.fields)
      aborts.current.set(job.key, h.abort)
      h.promise
        .then((item) => patchRow(job.key, { state: item.duplicate ? 'duplicate' : 'done', progress: 1, item }))
        .catch((e: Error) => patchRow(job.key, { state: 'failed', error: e.message }))
        .finally(() => {
          active.current -= 1
          aborts.current.delete(job.key)
          if (!queue.current.length && active.current === 0) {
            qc.invalidateQueries({ queryKey: catalogueKeys.photos })
            qc.invalidateQueries({ queryKey: catalogueKeys.albums })
            qc.invalidateQueries({ queryKey: ['media'] })
          }
          again.current()
        })
    }
  }, [qc])
  useEffect(() => {
    again.current = pump
  }, [pump])

  const add = useCallback(
    (files: File[], fields: { album_id?: string; on_duplicate?: 'skip' | 'keep' }) => {
      const stamp = Date.now()
      const fresh = files.map((file, i) => ({ key: `${stamp}-${i}-${file.name}`, file, fields }))
      setRows((rs) => [...rs, ...fresh.map((f) => ({ key: f.key, name: f.file.name, progress: 0, state: 'waiting' as const }))])
      queue.current.push(...fresh)
      pump()
    },
    [pump],
  )

  const cancelAll = useCallback(() => {
    const waiting = new Set(queue.current.map((q) => q.key))
    queue.current = []
    aborts.current.forEach((abort) => abort())
    setRows((rs) => rs.map((r) => (waiting.has(r.key) ? { ...r, state: 'failed', error: 'Cancelled' } : r)))
  }, [])

  const clearFinished = useCallback(() => setRows((rs) => rs.filter((r) => r.state === 'waiting' || r.state === 'uploading')), [])
  return { rows, add, cancelAll, clearFinished }
}
