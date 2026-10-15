import { useQueries } from '@tanstack/react-query'
import { qk } from '@/hooks/keys'
import { api } from '@/lib/api'
import { FALLBACK_MODELS, modelLabel } from '@/lib/models'
import type { ModelInfo, ModelType } from '@/lib/types'

const TYPES: ModelType[] = ['image', 'edit', 'video', 'upscale']

/**
 * Model id → label from whatever catalog is already cached. Never fetches: a library page full of
 * tiles shouldn't fire four catalog requests just to print names.
 */
export function useModelLabels() {
  const qs = useQueries({
    queries: TYPES.map((t) => ({ queryKey: qk.models(t), queryFn: () => api.models.list(t), enabled: false })),
  })
  const catalog: Record<string, ModelInfo[]> = { fallback: Object.values(FALLBACK_MODELS).flat() }
  qs.forEach((q, i) => {
    if (Array.isArray(q.data)) catalog[TYPES[i]] = q.data
  })
  return (id: string | null | undefined) => modelLabel(catalog, id)
}

/**
 * Whether a model can be picked here, from the cached image catalog only: false when the catalog lists it as
 * not installed or leaves it out (switched off), undefined when no catalog is cached yet.
 */
export function useImageModelUsable() {
  const [q] = useQueries({
    queries: [{ queryKey: qk.models('image'), queryFn: () => api.models.list('image'), enabled: false }],
  })
  const list = Array.isArray(q.data) ? (q.data as ModelInfo[]) : null
  return (id: string | null | undefined): boolean | undefined => {
    if (!id || !list) return undefined
    return list.find((m) => m.id === id)?.available ?? false
  }
}
