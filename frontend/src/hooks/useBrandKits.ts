import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { brandApi, type BrandKit, type BrandKitPatch, type BrandSettings, type LogoRevealRequest, type PreviewKind } from '@/lib/brand'
import type { Project } from '@/lib/types'
import { qk } from './keys'
import { upsertJob } from './useJobs'
import { upsertMedia } from './useMedia'

// an older server answers 404 here; treat that as "no kits yet" so the chips just stay off
const asList = (data: unknown) => (Array.isArray(data) ? (data as BrandKit[]) : [])

export function useBrandKits() {
  const q = useQuery({ queryKey: qk.brandKits, queryFn: api.brandKits.list, retry: false, staleTime: 60_000 })
  return { ...q, kits: asList(q.data) }
}

export function useBrandKit(id: string | null | undefined) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.brandKit(id ?? ''),
    queryFn: () => api.brandKits.get(id!),
    enabled: !!id,
    initialData: () => asList(qc.getQueryData(qk.brandKits)).find((k) => k.id === id),
  })
}

function storeKit(qc: QueryClient, kit: BrandKit) {
  qc.setQueryData(qk.brandKit(kit.id), kit)
  qc.setQueryData<BrandKit[]>(qk.brandKits, (old) => {
    const list = asList(old)
    return list.some((k) => k.id === kit.id) ? list.map((k) => (k.id === kit.id ? kit : k)) : [...list, kit]
  })
}

export function useCreateKit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.brandKits.create({ name }),
    onSuccess: (kit) => {
      storeKit(qc, kit)
      // the first kit becomes the default, which flips the others
      qc.invalidateQueries({ queryKey: qk.brandKits })
    },
  })
}

export function useUpdateKit(id: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (patch: BrandKitPatch) => api.brandKits.update(id, patch), onSuccess: (kit) => storeKit(qc, kit) })
}

export function useDeleteKit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.brandKits.remove(id),
    onSuccess: (_r, id) => {
      qc.setQueryData<BrandKit[]>(qk.brandKits, (old) => asList(old).filter((k) => k.id !== id))
      qc.removeQueries({ queryKey: qk.brandKit(id) })
    },
  })
}

export function useSetDefaultKit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.brandKits.setDefault(id),
    onSuccess: (kit) => {
      qc.setQueryData<BrandKit[]>(qk.brandKits, (old) => asList(old).map((k) => (k.id === kit.id ? kit : { ...k, is_default: false })))
      qc.setQueryData(qk.brandKit(kit.id), kit)
    },
  })
}

const STYLE_POLL_MS = 3000

/** The kit's ad-style references: save the list (which starts a read), read again, and poll while it works. */
export function useAdStyle(kit: BrandKit) {
  const qc = useQueryClient()
  const live = useQuery({
    queryKey: qk.brandKit(kit.id),
    queryFn: () => api.brandKits.get(kit.id),
    initialData: kit,
    refetchInterval: (q) => (q.state.data?.ad_style?.status === 'working' ? STYLE_POLL_MS : false),
  })
  const put = useMutation({ mutationFn: (refs: string[]) => brandApi.putAdStyle(kit.id, refs), onSuccess: (k) => storeKit(qc, k) })
  const extract = useMutation({
    mutationFn: () => brandApi.extractAdStyle(kit.id),
    onSuccess: (job) => {
      upsertJob(qc, job)
      qc.invalidateQueries({ queryKey: qk.brandKit(kit.id) })
    },
  })
  return { kit: live.data ?? kit, put, extract }
}

export function useLogoReveal(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: LogoRevealRequest) => api.brandKits.logoReveal(id, body),
    onSuccess: ({ item, job }) => {
      upsertMedia(qc, item)
      qc.setQueryData(qk.mediaItem(item.id), { ...item, versions: [] })
      if (job) upsertJob(qc, job)
    },
  })
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Live PNG of the unsaved settings, debounced so dragging a slider doesn't flood the server. */
export function useBrandPreview(kitId: string, kind: PreviewKind, settings: BrandSettings, enabled: boolean) {
  const key = useDebounced(JSON.stringify(settings), 400)
  const q = useQuery({
    queryKey: qk.brandPreview(kitId, kind, key),
    queryFn: () => api.brandKits.preview(kitId, { kind, settings: JSON.parse(key) }),
    enabled: enabled && !!kitId,
    staleTime: Infinity,
    placeholderData: (prev) => prev,
    retry: false,
  })
  const url = useMemo(() => (q.data instanceof Blob && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(q.data) : null), [q.data])
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  return { url, loading: q.isFetching, error: q.error }
}

export function useSetProjectKit(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (kitId: string | null) => api.projects.setBrandKit(projectId, kitId),
    onSuccess: ({ brand_kit_id }) => {
      const patch = (p: Project) => ({ ...p, settings: { ...p.settings, brand_kit_id } })
      qc.setQueryData<Project>(qk.project(projectId), (old) => (old ? patch(old) : old))
      qc.setQueryData<Project[]>(qk.projects, (old) => old?.map((p) => (p.id === projectId ? patch(p) : p)))
    },
  })
}

/**
 * The generator chip's state. Off with no kit picked until the user picks one, every time: a kit that
 * switched itself on put the logo into pictures nobody meant to brand.
 * `sendId` is what goes into brand_kit_id (undefined while off).
 */
export function useBrandChoice() {
  const { kits } = useBrandKits()
  const [picked, setPicked] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const kit = kits.find((k) => k.id === picked) ?? null
  const on = !!kit && enabled
  return {
    kits,
    kit,
    on,
    setKit: (id: string) => {
      setPicked(id || null)
      setEnabled(!!id)
    },
    setOn: setEnabled,
    sendId: on ? kit?.id : undefined,
  }
}

export type BrandChoice = ReturnType<typeof useBrandChoice>
