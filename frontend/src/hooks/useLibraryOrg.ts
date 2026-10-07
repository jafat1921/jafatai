import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BatchAction, Folder, FolderKind, MediaKind } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'

/** Every folder of the workspace; pages filter by kind client-side so one cache serves both libraries. */
export function useFolders(kind?: MediaKind) {
  const q = useQuery({ queryKey: qk.folders, queryFn: () => api.folders.list() })
  const all = Array.isArray(q.data) ? q.data : []
  const folders = kind ? all.filter((f) => f.kind === 'any' || f.kind === kind) : all
  return { ...q, folders }
}

export function useFolderMutations() {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: qk.folders })
  const lists = () => qc.invalidateQueries({ queryKey: qk.mediaLists })
  return {
    create: useMutation({
      mutationFn: (body: { name: string; parent_id?: string | null; kind?: FolderKind }) => api.folders.create(body),
      onSuccess: done,
    }),
    rename: useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.folders.update(id, { name }), onSuccess: done }),
    remove: useMutation({
      mutationFn: (id: string) => api.folders.remove(id),
      onSuccess: () => {
        done()
        lists()
      },
    }),
  }
}

export function useBatchAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ action, refs, options }: { action: BatchAction; refs: string[]; options?: Record<string, unknown> }) =>
      action === 'move' ? api.media.move(refs, (options?.folder_id as string | null) ?? null) : api.media.batch(action, refs, options),
    onSuccess: (res) => {
      ;(res.jobs ?? []).forEach((j) => upsertJob(qc, j))
      qc.invalidateQueries({ queryKey: qk.mediaLists })
      qc.invalidateQueries({ queryKey: qk.folders })
      if (res.action === 'delete') qc.invalidateQueries({ queryKey: qk.dashboard })
    },
  })
}

export function useSavedFilters() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: qk.savedFilters, queryFn: () => api.savedFilters.list() })
  const done = () => qc.invalidateQueries({ queryKey: qk.savedFilters })
  return {
    filters: Array.isArray(q.data) ? q.data : [],
    save: useMutation({ mutationFn: api.savedFilters.create, onSuccess: done }),
    remove: useMutation({ mutationFn: api.savedFilters.remove, onSuccess: done }),
  }
}

/** Root-first chain of folders down to `id`, for breadcrumbs. */
export function folderPath(folders: Folder[], id: string | null | undefined): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out: Folder[] = []
  let cur = id ? byId.get(id) : undefined
  while (cur && !out.includes(cur)) {
    out.unshift(cur)
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return out
}
