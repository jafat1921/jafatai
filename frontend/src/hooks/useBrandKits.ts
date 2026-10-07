import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BrandKit, BrandKitPatch, BrandSettings, LogoRevealRequest, PreviewKind } from '@/lib/brand'
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
 * The generator chip's state: the default kit is preselected and on when one exists, off when none.
 * `sendId` is what goes into brand_kit_id (undefined while off).
 */
export function useBrandChoice() {
  const { kits } = useBrandKits()
  const [picked, setPicked] = useState<string | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const fallback = kits.find((k) => k.is_default) ?? null
  const kit = kits.find((k) => k.id === picked) ?? fallback ?? kits[0] ?? null
  const on = !!kit && (enabled ?? !!fallback)
  return {
    kits,
    kit,
    on,
    setKit: (id: string) => {
      setPicked(id)
      setEnabled(true)
    },
    setOn: setEnabled,
    sendId: on ? kit?.id : undefined,
  }
}

export type BrandChoice = ReturnType<typeof useBrandChoice>
